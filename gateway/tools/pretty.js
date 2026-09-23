#!/usr/bin/env node
'use strict';
/**
 * pretty.js v0.1.0 - live, human-readable view of the jibo-gateway log.
 * Reads the gateway's JSON log lines on stdin (e.g. `docker compose logs -f`)
 * and prints one readable line per event. Non-JSON lines pass through dimmed.
 *
 *   docker compose logs -f --no-log-prefix --since 5m gateway | node gateway/tools/pretty.js
 *   (or just ./watch.sh from the repo root)
 *
 * Options (env): VERBOSE=1 also shows raw ROM events / head touches / aco.
 *                NO_COLOR=1 disables colours.
 * Q&A text appears only if the gateway runs with LOG_TRANSCRIPTS=1 (or TAKEOVER_DEBUG=1).
 */
const readline = require('readline');

const COLOR = !process.env.NO_COLOR && process.stdout.isTTY !== false;
const c = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c('2'); const bold = c('1'); const red = c('31'); const green = c('32');
const yellow = c('33'); const blue = c('34'); const magenta = c('35'); const cyan = c('36');
const VERBOSE = process.env.VERBOSE === '1';

const OUTCOME = {
  answered: green('ANSWERED'), off: magenta('OFF'), stopped: magenta('STOPPED'),
  'no-speech': yellow('NO SPEECH'), empty: yellow('EMPTY'),
  'claude-error': red('CLAUDE ERROR'), error: red('ERROR'), 'say-failed': red('SAY FAILED'),
};

function hhmmss (t) {
  const d = t ? new Date(t) : new Date();
  return isNaN(d) ? '--:--:--' : d.toLocaleTimeString('en-AU', { hour12: false });
}
function secs (ms) { return typeof ms === 'number' ? (ms / 1000).toFixed(1) + 's' : '-'; }
function wrap (label, text) {
  if (!text) return '';
  return '\n           ' + label + ' ' + String(text);
}

/** @returns {string|null} formatted line, or null to hide */
function format (j) {
  const ts = dim(hhmmss(j.t));
  const m = j.msg || '';
  switch (m) {
    case 'turn': {
      const parts = [`listen ${secs(j.listenMs)}`];
      if (j.claudeMs !== undefined) parts.push(`claude ${secs(j.claudeMs)}`);
      if (j.sayMs !== undefined) parts.push(`say ${secs(j.sayMs)}`);
      parts.push(`total ${secs(j.totalMs)}`);
      const extra = [j.thinkingCue ? 'thinking cue' : '', j.status ? 'HTTP ' + j.status : '', j.err || ''].filter(Boolean).join(', ');
      return `${ts} ${bold('#' + j.n)} ${OUTCOME[j.outcome] || j.outcome}  ${dim(parts.join(' · '))}${extra ? '  ' + red(extra) : ''}` +
        wrap(cyan('Q:'), j.text) + wrap(green('A:'), j.reply);
    }
    case 'ask':
      if (j.via === 'takeover') return null; // the 'turn' line covers it
      return `${ts} ${blue('ASK')} ${j.via} ${j.route} ${dim(secs(j.ms))}` + wrap(cyan('Q:'), j.text) + wrap(green('A:'), j.reply);
    case 'takeover starting': return `${ts} ${blue('▶ Claude mode starting')} ${dim('(' + (j.reason || '') + ')')}`;
    case 'takeover on': return `${ts} ${green(bold('● CLAUDE MODE ON'))}`;
    case 'takeover stopping': return `${ts} ${magenta('■ stopping')} ${dim('(' + (j.reason || '') + ')')}`;
    case 'takeover off': return `${ts} ${magenta(bold('○ CLAUDE MODE OFF'))} ${dim('(' + (j.reason || '') + ')')}`;
    case 'hotword ignored (busy with a turn)': return `${ts} ${yellow('“Hey Jibo” ignored: still busy with the last question')}`;
    case 'wake-word stream dropped, reconnecting in 3 s': return `${ts} ${yellow('wake-word stream dropped, reconnecting…')}`;
    case 'rom session closed cleanly': return `${ts} ${dim('Jibo released cleanly')}`;
    case 'rom close not acked, terminating': return `${ts} ${yellow('Jibo did not ack the close; forced')}`;
    case 'claude call failed': return `${ts} ${red('Claude API failed')} ${dim(`status ${j.status || '?'} · ${secs(j.ms)}`)} ${red(j.err || '')}`;
    case 'rejected ip': return `${ts} ${red('rejected request from ' + j.ip)} ${dim(j.url || '')}`;
    default:
      if (/listening$/.test(m)) return `${ts} ${bold(m)} ${dim(`model ${j.model || '?'}${j.takeover ? ' · takeover enabled' : ''}`)}`;
      if (j.level === 'error') return `${ts} ${red(m)} ${red(j.err || '')}`;
      if (VERBOSE) return `${ts} ${dim(m + ' ' + JSON.stringify(Object.assign({}, j, { t: undefined, level: undefined, msg: undefined })))}`;
      return null;
  }
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const i = line.indexOf('{');
    if (i < 0) { if (line.trim()) console.log(dim(line)); return; }
    let j;
    try { j = JSON.parse(line.slice(i)); } catch (e) { console.log(dim(line)); return; }
    const out = format(j);
    if (out) console.log(out);
  });
}

module.exports = { format };
