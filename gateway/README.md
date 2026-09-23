# ClaudeOver gateway (jibo-gateway) v0.2.0

This is a LAN service in Docker. It does two jobs:

1. **Claude service.** `POST /v1/ask` takes text and returns a short spoken-style
   reply, with per-session history, speech shaping and end-of-conversation
   detection.
2. **Takeover worker (ClaudeOver mode).** On `POST /v1/takeover {on}` it opens a
   ROM session to Jibo (`rom-control`). In that mode "Hey Jibo" → on-robot speech
   recognition → Claude → Jibo speaks. The loop is ported from the proven
   `bridge/jibo_claude.js` v0.4.0.

```
Jibo skill / curl ──http :8765──▶ gateway ──https──▶ api.anthropic.com
                                     └──ws :8160 / :8088──▶ Jibo (takeover only)
```

## API

| Method | Path | Auth | Body → Response |
|---|---|---|---|
| GET | `/healthz` | none | `{ok, version}` |
| GET | `/version` | none | `{name, version, model, sessions, takeover}` |
| POST | `/v1/ask` | Bearer | `{session?, text, reset?}` → `{reply, esml, end, route, session, turns, version}` |
| POST | `/v1/reset` | Bearer | `{session}` → `{ok, existed}` |
| GET | `/v1/takeover` | Bearer | → `{takeover: {state, since, reason, turns, jiboHost, idleMinutes}}` |
| POST | `/v1/takeover` | Bearer | `{state: on\|off\|toggle, reason?}` → `{takeover, reply, esml}` |

Every error body carries a speakable `reply`/`esml` too.

### Takeover states and exits

`off → starting → on → stopping → off`

- **Start:** waits `TAKEOVER_START_DELAY_MS` (2.5 s) so the menu skill can exit
  first, then connects. It gives up after 45 s with reason `error: connect timeout`.
- **On:** Jibo says "Claude mode is on…" and the screen shows the instructions
  plus the version (`TAKEOVER_SCREEN=text`; set it to `eye` to keep the normal eye).
- **Ways to exit:**
  - **double head pat** (two separate touches within 1.5 s; one long touch doesn't count)
  - **swipe down** on the screen
  - saying **"Claude off" / "stop Claude" / "normal mode"** after "Hey Jibo"
  - **idle timeout** (`TAKEOVER_IDLE_MIN`, default 30)
  - `POST /v1/takeover {off}`
- A stop requested mid-answer lets the answer finish first, then says goodbye.
- If the ROM session drops, `rom-control` reconnects and the wake word is re-armed.
- Gateway shutdown (container stop or restart) releases Jibo immediately.

## Install on the gateway host (Ubuntu laptop, 192.168.20.26)

```bash
# Docker (skip if `docker compose version` works)
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2
sudo systemctl enable --now docker && sudo usermod -aG docker $USER   # re-login

cd ~/ClaudeOver/gateway          # or wherever the repo is cloned
mkdir -p data
cp .env.example .env && chmod 600 .env
sed -i "s/^GATEWAY_TOKEN=.*/GATEWAY_TOKEN=$(openssl rand -hex 24)/" .env
read -rsp "API key: " K && sed -i "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$K|" .env && unset K; echo
docker compose up -d --build && docker compose logs -f     # "jibo-gateway v0.2.0 listening"
```

## Test

```bash
TOKEN=$(grep ^GATEWAY_TOKEN .env | cut -d= -f2)
curl -s http://192.168.20.26:8765/version; echo
curl -s http://192.168.20.26:8765/v1/ask -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"session":"t","text":"ask claude say hi"}'; echo

# ClaudeOver without the tile:
GATEWAY_TOKEN=$TOKEN GATEWAY_HOST=192.168.20.26 node client/gateway_client.js --takeover on
GATEWAY_TOKEN=$TOKEN GATEWAY_HOST=192.168.20.26 node client/gateway_client.js --takeover off
docker compose logs -f | grep takeover
```

**Offline tests** (no key, no robot): `npm install && npm test`. This runs 16
takeover-worker tests against a fake rom-control client and 20 HTTP
end-to-end tests against a fake Anthropic API.

**Curl from the host itself returns 403:** Docker's bridge address
(`172.18.0.1`) must be in `ALLOW_IPS`. Check `docker compose logs | grep rejected`.

## Gotchas (learned the hard way)

- `BIND_ADDR` must be an address the host actually owns. Otherwise you get
  `bind: cannot assign requested address`.
- `TOKEN` in your shell is per-session. Re-read it from `.env` in each new SSH session.
- Jibo must be in **normal** mode for takeover. In `int-developer` mode (checkmark
  on screen), ROM connects but nothing works.
- **Don't run `bridge/jibo_claude.js` at the same time.** Two ROM clients will fight.

## Laptop as an always-on server

```bash
sudo sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/; s/^#\?HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
sudo systemctl restart systemd-logind      # + Settings → Power → Automatic Suspend: Off
```

Reserve `192.168.20.26` for the laptop in the router's DHCP settings.

## Security

- Docker-published ports bypass ufw. The real controls are `BIND_ADDR`,
  `ALLOW_IPS` and the token. Never port-forward 8765.
- The token also lives on Jibo (in the skill's `config.json`), which has an open
  debug inspector, so treat it as readable by anyone on the LAN. It grants Claude
  access and takeover control, nothing else. Backstops: `RATE_PER_MIN`,
  `MAX_TOKENS`, and a monthly spend limit in the Anthropic console.
- Transcripts are only logged when `LOG_TRANSCRIPTS=1`.

## Versioning

`package.json` is the source of truth. **On every code change:** bump
`package.json` and the `compose.yaml` `image:` tag and header (`npm test` fails
if they differ), plus this README's title.

| File | Version |
|---|---|
| `src/server.js` | 0.2.0 |
| `src/takeover.js` | 0.2.0 (new) |
| `client/gateway_client.js` | 0.2.0 (adds `takeover()` and `--takeover` CLI) |
| `test/smoke.js` / `test/takeover.test.js` | 0.2.0 |
