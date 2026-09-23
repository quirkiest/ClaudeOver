#!/usr/bin/env bash
# deploy.sh v0.3.2 - push the ClaudeOver skill (@be/claude) to Jibo. Run on the LINUX BOX.
#
#   ./deploy.sh install     STAGE 1: copy skill + lazySkills entry. Reboot, check eye + menu.
#   ./deploy.sh tile        STAGE 2: add ClaudeOver menu tile + icon. Reboot, check menu.
#   ./deploy.sh code        copy index.js/client/config only (hot-reloads on next tap, no reboot)
#   ./deploy.sh status      installed version, registration, permissions, last launch dump
#   ./deploy.sh check       exit 1 if anything Be reads is not readable by user jibo-skill
#   ./deploy.sh fixperms    repair: make everything Be reads world-readable (recovery)
#   ./deploy.sh untile      remove the menu tile + icon only
#   ./deploy.sh uninstall   remove tile, icon, lazySkills entry and skill files
#
# v0.3.2: BEam's skill host runs as `jibo-skill` and root's umask on Jibo is 077,
#   so files root creates are 600 = unreadable = no eye / no menu. Every remote
#   session now runs `umask 022`, chmods what it writes, and ends with a check.
#   Install is split into two stages so a bad tile can't take the menu down with it.
#
# Env: JIBO_HOST (default 192.168.20.40), GATEWAY_ENV (default ../gateway/.env,
#      then ~/jibo-gateway/.env) - source of GATEWAY_TOKEN + BIND_ADDR/PORT for the
#      skill's config.json (written into the pushed copy only, never into the repo). Each action is ONE ssh session, so
# one password prompt ("jibo"). Tip: `ssh-copy-id root@$JIBO_HOST` to skip it.
set -euo pipefail

VERSION=0.3.2
JIBO_HOST=${JIBO_HOST:-192.168.20.40}
BE=${JIBO_BE:-/opt/jibo/Jibo/Skills/@be/be}   # override only for local testing
DEST=$BE/skills/claude
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/claude"
SSH=${JIBO_SSH:-"ssh -o ConnectTimeout=5 root@$JIBO_HOST"}

skill_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$SRC/package.json" | head -1; }

STAGE=/tmp/claude-deploy
WCHK="touch $BE/.claude-wtest 2>/dev/null && rm -f $BE/.claude-wtest || { echo 'ERROR: $BE is read-only. Try: mount -o remount,rw /'; exit 1; }"
# every remote session: umask 022 (root's default on Jibo is 077 -> files jibo-skill can't read), unpack stage
PRE="umask 022; rm -rf $STAGE && mkdir -p $STAGE && tar -xf - -C $STAGE"
REG="node $STAGE/tools/register.js"

# ── skill config.json from the gateway's .env ───────────────────────────────
find_env() {
  for f in "${GATEWAY_ENV:-}" "$HERE/../gateway/.env" "$HOME/jibo-gateway/.env"; do
    [ -n "$f" ] && [ -f "$f" ] && { echo "$f"; return; }
  done
  echo "ERROR: gateway .env not found (set GATEWAY_ENV=/path/to/.env)" >&2; exit 1
}
env_val() { sed -n "s/^$1=//p" "$2" | tail -1 | tr -d '\r'; }

