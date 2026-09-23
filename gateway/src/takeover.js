'use strict';
/**
 * takeover.js - "ClaudeOver" mode: the gateway holds a ROM session on Jibo so
 * every "Hey Jibo ..." goes to Claude. Switched on/off over HTTP (menu tile,
 * curl), off by double head pat, swipe down, voice ("claude off"), idle timeout.
 *
 * Ported from jibo_claude.js v0.4.0 (proven loop). Hard-won rules kept:
 *   - transcript is result.content (not .speech)
 *   - stop the wakeword watcher before listening, restart only AFTER speaking
 *   - pass both time and noSpeechTime to awaitSpeech
 *
 * States: off -> starting -> on -> stopping -> off   (error -> off on next start)
 */

const { EventEmitter } = require('node:events');
const { homeText } = require('./screen');

// Voice exit. Jibo's local ASR doesn't know "Claude": it hears cloud / clawed /
// clod / claw... and "off" often comes back as "of". Match on a normalised
// utterance (lowercase, no punctuation, no leading "hey jibo"), short phrases only.
const CL = '(?:claude|claudes|claud|clawed|clawd|claw|claws|cloud|clouds|clod|clods|clause|klaud|klod|claudia)';
const OFF_RE = new RegExp('^(?:(?:ok|okay|hey|hi|please|now|so)\\s+)*(?:' + [
  '(?:(?:turn|switch|shut|put)\\s+)?' + CL + '\\s*(?:mode\\s+)?(?:off|of)(?:\\s+(?:mode|now))?',
  '(?:turn|switch|shut)\\s+off\\s+(?:the\\s+)?' + CL + '(?:\\s+mode)?',
  '(?:stop|exit|end|quit|leave|close|cancel|disable)\\s+(?:the\\s+)?' + CL + '(?:\\s+mode)?',
  '(?:goodbye|bye)\\s+' + CL,
  '(?:go\\s+)?back\\s+to\\s+(?:normal|regular)(?:\\s+(?:jibo|mode))?',
  '(?:normal|regular)\\s+(?:mode|jibo)',
].join('|') + ')(?:\\s+please)?$');

/** Lowercase, strip punctuation, drop a leading "hey jibo" the ASR may include. */
function normalise (text) {
  return String(text || '').toLowerCase()
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/^(?:hey\s+)?jibo\s+/, '');
}
function isOffCommand (text) { return OFF_RE.test(normalise(text)); }

// ROM websocket close codes (@jibo/command-protocol DisconnectCode)
const CLOSE = { HeadTouchExit: 4000, RobotError: 4001, NewConnection: 4002, Inactivity: 4003 };

const DEFAULTS = {
  jiboHost: '192.168.20.40',
  listenMs: 15000,
  startDelayMs: 2500,       // let the menu skill exit before ROM grabs the foreground
  idleMinutes: 30,          // auto-off after this long without a wakeword
  connectTimeoutMs: 45000,  // give up if ROM never becomes ready
  doublePatMs: 1500,        // two separate pats within this window = off
  touchGapMs: 280,          // events closer than this belong to the same touch (a hold streams every 50-210 ms)
  holdMs: 2000,             // a continuous touch this long = off
  screen: 'image',          // 'image' = gateway's /screen.svg; 'text' = one short line; 'eye' = normal eye
  screenUrl: '',            // where Jibo fetches the image screen (set by server.js)
  sessionId: 'takeover',
  debug: false,             // log every raw ROM event + subscription result (TAKEOVER_DEBUG=1)
  logText: false,           // include heard text in 'takeover heard' log lines (LOG_TRANSCRIPTS=1)
};

function nowIso () { return new Date().toISOString(); }
function safe (v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); } }

class Takeover extends EventEmitter {
  /**
   * @param {object} deps
   *   converse(sessionId, text, opts) -> Promise<{reply, end, route, error?}>
   *   createClient(opts) -> rom-control Client (injectable for tests)
   *   log(level, msg, extra)
   *   version
   * @param {object} cfg  overrides for DEFAULTS
   */
  constructor (deps, cfg) {
    super();
    this.deps = deps;
    this.cfg = Object.assign({}, DEFAULTS, cfg || {});
    this.state = 'off';
    this.since = nowIso();
    this.reason = 'boot';
    this.turns = 0;
    this.client = null;
    this._busy = false;
    this._timers = { start: null, idle: null, connect: null };
    this._lastTouchAt = 0;
    this._touchStartAt = 0;
    this._touchStarts = [];
    this._stopRequested = null;
  }

