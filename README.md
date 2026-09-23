# ClaudeOver

Claude as a voice mode for a revived Jibo robot (BEam firmware + 5x1 server).

Tap the **ClaudeOver** tile in Jibo's menu, and from then on every
"Hey Jibo …" goes to Claude. **Pat his head twice** to get normal Jibo back.

| Component | Version | What it is |
|---|---|---|
| [`gateway/`](gateway/) | **0.2.2** | Docker service on the LAN. Holds the API key, talks to Claude, and runs the **takeover worker**: a ROM session to Jibo that handles wake word → speech → Claude → reply. |
| [`skill/`](skill/) | **0.2.0** | On-robot BEam skill: the ClaudeOver menu tile. Tapping it asks the gateway to switch takeover on, then exits. |
| [`skill/deploy.sh`](skill/deploy.sh) | 0.3.1 | Pushes and registers the skill on Jibo from the linux box. |
| [`bridge/`](bridge/) | 0.4.0 | The original ROM bridge (`jibo_claude.js`). It's superseded by the gateway's takeover worker and kept for reference. |
| [`docs/`](docs/) | – | Handoff notes: history, dead ends, findings. |
| `compose.yaml` (root) | 0.2.1 | Includes `gateway/compose.yaml`, so `docker compose …` works from the repo root. |

## Terms

- **linux box**: the always-on Ubuntu machine that runs the gateway container (`192.168.20.26`)
- **mac**: Waz's laptop, where the repo is edited and committed
- **Jibo**: the robot (`192.168.20.40`)

## How it works

```
 Jibo menu ──tap──▶ ClaudeOver skill ──POST /v1/takeover {on}──▶ gateway (Docker, LAN)
                        │ says "Switching to Claude mode", exits          │
                        ▼                                                 │ waits 2.5 s, then
                   normal Jibo ◀──────── disconnect ◀── OFF ◀──┐          ▼ opens ROM session
                                                                │   "Hey Jibo" → on-robot ASR
  OFF = double head pat · swipe down · "Claude off" · 30 min idle   → Claude → Jibo speaks
```

Why a takeover mode: on BEam 3.1.4 + 5x1, **voice launch rules for community
skills don't fire**, and intent matching seems to happen server-side (see
`docs/`). A ROM session reliably receives speech, so ClaudeOver switches Jibo
into that mode on demand instead of trying to add a new voice intent.

While ClaudeOver is on, Jibo's own skills (clock, timers, and so on) are
suspended. That's inherent to ROM. Turn it off to get them back.

## Quick start

1. **Gateway**: on the **linux box** (always on, `192.168.20.26`), clone this repo, then:
   ```bash
   ./gateway/setup.sh --import ~/jibo-gateway/.env   # or ./gateway/setup.sh for a fresh .env
   docker compose up -d --build                      # root compose.yaml includes gateway/
   ```
   Details: [`gateway/README.md`](gateway/README.md).
2. **Skill**: from the same clone, with Jibo in *normal* mode, run
   `./skill/deploy.sh install`, then reboot Jibo once. It reads the token from
   `gateway/.env` automatically. See [`skill/README.md`](skill/README.md).
3. On Jibo: **Menu → ClaudeOver**, then "Hey Jibo, how far is Melbourne from London?"
4. Double-pat his head to exit.

**Update loop:** `git pull && docker compose up -d --build`, plus
`./skill/deploy.sh code` if `skill/` changed.

You can also switch it from the linux box without the tile:
`node gateway/client/gateway_client.js --takeover on|off|toggle`
(with `GATEWAY_TOKEN` set).

## Security

Jibo exposes an unauthenticated ROM API (:8160) and a Node debug inspector
(:10223) to the LAN, so **keep him on a trusted or isolated network**. The
gateway requires a bearer token and an IP allowlist, and the Anthropic API key
never leaves the linux box. Set a monthly spend limit in the Anthropic console.

## Versioning

Every component shows its version at runtime (gateway: startup log, `/version`,
`x-gateway-version`; skill: on its screen panel; Claude mode: on-screen text).
Any code change bumps the component's version.
