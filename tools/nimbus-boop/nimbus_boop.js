#!/usr/bin/env node
/*
 * ClaudeOver nimbus-boop: plays a short "I heard you" earcon on Jibo when the
 * answer skill (@be/nimbus) starts thinking, i.e. once the server has transcribed
 * the question and is waiting on Claude / the knowledge backend.
 *
 * Runs ON JIBO with Jibo's own node. Edits skills/nimbus/index.js in place (the file
 * keeps its owner and mode), after a backup made with the same owner and mode.
 *
 *   node nimbus_boop.js status
 *   node nimbus_boop.js apply  [--sound SFX_Global_TurnTakingOff]
 *   node nimbus_boop.js revert
 */
'use strict';
var fs = require('fs');

var VERSION = '0.1.0';
var BE = '/opt/jibo/Jibo/Skills/@be/be';
var TARGET = BE + '/skills/nimbus/index.js';
var BACKUP = TARGET + '.bak-boop';
var SOUND_DIR = BE + '/node_modules/jibo/resources/audio';
var MARK = '/* ClaudeOver nimbus-boop */';
var ANCHOR = '            if (isGQA) {\n';

function readArg(name, fallback) {
  var i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function copyKeepingOwnerAndMode(src, dst) {
  var st = fs.statSync(src);
  fs.writeFileSync(dst, fs.readFileSync(src));
  fs.chmodSync(dst, st.mode & 4095);
  fs.chownSync(dst, st.uid, st.gid);
}

function describe(path) {
  var st = fs.statSync(path);
  return (st.mode & 4095).toString(8) + ' uid=' + st.uid + ' gid=' + st.gid + ' ' + st.size + ' bytes';
}

function snippet(sound) {
  // Plain ES5-ish code; uses only objects Nimbus already has (this.nimbus.jibo).
  return '                ' + MARK + ' try { var __j = this.nimbus.jibo, __a = ' + JSON.stringify(sound) +
    ', __play = function () { __j.sound.play(__a); }; if (__j.sound.exists(__a)) { __play(); } else { __j.loader.load(' +
    JSON.stringify(SOUND_DIR + '/' + sound + '.m4a') +
    ', function (e) { if (!e) { __play(); } }); } } catch (__e) { this.nimbus.log.warn("nimbus-boop failed", __e); }\n';
}

function status() {
  var src = fs.readFileSync(TARGET, 'utf8');
  console.log('nimbus_boop ' + VERSION);
  console.log('  target  ' + TARGET + '  (' + describe(TARGET) + ')');
  console.log('  patched ' + (src.indexOf(MARK) >= 0 ? 'yes' : 'no'));
  console.log('  anchor  ' + (src.split(ANCHOR).length - 1) + ' match(es)');
  console.log('  backup  ' + (fs.existsSync(BACKUP) ? BACKUP + '  (' + describe(BACKUP) + ')' : 'none'));
  fs.readdirSync(SOUND_DIR).filter(function (f) { return /^SFX_.*\.m4a$/.test(f); })
    .forEach(function (f) { console.log('  sound   ' + f.replace(/\.m4a$/, '')); });
}

function apply() {
  var sound = readArg('--sound', 'SFX_Global_TurnTakingOff');
  if (!fs.existsSync(SOUND_DIR + '/' + sound + '.m4a')) throw new Error('No such sound: ' + sound + ' (see status)');
  var src = fs.readFileSync(TARGET, 'utf8');
  if (src.indexOf(MARK) >= 0) { console.log('Already patched; run revert first to change the sound.'); return; }
  if (src.split(ANCHOR).length - 1 !== 1) throw new Error('Anchor not found exactly once; this Nimbus version is not supported. Nothing changed.');
  if (!fs.existsSync(BACKUP)) copyKeepingOwnerAndMode(TARGET, BACKUP);
  fs.writeFileSync(TARGET, src.replace(ANCHOR, ANCHOR + snippet(sound)));   // in place: owner/mode kept
  console.log('Patched with ' + sound + '. Target now ' + describe(TARGET) + '; backup ' + describe(BACKUP) + '.');
  console.log('Check the two mode/uid/gid values match, then reboot Jibo.');
}

function revert() {
  if (!fs.existsSync(BACKUP)) throw new Error('No backup at ' + BACKUP + '; nothing to revert.');
  fs.writeFileSync(TARGET, fs.readFileSync(BACKUP));                          // in place: owner/mode kept
  console.log('Restored from backup. Target now ' + describe(TARGET) + '. Reboot Jibo.');
}

var cmd = process.argv[2];
try {
  if (cmd === 'status') status();
  else if (cmd === 'apply') apply();
  else if (cmd === 'revert') revert();
  else { console.log('usage: node nimbus_boop.js status | apply [--sound NAME] | revert'); process.exit(2); }
} catch (e) {
  console.error('ERROR: ' + e.message);
  process.exit(1);
}
