#!/usr/bin/env node
/**
 * smoke.js v0.2.1 - end-to-end test of jibo-gateway against a fake Anthropic API.
 * No real key or network needed.   npm test
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const gw = require('../client/gateway_client');

const ROOT = path.join(__dirname, '..');
const PKG = require('../package.json');
const TOKEN = 'test-token-0123456789abcdef';
const UP_PORT = 18766, GW_PORT = 18765;

let upstreamCalls = [];
let upstreamMode = 'ok';

// ── fake Anthropic ──────────────────────────────────────────────────────────
const upstream = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const body = JSON.parse(b || '{}');
    upstreamCalls.push({ url: req.url, headers: req.headers, body });
    if (upstreamMode === '429') {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
    }
    const last = body.messages[body.messages.length - 1].content;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_x', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn',
      content: [{ type: 'text', text: `**Echo:** ${last} 🤖 <b> & see https://x.io` }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
  });
});

function startGateway() {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: GW_PORT, HOST: '127.0.0.1', GATEWAY_TOKEN: TOKEN,
      ANTHROPIC_API_KEY: 'sk-fake', ANTHROPIC_BASE_URL: `http://127.0.0.1:${UP_PORT}`,
      RATE_PER_MIN: '1000', TAKEOVER_START_DELAY_MS: '60000', JIBO_HOST: '127.0.0.1', DATA_DIR: path.join(ROOT, 'test', '.data'), CLAUDE_TIMEOUT_MS: '3000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return new Promise((resolve, reject) => {
    const t = setInterval(() => { if (out.includes('listening')) { clearInterval(t); resolve({ child, log: () => out }); } }, 50);
    setTimeout(() => { clearInterval(t); reject(new Error('gateway did not start:\n' + out)); }, 5000);
  });
}

function raw(method, p, { token = TOKEN, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: GW_PORT, path: p, method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' } }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s) }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const client = gw.create({ host: '127.0.0.1', port: GW_PORT, token: TOKEN });
const ask = (session, text) => new Promise((r) => client.ask(session, text, (err, res) => r({ err, res })));

const results = [];
async function t(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
}

(async () => {
  await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));
  const g = await startGateway();

  await t('compose image tag matches package version', () => {
    const compose = fs.readFileSync(path.join(ROOT, 'compose.yaml'), 'utf8');
    assert.match(compose, new RegExp(`image: jibo-gateway:${PKG.version.replace(/\./g, '\\.')}\\b`));
  });
  await t('healthz + version, no auth', async () => {
    const h = await raw('GET', '/healthz', { token: null });
    assert.equal(h.status, 200); assert.equal(h.json.version, PKG.version);
    const v = await raw('GET', '/version', { token: null });
    assert.equal(v.json.name, 'jibo-gateway'); assert.equal(v.json.model, 'claude-sonnet-5');
  });
  await t('401 without / with wrong token', async () => {
    assert.equal((await raw('POST', '/v1/ask', { token: null, body: { text: 'hi' } })).status, 401);
    assert.equal((await raw('POST', '/v1/ask', { token: 'nope', body: { text: 'hi' } })).status, 401);
  });
  await t('ask → claude, prefix stripped, speech-shaped + ESML escaped', async () => {
    upstreamCalls = [];
    const { err, res } = await ask('s1', 'Ask Claude how far is Melbourne from London');
    assert.equal(err, null);
    assert.equal(res.route, 'claude');
    assert.equal(upstreamCalls[0].body.messages[0].content, 'how far is Melbourne from London');
    assert.equal(upstreamCalls[0].headers['x-api-key'], 'sk-fake');
    assert.equal(res.reply, 'Echo: how far is Melbourne from London <b> & see');
    assert.equal(res.esml, 'Echo: how far is Melbourne from London &lt;b&gt; &amp; see');
    assert.equal(res.end, false);
  });
  await t('multi-turn history kept per session', async () => {
    upstreamCalls = [];
    await ask('s1', 'and from Tokyo?');
    const msgs = upstreamCalls[0].body.messages;
    assert.equal(msgs.length, 3);
    assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user']);
  });
  await t('sessions isolated', async () => {
    upstreamCalls = [];
    await ask('s2', 'hello');
    assert.equal(upstreamCalls[0].body.messages.length, 1);
  });
  await t('local time handler, no upstream call', async () => {
    upstreamCalls = [];
    const { res } = await ask('s3', "what's the time");
    assert.equal(res.route, 'local'); assert.match(res.reply, /^It's \d{1,2}:\d{2}/);
    assert.equal(upstreamCalls.length, 0);
  });
  await t('"time in London" goes to Claude, not local', async () => {
    const { res } = await ask('s3', 'what time is it in London');
    assert.equal(res.route, 'claude');
  });
  await t('bare "ask claude" prompts for a question', async () => {
    const { res } = await ask('s4', 'ask claude');
    assert.equal(res.route, 'prompt'); assert.equal(res.end, false);
  });
  await t('end phrases close session', async () => {
    for (const p of ['thanks', 'Thank you Claude.', "that's all", 'okay bye', 'stop']) {
      const { res } = await ask('s1', p);
      assert.equal(res.end, true, p); assert.equal(res.route, 'end', p);
    }
    upstreamCalls = [];
    await ask('s1', 'new question');
    assert.equal(upstreamCalls[0].body.messages.length, 1, 'history cleared after end');
  });
  await t('reset endpoint', async () => {
    await ask('s5', 'one');
    const r = await raw('POST', '/v1/reset', { body: { session: 's5' } });
    assert.equal(r.json.existed, true);
  });
  await t('upstream 429 → 503 with speakable reply', async () => {
    upstreamMode = '429';
    const { err, res } = await ask('s6', 'hello');
    upstreamMode = 'ok';
    assert.match(err.message, /503/); assert.match(res.esml, /breather/);
  });
  await t('failed turn does not corrupt history', async () => {
    upstreamCalls = [];
    await ask('s6', 'retry');
    assert.equal(upstreamCalls[0].body.messages.length, 1);
  });
  await t('bad input rejected', async () => {
    assert.equal((await raw('POST', '/v1/ask', { body: { session: 'bad id!', text: 'x' } })).status, 400);
    assert.equal((await raw('POST', '/v1/ask', { body: { session: 's' } })).status, 400);
    assert.equal((await raw('POST', '/v1/ask', { body: '{nope' })).status, 400);
  });
  await t('client falls back when gateway unreachable', async () => {
    const dead = gw.create({ host: '127.0.0.1', port: 1, token: TOKEN });
    const r = await new Promise((ok) => dead.ask('x', 'hi', (err, res) => ok({ err, res })));
    assert.ok(r.err); assert.match(r.res.esml, /thinking cap/);
  });
  await t('takeover: GET status off; 401 without token', async () => {
    assert.equal((await raw('GET', '/v1/takeover', { token: null })).status, 401);
    const r = await raw('GET', '/v1/takeover');
    assert.equal(r.status, 200); assert.equal(r.json.takeover.state, 'off');
  });
  await t('takeover: on → starting (speakable reply), repeat → already on', async () => {
    const r = await raw('POST', '/v1/takeover', { body: { state: 'on' } });
    assert.equal(r.json.takeover.state, 'starting'); assert.equal(r.json.reply, 'Switching to Claude mode.');
    assert.equal(r.json.esml, 'Switching to Claude mode.');
    const r2 = await raw('POST', '/v1/takeover', { body: { state: 'on' } });
    assert.equal(r2.json.reply, 'Claude mode is already on.');
    assert.equal((await raw('GET', '/version', { token: null })).json.takeover, 'starting');
  });
  await t('takeover: toggle → off; off again → already off', async () => {
    const r = await raw('POST', '/v1/takeover', { body: { state: 'toggle' } });
    assert.equal(r.json.takeover.state, 'off');
    const r2 = await raw('POST', '/v1/takeover', { body: { state: 'off' } });
    assert.equal(r2.json.reply, 'Claude mode is already off.');
  });
  await t('takeover: bad state → 400', async () => {
    assert.equal((await raw('POST', '/v1/takeover', { body: { state: 'sideways' } })).status, 400);
  });
  await t('transcripts not logged by default', () => {
    assert.ok(!g.log().includes('Melbourne from London'));
  });

  await t('GET /screen.svg: SVG with version, no token needed', async () => {
    const r = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: GW_PORT, path: '/screen.svg?v=x' }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: b }));
      }).on('error', reject);
    });
    assert.equal(r.status, 200); assert.equal(r.type, 'image/svg+xml');
    assert.match(r.body, /^<\?xml[\s\S]*<svg[^>]+width="1280" height="720"/);
    assert.ok(r.body.includes('v' + PKG.version) && r.body.includes('ClaudeOver'));
  });

  await t('/v1/ask: no takeover exit prompt, "claude," prefix still stripped', async () => {
    upstreamMode = 'ok'; upstreamCalls = [];
    const { res } = await ask('pfx', 'Claude, what is two plus two');
    const up = upstreamCalls[upstreamCalls.length - 1].body;
    const sys = typeof up.system === 'string' ? up.system : JSON.stringify(up.system);
    assert.ok(!sys.includes('[[EXIT]]'), 'exit marker leaked into /v1/ask prompt');
    assert.equal(up.messages[up.messages.length - 1].content, 'what is two plus two');
    assert.equal(res.exit, false);
  });

  g.child.kill('SIGTERM');
  upstream.close();
  fs.rmSync(path.join(ROOT, 'test', '.data'), { recursive: true, force: true });

  for (const r of results) console.log(r.join('  '));
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed (jibo-gateway v${PKG.version})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