  status () {
    return {
      state: this.state, since: this.since, reason: this.reason, turns: this.turns,
      jiboHost: this.cfg.jiboHost, idleMinutes: this.cfg.idleMinutes,
    };
  }

  _set (state, reason) {
    this.state = state;
    this.since = nowIso();
    if (reason) this.reason = reason;
    this.deps.log('info', 'takeover ' + state, { reason: this.reason });
    this.emit('state', this.status());
  }

  _clear (name) { if (this._timers[name]) { clearTimeout(this._timers[name]); this._timers[name] = null; } }

  _resetIdle () {
    this._clear('idle');
    if (this.cfg.idleMinutes > 0) {
      this._timers.idle = setTimeout(() => this.stop('idle timeout'), this.cfg.idleMinutes * 60000);
    }
  }

  /** Switch on. Idempotent while starting/on. */
  start (reason) {
    if (this.state === 'starting' || this.state === 'on') return this.status();
    if (this.state === 'stopping') return this.status();
    this._set('starting', reason || 'request');
    this._clear('start');
    this._timers.start = setTimeout(() => this._connect(), this.cfg.startDelayMs);
    return this.status();
  }

  _connect () {
    this._timers.start = null;
    if (this.state !== 'starting') return;
    let client;
    try {
      client = this.deps.createClient({ host: this.cfg.jiboHost, autoReconnect: true });
    } catch (e) {
      this.deps.log('error', 'takeover client create failed', { err: e.message });
      return this._set('off', 'error: ' + e.message);
    }
    this.client = client;
    this._wire(client);
    this._timers.connect = setTimeout(() => {
      if (this.state === 'starting') { this.deps.log('error', 'takeover connect timeout'); this._teardown('error: connect timeout'); }
    }, this.cfg.connectTimeoutMs);
    try {
      const p = client.connect();
      if (p && typeof p.catch === 'function') {
        p.catch((e) => this.deps.log('error', 'takeover connect error', { err: e && e.message }));
      }
    } catch (e) {
      this.deps.log('error', 'takeover connect threw', { err: e.message });
    }
  }

  _wire (client) {
    client.on('ready', () => this._onReady());
    client.on('hotword', () => this._onHotword());
    client.on('headTouch', (ev) => this._onHeadTouch(ev));
    client.on('gesture', (ev) => {
      if (this.cfg.debug) this.deps.log('info', 'gesture', { type: ev && ev.type, direction: ev && ev.direction });
      if (ev && ev.isSwipe && String(ev.direction).toLowerCase() === 'down') this.stop('swipe down');
    });
    client.on('disconnect', () => {
      if (this.state === 'on') this.deps.log('info', 'takeover: ROM disconnected, auto-reconnecting');
    });
    client.on('error', (err) => this.deps.log('error', 'takeover rom error', { err: err && err.message }));
  }

  async _onReady () {
    const c = this.client;
    if (!c) return;
    if (this.state === 'on') {            // reconnect after a drop: re-hook + resume listening
      this._hookConnection();
      try { c.audio.watchWakeword(); } catch (e) { /* no-op */ }
      return;
    }
    if (this.state !== 'starting') return;
    this._clear('connect');
    this._set('on');
    this.turns = 0;
    this._resetIdle();
    this._hookConnection();
    this._showHome();
    // Greet BEFORE arming the wakeword: the greeting contains "hey Jibo" and
    // he would otherwise wake on his own voice (seen on Jibo 2026-09-23).
    this._busy = true;
    await this._say('Claude mode is on. Say hey Jibo, then ask me anything. Pat my head twice, or swipe down, to go back to normal.');
    this._busy = false;
    if (this.state !== 'on') return;
    if (this._stopRequested) { const r = this._stopRequested; this._stopRequested = null; return this._doStop(r); }
    try { c.audio.watchWakeword(); } catch (e) { this.deps.log('error', 'watchWakeword failed', { err: e.message }); }
  }

