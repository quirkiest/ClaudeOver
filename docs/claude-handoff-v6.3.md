# Jibo Revival — Claude Handoff v0.6.3

Supersedes v0.6.2. Written 2026-09-23.

**Status: WORKING** (laptop-hosted ROM bridge, `jibo_claude.js` v0.4.0).
**New direction (v0.6.0): hybrid architecture** — on-robot skill with an
"ask Claude" trigger + containerised gateway service on the LAN. See §1 and §10.

**Read §11 before building anything** — check community tools first.

---

## ⏸ STATUS: PARKED (23 Sep 2026)

Waz decided to **pause until OpenJibo / BEam / 5x1 develop further**. The
**laptop server is powered down.** A question about voice-launching custom
skills has been posted on the Revival Discord; check for replies first when
resuming.

### Why parked

- The on-robot skill **installs, loads and registers**. BEacon lists
  `@be/claude V0.1.0` as **ON + VOICE**.
- **Voice launch rules don't fire for any community skill** on BEam 3.1.4 + 5x1:
  - "hey jibo, jukebox" (ON + VOICE) → "I don't understand"
  - "doom" → "I don't understand"; doom is OFF (not registered)
  - "play bad apple" → "I can only play that on Beam". The server may not
    recognise this robot as BEam; a server-side registration issue is suspected.
  - "ask Claude" → nothing; `open()` was never called and no dump was written.
  - Intent matching appears to happen server-side (5x1), not from local `launch.rule` files.
- **Touch launch works** (Bad Apple from the main menu), but a touch-only Claude
  tile was judged to have no real value, so v0.1.1 (menu tile) was **built but
  NOT deployed**.

### State of each component

| Component | Version | State |
|---|---|---|
| jibo-gateway (Docker, laptop) | 0.1.0 | Working; tested end to end with curl and from Jibo. **Laptop powered off.** |
| `@be/claude` skill | 0.1.0 **installed on Jibo** | Registered in lazySkills, never launched. Harmless. |
| `@be/claude` skill | 0.1.1 | Built (adds menu tile + icon), **not deployed** |
| deploy.sh / tools/register.js | 0.2.0 | Built, tested locally, not yet used on Jibo |
| jibo_claude.js (ROM bridge) | 0.4.0 | Still the only working voice path (takeover mode) |

**Leftover on Jibo:** `@be/claude` v0.1.0 in `skills/claude` plus a lazySkills
entry (backup at `@be/be/package.json.bak-claude`). To remove it, run the
v0.1.0 `deploy.sh uninstall` and reboot. Otherwise leave it; it's inert.

### Resume checklist

1. Read the Discord replies. Check for BEam / 5x1 updates, specifically custom
   voice launch or a documented skill-registration mechanism.
2. Power up the laptop. Confirm it's still on `.26`, or update `BIND_ADDR` /
   `ALLOW_IPS`. `docker compose up -d` in `~/jibo-gateway` (it
   auto-starts if Docker is enabled). Then `curl http://192.168.20.26:8765/version`.
3. **If voice launch now works:** `./deploy.sh install` with the latest skill,
   reboot, say "hey jibo, ask Claude", then `./deploy.sh status` to read the
   launch dump (where the utterance lands).
4. **If still no voice launch:** options in order of preference:
   - (a) Deploy v0.1.1 via the menu tile *once*, only to verify the
     speak/exit/launch dump, which de-risks the skill.
   - (b) Refactor `jibo_claude.js` into a thin client of the gateway, so the
     working ROM bridge gets sessions, speech shaping and end detection (~1h).
   - (c) Resident listener: a warmed lazy skill subscribes to
     `jibo.jetstream.events.*` and switches to itself on "ask Claude…".
     Fragile, a last resort.
5. **Next skill build (v0.2.0), once it can launch:** use the speak API
   confirmed by the probe, then listen → `client/gateway_client.js` → speak
   → loop until `end:true` → `exit()`.

### Unresolved unknowns

- The main-menu `destination` → skill mapping. Some destinations (`fun`,
  `snapshot`) aren't skill names. Check `@be/be/index.js` or `main-menu/index.js`
  with `grep -o ".\{80\}destination.\{120\}"` before relying on the tile.
- The listen API inside a skill (candidates: `jibo.embodied.listen.*`,
  `jibo.jetstream.*`).
- Whether port 10223 (Chrome DevTools via `chrome://inspect`) connects. It
  would give live logs and a JS console in the skill runtime.

