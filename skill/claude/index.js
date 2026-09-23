'use strict';
/**
 * @be/claude - "ClaudeOver" main-menu tile.
 *
 * v0.2.2 - new menu icon (speech bubble + spark, original; source skill/assets/claude-icon.svg).
 * v0.2.1 - exit hint now "pat twice or hold" (matches gateway 0.2.3).
 * v0.2.0 - Tapping the tile asks jibo-gateway to switch Jibo into Claude mode
 * (the gateway opens a ROM session: every "Hey Jibo ..." then goes to Claude).
 * This skill only flips the switch: show instructions, POST /v1/takeover,
 * say the result, exit quickly so the gateway's ROM session can take the
 * foreground. Leaving Claude mode (double head pat / swipe down / "Claude off"
 * / idle timeout) is handled by the gateway, not here.
 *
 * Config: config.json next to this file, written by deploy.sh from the
 * gateway's .env: { "gatewayHost": "...", "gatewayPort": 8765, "token": "..." }
 *
 * Runtime: Electron 1.4 / Node 6.9 - plain CommonJS, ES2015, no async/await.
 */

const be = require('@be/be-framework');
const jibo = require('jibo');
const fs = require('fs');
const path = require('path');
const gw = require('./gateway_client');

const VERSION = '0.2.2';
const TAG = '[claudeover v' + VERSION + ']';
const DUMP_FILE = '/tmp/claude-skill-last.json';
const CONFIG_FILE = path.join(__dirname, 'config.json');
const SPEAK_TIMEOUT_MS = 12000;
const EXIT_AFTER_MS = 300;

// ── helpers ─────────────────────────────────────────────────────────────────

function log () {
  const args = Array.prototype.slice.call(arguments);
  args.unshift(TAG);
  try { console.log.apply(console, args); } catch (e) { /* no-op */ }
}

function loadConfig () {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!c.token) { throw new Error('token missing'); }
    return { host: c.gatewayHost || '192.168.20.26', port: Number(c.gatewayPort || 8765), token: c.token };
  } catch (e) {
    log('config error:', e.message);
    return null;
  }
}

/** Minimal launch-result dump (kept from the v0.1 probe: tells us how tiles launch us). */
function dumpLaunch (result, prev) {
  const seen = [];
  function walk (v, d) {
    if (v === null || typeof v !== 'object') { return typeof v === 'function' ? '[fn]' : v; }
    if (seen.indexOf(v) !== -1 || d > 5) { return '[..]'; }
    seen.push(v);
    if (Array.isArray(v)) { return v.map(function (x) { return walk(x, d + 1); }); }
    const o = {};
    Object.keys(v).forEach(function (k) { try { o[k] = walk(v[k], d + 1); } catch (e) { o[k] = '[err]'; } });
    return o;
  }
  try {
    fs.writeFileSync(DUMP_FILE, JSON.stringify({ version: VERSION, at: new Date().toISOString(), prev: prev, result: walk(result, 0) }, null, 2));
  } catch (e) { /* no-op */ }
}

/** Speak via whichever API exists; callback- or promise-style; hard timeout. */
function speak (text, cb) {
  let finished = false;
  let api = 'none';
  const timer = setTimeout(function () { finish(new Error('speak timeout')); }, SPEAK_TIMEOUT_MS);
  function finish (err) {
    if (finished) { return; }
    finished = true;
    clearTimeout(timer);
    try { fs.writeFileSync('/tmp/claude-skill-last-speak.txt', 'api=' + api + '\nerror=' + (err ? err.message : 'none') + '\n'); } catch (e) { /* no-op */ }
    cb(err || null, api);
  }
  try {
    const es = jibo.embodied && jibo.embodied.speech;
    let ret;
    if (es && typeof es.speak === 'function') {
      api = 'embodied.speech.speak';
      ret = es.speak(text, function (err) { finish(err); });
    } else if (jibo.tts && typeof jibo.tts.speak === 'function') {
      api = 'tts.speak';
      ret = jibo.tts.speak(text, function (err) { finish(err); });
    } else {
      return finish(new Error('no speak API found'));
    }
    if (ret && typeof ret.then === 'function') {
      ret.then(function () { finish(); }, function (err) { finish(err || new Error('speak rejected')); });
    }
  } catch (err) {
    finish(err);
  }
}

