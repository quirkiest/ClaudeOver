#!/usr/bin/env node
/**
 * jibo-gateway - LAN service between an on-robot Jibo skill and Claude.
 *
 * The robot speaks plain HTTP on the LAN; only this service holds the API key
 * and talks TLS to api.anthropic.com. Keeps per-session conversation history,
 * strips the "ask claude" prefix, answers trivial local intents, and returns
 * replies already shaped for speech (plain text + ESML-escaped copy).
 *
 * Routes:
 *   GET  /healthz          no auth   liveness
 *   GET  /version          no auth   name, version, model
 *   POST /v1/ask           bearer    { session?, text, reset? } -> { reply, esml, end, ... }
 *   POST /v1/reset         bearer    { session }                -> { ok }
 *   GET  /v1/takeover      bearer    ClaudeOver state
 *   POST /v1/takeover      bearer    { state: on|off|toggle }   -> { takeover, reply, esml }
 *
 * Version source of truth: package.json.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { Takeover } = require('./takeover');

const { name: NAME, version: VERSION } = require('../package.json');

// ── Config ──────────────────────────────────────────────────────────────────

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const CFG = {
  port:          Number(env('PORT', 8765)),
  host:          env('HOST', '0.0.0.0'),
  token:         env('GATEWAY_TOKEN', ''),
  allowIps:      env('ALLOW_IPS', '').split(',').map((s) => s.trim()).filter(Boolean),
  model:         env('CLAUDE_MODEL', 'claude-sonnet-5'),
  maxTokens:     Number(env('MAX_TOKENS', 300)),
  maxTurns:      Number(env('MAX_TURNS', 12)),          // messages kept per session
  sessionTtlS:   Number(env('SESSION_TTL_S', 300)),     // idle expiry
  ratePerMin:    Number(env('RATE_PER_MIN', 20)),       // per client IP
  timeoutMs:     Number(env('CLAUDE_TIMEOUT_MS', 20000)),
  tz:            env('JIBO_TZ', env('TZ', 'Australia/Melbourne')),
  place:         env('JIBO_PLACE', 'Melbourne, Australia'),
  localHandlers: env('LOCAL_HANDLERS', '1') === '1',
  persist:       env('PERSIST', '0') === '1',
  dataDir:       env('DATA_DIR', '/data'),
  logText:       env('LOG_TRANSCRIPTS', '0') === '1',
  // ClaudeOver (takeover) mode
  takeover:      env('TAKEOVER_ENABLED', '1') === '1',
  jiboHost:      env('JIBO_HOST', '192.168.20.40'),
  listenMs:      Number(env('JIBO_LISTEN_MS', 15000)),
  toIdleMin:     Number(env('TAKEOVER_IDLE_MIN', 30)),
  toStartDelay:  Number(env('TAKEOVER_START_DELAY_MS', 2500)),
  toScreen:      env('TAKEOVER_SCREEN', 'text'),
  toDebug:       env('TAKEOVER_DEBUG', '0') === '1',
};

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set - refusing to start.');
  process.exit(1);
}
if (!CFG.token || CFG.token.length < 16) {
  console.error('GATEWAY_TOKEN missing or shorter than 16 chars - refusing to start.');
  console.error('generate one: openssl rand -hex 24');
  process.exit(1);
}

const claude = new Anthropic({ timeout: CFG.timeoutMs, maxRetries: 1 });

const MAX_BODY = 16 * 1024;
const MAX_TEXT = 1000;
const MSG_ERROR = 'Something went wrong in my head. Try again?';
const MSG_BUSY  = 'I need a little breather. Ask me again in a minute.';

// ── Logging ─────────────────────────────────────────────────────────────────

function log(level, msg, extra) {
  const line = { t: new Date().toISOString(), level, msg, ...(extra || {}) };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}

// ── Time helpers ────────────────────────────────────────────────────────────

function nowParts() {
  const fmt = (opts) => new Intl.DateTimeFormat('en-AU', { timeZone: CFG.tz, ...opts }).format(new Date());
  return {
    time: fmt({ hour: 'numeric', minute: '2-digit', hour12: true }),
    date: fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
  };
}

// ── Speech shaping ──────────────────────────────────────────────────────────

/** Remove things that don't speak well: markdown, emoji, bullets, URLs. */
function toSpeakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')            // [label](url) -> label
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')                  // headings
    .replace(/^\s*[-*•]\s+/gm, '')                       // bullets
    .replace(/(\*\*|__|\*|_)(.+?)\1/g, '$2')             // bold / italic
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** say() takes ESML (XML-ish): escape so model output cannot break it. */
function toESML(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Routing ─────────────────────────────────────────────────────────────────

// Local answers are for *here and now* only - "what time is it in London" goes to Claude.
const ELSEWHERE = /\b(in|at|for)\s+(?!the\b)\w+/;
const LOCAL_HANDLERS = [
  { name: 'time', test: (u) => !ELSEWHERE.test(u) && (/\b(what|whats|what's)\b.*\btime\b/.test(u) || /^time$/.test(u)),
    run: () => `It's ${nowParts().time}.` },
  { name: 'date', test: (u) => !ELSEWHERE.test(u) && /\b(what|whats|what's)\b.*\b(date|day)\b/.test(u),
    run: () => `It's ${nowParts().date}.` },
];

const END_RE = /^(?:(?:ok(?:ay)?|alright)[,\s]+)?(?:thanks?(?: you)?(?: claude| jibo)?|thank you|that'?s (?:all|it)|stop|goodbye|bye|never ?mind|no thanks?|nothing)[.!\s]*$/;

/**
 * Strip "ask claude" / "hey claude" / "claude," prefixes. The skill's launch
 * rule may or may not have removed them already; be tolerant either way.
 */
function stripPrefix(u) {
  const m = u.match(/^(?:hey\s+jibo[,\s]+)?(?:(?:can you\s+|please\s+)?ask\s+claude|hey\s+claude|claude)[,:]?\s*(.*)$/i);
  return m ? m[1].trim() : u;
}

function route(raw) {
  const text = stripPrefix(raw.trim());
  const u = text.toLowerCase().replace(/[?.!]+$/, '').trim();

  if (!u) return { target: 'prompt' };                       // "ask claude" alone
  if (END_RE.test(u)) return { target: 'end' };
  if (CFG.localHandlers) {
    for (const h of LOCAL_HANDLERS) if (h.test(u)) return { target: 'local', handler: h.name, reply: h.run() };
  }
  return { target: 'claude', text };
}

function systemPrompt() {
  const { time, date } = nowParts();
  return `You are Jibo, a friendly social robot with a physical body, speaking aloud.
Right now it is ${time} on ${date}, and you are in ${CFG.place}.
Keep every reply to one or two short sentences unless the person clearly asks for
more - your words go through a small speaker, so long answers are tiring. Be warm,
curious and concise. Never use markdown, lists, URLs or emoji; only plain spoken
language. Spell out symbols and abbreviations the way you would say them. If you
genuinely cannot know something (live news, weather right now), say so briefly.`;
}

// ── Sessions ────────────────────────────────────────────────────────────────

/** @type {Map<string, {history: {role:string, content:string}[], last: number}>} */
const sessions = new Map();
const SESSION_FILE = path.join(CFG.dataDir, 'sessions.json');

function getSession(id) {
  let s = sessions.get(id);
  if (!s || Date.now() - s.last > CFG.sessionTtlS * 1000) {
    s = { history: [], last: Date.now() };
    sessions.set(id, s);
  }
  s.last = Date.now();
  return s;
}

function remember(s, role, content) {
  s.history.push({ role, content });
  while (s.history.length > CFG.maxTurns) s.history.shift();
  // API requires the first message to be from the user.
  while (s.history.length && s.history[0].role !== 'user') s.history.shift();
}

function sweepSessions() {
  const cutoff = Date.now() - CFG.sessionTtlS * 1000;
  for (const [id, s] of sessions) if (s.last < cutoff) sessions.delete(id);
}

function loadSessions() {
  if (!CFG.persist) return;
  try {
    const obj = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    for (const [id, s] of Object.entries(obj)) sessions.set(id, s);
    sweepSessions();
    log('info', 'sessions loaded', { count: sessions.size });
  } catch (e) {
    if (e.code !== 'ENOENT') log('error', 'session load failed', { err: e.message });
  }
}

function saveSessions() {
  if (!CFG.persist) return;
  try {
    fs.mkdirSync(CFG.dataDir, { recursive: true });
    const tmp = SESSION_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions)));
    fs.renameSync(tmp, SESSION_FILE);
  } catch (e) {
    log('error', 'session save failed', { err: e.message });
  }
}

// ── Claude ──────────────────────────────────────────────────────────────────

async function askClaude(s, text) {
  remember(s, 'user', text);
  try {
    const res = await claude.messages.create({
      model: CFG.model,
      max_tokens: CFG.maxTokens,
      system: systemPrompt(),
      messages: s.history,
    });
    const reply = toSpeakable(res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' '));
    remember(s, 'assistant', reply || '...');
    return { reply, usage: res.usage };
  } catch (e) {
    s.history.pop(); // drop the unanswered user turn so history stays alternating
    throw e;
  }
}

// ── Auth / rate limit ───────────────────────────────────────────────────────

const tokenBuf = Buffer.from(CFG.token);
function authorised(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const given = Buffer.from(m[1].trim());
  return given.length === tokenBuf.length && crypto.timingSafeEqual(given, tokenBuf);
}

function clientIp(req) {
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

const buckets = new Map(); // ip -> {tokens, ts}
function rateOk(ip) {
  const now = Date.now();
  const b = buckets.get(ip) || { tokens: CFG.ratePerMin, ts: now };
  b.tokens = Math.min(CFG.ratePerMin, b.tokens + ((now - b.ts) / 60000) * CFG.ratePerMin);
  b.ts = now;
  const ok = b.tokens >= 1;
  if (ok) b.tokens -= 1;
  buckets.set(ip, b);
  return ok;
}

// ── HTTP plumbing ───────────────────────────────────────────────────────────

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-gateway-version': VERSION,
  });
  res.end(body);
}

