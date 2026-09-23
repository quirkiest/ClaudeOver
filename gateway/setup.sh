#!/usr/bin/env bash
# setup.sh v0.1.0 - first-time (or repair) setup of the ClaudeOver gateway .env
# on the linux box. Safe to re-run: never overwrites an existing value
# unless you pass --reset-ip.
#
#   ./setup.sh                 create/complete .env, data/, print next steps
#   ./setup.sh --reset-ip      re-detect this host's LAN IP (after a DHCP change)
#   ./setup.sh --import PATH   take ANTHROPIC_API_KEY + GATEWAY_TOKEN from an old
#                              .env (e.g. ~/jibo-gateway/.env) so Jibo's skill
#                              config keeps working
#
# Env: JIBO_HOST (default 192.168.20.40).
set -euo pipefail

VERSION=0.1.0
HERE="$(cd "$(dirname "$0")" && pwd)"
ENVF="$HERE/.env"
JIBO_HOST=${JIBO_HOST:-192.168.20.40}
RESET_IP=0
IMPORT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --reset-ip) RESET_IP=1 ;;
    --import)   IMPORT="${2:-}"; shift ;;
    -h|--help)  sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

get() { sed -n "s/^$1=//p" "$ENVF" | tail -1 | tr -d '\r'; }
set_kv() {  # set_kv KEY VALUE  (replace or append; value may contain / and &)
  local k="$1" v="$2" tmp
  tmp=$(mktemp)
  if grep -q "^$k=" "$ENVF"; then
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k {print k"="v; next} {print}' "$ENVF" > "$tmp"
  else
    cat "$ENVF" > "$tmp"; printf '%s=%s\n' "$k" "$v" >> "$tmp"
  fi
  cat "$tmp" > "$ENVF"; rm -f "$tmp"
}
blank_or_placeholder() { local v; v=$(get "$1"); [ -z "$v" ] || [ "$v" = "sk-ant-..." ]; }

echo "ClaudeOver gateway setup v$VERSION  ($HERE)"

# ── prerequisites ───────────────────────────────────────────────────────────
command -v docker >/dev/null || { warn "docker not installed:  sudo apt-get install -y docker.io docker-compose-v2"; exit 1; }
docker compose version >/dev/null 2>&1 || { warn "docker compose plugin missing:  sudo apt-get install -y docker-compose-v2"; exit 1; }
ok "docker $(docker --version | sed 's/Docker version //; s/,.*//'), compose $(docker compose version --short 2>/dev/null)"

# ── .env ────────────────────────────────────────────────────────────────────
if [ ! -f "$ENVF" ]; then
  cp "$HERE/.env.example" "$ENVF"; ok "created .env from .env.example"
else
  ok ".env exists - completing missing values only"
fi
chmod 600 "$ENVF"
# add any keys new in .env.example (e.g. after an upgrade) without touching existing ones
while IFS= read -r line; do
  case "$line" in ''|\#*) continue ;; esac
  k=${line%%=*}
  grep -q "^$k=" "$ENVF" || { printf '%s\n' "$line" >> "$ENVF"; say "added new key $k (default)"; }
done < "$HERE/.env.example"

if [ -n "$IMPORT" ]; then
  [ -f "$IMPORT" ] || { warn "import file not found: $IMPORT"; exit 1; }
  for k in ANTHROPIC_API_KEY GATEWAY_TOKEN; do
    v=$(sed -n "s/^$k=//p" "$IMPORT" | tail -1 | tr -d '\r')
    [ -n "$v" ] && { set_kv "$k" "$v"; ok "imported $k from $IMPORT"; }
  done
fi

# token
if [ "$(get GATEWAY_TOKEN | wc -c)" -lt 17 ]; then
  set_kv GATEWAY_TOKEN "$(openssl rand -hex 24)"; ok "generated GATEWAY_TOKEN"
  warn "new token: re-run skill/deploy.sh install so Jibo's skill gets it"
else
  ok "GATEWAY_TOKEN present"
fi

# API key
if blank_or_placeholder ANTHROPIC_API_KEY; then
  if [ -t 0 ]; then
    read -rsp "  Anthropic API key (input hidden): " K; echo
    [ -n "$K" ] && { set_kv ANTHROPIC_API_KEY "$K"; ok "ANTHROPIC_API_KEY set"; }
    unset K
  else
    warn "ANTHROPIC_API_KEY not set (no terminal to prompt) - edit .env"
  fi
else
  ok "ANTHROPIC_API_KEY present"
fi

# LAN IP: the source address this host uses to reach Jibo
IP=""
if command -v ip >/dev/null; then
  IP=$(ip -4 route get "$JIBO_HOST" 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1 || true)
fi
on_host() { command -v ip >/dev/null && ip -4 addr 2>/dev/null | grep -q "inet $1/"; }
CUR_BIND=$(get BIND_ADDR)
if [ -z "$IP" ]; then
  warn "could not detect LAN IP towards $JIBO_HOST - check BIND_ADDR/ALLOW_IPS by hand"
elif [ "$RESET_IP" = 1 ] || [ -z "$CUR_BIND" ] || ! on_host "$CUR_BIND"; then
  [ -n "$CUR_BIND" ] && [ "$CUR_BIND" != "$IP" ] && warn "BIND_ADDR $CUR_BIND is not on this host - switching to $IP"
  set_kv BIND_ADDR "$IP"; ok "BIND_ADDR=$IP"
else
  ok "BIND_ADDR=$CUR_BIND (on this host)"
fi

# ALLOW_IPS: Jibo + this host + docker bridge gateway (for curl from the host)
HOST_IP=$(get BIND_ADDR)
BRIDGE=$(docker network inspect jibo_default -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)
[ -z "$BRIDGE" ] && BRIDGE=172.18.0.1
want="$JIBO_HOST,$HOST_IP,$BRIDGE"
cur=$(get ALLOW_IPS)
merged=$(printf '%s,%s\n' "$cur" "$want" | tr ',' '\n' | sed '/^$/d' | awk '!s[$0]++' | paste -sd, - || true)
[ "$merged" != "$cur" ] && { set_kv ALLOW_IPS "$merged"; ok "ALLOW_IPS=$merged"; } || ok "ALLOW_IPS=$cur"
set_kv JIBO_HOST "$JIBO_HOST"

mkdir -p "$HERE/data"; ok "data/ ready"

# ── next steps ──────────────────────────────────────────────────────────────
cat <<EOF

Next (from the repo root, or from gateway/):
  docker compose up -d --build        # start / rebuild after git pull
  docker compose logs -f              # expect: "jibo-gateway v$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HERE/package.json" | head -1) listening"
  curl -s http://$HOST_IP:$(get PORT)/version; echo

If the old ~/jibo-gateway container is still running, stop it first:
  (cd ~/jibo-gateway && docker compose down)
EOF
