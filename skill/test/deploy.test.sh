#!/usr/bin/env bash
# deploy.test.sh v0.1.0 - runs deploy.sh v0.3.2 against a MOCK BEam tree, with
# "ssh" replaced by a local shell that has Jibo's root umask (077). Asserts that
# everything Be reads stays world-readable (the 2026-09-23 no-eye bug).
#   bash test/deploy.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
BE=$T/be
pass=0; fail=0
ok()   { echo "PASS  $1"; pass=$((pass+1)); }
bad()  { echo "FAIL  $1"; fail=$((fail+1)); }
mode() { stat -c %a "$1"; }

# mock BEam tree, originals 777 like on Jibo
mkdir -p $BE/skills/main-menu/resources/views $BE/skills/main-menu/resources/icons $BE/skills/bad-apple
cat > $BE/package.json <<'J'
{ "name": "@be/be", "jibo": { "skills": ["@be/main-menu"], "lazySkills": ["@be/bad-apple"] } }
J
cat > $BE/skills/main-menu/resources/views/main-menu-verbal.json <<'J'
{ "viewConfig": { "list": [ { "id": "clock", "action": {} }, { "id": "bad-apple", "action": {} }, { "id": "doom", "action": {} } ] } }
J
chmod -R 777 $BE
printf 'GATEWAY_TOKEN=tok-0123456789abcdef0123\nBIND_ADDR=192.168.20.26\nPORT=8765\n' > $T/.env

export JIBO_BE=$BE GATEWAY_ENV=$T/.env
cat > $T/fakessh <<'S'
#!/usr/bin/env bash
umask 077
exec bash -c "$1"
S
chmod +x $T/fakessh
export JIBO_SSH=$T/fakessh

D=$HERE/deploy.sh
unreadable() { find $BE -path '*.broken' -prune -o \( -type f ! -perm -004 -o -type d ! -perm -005 \) -print; }

# 1. stage 1
out=$($D install 2>&1); rc=$?
[ $rc -eq 0 ] && ok "install exits 0" || { bad "install exits 0"; echo "$out"; }
grep -q '@be/claude' $BE/package.json && ok "lazySkills has @be/claude" || bad "lazySkills has @be/claude"
grep -q '"claude"' $BE/skills/main-menu/resources/views/main-menu-verbal.json && bad "stage 1 must NOT add tile" || ok "stage 1 leaves menu alone"
[ -z "$(unreadable)" ] && ok "stage 1: everything world-readable" || { bad "stage 1 perms"; unreadable; }
[ "$(mode $BE/package.json)" = 777 ] && ok "package.json keeps 777" || bad "package.json mode $(mode $BE/package.json)"
[ -f $BE/package.json.bak-claude ] && [ "$(mode $BE/package.json.bak-claude)" = 777 ] && ok "backup copies original mode" || bad "backup mode"
[ -f $BE/skills/claude/config.json ] && grep -q tok-0123 $BE/skills/claude/config.json && ok "config.json pushed" || bad "config.json"

# 2. stage 2
out=$($D tile 2>&1); rc=$?
[ $rc -eq 0 ] && ok "tile exits 0" || { bad "tile exits 0"; echo "$out"; }
node -e "const m=require('$BE/skills/main-menu/resources/views/main-menu-verbal.json').viewConfig.list.map(x=>x.id);if(m.join()!=='clock,bad-apple,claude,doom')process.exit(1)" \
  && ok "tile inserted after bad-apple" || bad "tile position"
[ "$(mode $BE/skills/main-menu/resources/icons/claude.png)" = 644 ] && ok "icon is 644" || bad "icon mode $(mode $BE/skills/main-menu/resources/icons/claude.png)"
[ -z "$(unreadable)" ] && ok "stage 2: everything world-readable" || { bad "stage 2 perms"; unreadable; }

# 3. code push
$D code >/dev/null 2>&1 && [ -z "$(unreadable)" ] && ok "code push keeps perms" || bad "code push perms"

# 4. check catches the exact 2026-09-23 failure, fixperms repairs it
chmod 600 $BE/package.json $BE/skills/main-menu/resources/views/main-menu-verbal.json
$D check >/dev/null 2>&1 && bad "check should fail on 600 package.json" || ok "check fails on 600 package.json"
st=$($D status 2>&1); echo "$st" | grep -q 'NOT readable' && ok "status reports unreadable files" || bad "status perms report"
$D untile >/dev/null 2>&1; chmod 600 $BE/package.json   # tile gone, tree broken again
$D tile >/dev/null 2>&1 && bad "tile must refuse on broken perms" || ok "tile refuses on broken perms"
grep -q '"claude"' $BE/skills/main-menu/resources/views/main-menu-verbal.json && bad "refused tile must not touch menu" || ok "refused tile leaves menu untouched"
$D fixperms >/dev/null 2>&1 && [ -z "$(unreadable)" ] && ok "fixperms repairs" || { bad "fixperms"; unreadable; }

# 5. untile / uninstall
$D untile >/dev/null 2>&1 && ! grep -q '"claude"' $BE/skills/main-menu/resources/views/main-menu-verbal.json \
  && [ ! -f $BE/skills/main-menu/resources/icons/claude.png ] && grep -q '@be/claude' $BE/package.json \
  && ok "untile removes tile+icon, keeps skill" || bad "untile"
$D uninstall >/dev/null 2>&1 && [ ! -d $BE/skills/claude ] && ! grep -q '@be/claude' $BE/package.json \
  && [ -z "$(unreadable)" ] && ok "uninstall clean + readable" || bad "uninstall"

echo; echo "$pass/$((pass+fail)) deploy tests passed"
[ $fail -eq 0 ]