/** Every error body carries a speakable reply so the robot can just say it. */
function sendSpeakable(res, status, error, reply, extra) {
  send(res, status, { error, reply, esml: toESML(reply), end: false, version: VERSION, ...(extra || {}) });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function validSessionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(id);
}

// ── Handlers ────────────────────────────────────────────────────────────────

/**
 * One conversational turn, shared by POST /v1/ask and the takeover worker.
 * Never throws for upstream failures: returns { error, status } plus a speakable reply.
 */
async function converse(sessionId, rawText, opts) {
  const t0 = Date.now();
  const text = String(rawText || '').slice(0, MAX_TEXT);
  if (opts && opts.reset) sessions.delete(sessionId);
  const s = getSession(sessionId);
  const r = route(text);

  let reply;
  let end = false;
  let usage;
  switch (r.target) {
    case 'prompt': reply = 'Sure, what would you like to ask?'; break;
    case 'end':    reply = 'Okay, talk to you later.'; end = true; sessions.delete(sessionId); break;
    case 'local':  reply = r.reply; break;
    default: {
      try {
        ({ reply, usage } = await askClaude(s, r.text));
      } catch (e) {
        log('error', 'claude call failed', { session: sessionId, status: e.status, err: e.message, ms: Date.now() - t0 });
        const busy = e.status === 429;
        return { error: 'upstream failure', status: busy ? 503 : 502, reply: busy ? MSG_BUSY : MSG_ERROR,
          end: false, route: r.target, session: sessionId, turns: s.history.length };
      }
      if (!reply) reply = "Hmm, I don't have an answer for that.";
    }
  }

  log('info', 'ask', {
    via: (opts && opts.via) || 'http', session: sessionId, route: r.target, ms: Date.now() - t0,
    in_chars: text.length, out_chars: reply.length,
    ...(usage ? { in_tok: usage.input_tokens, out_tok: usage.output_tokens } : {}),
    ...(CFG.logText ? { text, reply } : {}),
  });
  return { reply, end, route: r.target, session: sessionId, turns: s.history.length };
}

