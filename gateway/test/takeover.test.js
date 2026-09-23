#!/usr/bin/env node
/** Unit tests for src/takeover.js against a fake rom-control Client. */
'use strict';
const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const { Takeover, OFF_RE } = require('../src/takeover');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeClient extends EventEmitter {
  constructor (script) {
    super();
    this.log = [];
    this.script = script || [];          // queued transcripts for awaitSpeech
    this.watching = false;
    this.destroyed = false;
    const self = this;
    this.audio = {
      watchWakeword () { self.watching = true; self.log.push('watch'); },
      stopWakeword () { self.watching = false; self.log.push('unwatch'); },
      awaitSpeech (opts) {
        self.log.push('listen:' + opts.time + '/' + opts.noSpeechTime);
        const next = self.script.shift();
        if (next === 'TIMEOUT') return Promise.reject(Object.assign(new Error('t'), { code: 'SPEECH_TIMEOUT' }));
        return sleep(5).then(() => ({ content: next }));
      },
    };
    this.behavior = { say (t) { self.log.push('say:' + t); return sleep(self.sayMs || 5); } };
    this.display = { showText (t) { self.log.push('text'); }, showEye () { self.log.push('eye'); } };
    // minimal RomConnection stand-in: event bus + websocket + subscribe
    this._conn = new EventEmitter();
    this._conn.ws = new EventEmitter();
    this._conn.subscribeHeadTouch = () => Promise.resolve({ ResponseCode: 200 });
  }
  connect () { setTimeout(() => this.emit('ready'), 5); return Promise.resolve(); }
  destroy () { this.destroyed = true; this.log.push('destroy'); }
}

function make (cfg, script) {
  const calls = [];
  let client;
  const t = new Takeover({
    converse: async (sid, text) => { calls.push([sid, text]); return { reply: 'R:' + text, end: false, route: 'claude' }; },
    createClient: () => (client = new FakeClient(script)),
    log: () => {},
    version: '9.9.9',
  }, Object.assign({ startDelayMs: 10, idleMinutes: 0, doublePatMs: 300 }, cfg || {}));
  return { t, calls, client: () => client };
}

const pat = (c, on) => c.emit('headTouch', { activePads: on ? ['frontLeft'] : [] });

const results = [];
async function test (name, fn) {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.stack.split('\n').slice(0, 2).join(' | ')]); }
}

