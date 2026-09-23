/**
 * gateway_client.js - minimal jibo-gateway client for the ON-ROBOT skill.
 *
 * v0.2.0 - adds takeover(state) for ClaudeOver mode.
 *
 * Deliberately ES5 + core `http` only: the robot's Node is old (version TBC,
 * see handoff §10-T), so no fetch, no async/await, no SDK, no dependencies.
 * Drop this file into the skill and require it.
 *
 *   var gw = require('./gateway_client');
 *   var client = gw.create({ host: '192.168.20.26', port: 8765, token: '...' });
 *   client.ask('jibo-1', 'how far is melbourne from london', function (err, r) {
 *     // r.esml -> jibo.tts / say ; r.end === true -> close the skill
 *   });
 *   client.takeover('on', 'menu tile', function (err, r) { ... r.esml, r.takeover.state });
 *
 * On any failure the callback still receives a speakable `r.esml`, so the skill
 * can always say *something* and never hangs silently.
 *
 * CLI test (from any machine with node):
 *   GATEWAY_TOKEN=... node gateway_client.js "what's the capital of peru"
 */
'use strict';

var http = require('http');

var VERSION = '0.2.0';
var FALLBACK = 'I could not reach my thinking cap. Try again in a moment.';

function escapeESML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fallback(err) {
  return { reply: FALLBACK, esml: escapeESML(FALLBACK), end: false, error: err && err.message };
}

function create(opts) {
  opts = opts || {};
  var host = opts.host || '192.168.20.26';
  var port = opts.port || 8765;
  var token = opts.token || '';
  var timeoutMs = opts.timeoutMs || 30000;

  function post(path, payload, cb) {
    var body = JSON.stringify(payload);
    var done = false;
    function finish(err, res) { if (!done) { done = true; cb(err, res); } }

    var req = http.request({
      host: host,
      port: port,
      path: path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'authorization': 'Bearer ' + token,
        'user-agent': 'jibo-skill-client/' + VERSION
      }
    }, function (res) {
      var chunks = [];
      res.setEncoding('utf8');
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var parsed;
        try { parsed = JSON.parse(chunks.join('')); } catch (e) {
          return finish(new Error('bad JSON from gateway (HTTP ' + res.statusCode + ')'), fallback(e));
        }
        if (res.statusCode !== 200) {
          var err = new Error('gateway HTTP ' + res.statusCode + ': ' + (parsed.error || '?'));
          // gateway error bodies carry their own speakable reply
          if (!parsed.esml) parsed = fallback(err);
          return finish(err, parsed);
        }
        finish(null, parsed);
      });
    });

    req.setTimeout(timeoutMs, function () { req.abort(); finish(new Error('gateway timeout'), fallback(new Error('timeout'))); });
    req.on('error', function (e) { finish(e, fallback(e)); });
    req.write(body);
    req.end();
  }

  return {
    version: VERSION,
    ask: function (session, text, cb) { post('/v1/ask', { session: session, text: text }, cb); },
    reset: function (session, cb) { post('/v1/reset', { session: session }, cb || function () {}); },
    /** ClaudeOver: state = 'on' | 'off' | 'toggle'. Reply carries a speakable esml. */
    takeover: function (state, reason, cb) { post('/v1/takeover', { state: state, reason: reason }, cb); }
  };
}

module.exports = { create: create, VERSION: VERSION };

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  var text = process.argv.slice(2).join(' ');
  if (!text) { console.error('usage: GATEWAY_TOKEN=... node gateway_client.js "question" | --takeover on|off|toggle'); process.exit(2); }
  var c = create({
    host: process.env.GATEWAY_HOST || '192.168.20.26',
    port: Number(process.env.GATEWAY_PORT || 8765),
    token: process.env.GATEWAY_TOKEN || ''
  });
  var t0 = Date.now();
  if (process.argv[2] === '--takeover') {
    c.takeover(process.argv[3] || 'toggle', 'cli', function (err, r) {
      if (err) console.error('error:', err.message);
      console.log(JSON.stringify(r, null, 2));
      process.exit(err ? 1 : 0);
    });
  } else c.ask(process.env.GATEWAY_SESSION || 'cli', text, function (err, r) {
    if (err) console.error('error:', err.message);
    console.log(JSON.stringify(r, null, 2));
    console.log('(' + (Date.now() - t0) + 'ms, client v' + VERSION + ')');
    process.exit(err ? 1 : 0);
  });
}