### Housekeeping notes

- Set a monthly spend limit in the Anthropic console before leaving the gateway
  unattended.
- Reserve `.26` for the laptop in the router's DHCP (if not done yet).
- BusyBox `grep -r` over `/opt/jibo` or `skills/` hangs, because of large
  video/WAD files. Search single files or small directories only.

## 0b. Changes since v0.6.1: skill route investigated

Every §10-T gate has passed or is moot.

| Gate | Result |
|---|---|
| 1'. Robot → gateway over HTTP | **PASS.** `curl http://192.168.20.26:8765/version` from Jibo returns JSON |
| 2. Toolchain | **MOOT.** A hand-written CommonJS `index.js` is enough; no build step |
| 3. Custom launch intent | **PASS (expected).** Plain-text `launch.rule` per skill; BEam compiles it at load |
| 4. Install without signing | **PASS (expected).** Community skills (doom, bad-apple) installed the same way |
| 5. SSH in normal mode | **PASS.** Confirmed by Waz; that is how dev mode was entered |

**Robot runtime:** Node **v6.9.2**, Electron 1.4. Plain CommonJS and ES2015:
`class`, arrows and `const` are fine; no async/await, no fetch. The shell is
BusyBox: **`grep` has no `--include`** (that silently broke an earlier search).
Use `find … -exec grep` instead.

**How BEam loads skills** (`/opt/jibo/Jibo/Skills/@be/be/`):

- `package.json` → `jibo.skills` (loaded at boot) and `jibo.lazySkills`
  (loaded on first open). **A new skill must be added to `lazySkills`.**
- `skills-resolve.js` maps `@be/<name>` → `skills/<name>/` and puts Be's
  `node_modules` on NODE_PATH, so `require('jibo')` and
  `require('@be/be-framework')` work.
- `skill-registry.js`: lazy skills **hot-reload when `index.js` mtime changes**.
  Code edits need no reboot; registry and launch.rule changes need one reboot.
- The skill folder contains: `package.json` (with
  `jibo.launchRule: "launch.rule"`, `jibo.main: "index.html"`,
  `type: "asset-pack"`), `launch.rule`, `index.html`, and `index.js`
  (`module.exports = class extends BeSkill`).
- Lifecycle: `postInit(done)`, `preload(done)`, `open(result, refresh, prev)`,
  `close(done)`. Exit via `this.exit()`.
- Reference skill with TypeScript source: `skills/bad-apple/src/index.ts`.
- launch.rule syntax: `TopRule = $* ( a | (b c) ) $* {skill='\@be/x'};`,
  where `?` means optional and `$NAME` refers to a sub-rule.
- The speech APIs seen in use: `jibo.tts.speak(`, `jibo.embodied.speech.speak(`,
  `jibo.embodied.listen.exitActiveMode(`, `jibo.jetstream.setHotwordMode(`,
  `jibo.jetstream.events.hjHeard`. The listen API is still to be confirmed.

**Built:** `jibo-claude-skill` v0.1.0 (probe build: launch → dump `result` → speak
→ exit) plus `deploy.sh` v0.1.0 (`install` / `code` / `status` / `uninstall`,
one ssh session each, backs up `package.json` to `.bak-claude`).

**Watch:** `update-beam.sh` will probably overwrite `@be/be/package.json`;
re-run `deploy.sh install` after any BEam update.

## 0a. Changes since v0.6.0

- **jibo-gateway v0.1.0 DEPLOYED and working** on the laptop in Docker.
  End-to-end curl → gateway → Claude returns a spoken-style reply.
- **Laptop IP is now `192.168.20.26`** (DHCP moved it off .20). All references
  have been updated. **TODO: reserve .26 on the router.**
- Deploy gotchas hit (all resolved):
  1. `BIND_ADDR` must be an address the host actually owns; otherwise
     `bind: cannot assign requested address`.
  2. Curl from the laptop itself arrives from the Docker bridge
     (`172.18.0.1`), not .26. It's now in `ALLOW_IPS`. It is only reachable
     from the host, so this is safe.
  3. `TOKEN` is a per-shell variable. Re-run
     `TOKEN=$(grep ^GATEWAY_TOKEN .env | cut -d= -f2)` in each new SSH session.
- Live `.env`: `BIND_ADDR=192.168.20.26`,
  `ALLOW_IPS=192.168.20.40,192.168.20.26,172.18.0.1`.
