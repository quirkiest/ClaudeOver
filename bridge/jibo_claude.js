#!/usr/bin/env node
/**
 * jibo_claude.js - Claude conversational backend for Jibo.
 *
 * v0.4.0
 *
 * Built on rom-control, which speaks the Jibo ROM WebSocket API on port 8160.
 * Flow: wakeword -> local ASR -> router -> Claude or a local handler -> TTS.
 *
 * Requires Jibo in NORMAL mode. In int-developer the SSM loads SkillsServiceSim,
 * no skill runs, and the ROM socket has nothing on the far side.
 *
 * NOTE ON ROUTING: ROM is a takeover mode. While this session is open,
 * @be/remote is the foreground skill and Jibo's own NLU and skills are
 * suspended - there is no "default route" to fall back to. Anything Jibo used
 * to answer itself (clock, timers, weather) has to be handled here instead.
 * A real fallback would mean building an on-robot skill with its own NLU rule.
 *
 * Setup:
 *   npm install rom-control @anthropic-ai/sdk
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   node jibo_claude.js
 */

const { Client, AttentionMode } = require('rom-control');
const Anthropic = require('@anthropic-ai/sdk');

const VERSION = '0.4.0';

const JIBO_HOST  = process.env.JIBO_HOST  || '192.168.20.40';
const MODEL      = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const TIMEZONE   = process.env.JIBO_TZ    || 'Australia/Melbourne';
const PLACE      = process.env.JIBO_PLACE || 'Melbourne, Australia';
const LISTEN_MS  = Number(process.env.JIBO_LISTEN_MS || 15000);
const MAX_TURNS  = 12;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set. export it before running.');
  process.exit(1);
}

const claude = new Anthropic();
const jibo = new Client({ host: JIBO_HOST });
const history = [];

function remember(role, content) {
  history.push({ role, content });
  while (history.length > MAX_TURNS) history.shift();
}

/**
 * This firmware returns the transcript as `content`. The library's README uses
 * `speech`, which is undefined here - check both so either shape works.
 */
function transcriptOf(result) {
  if (!result) return '';
  return String(result.content || result.speech || result.text || '').trim();
}

/** say() takes ESML, which is XML-ish - escape so model output cannot break it. */
function toESML(text) {
  return text
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '') // emoji do not speak well
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function nowParts() {
  const fmt = (opts) => new Intl.DateTimeFormat('en-AU', { timeZone: TIMEZONE, ...opts }).format(new Date());
  return {
    time: fmt({ hour: 'numeric', minute: '2-digit', hour12: true }),
    date: fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
  };
}

// ── Local handlers ──────────────────────────────────────────────────────────
// Things Jibo would normally answer itself, which ROM takes away from him.
// Cheap, instant, and no API round trip.

const LOCAL_HANDLERS = [
  {
    test: (u) => /\b(what|whats)\b.*\btime\b/.test(u) || /^time$/.test(u),
    run: () => `It's ${nowParts().time}.`,
  },
  {
    test: (u) => /\b(what|whats)\b.*\b(date|day)\b/.test(u),
    run: () => `It's ${nowParts().date}.`,
  },
];

/**
 * Decide where an utterance goes.
 * "ask claude ..." / "claude, ..." always forces the model, so you can reach it
 * even for something a local handler would otherwise grab.
 */
function route(utterance) {
  const u = utterance.toLowerCase().trim();

  const forced = u.match(/^(?:ask\s+claude|claude[,:]?)\s+(.*)$/);
  if (forced && forced[1]) return { target: 'claude', text: forced[1] };

  for (const h of LOCAL_HANDLERS) {
    if (h.test(u)) return { target: 'local', reply: h.run() };
  }
  return { target: 'claude', text: utterance };
}

function systemPrompt() {
  const { time, date } = nowParts();
  return `You are Jibo, a friendly social robot with a physical body, speaking aloud.
Right now it is ${time} on ${date}, and you are in ${PLACE}.
Keep every reply to one or two short sentences - your words go through a small
speaker, so long answers are tiring. Be warm, curious and concise. Never use
markdown, lists, or emoji; only plain spoken language. If you genuinely cannot
know something, say so briefly rather than explaining your limitations at length.`;
}

async function ask(utterance) {
  remember('user', utterance);
  const res = await claude.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: systemPrompt(),
    messages: history,
  });
  const reply = res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
  remember('assistant', reply);
  return reply;
}

// ── Session ─────────────────────────────────────────────────────────────────

jibo.once('ready', async () => {
  console.log(`jibo_claude v${VERSION} - connected to ${JIBO_HOST}`);
  jibo.audio.watchWakeword();
  console.log(`wakeword listener started (tz=${TIMEZONE})`);

  await jibo.behavior.setAttention(AttentionMode.Engaged);
  await jibo.behavior.say('<anim cat="happy" nonBlocking="true"/> Hi, I am back. Say my name when you want to talk.');
});

let busy = false;

jibo.on('hotword', async () => {
  if (busy) return;
  busy = true;
  console.log('hotword - listening...');

  try {
    // The wakeword watcher holds the ASR service - a listen opened while it
    // runs returns nothing. Pause it for the whole turn, including the reply:
    // restarting it before Jibo finishes speaking makes him wake on his own
    // voice, which showed up as spurious listens after longer answers.
    jibo.audio.stopWakeword();

    const heard = await jibo.audio.awaitSpeech({
      mode: 'local',
      time: LISTEN_MS,
      noSpeechTime: LISTEN_MS,
    });

    const utterance = transcriptOf(heard);
    if (!utterance) {
      await jibo.behavior.say('Sorry, I did not catch that.');
      return;
    }
    console.log('heard:', utterance);

    const decision = route(utterance);
    let reply;
    if (decision.target === 'local') {
      reply = decision.reply;
      console.log('local:', reply);
    } else {
      reply = await ask(decision.text);
      console.log('reply:', reply);
    }

    await jibo.behavior.say(toESML(reply));
  } catch (err) {
    if (err.code === 'SPEECH_TIMEOUT') {
      console.log('no speech heard within', LISTEN_MS, 'ms');
      return;
    }
    console.error('turn failed:', err.message);
    try {
      await jibo.behavior.say('Something went wrong in my head. Try again?');
    } catch (_) { /* robot unreachable */ }
  } finally {
    // Only now is it safe to listen for the wakeword again.
    try { jibo.audio.watchWakeword(); } catch (_) { /* session gone */ }
    busy = false;
  }
});

jibo.on('error', (err) => console.error('rom-control error:', err.message));

process.on('SIGINT', () => {
  console.log('\nshutting down...');
  try { jibo.audio.stopWakeword(); jibo.disconnect(); } catch (_) {}
  process.exit(0);
});

jibo.connect();
