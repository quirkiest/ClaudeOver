'use strict';
/**
 * register.js v0.3.0 - runs ON JIBO (Node 6). Registers/unregisters @be/claude.
 *
 *   node register.js <action> <beRoot>
 *
 *   skill      lazySkills entry in @be/be/package.json            (stage 1)
 *   tile       main-menu tile + icon                              (stage 2)
 *   install    skill + tile
 *   untile     remove tile + icon only
 *   uninstall  remove tile, icon and lazySkills entry
 *   status     show what is registered
 *   check      exit 1 if any file Be reads is not world-readable
 *   fixperms   make every file/dir Be reads world-readable (a+r / a+rx)
 *
 * v0.3.0 - PERMISSIONS FIX. The BEam skill host runs as user `jibo-skill`, not
 *   root, and root's umask on Jibo is 077. v0.2.x wrote backups and icon as NEW
 *   files (mode 600), and a restore from those backups left package.json at 600
 *   -> Be could not read it -> no eye, no menu. Now: every write keeps the
 *   original file's mode and is forced world-readable; backups copy the mode;
 *   a `check` runs after every change; `fixperms` repairs a broken tree.
 * v0.2.1 - tile label ClaudeOver.
 */
var fs = require('fs');
var path = require('path');

var VERSION = '0.3.0';
var ID = '@be/claude';
var MENU_ID = 'claude';
var action = process.argv[2];
var beRoot = process.argv[3] || '/opt/jibo/Jibo/Skills/@be/be';

var PKG = path.join(beRoot, 'package.json');
var MENU_DIR = path.join(beRoot, 'skills', 'main-menu');
var MENU = path.join(MENU_DIR, 'resources', 'views', 'main-menu-verbal.json');
var SKILL_DIR = path.join(beRoot, 'skills', 'claude');
var ICON_SRC = path.join(SKILL_DIR, 'resources', 'icons', 'claude.png');
var ICON_DST = path.join(MENU_DIR, 'resources', 'icons', 'claude.png');

var MENU_ENTRY = {
  id: MENU_ID,
  label: 'ClaudeOver',
  colors: ['0xD97757', '0x8C3B24'],
  iconSrc: 'resources/icons/claude.png',
  action: { type: 'utterance', data: { utterance: { intent: 'loadMenu', entities: { destination: MENU_ID } } } }
};

// ── permission-safe file ops ────────────────────────────────────────────────

var R_FILE = 292; // 0o444
var R_DIR = 365;  // 0o555

function modeOf (f) { return fs.statSync(f).mode & 4095; }

/** Write in place (keeps owner + inode), then restore mode, forced world-readable. */
function safeWrite (f, data, fallbackMode) {
  var mode = fs.existsSync(f) ? modeOf(f) : (fallbackMode || 420); // 0o644
  fs.writeFileSync(f, data);
  fs.chmodSync(f, mode | R_FILE);
}

function backupOnce (f) {
  var b = f + '.bak-claude';
  if (!fs.existsSync(b)) { safeWrite(b, fs.readFileSync(f), modeOf(f)); }
}
function readJson (f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }
function writeJson (f, obj) {
  backupOnce(f);
  var text = JSON.stringify(obj, null, 4) + '\n';
  JSON.parse(text); // never write something Be can't parse
  safeWrite(f, text);
}

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

// ── registration steps ──────────────────────────────────────────────────────

function lazy (install) {
  var p = readJson(PKG);
  var l = p.jibo.lazySkills;
  var i = l.indexOf(ID);
  if (install && !fs.existsSync(path.join(SKILL_DIR, 'index.js'))) { throw new Error('skill files missing: ' + SKILL_DIR); }
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
    safeWrite(ICON_DST, fs.readFileSync(ICON_SRC), 420);
    return 'menu icon copied';
  }
  if (fs.existsSync(ICON_DST)) { fs.unlinkSync(ICON_DST); return 'menu icon removed'; }
  return 'no menu icon';
}

// ── permission check / repair ───────────────────────────────────────────────

/** Paths Be (user jibo-skill) must be able to read. */
function watched () {
  var list = [PKG, MENU, path.dirname(MENU), ICON_DST, path.dirname(ICON_DST)];
  (function walk (d) {
    if (!fs.existsSync(d)) { return; }
    list.push(d);
    fs.readdirSync(d).forEach(function (n) {
      var f = path.join(d, n);
      if (fs.statSync(f).isDirectory()) { walk(f); } else { list.push(f); }
    });
  })(SKILL_DIR);
  return list.filter(function (f) { return fs.existsSync(f); });
}

function badPerms () {
  return watched().filter(function (f) {
    var st = fs.statSync(f);
    var need = st.isDirectory() ? 5 : 4; // o+rx for dirs, o+r for files
    return ((st.mode & 7) & need) !== need;
  });
}

function check () {
  var bad = badPerms();
  if (!bad.length) { return 'perms ok (' + watched().length + ' paths readable by jibo-skill)'; }
  var e = new Error('NOT readable by jibo-skill:\n  ' + bad.map(function (f) {
    return ('000' + modeOf(f).toString(8)).slice(-3) + ' ' + f;
  }).join('\n  ') + '\nRepair: ./deploy.sh fixperms (linux box), or on Jibo: node register.js fixperms ' + beRoot);
  e.permCheck = true;
  throw e;
}

function fixperms () {
  var bad = badPerms();
  bad.forEach(function (f) {
    fs.chmodSync(f, modeOf(f) | (fs.statSync(f).isDirectory() ? R_DIR : R_FILE));
  });
  return bad.length ? 'fixed ' + bad.length + ' path(s)' : 'nothing to fix';
}

function status () {
  var p = readJson(PKG);
  var inLazy = p.jibo.lazySkills.indexOf(ID) >= 0;
  var inMenu = false;
  try { inMenu = !!findMenuArray(readJson(MENU), function (x) { return x.id === MENU_ID; }); } catch (e) { /* no-op */ }
  var perms;
  try { perms = check(); } catch (e) { perms = e.message; }
  return 'lazySkills=' + inLazy + ' menuTile=' + inMenu + ' menuIcon=' + fs.existsSync(ICON_DST) + '\n' + perms;
}

// ── main ────────────────────────────────────────────────────────────────────

var ACTIONS = {
  skill: function () { return [lazy(true)]; },
  tile: function () { return [menu(true), icon(true)]; },
  install: function () { return [lazy(true), menu(true), icon(true)]; },
  untile: function () { return [menu(false), icon(false)]; },
  uninstall: function () { return [menu(false), icon(false), lazy(false)]; }
};

try {
  if (ACTIONS[action]) {
    // Adding things to a tree Be already can't read hides the real fault: refuse up front.
    // (Removing is allowed on a broken tree; safeWrite leaves what it touches readable.)
    if (['skill', 'tile', 'install'].indexOf(action) >= 0) { check(); }
    var out = ACTIONS[action]();
    out.push(check());
    console.log('register v' + VERSION + ': ' + out.join('; '));
  } else if (action === 'status') { console.log(status()); }
  else if (action === 'check') { console.log(check()); }
  else if (action === 'fixperms') { console.log(fixperms() + '; ' + check()); }
  else {
    console.error('usage: node register.js skill|tile|install|untile|uninstall|status|check|fixperms <beRoot>');
    process.exit(2);
  }
} catch (e) {
  console.error('register.js v' + VERSION + ' failed: ' + e.message);
  process.exit(1);
}
