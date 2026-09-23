'use strict';
/**
 * harness.js v0.2.0 - ClaudeOver skill lifecycle against stubbed jibo /
 * be-framework / DOM and a fake jibo-gateway HTTP server.
 *   node test/harness.js            run all scenarios
 */
const Module = require('module');
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const SKILL = path.join(__dirname, '..', 'claude');
const CFG = path.join(SKILL, 'config.json');
const results = [];
let calls = [];
let speakMode = 'callback';

const jiboStub = {
  embodied: { speech: {
    installDelegate: () => calls.push('installDelegate'),
    speak: (text, cb) => {
      calls.push('speak:' + text);
      if (speakMode === 'promise') return Promise.resolve();
      if (speakMode === 'throw') throw new Error('boom');
      setTimeout(cb, 5);
    } } },
};
class BeSkill { constructor (a) { this.assetPack = a; } exit () { calls.push('exit'); this.close(() => calls.push('closed')); } }
const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'jibo') return jiboStub;
  if (req === '@be/be-framework') return { BeSkill };
  return origLoad.apply(this, arguments);
};
const el = () => ({ style: {}, appendChild () {}, parentNode: null });
global.document = { createElement: el, body: { appendChild (n) { n.parentNode = { removeChild () {} }; } } };

// fake gateway
let gwReq = null;
let gwMode = 'ok';
const gwServer = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    gwReq = { url: req.url, auth: req.headers.authorization, body: JSON.parse(b) };
    if (gwMode === '401') { res.writeHead(401); return res.end('{"error":"unauthorised"}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ takeover: { state: 'starting' }, reply: 'Switching to Claude mode.', esml: 'Switching to Claude mode.' }));
  });
});

function runSkill () {
  delete require.cache[require.resolve(path.join(SKILL, 'index.js'))];
  const Skill = require(path.join(SKILL, 'index.js'));
  const s = new Skill('pack');
  s.preload(() => s.open({ nlu: { intent: 'loadMenu', entities: { destination: 'claude' } } }, false, '@be/main-menu'));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function test (name, fn) {
  calls = []; gwReq = null;
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
}

(async () => {
  await new Promise((r) => gwServer.listen(0, '127.0.0.1', r));
  const port = gwServer.address().port;
  const hadCfg = fs.existsSync(CFG) ? fs.readFileSync(CFG) : null;
  const writeCfg = () => fs.writeFileSync(CFG, JSON.stringify({ gatewayHost: '127.0.0.1', gatewayPort: port, token: 'tok-0123456789abcdef' }));

  await test('gateway_client.js in skill is identical to gateway/client copy', () => {
    const a = fs.readFileSync(path.join(SKILL, 'gateway_client.js'), 'utf8');
    const b = fs.readFileSync(path.join(__dirname, '..', '..', 'gateway', 'client', 'gateway_client.js'), 'utf8');
    assert.strictEqual(a, b);
  });

  for (const m of ['callback', 'promise', 'throw']) {
    await test('happy path (speak ' + m + '): speak → POST takeover on → exit fast', async () => {
      speakMode = m; gwMode = 'ok'; writeCfg();
      runSkill(); await sleep(500);
      assert.strictEqual(gwReq.url, '/v1/takeover');
      assert.deepStrictEqual(gwReq.body, { state: 'on', reason: 'menu tile' });
      assert.strictEqual(gwReq.auth, 'Bearer tok-0123456789abcdef');
      assert.strictEqual(calls[1], 'speak:Switching to Claude mode.');
      assert.ok(calls.indexOf('exit') > 0 && calls.indexOf('closed') > 0);
      const d = JSON.parse(fs.readFileSync('/tmp/claude-skill-last.json', 'utf8'));
      assert.strictEqual(d.result.nlu.entities.destination, 'claude');
    });
  }

  await test('gateway rejects (401) → says the error, still exits', async () => {
    speakMode = 'callback'; gwMode = '401'; writeCfg();
    runSkill(); await sleep(2200);
    assert.ok(calls.some((c) => /could not reach|thinking cap/i.test(c)), calls.join(','));
    assert.ok(calls.indexOf('exit') > 0);
  });

  await test('gateway down → fallback speech, exits', async () => {
    fs.writeFileSync(CFG, JSON.stringify({ gatewayHost: '127.0.0.1', gatewayPort: 1, token: 'tok-0123456789abcdef' }));
    runSkill(); await sleep(2200);
    assert.ok(calls.some((c) => /thinking cap|could not reach/i.test(c)), calls.join(','));
    assert.ok(calls.indexOf('exit') > 0);
  });

  await test('missing config.json → setup message, no HTTP, exits', async () => {
    if (fs.existsSync(CFG)) fs.unlinkSync(CFG);
    runSkill(); await sleep(2000);
    assert.strictEqual(gwReq, null);
    assert.ok(calls.some((c) => /not set up/i.test(c)));
    assert.ok(calls.indexOf('exit') > 0);
  });

  if (hadCfg) fs.writeFileSync(CFG, hadCfg); else if (fs.existsSync(CFG)) fs.unlinkSync(CFG);
  gwServer.close();
  for (const r of results) console.log(r.join('  '));
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} skill tests passed`);
  process.exit(failed ? 1 : 0);
})();
