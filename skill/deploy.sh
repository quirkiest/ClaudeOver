#!/usr/bin/env bash
# deploy.sh v0.3.1 - push the ClaudeOver skill (@be/claude) to Jibo. Run on the LINUX BOX.
#
#   ./deploy.sh install     copy skill + register (lazySkills, menu tile, icon); then reboot Jibo
#   ./deploy.sh code        copy index.js only (hot-reloads on next "ask Claude", no reboot)
#   ./deploy.sh status      show installed version, registry entry, last launch dump
#   ./deploy.sh uninstall   unregister + remove skill (restores nothing else)
#
# Env: JIBO_HOST (default 192.168.20.40), GATEWAY_ENV (default ../gateway/.env,
#      then ~/jibo-gateway/.env) - source of GATEWAY_TOKEN + BIND_ADDR/PORT for the
#      skill's config.json (written into the pushed copy only, never into the repo). Each action is ONE ssh session, so
# one password prompt ("jibo"). Tip: `ssh-copy-id root@$JIBO_HOST` to skip it.
set -euo pipefail

VERSION=0.3.1
JIBO_HOST=${JIBO_HOST:-192.168.20.40}
BE=${JIBO_BE:-/opt/jibo/Jibo/Skills/@be/be}   # override only for local testing
DEST=$BE/skills/claude
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/claude"
SSH=${JIBO_SSH:-"ssh -o ConnectTimeout=5 root@$JIBO_HOST"}

skill_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$SRC/package.json" | head -1; }

STAGE=/tmp/claude-deploy
WRITABLE_CHECK="touch $BE/.claude-wtest 2>/dev/null && rm -f $BE/.claude-wtest || { echo 'ERROR: $BE is read-only. Try: mount -o remount,rw /'; exit 1; }"

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

case "${1:-}" in
  install)
    stage_local
    echo "deploy v$VERSION: installing @be/claude v$(skill_version) to $JIBO_HOST"
    push_all | $SSH "set -e; $WRITABLE_CHECK
      rm -rf $STAGE && mkdir -p $STAGE && tar -xf - -C $STAGE
      mkdir -p $DEST && cp -r $STAGE/claude/. $DEST/
      node $STAGE/tools/register.js install $BE
      echo installed: \$(sed -n 's/.*\"version\": *\"\\([^\"]*\\)\".*/\\1/p' $DEST/package.json | head -1)
      rm -rf $STAGE"
    echo
    echo "NEXT: reboot Jibo once so BEam picks up the registry, menu tile and launch rule:"
    echo "  $SSH reboot"
    echo "Then open Jibo's menu -> 'ClaudeOver' tile (next to Bad Apple). Afterwards: ./deploy.sh status"
    ;;
  code)
    echo "deploy v$VERSION: pushing index.js (skill v$(skill_version)) to $JIBO_HOST"
    stage_local
    tar --format=ustar -C "$WORK/claude" -cf - index.js package.json gateway_client.js config.json | $SSH "set -e; $WRITABLE_CHECK
      tar -xf - -C $DEST && ls -l $DEST/index.js"
    echo "Hot reload: next tile tap loads the new index.js (mtime changed). No reboot."
    echo "If launch.rule changed, use 'install' + reboot instead."
    ;;
  status)
    stage_local
    push_all | $SSH "rm -rf $STAGE && mkdir -p $STAGE && tar -xf - -C $STAGE
      echo '== installed'; sed -n 's/.*\"version\": *\"\\([^\"]*\\)\".*/\\1/p' $DEST/package.json 2>/dev/null | head -1 || echo none
      echo '== registration'; node $STAGE/tools/register.js status $BE
      echo '== last speak'; cat /tmp/claude-skill-last-speak.txt 2>/dev/null || echo none
      echo '== last launch dump'; cat /tmp/claude-skill-last.json 2>/dev/null || echo none
      rm -rf $STAGE"
    ;;
  uninstall)
    stage_local
    push_all | $SSH "set -e; $WRITABLE_CHECK
      rm -rf $STAGE && mkdir -p $STAGE && tar -xf - -C $STAGE
      node $STAGE/tools/register.js uninstall $BE
      rm -rf $DEST $STAGE && echo removed $DEST"
    echo "Reboot Jibo to drop the tile and launch rule:  $SSH reboot"
    ;;
  *)
    sed -n '2,11p' "$0"; exit 2 ;;
esac