// ── on-screen panel ─────────────────────────────────────────────────────────

function makePanel () {
  const root = document.createElement('div');
  root.id = 'claudeover-root';
  root.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:720px;background:#1a1512;' +
    'z-index:99999;overflow:hidden;font-family:sans-serif;color:#f3ece4;';

  const title = document.createElement('div');
  title.style.cssText = 'position:absolute;left:60px;top:50px;font-size:72px;font-weight:bold;color:#e0896b;';
  title.textContent = 'ClaudeOver';
  root.appendChild(title);

  const ver = document.createElement('div');
  ver.style.cssText = 'position:absolute;right:50px;top:66px;font-size:26px;color:#9a8f84;';
  ver.textContent = 'v' + VERSION;
  root.appendChild(ver);

  const status = document.createElement('div');
  status.style.cssText = 'position:absolute;left:60px;top:170px;font-size:40px;color:#f3ece4;';
  root.appendChild(status);

  const help = document.createElement('div');
  help.style.cssText = 'position:absolute;left:60px;right:60px;top:270px;font-size:34px;line-height:1.6;color:#d8cfc6;';
  help.innerHTML =
    '&bull; Say <b>&ldquo;Hey Jibo&rdquo;</b>, then ask Claude anything<br>' +
    '&bull; <b>Pat my head twice</b> (or hold it) to go back to normal<br>' +
    '&bull; or swipe down, or say <b>&ldquo;Claude off&rdquo;</b>';
  root.appendChild(help);

  document.body.appendChild(root);
  return {
    status: function (t) { status.textContent = t; },
    remove: function () { if (root.parentNode) { root.parentNode.removeChild(root); } }
  };
}

// ── the skill ───────────────────────────────────────────────────────────────

class ClaudeOverSkill extends be.BeSkill {

  constructor (assetPack) {
    super(assetPack);
    this._panel = null;
    this._exiting = false;
    this._timers = [];
    log('constructed');
  }

  postInit (done) { done(); }

  preload (done) {
    try {
      const es = jibo.embodied && jibo.embodied.speech;
      if (es && typeof es.installDelegate === 'function') { es.installDelegate(this.assetPack); }
    } catch (e) { log('installDelegate failed:', e.message); }
    done();
  }

  open (result, refresh, previousSkillName) {
    this._exiting = false;
    log('open; prev=', previousSkillName);
    dumpLaunch(result, previousSkillName);

    try { this._panel = makePanel(); this._panel.status('Starting Claude mode…'); } catch (e) { log('panel failed:', e.message); }

    const self = this;
    const cfg = loadConfig();
    if (!cfg) {
      return this._finish('Setup problem', 'I am not set up to reach the Claude server yet.');
    }

    // Speak first, then flip the switch, then exit at once: the gateway waits
    // TAKEOVER_START_DELAY_MS before opening ROM, so we are gone by then.
    speak('Switching to Claude mode.', function () {
      gw.create({ host: cfg.host, port: cfg.port, token: cfg.token, timeoutMs: 8000 })
        .takeover('on', 'menu tile', function (err, r) {
          if (err) {
            log('takeover request failed:', err.message);
            return self._finish('Could not reach the Claude server',
              (r && r.esml) || 'I could not reach the Claude server.');
          }
          log('takeover:', r && r.takeover && r.takeover.state);
          if (self._panel) { self._panel.status('Claude mode on — say “Hey Jibo”'); }
          self._later(function () { self._leave('switched'); }, EXIT_AFTER_MS);
        });
    });
  }

  /** Failure path: show + say what went wrong, then exit. */
  _finish (statusText, speech) {
    const self = this;
    if (this._panel) { this._panel.status(statusText); }
    speak(speech, function () { self._later(function () { self._leave('failed'); }, 1500); });
  }

  close (done) {
    log('close');
    this._timers.forEach(function (t) { clearTimeout(t); });
    this._timers = [];
    if (this._panel) { try { this._panel.remove(); } catch (e) { /* no-op */ } this._panel = null; }
    done();
  }

  _later (fn, ms) { this._timers.push(setTimeout(fn, ms)); }

  _leave (why) {
    if (this._exiting) { return; }
    this._exiting = true;
    log('exit:', why);
    try { this.exit(); } catch (e) { log('exit() failed:', e.message); }
  }
}

module.exports = ClaudeOverSkill;