(async () => {
  await test('off → starting → on; greets, shows instructions, watches wakeword', async () => {
    const { t, client } = make();
    assert.equal(t.state, 'off');
    t.start('test');
    assert.equal(t.state, 'starting');
    await sleep(60);
    assert.equal(t.state, 'on');
    const log = client().log;
    assert.ok(log.includes('text') && log.includes('watch'));
    assert.ok(log.some((l) => l.startsWith('say:Claude mode is on')));
  });

  await test('start is idempotent', async () => {
    const { t } = make();
    t.start(); t.start(); await sleep(60); t.start();
    assert.equal(t.state, 'on');
  });

  await test('hotword turn: unwatch → listen(15000/15000) → converse → say → re-watch (in that order)', async () => {
    const { t, calls, client } = make({}, ['how far is london']);
    t.start(); await sleep(60);
    const c = client(); c.log.length = 0;
    c.emit('hotword', {}); await sleep(60);
    assert.deepEqual(calls, [['takeover', 'how far is london']]);
    assert.deepEqual(c.log, ['unwatch', 'listen:15000/15000', 'say:R:how far is london', 'watch']);
    assert.equal(t.turns, 1);
  });

  await test('hotword ignored while a turn is in progress', async () => {
    const { t, calls, client } = make({}, ['one', 'two']);
    t.start(); await sleep(60);
    client().emit('hotword'); client().emit('hotword'); await sleep(80);
    assert.equal(calls.length, 1);
  });

  await test('speech timeout → no reply, wakeword re-armed', async () => {
    const { t, calls, client } = make({}, ['TIMEOUT']);
    t.start(); await sleep(60);
    const c = client(); c.log.length = 0;
    c.emit('hotword'); await sleep(40);
    assert.equal(calls.length, 0);
    assert.equal(c.log[c.log.length - 1], 'watch');
  });

  await test('double head pat → off, goodbye spoken, client destroyed', async () => {
    const { t, client } = make();
    t.start(); await sleep(60);
    const c = client();
    pat(c, true); pat(c, true); pat(c, false);   // held touch = one start
    await sleep(20);
    assert.equal(t.state, 'on', 'single held touch must not exit');
    pat(c, true); await sleep(60);
    assert.equal(t.state, 'off');
    assert.equal(t.reason, 'double head pat');
    assert.ok(c.log.some((l) => l.startsWith('say:Okay, back to normal')));
    assert.ok(c.destroyed);
  });

  await test('two pats too far apart do not exit', async () => {
    const { t, client } = make();
    t.start(); await sleep(60);
    const c = client();
    pat(c, true); pat(c, false); await sleep(400); pat(c, true); pat(c, false);
    await sleep(20);
    assert.equal(t.state, 'on');
  });

  await test('swipe down → off', async () => {
    const { t, client } = make();
    t.start(); await sleep(60);
    client().emit('gesture', { isSwipe: true, direction: 'Down' }); await sleep(40);
    assert.equal(t.state, 'off'); assert.equal(t.reason, 'swipe down');
  });

  await test('voice "claude off" → off without calling Claude', async () => {
    const { t, calls, client } = make({}, ['Claude off']);
    t.start(); await sleep(60);
    client().emit('hotword'); await sleep(60);
    assert.equal(calls.length, 0);
    assert.equal(t.state, 'off'); assert.equal(t.reason, 'voice');
  });

  await test('OFF_RE phrases', () => {
    for (const p of ['claude off', 'claude mode off', 'turn claude off', 'stop claude', 'exit claude mode', 'normal mode', 'go back to normal', 'okay claude off.'])
      assert.ok(OFF_RE.test(p), p);
    for (const p of ['what is claude', 'turn off the lights', 'is normal mode good', 'stop'])
      assert.ok(!OFF_RE.test(p), p);
  });

  await test('stop during a turn waits for the reply to finish', async () => {
    const { t, client } = make({}, ['long question']);
    t.start(); await sleep(60);
    const c = client(); c.sayMs = 60;
    c.emit('hotword'); await sleep(15);
    t.stop('http');
    assert.equal(t.state, 'on', 'still on mid-turn');
    await sleep(250);
    assert.equal(t.state, 'off');
    const iReply = c.log.indexOf('say:R:long question');
    const iBye = c.log.findIndex((l) => l.startsWith('say:Okay, back to normal'));
    assert.ok(iReply >= 0 && iBye > iReply, 'reply then goodbye');
  });

  await test('stop while starting cancels cleanly', async () => {
    const { t } = make({ startDelayMs: 200 });
    t.start(); t.stop('changed mind');
    assert.equal(t.state, 'off');
    await sleep(250);
    assert.equal(t.state, 'off');
  });

  await test('idle timeout → off with idle goodbye', async () => {
    const { t, client } = make({ idleMinutes: 0.002 });   // 120 ms
    t.start(); await sleep(250);
    assert.equal(t.state, 'off'); assert.equal(t.reason, 'idle timeout');
    assert.ok(client().log.some((l) => l.includes('quiet for a while')));
  });

  await test('connect timeout → off with error reason', async () => {
    const t = new Takeover({
      converse: async () => ({}), log: () => {}, version: 'x',
      createClient: () => { const c = new FakeClient(); c.connect = () => Promise.resolve(); return c; },
    }, { startDelayMs: 5, connectTimeoutMs: 50, idleMinutes: 0 });
    t.start(); await sleep(120);
    assert.equal(t.state, 'off'); assert.match(t.reason, /connect timeout/);
  });

  await test('reconnect while on re-arms wakeword without re-greeting', async () => {
    const { t, client } = make();
    t.start(); await sleep(60);
    const c = client(); c.log.length = 0;
    c.emit('disconnect'); c.emit('ready'); await sleep(20);
    assert.deepEqual(c.log, ['watch']);
    assert.equal(t.state, 'on');
  });

  await test('ROM close code 4000 (robot head-touch exit) → off, no reconnect', async () => {
    const { t, client } = make();
    t.start(); await sleep(60);
    const c = client();
    assert.ok(c._conn.ws._claudeoverClose, 'close hook attached');
    c._conn.ws.emit('close', 4000, Buffer.from('HeadTouchExit'));
    await sleep(10);
    assert.equal(t.state, 'off'); assert.match(t.reason, /head touch exit/);
    assert.ok(c.destroyed, 'client destroyed so rom-control cannot auto-reconnect');
  });

  await test('ROM close code 1006 (network drop) → stays on for auto-reconnect', async () => {
    const { t, client } = make();
    t.start(); await sleep(60);
    client()._conn.ws.emit('close', 1006, '');
    await sleep(10);
    assert.equal(t.state, 'on');
  });

  await test('debug mode logs raw ROM events + head touches', async () => {
    const logs = [];
    let client;
    const t = new Takeover({
      converse: async () => ({ reply: 'x' }), version: 'x',
      log: (lvl, msg, extra) => logs.push([msg, extra]),
      createClient: () => (client = new FakeClient()),
    }, { startDelayMs: 5, idleMinutes: 0, debug: true });
    t.start(); await sleep(60);
    client._conn.emit('event', 'tx1', { Event: 'onHeadTouch', Pads: [true, false, false, false, false, false] });
    client.emit('headTouch', { activePads: ['frontLeft'], pads: [true] });
    assert.ok(logs.some(([m, e]) => m === 'rom event' && e.event === 'onHeadTouch'));
    assert.ok(logs.some(([m]) => m === 'headTouch'));
    assert.ok(logs.some(([m]) => m === 'subscribe headtouch (re)'));
    t.shutdown();
  });

  await test('shutdown releases Jibo immediately', async () => {
    const { t, client } = make();
    t.start(); await sleep(60);
    t.shutdown();
    assert.equal(t.state, 'off'); assert.ok(client().destroyed);
  });

  for (const r of results) console.log(r.join('  '));
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} takeover tests passed`);
  process.exit(failed ? 1 : 0);
})();