  /**
   * Things rom-control doesn't do for us (v0.2.2):
   *  - watch the websocket close code: 4000 = the robot's remote skill was
   *    exited by head touch -> treat as "user wants out", don't auto-reconnect
   *  - optional raw event logging for diagnosis
   */
  _hookConnection () {
    const conn = this.client && this.client._conn;
    if (!conn) return;
    const log = this.deps.log;
    const debug = this.cfg.debug;

    if (debug && !conn._claudeoverDebug) {
      conn._claudeoverDebug = true;
      conn.on('event', (txId, body) => {
        let b = '';
        try { b = JSON.stringify(body).slice(0, 400); } catch (e) { b = '[unserialisable]'; }
        log('info', 'rom event', { event: body && body.Event, body: b });
      });
    }

    const ws = conn.ws;
    if (ws && typeof ws.on === 'function' && !ws._claudeoverClose) {
      ws._claudeoverClose = true;
      ws.on('close', (code, reason) => this._onRomClose(code, reason ? String(reason) : ''));
    }

    const sub = (label, fn) => {
      try {
        const p = fn();
        if (p && typeof p.then === 'function') {
          p.then((r) => { if (debug) log('info', 'subscribe ' + label, { resp: safe(r) }); },
                 (e) => log('error', 'subscribe ' + label + ' failed', { err: e && e.message }));
        }
      } catch (e) { log('error', 'subscribe ' + label + ' threw', { err: e.message }); }
    };
    // (swipes already arrive with rom-control's default subscription - verified on Jibo 2026-09-23)
    if (debug && typeof conn.subscribeHeadTouch === 'function') {
      sub('headtouch (re)', () => conn.subscribeHeadTouch());
    }
  }

  _onRomClose (code, reason) {
    this.deps.log('info', 'rom socket closed', { code, reason, state: this.state });
    if (this.state !== 'on' && this.state !== 'starting') return;
    if (code === CLOSE.HeadTouchExit) return this._teardown('head touch exit (robot)');
    if (code === CLOSE.NewConnection) return this._teardown('another ROM client connected');
    if (code === CLOSE.RobotError) return this._teardown('robot error');
    // other codes: let rom-control auto-reconnect; _onReady re-arms the wakeword
  }

  _showHome () {
    const c = this.client;
    if (!c || !c.display) return;
    try {
      const mode = this.cfg.screen === 'image' && !this.cfg.screenUrl ? 'text' : this.cfg.screen;
      if (mode === 'image' && typeof c.display.showImage === 'function') {
        c.display.showImage(this.cfg.screenUrl + '?v=' + encodeURIComponent(this.deps.version));
      } else if (mode === 'image' || mode === 'text') {
        c.display.showText(homeText(this.deps.version));
      } else {
        c.display.showEye();
      }
    } catch (e) { /* display is best-effort */ }
  }

  async _say (text) {
    const c = this.client;
    if (!c) return;
    try { await c.behavior.say(text); } catch (e) { this.deps.log('error', 'say failed', { err: e && e.message }); }
  }

  /**
   * Jibo sends onHeadTouch ONLY while a pad is touched: one event for a pat,
   * a stream every ~50-210 ms for a hold, and never a "released" event
   * (verified on Jibo 2026-09-23). So touches are separated by time gaps:
   *   gap > touchGapMs          -> a new touch starts
   *   2 starts within doublePat -> double pat  -> off
   *   one touch >= holdMs       -> head hold   -> off
   */
  _onHeadTouch (ev) {
    if (this.cfg.debug) this.deps.log('info', 'headTouch', { active: ev && ev.activePads, pads: ev && ev.pads });
    const active = !!(ev && ev.activePads && ev.activePads.length);
    if (!active || this.state !== 'on') return;
    const now = Date.now();
    const gap = now - this._lastTouchAt;
    this._lastTouchAt = now;
    if (gap > this.cfg.touchGapMs) {                  // new touch
      this._touchStartAt = now;
      this._touchStarts = this._touchStarts.filter((t) => now - t <= this.cfg.doublePatMs);
      this._touchStarts.push(now);
      if (this._touchStarts.length >= 2) {
        this._touchStarts = [];
        this.stop('double head pat');
      }
    } else if (now - this._touchStartAt >= this.cfg.holdMs) {   // same touch, held long enough
      this._touchStarts = [];
      this._touchStartAt = now + 1e9;                  // fire once per hold
      this.stop('head hold');
    }
  }

