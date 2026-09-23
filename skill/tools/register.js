'use strict';
/**
 * register.js v0.2.1 (tile label: ClaudeOver) - runs ON JIBO (Node 6). Registers/unregisters @be/claude:
 *   1. jibo.lazySkills entry in @be/be/package.json
 *   2. main-menu tile in main-menu/resources/views/main-menu-verbal.json
 *   3. menu icon copied to main-menu/resources/icons/claude.png
 * Each edited file is backed up once to <file>.bak-claude before first change.
 *
 *   node register.js install|uninstall|status <beRoot>
 */
var fs = require('fs');
var path = require('path');

var ID = '@be/claude';
var MENU_ID = 'claude';
var action = process.argv[2];
var beRoot = process.argv[3] || '/opt/jibo/Jibo/Skills/@be/be';

var PKG = path.join(beRoot, 'package.json');
var MENU_DIR = path.join(beRoot, 'skills', 'main-menu');
var MENU = path.join(MENU_DIR, 'resources', 'views', 'main-menu-verbal.json');
var ICON_SRC = path.join(beRoot, 'skills', 'claude', 'resources', 'icons', 'claude.png');
var ICON_DST = path.join(MENU_DIR, 'resources', 'icons', 'claude.png');

var MENU_ENTRY = {
  id: MENU_ID,
  label: 'ClaudeOver',
  colors: ['0xD97757', '0x8C3B24'],
  iconSrc: 'resources/icons/claude.png',
  action: { type: 'utterance', data: { utterance: { intent: 'loadMenu', entities: { destination: MENU_ID } } } }
};

function backupOnce (f) {
  if (!fs.existsSync(f + '.bak-claude')) { fs.writeFileSync(f + '.bak-claude', fs.readFileSync(f)); }
}
function readJson (f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }
function writeJson (f, obj) { backupOnce(f); fs.writeFileSync(f, JSON.stringify(obj, null, 4) + '\n'); }

/** Find the array of menu items: the one holding an object with id 'bad-apple' (fallback: any id+action array). */
function findMenuArray (node, pred) {
  if (Array.isArray(node)) {
    if (node.some(function (x) { return x && typeof x === 'object' && pred(x); })) { return node; }
    for (var i = 0; i < node.length; i++) { var r = findMenuArray(node[i], pred); if (r) { return r; } }
  } else if (node && typeof node === 'object') {
    var keys = Object.keys(node);
    for (var k = 0; k < keys.length; k++) { var r2 = findMenuArray(node[keys[k]], pred); if (r2) { return r2; } }
  }
  return null;
}

function lazy (install) {
  var p = readJson(PKG);
  var l = p.jibo.lazySkills;
  var i = l.indexOf(ID);
  if (install && i < 0) { l.push(ID); writeJson(PKG, p); return 'registered in lazySkills'; }
  if (!install && i >= 0) { l.splice(i, 1); writeJson(PKG, p); return 'removed from lazySkills'; }
  return install ? 'already in lazySkills' : 'not in lazySkills';
}

function menu (install) {
  if (!fs.existsSync(MENU)) { return 'WARN: menu file not found: ' + MENU; }
  var m = readJson(MENU);
  var arr = findMenuArray(m, function (x) { return x.id === 'bad-apple'; }) ||
            findMenuArray(m, function (x) { return x.id && x.action; });
  if (!arr) { return 'WARN: could not locate menu item array'; }
  var idx = -1;
  arr.forEach(function (x, j) { if (x && x.id === MENU_ID) { idx = j; } });
  if (install) {
    if (idx >= 0) { arr[idx] = MENU_ENTRY; writeJson(MENU, m); return 'menu tile updated'; }
    var after = -1;
    arr.forEach(function (x, j) { if (x && x.id === 'bad-apple') { after = j; } });
    arr.splice(after >= 0 ? after + 1 : arr.length, 0, MENU_ENTRY);
    writeJson(MENU, m);
    return 'menu tile added';
  }
  if (idx >= 0) { arr.splice(idx, 1); writeJson(MENU, m); return 'menu tile removed'; }
  return 'no menu tile';
}

function icon (install) {
  if (install) {
    if (!fs.existsSync(ICON_SRC)) { return 'WARN: icon missing in skill: ' + ICON_SRC; }
    try { fs.mkdirSync(path.dirname(ICON_DST)); } catch (e) { /* exists */ }
    fs.writeFileSync(ICON_DST, fs.readFileSync(ICON_SRC));
    return 'menu icon copied';
  }
  if (fs.existsSync(ICON_DST)) { fs.unlinkSync(ICON_DST); return 'menu icon removed'; }
  return 'no menu icon';
}

function status () {
  var p = readJson(PKG);
  var inLazy = p.jibo.lazySkills.indexOf(ID) >= 0;
  var inMenu = false;
  try { inMenu = !!findMenuArray(readJson(MENU), function (x) { return x.id === MENU_ID; }); } catch (e) { /* no-op */ }
  return 'lazySkills=' + inLazy + ' menuTile=' + inMenu + ' menuIcon=' + fs.existsSync(ICON_DST);
}

try {
  if (action === 'install') { console.log([lazy(true), menu(true), icon(true)].join('; ')); }
  else if (action === 'uninstall') { console.log([lazy(false), menu(false), icon(false)].join('; ')); }
  else if (action === 'status') { console.log(status()); }
  else { console.error('usage: node register.js install|uninstall|status <beRoot>'); process.exit(2); }
} catch (e) {
  console.error('register.js failed: ' + e.message);
  process.exit(1);
}