- **Next:** Gate 1' (robot → gateway over HTTP), then the §10-T investigation.

## 0. Changes since v0.5.0

- **Jibo-LLM ruled out.** It exists but is unmaintained, and it uses Parakeet
  ASR (NVIDIA NeMo, runs off-robot, needs its own host and ideally a GPU,
  English/European languages only). Ours uses on-robot local ASR, which works
  well. Ours stands. §11a closed.
- **Architecture decision: hybrid.** The ROM bridge is a *full takeover* (§6):
  while it runs, Jibo's own skills are suspended and the bridge has to handle
  every interaction. Replaced by: an on-robot skill that launches only on
  "Hey Jibo, ask Claude…", calling a gateway service on the LAN.
- **The hybrid removes Gate 1 (TLS) as a fatal risk.** The robot talks plain
  HTTP to the gateway on the LAN, and only the gateway talks TLS to Anthropic.
  The API key also stays off the robot.
- **Hosting decision:** the Ubuntu laptop (192.168.20.26) is the always-on
  host for now. The gateway **runs in a container** (Docker + compose) so it
  can be moved to a Pi, NAS or mini PC later without changes.
- **"Hey Claude" as a wake word is judged infeasible.** "Hey Jibo" is a trained
  acoustic keyword-spotter model inside the ASR service, not a text setting.
  Target trigger: **"Hey Jibo, ask Claude …"** as a launch intent.

---

## 1. Architecture

### 1a. Target (v0.6.0+)

```
"Hey Jibo, ask Claude …"
        │
Jibo 192.168.20.40 (normal mode, native skills intact)
  │  BEam NLU matches "ask Claude" → launches @local/claude skill
  │  skill: listen → HTTP POST (LAN, plain http) → say reply → loop/exit
  ▼
Ubuntu laptop 192.168.20.26  (always-on, for now)
  ┌─ docker: jibo-gateway ───────────────────┐
  │  POST /v1/ask   GET /healthz  /version    │
  │  API key, sessions, routing, TLS          │
  └───────────────┬───────────────────────────┘
                  ▼ https
          api.anthropic.com
```

### 1b. Current / fallback (v0.4.0 ROM bridge)

```
laptop: node jibo_claude.js ── ws :8160 ──▶ Jibo @be/remote (takeover)
                             ◀── :8088 wakeword/ASR
```

**The ROM bridge and the skill cannot run at the same time.** A ROM session
seizes the foreground and suspends Jibo's skills, including ours. Stop the
bridge before testing the skill.

**Jibo must be in `normal` mode.** Not `int-developer`. See §4.

---

## 2. Hardware / network

| Item | Value |
|---|---|
| Jibo IP | `192.168.20.40` |
| Ubuntu laptop / gateway host | `192.168.20.26` (wazza@ubuntu-1), Node 18.19.1 |
| Working dir | `~/jibo-bridge` (bridge), `~/jibo-gateway` (gateway, planned) |
| Gateway port | **`8765`** (proposed) |
| SSH (dev mode only) | `ssh root@192.168.20.40` password `jibo` |
| BEacon | `http://192.168.20.40:8123` (normal mode — not yet checked) |

### Ports on Jibo (confirmed, bound 0.0.0.0)

| Port | Process | Role |
|---|---|---|
| **8160** | node (`jibo-ssm.js`) | ROM Command API (bridge target) |
| **8088** | jibo-asr-service | wakeword watcher connects here directly |
| 8089 | jibo-tts-service | |
| 8090 | jibo-jetstream-service | local ASR/VAD/speaker-ID stack |
| 8123 | BEacon | web control panel (normal mode) |
| 8181 | jibo-service-registry | internal plumbing, NOT a client surface |
| 8282 / 8383 | body / audio | |
| 8489 / 8585 | identity / system-manager | |
| 8484, 8486 | lps | |
| 8888 | server-service | |
| 10223 | **node debug inspector** | see §3 |
| 22 | sshd | dev mode |

---

## 3. SECURITY

1. **Port 10223 is the Node debug inspector, open to the LAN.** It gives
   arbitrary JS execution as root, with mic/speaker/motor/camera handles.
   No password.