  async _onHotword () {
    if (this.state !== 'on' || this._busy) return;
    const c = this.client;
    this._busy = true;
    this._resetIdle();
    try {
      try { c.audio.stopWakeword(); } catch (e) { /* no-op */ }
      let heard;
      try {
        heard = await c.audio.awaitSpeech({ mode: 'local', time: this.cfg.listenMs, noSpeechTime: this.cfg.listenMs });
      } catch (e) {
        if (e && e.code === 'SPEECH_TIMEOUT') return;
        throw e;
      }
      const text = String((heard && (heard.content || heard.speech || heard.text)) || '').trim();
      if (!text) { await this._say('Sorry, I did not catch that.'); return; }
      if (this._stopRequested) return;

      const off = isOffCommand(text);
      // Transcript text only with TAKEOVER_DEBUG or LOG_TRANSCRIPTS; otherwise just its shape.
      this.deps.log('info', 'takeover heard', Object.assign({ words: normalise(text).split(' ').length, off: off },
        (this.cfg.debug || this.cfg.logText) ? { text: text } : {}));
      if (off) { this._busy = false; return this.stop('voice'); }

      const out = await this.deps.converse(this.cfg.sessionId, text, { via: 'takeover' });
      this.turns += 1;
      if (this._stopRequested) return;
      // Safety net: Claude recognised an exit request the regex missed (see server.js EXIT_MARK).
      if (out && out.exit) { this._busy = false; return this.stop('voice (claude)'); }
      await this._say(out.reply);
    } catch (e) {
      this.deps.log('error', 'takeover turn failed', { err: e && e.message });
      await this._say('Something went wrong in my head. Try again?');
    } finally {
      this._busy = false;
      if (this.state === 'on' && !this._stopRequested) {
        try { c.audio.watchWakeword(); } catch (e) { /* session gone */ }
      }
      if (this._stopRequested) { const r = this._stopRequested; this._stopRequested = null; this._doStop(r); }
    }
  }

  /** Switch off. If a turn is in flight, finish it first (no half-spoken replies). */
  stop (reason) {
    reason = reason || 'request';
    if (this.state === 'starting') { this._teardown(reason); return this.status(); }
    if (this.state !== 'on') return this.status();
    if (this._busy) { this._stopRequested = reason; this.deps.log('info', 'takeover stop queued', { reason }); return this.status(); }
    this._doStop(reason);
    return this.status();
  }

  async _doStop (reason) {
    if (this.state !== 'on') return;
    this._set('stopping', reason);
    this._clear('idle');
    try { this.client.audio.stopWakeword(); } catch (e) { /* no-op */ }
    const bye = reason === 'idle timeout'
      ? 'I have been quiet for a while, so I am going back to normal.'
      : 'Okay, back to normal Jibo.';
    await Promise.race([this._say(bye), new Promise((r) => setTimeout(r, 6000))]);
    try { this.client.display && this.client.display.showEye(); } catch (e) { /* no-op */ }
    this._teardown(reason);
  }

  _teardown (reason) {
    ['start', 'idle', 'connect'].forEach((t) => this._clear(t));
    const c = this.client;
    this.client = null;
    this._busy = false;
    this._stopRequested = null;
    this._touchStarts = [];
    this._lastTouchAt = 0;
    this._touchStartAt = 0;
    if (c) { try { c.destroy ? c.destroy() : c.disconnect(); } catch (e) { /* no-op */ } }
    this._set('off', reason);
  }

  /** For process shutdown: release Jibo quickly, no goodbye. */
  shutdown () { if (this.state !== 'off') this._teardown('gateway shutdown'); }
}

module.exports = { Takeover, OFF_RE, isOffCommand, normalise, DEFAULTS, CLOSE };