async function handleAsk(req, res, ip) {
  const body = await readJson(req);
  const sessionId = body.session === undefined ? 'default' : body.session;
  if (!validSessionId(sessionId)) return sendSpeakable(res, 400, 'bad session id', MSG_ERROR);
  if (typeof body.text !== 'string') return sendSpeakable(res, 400, 'text required', MSG_ERROR);

  const out = await converse(sessionId, body.text, { reset: body.reset, via: 'http:' + ip });
  if (out.error) return sendSpeakable(res, out.status, out.error, out.reply);
  send(res, 200, { ...out, esml: toESML(out.reply), version: VERSION });
}

async function handleReset(req, res) {
  const body = await readJson(req);
  const id = body.session === undefined ? 'default' : body.session;
  if (!validSessionId(id)) return send(res, 400, { error: 'bad session id' });
  const existed = sessions.delete(id);
  send(res, 200, { ok: true, existed, version: VERSION });
}

// ── ClaudeOver takeover ─────────────────────────────────────────────────────

const takeover = new Takeover({
  converse,
  log,
  version: VERSION,
  createClient: (opts) => { const { Client } = require('rom-control'); return new Client(opts); },
}, {
  jiboHost: CFG.jiboHost, listenMs: CFG.listenMs, idleMinutes: CFG.toIdleMin,
  startDelayMs: CFG.toStartDelay, screen: CFG.toScreen, debug: CFG.toDebug,
});