WORK=""
stage_local() {
  local envf token host port
  envf=$(find_env)
  token=$(env_val GATEWAY_TOKEN "$envf"); host=$(env_val BIND_ADDR "$envf"); port=$(env_val PORT "$envf")
  [ ${#token} -ge 16 ] || { echo "ERROR: GATEWAY_TOKEN missing/short in $envf" >&2; exit 1; }
  { [ -z "$host" ] || [ "$host" = "0.0.0.0" ]; } && host=192.168.20.26
  WORK=$(mktemp -d)
  cp -r "$SRC" "$WORK/claude"; cp -r "$HERE/tools" "$WORK/tools"
  printf '{\n  "gatewayHost": "%s",\n  "gatewayPort": %s,\n  "token": "%s"\n}\n' "$host" "${port:-8765}" "$token" > "$WORK/claude/config.json"
  echo "config: gateway $host:${port:-8765} (token from $envf)" >&2
}
cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; }
trap cleanup EXIT

# Ship skill (+config.json) + tools as one tar to a staging dir on Jibo (single ssh session).
push_all() { tar --format=ustar -C "$WORK" -cf - claude tools; }   # call stage_local first (main shell)

REBOOT_HINT="  $SSH reboot"

case "${1:-}" in
  install)
    stage_local
    echo "deploy v$VERSION: STAGE 1 - installing @be/claude v$(skill_version) to $JIBO_HOST (no menu tile yet)"
    push_all | $SSH "set -e; $PRE
      $WCHK
      mkdir -p $DEST && cp -r $STAGE/claude/. $DEST/
      chmod -R a+rX $DEST
      $REG skill $BE
      echo installed: \$(sed -n 's/.*\"version\": *\"\\([^\"]*\\)\".*/\\1/p' $DEST/package.json | head -1)
      rm -rf $STAGE"
    echo
    echo "NEXT: reboot Jibo, wait for the eye, tap it and check the menu opens:"
    echo "$REBOOT_HINT"
    echo "Only if eye + menu are fine: ./deploy.sh tile"
    echo "If not: ./deploy.sh fixperms, reboot; still bad: ./deploy.sh uninstall, reboot."
    ;;
  tile)
    stage_local
    echo "deploy v$VERSION: STAGE 2 - adding ClaudeOver menu tile on $JIBO_HOST"
    push_all | $SSH "set -e; $PRE
      $WCHK
      test -f $DEST/index.js || { echo 'ERROR: skill not installed - run ./deploy.sh install first'; exit 1; }
      $REG tile $BE
      rm -rf $STAGE"
    echo
    echo "NEXT: reboot Jibo, then Menu -> 'ClaudeOver' (after Bad Apple):"
    echo "$REBOOT_HINT"
    echo "Menu broken? ./deploy.sh untile, reboot."
    ;;
  code)
    echo "deploy v$VERSION: pushing index.js (skill v$(skill_version)) to $JIBO_HOST"
    stage_local
    tar --format=ustar -C "$WORK/claude" -cf - index.js package.json gateway_client.js config.json | $SSH "set -e; umask 022; $WCHK
      test -d $DEST || { echo 'ERROR: skill not installed'; exit 1; }
      tar -xf - -C $DEST && chmod a+r $DEST/index.js $DEST/package.json $DEST/gateway_client.js $DEST/config.json
      ls -l $DEST/index.js"
    echo "Hot reload: next tile tap loads the new index.js (mtime changed). No reboot."
    echo "If launch.rule or the icon changed, use 'install' + reboot instead."
    ;;
  status|check|fixperms|untile|uninstall)
    stage_local
    ACT=$1
    push_all | $SSH "$PRE
      case $ACT in
        status)
          echo '== installed'; sed -n 's/.*\"version\": *\"\\([^\"]*\\)\".*/\\1/p' $DEST/package.json 2>/dev/null | head -1 || echo none
          echo '== registration + permissions'; $REG status $BE
          echo '== last speak'; cat /tmp/claude-skill-last-speak.txt 2>/dev/null || echo none
          echo '== last launch dump'; cat /tmp/claude-skill-last.json 2>/dev/null || echo none ;;
        untile|fixperms) $WCHK; $REG $ACT $BE ;;
        uninstall) $WCHK; $REG uninstall $BE && rm -rf $DEST && echo removed $DEST ;;
        *) $REG $ACT $BE ;;
      esac; rc=\$?
      rm -rf $STAGE; exit \$rc"
    case $ACT in untile|uninstall|fixperms) echo "Reboot Jibo to apply:"; echo "$REBOOT_HINT" ;; esac
    ;;
  *)
    sed -n '2,20p' "$0"; exit 2 ;;
esac