2. **Port 8160 accepts unauthenticated websocket connections.**
3. **(new) The gateway token will live on the robot** and is therefore
   readable by anyone on the LAN (via #1). The token grants only "ask Claude
   through the gateway", not the API key. Mitigations: firewall 8765 to Jibo's
   IP only, a per-request `max_tokens` cap, a rate limit, and a monthly spend
   limit in the Anthropic console.

Keep Jibo on an isolated VLAN or trusted home LAN. Never guest wifi, never an
office LAN, never port-forwarded. Never expose 8765 beyond the LAN.

---

## 4. Modes

`post-mod.sh` ends with `jibo-setmode normal` + `reboot`. That is the intended
end state.

`int-developer` loads `SkillsServiceSim`, so no skill process runs, the screen
shows a **checkmark** instead of eyes, and the ROM socket throws
`Cannot read property 'send' of undefined`. Nothing works.

```bash
jibo-setmode normal && reboot          # eyes, skills running, ROM usable
jibo-setmode int-developer && reboot   # root SSH, nothing functional
```

**Open question:** whether SSH works in `normal` mode. It is needed for skill
deployment. If it doesn't, the edit/deploy loop is: dev mode → copy → normal
mode → test, which is slow. Check this early (§10-T).

---

## 5. Key API facts (ROM / rom-control)

- Client library: `rom-control` (npm, `Paskooter/rom-control`).
- Protocol schema: `@jibo/command-protocol` on npm (`lib/requestSchema.json`,
  `lib/responseSchema.json`).
- **`result.content`, NOT `result.speech`.**
- **`jibo.audio.watchWakeword()` must be called explicitly.** Speech is not a
  ROM subscription; the watcher opens its own connection to 8088.
- **The wakeword watcher and `listenLocalASR` contend for ASR.**
  `stopWakeword()` → listen → `watchWakeword()`.
- **Restart the watcher only AFTER the reply finishes speaking.**
- `awaitSpeech` defaults to `mode: 'local'` (on-robot ASR, good).
- **Pass both `time` and `noSpeechTime`** (15s works); `min()` of the two applies.
- On-robot ASR quality is excellent.

These are ROM-side facts. The skill will use the in-process `jibo.*` APIs
instead. The same ASR-contention rule probably applies there too.

---

## 6. ROM is a takeover mode

While a ROM session is open, `@be/remote` is the foreground skill and Jibo's
own NLU and skills are suspended (mauve ring = ROM active). The ROM bridge must
therefore reimplement everything (time, date, …). **This is the reason for the
v0.6.0 move to the hybrid skill.**

---

## 7. Files

| File | Version | Purpose |
|---|---|---|
| `jibo_claude.js` | v0.4.0 | ROM bridge. **Now the fallback.** Its routing/prompt logic gets ported into the gateway |
| `jibo_listen_test.js` | v0.1.0 | ASR isolation test |
| `jibo_events.js` | v0.1.1 | event logger |
| `jibo_probe.py` | v0.1.2 | obsolete |
| `jibo-gateway/` | **v0.1.0 (deployed)** | containerised LAN service (§10-S) |
| `jibo-claude-skill/` (`@be/claude`) | **v0.1.0 (probe, built)** | on-robot skill (§10-T) |

Bridge run: `cd ~/jibo-bridge && export ANTHROPIC_API_KEY=... && node jibo_claude.js`
Bridge env: `JIBO_HOST`, `CLAUDE_MODEL`, `JIBO_LISTEN_MS`, `JIBO_TZ`, `JIBO_PLACE`.

**Versioning rule:** every component shows its version at startup and via
`/version` (gateway) or on-screen/log (skill). Any code change bumps the version.

---

## 8. DEAD ENDS — do not repeat

1. **Developer mode.** Guarantees nothing works. A checkmark on screen means stop.
2. **Reverse-engineering the wire schema.** The schema and client were on npm.
3. **MIT workshop repo** (`jibo-workshop-hri2024`). ROS2/rosbridge, not applicable.
4. **Port 8181.** Internal plumbing.
5. **`@be/remote` as a client reference.** It's the server half.
6. **ROM subscribe for speech.** The wakeword is `audio.watchWakeword()` on 8088.
7. **Python.** The ecosystem is Node.
8. **Blaming the API key.** Test with a one-liner.
9. **Not checking community resources first.** Go to the JRG GitHub org,
   jibo.guide and Discord before building or scanning.
10. **(new) Jibo-LLM.** Unmaintained; Parakeet ASR is off-robot and limiting.
    Don't adopt.
11. **(new) Custom wake word ("Hey Claude").** It's a trained acoustic model,
    not configurable. Don't pursue unless Discord shows a solved path.

---

## 9. Open items

- Barge-in, face tracking (`subscribeEntity`), real weather API, conversation
  persistence. Persistence moves into the gateway (§10-S).
- `jibo-server-service` fails every 15s against dead `api.jibo.com`. Looks
  cosmetic.
- BEacon (:8123) not yet checked.
- BEam 3.1.4 lets you set location manually. With the hybrid approach, Jibo's
  native time and weather skills keep working, so the bridge's local handlers
  may not be needed.

---

## 10. PLAN: hybrid gateway + on-robot skill

Two workstreams, which can run in parallel. **S** (service) is low risk. **T**
(trigger/skill) is research.

### 10-S. jibo-gateway (container on the laptop)

**Goal:** a small Node HTTP service, in Docker, that takes text and returns a
short spoken-style Claude reply.

**Stack:** `node:22-alpine`, `@anthropic-ai/sdk`, no framework (plain `http`)
or a minimal one. `docker compose` with `restart: unless-stopped`.

**API (draft):**

```
POST /v1/ask
  Authorization: Bearer <GATEWAY_TOKEN>
  { "session": "jibo-1", "text": "how far is melbourne from london" }
→ 200 { "reply": "...", "session": "jibo-1", "end": false, "version": "0.1.0" }

GET /healthz  → 200 ok
GET /version  → { "name": "jibo-gateway", "version": "0.1.0", "model": "..." }
```

- `end: true` when the user says "thanks / that's all / stop", so the skill
  exits and hands Jibo back.
- Sessions live in memory with an idle TTL (e.g. 5 min). Optionally persist to
  `/data` (volume) for continuity across restarts.
- System prompt: spoken output only, no markdown/lists/URLs, short by default,
  Jibo persona. Port it from `jibo_claude.js` v0.4.0.
- Local handlers (time/date) are optional, since native skills cover them.
  Keep the "ask claude" prefix stripping.
- Config via `.env`: `ANTHROPIC_API_KEY`, `GATEWAY_TOKEN`, `CLAUDE_MODEL`,
  `MAX_TOKENS`, `SESSION_TTL_S`, `TZ`, `PLACE`, `PORT=8765`.
- Rate limit per token. Log request/latency, not full transcripts by default.

**Layout:**

```
jibo-gateway/
├── Dockerfile
├── compose.yaml
├── .env.example        # .env is gitignored
├── package.json        # version is the source of truth
├── src/server.js
└── README.md
```

**Laptop-as-server checklist:**

- Docker Engine + compose plugin installed; `systemctl enable docker`
- Don't suspend on lid close: `/etc/systemd/logind.conf` →
  `HandleLidSwitch=ignore`, `HandleLidSwitchExternalPower=ignore`, then
  `systemctl restart systemd-logind`. Also disable auto-suspend in GNOME power
  settings.
- DHCP reservation for 192.168.20.26 (the skill hardcodes it or reads it from
  config)
- `ufw allow from 192.168.20.40 to any port 8765 proto tcp`. Note: Docker's
  published ports bypass ufw by default. Either publish only to the LAN IP
  (`192.168.20.26:8765:8765`) and add a DOCKER-USER rule, or rely on token +
  LAN isolation. Decide at build time.

**Test before any robot work:** `curl` from the laptop, then from another LAN
machine.

### 10-T. Trigger + on-robot skill

**First, find out how BEam routes intents.** The original Jibo did launch NLU
in the cloud. BEam replaced that cloud, and it is unknown whether intents now
resolve locally (Jetstream :8090) or via 5x1. That determines how an
"ask Claude" launch rule gets registered.

Investigation order:

1. **BEacon (:8123):** skill list. Which skills are loaded, and are any
   community-added?
2. **The community Home Assistant integration**
   (https://jibo.guide/haint/). It's voice-triggered from normal Jibo, calls
   an external LAN service and speaks the result, the same pattern as ours.
   How it registers its intent answers Gates 2–4. **Highest-value lead.**
3. On the robot: look for `.rule` / `.fst` files and how existing skills
   declare `launchRule`:
   ```bash
   find /opt/jibo -name "*.rule" 2>/dev/null | head -50
   find /opt/jibo -name "*.fst"  2>/dev/null | head -50
   grep -rl "launchRule" /opt/jibo/Jibo/Skills --include=package.json 2>/dev/null
   node --version
   ```
4. Discord: ask directly how to add a custom launch intent under BEam 3.1.4.

**Gates (revised):**

| Gate | Status | Notes |
|---|---|---|
| 1. TLS to api.anthropic.com | **moot** | the skill talks plain HTTP to the gateway |
| 1'. Robot → laptop:8765 over HTTP | to test | trivial `curl` / `node -e http.get` from the robot |
| 2. Build toolchain (`jibo-dev`, `be-framework`) | open | probably copy from the robot's own `node_modules` |
| 3. Custom NLU launch rule | **key unknown** | see investigation above |
| 4. Skill install without signing | open | the mod remounts rw; possibly just drop in a directory |
| 5. SSH/deploy in normal mode | open | governs the edit/deploy loop speed |

**Trigger fallbacks** if Gate 3 fails:

1. Repurpose an existing compiled intent belonging to a dead cloud skill, and
   replace that skill's code with ours.
2. Physical trigger: head touch or screen gesture launches the Claude skill.

**Skill shape** (from `@be/remote`, `/opt/jibo/Jibo/Skills/@be/be/skills/remote/`):

```
claude-skill/
├── package.json          # "@local/claude", jibo{launchRule,...}
├── index.js              # extends BeSkill: open() / close(done)
├── index.html
├── animdb-manifest.json
├── mims/
└── resources/
```

- `open(result)` → `result.nlu` may carry the utterance after "ask Claude",
  so the first question arrives with the launch.
- Loop: POST to the gateway → `say` the reply → listen → repeat until
  `end: true` or silence → `close(done)`.
- Use Node's `http` module only (the robot's Node is old; no `fetch`, no SDK).
- Show the version on screen/log at `open`.

**Build order:**

1. S: gateway v0.1.0 in a container, tested with curl. *(Can start now.)*
2. T: investigation 1–4 above, plus Gate 1' (robot → gateway reachable).
3. T: hello-world skill; launch by any means, speak a fixed line.
4. T: skill → gateway round trip with a hardcoded question.
5. T: listen → gateway → say loop.
6. T: "ask Claude" launch intent (or fallback trigger).

---

## 11. Community ecosystem — CHECK BEFORE BUILDING

The Jibo Revival Group (JRG) is an organised, active FOSS community.
https://github.com/Jibo-Revival-Group

- **11a. Jibo-LLM:** closed. Unmaintained, Parakeet ASR. See §0 / dead end 10.
- **11b. BEacon:** web panel on `:8123`. Jukebox, eye image, loaded skills,
  BEam updates. Docs: `docs/beacon.md` in the BEam repo. Not yet checked.
- **11c. Version:** we are on BEam v3.1.4 (17 Sep 2026): redesigned BEacon,
  screen viewing/control, manual location, lazy background skill loading.
- **11d. Home Assistant integration:** the reference pattern for §10-T.
- jibo.guide lists "Build and run custom skills" as **Work In Progress**.
  Be-A-Maker drives Jibo live from a tablet; it is not a skill compiler.

| Resource | URL |
|---|---|
| Modding guide | https://jibo.guide/ |
| BEam-a-Maker tutorial | https://jibo.guide/guides/bamtut/ |
| Home Assistant pairing | https://jibo.guide/haint/ |
| Useful ports | https://jibo.guide/reference/useful-ports/ |
| SSM reference | https://jibo.guide/reference/ssm/ |
| Platform debugging | https://jibo.guide/platform-software/platform-debugging-techniques-and-root-cause-analysis/ |
| GitHub org | https://github.com/Jibo-Revival-Group |
| BEam | https://github.com/Jibo-Revival-Group/BEam |
| BEefy | https://github.com/Jibo-Revival-Group/BEefy |
| Discord | https://discord.gg/CBVJzkRGwN |

Other repos: `JiboExperiments`, `BEaker`, `BammyIDE`, `Be-A-Maker`,
`Be-a-maker-Scratch`, `JiboAutoMod`.

---

## 12. Reference

- `rom-control`: https://github.com/Paskooter/rom-control (API.md)
- `@jibo/command-protocol`: npm, JSON Schema files
- Original Jibo SDK: https://github.com/jefniro/jibo-sdk
- Mod scripts on the robot: `/opt/jibo/Jibo/Skills/`: `post-mod.sh`,
  `point-at-server.sh`, `5x1-patch.sh`, `update-beam.sh`
- Credentials: `/var/jibo/credentials.json` → `http://joap.5x1.com:80`
- Anthropic Messages API: `POST https://api.anthropic.com/v1/messages`,
  headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type`