async function handleTakeover(req, res) {
  if (!CFG.takeover) return sendSpeakable(res, 403, 'takeover disabled', 'Claude mode is disabled on the gateway.');
  if (req.method === 'GET') return send(res, 200, { takeover: takeover.status(), version: VERSION });
  const body = await readJson(req);
  let want = String(body.state || 'toggle').toLowerCase();
  const cur = takeover.state;
  if (want === 'toggle') want = (cur === 'on' || cur === 'starting') ? 'off' : 'on';
  let reply;
  if (want === 'on') {
    reply = (cur === 'on' || cur === 'starting') ? 'Claude mode is already on.' : 'Switching to Claude mode.';
    takeover.start(body.reason || 'http');
  } else if (want === 'off') {
    reply = cur === 'off' ? 'Claude mode is already off.' : 'Turning Claude mode off.';
    takeover.stop(body.reason || 'http');
  } else {
    return sendSpeakable(res, 400, 'state must be on, off or toggle', MSG_ERROR);
  }
  send(res, 200, { takeover: takeover.status(), reply, esml: toESML(reply), version: VERSION });
}

const server = http.createServer(async (req, res) => {
  const ip = clientIp(req);
  const url = (req.url || '/').split('?')[0];

  try {
    if (req.method === 'GET' && url === '/healthz') return send(res, 200, { ok: true, version: VERSION });
    if (req.method === 'GET' && url === '/version') {
      return send(res, 200, { name: NAME, version: VERSION, model: CFG.model, sessions: sessions.size, takeover: takeover.state });
    }

    if (CFG.allowIps.length && !CFG.allowIps.includes(ip)) {
      log('info', 'rejected ip', { ip, url });
      return send(res, 403, { error: 'forbidden' });
    }
    if (!authorised(req)) {
      log('info', 'unauthorised', { ip, url });
      return send(res, 401, { error: 'unauthorised' });
    }
    if (!rateOk(ip)) return sendSpeakable(res, 429, 'rate limited', MSG_BUSY);

    if (req.method === 'POST' && url === '/v1/ask')   return await handleAsk(req, res, ip);
    if (req.method === 'POST' && url === '/v1/reset') return await handleReset(req, res);
    if ((req.method === 'POST' || req.method === 'GET') && url === '/v1/takeover') return await handleTakeover(req, res);

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    log('error', 'request failed', { ip, url, err: e.message });
    if (!res.headersSent) sendSpeakable(res, e.status || 500, e.message, MSG_ERROR);
  }
});

server.requestTimeout = CFG.timeoutMs + 10000;

// ── Lifecycle ───────────────────────────────────────────────────────────────

loadSessions();
const sweeper = setInterval(() => { sweepSessions(); saveSessions(); }, 60000);
sweeper.unref();

server.listen(CFG.port, CFG.host, () => {
  log('info', `${NAME} v${VERSION} listening`, {
    host: CFG.host, port: CFG.port, model: CFG.model, tz: CFG.tz,
    allowIps: CFG.allowIps, persist: CFG.persist, localHandlers: CFG.localHandlers,
    takeover: CFG.takeover, jiboHost: CFG.jiboHost,
  });
});

function shutdown(sig) {
  log('info', `shutting down (${sig})`);
  takeover.shutdown();
  saveSessions();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

