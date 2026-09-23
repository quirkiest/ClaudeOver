# ClaudeOver — Claude Handoff v0.7.1

Supersedes `claude-handoff-v6.3.md` (kept in this folder for history: dead
ends, BEam internals, the gate results). Written 2026-09-23.

**Terms (agreed 2026-09-23):**

- **linux box**: the always-on Ubuntu gateway host, `192.168.20.26`
- **mac**: Waz's laptop, where the repo is edited and committed
- **Jibo**: the robot, `192.168.20.40`

Never say "the laptop"; it's ambiguous.

**Status: BUILT, NOT YET DEPLOYED.** The project has moved from *parked* to
**ClaudeOver**, a menu-tile switch into a gateway-hosted takeover mode.
Repo: `~/GitHub/ClaudeOver` on the mac (Waz commits/pushes) → `git clone` to `~/ClaudeOver` on the linux box, and run it from there.

---

## 1. The idea (Waz, 2026-09-23)

Voice launch of custom skills doesn't work on BEam 3.1.4 + 5x1 (handoff v6.3).
The **ROM takeover does work** (`bridge/jibo_claude.js` v0.4.0, normal mode). So:

- a **touch tile** (reliable, since menu launches work) flips a switch,
- the **always-on gateway** holds a ROM session while the switch is on,
- a **double head pat** (or swipe down, "Claude off", or idle) flips it back.

No dev mode is involved. That was only ever for filesystem inspection.

## 2. Architecture

```
Tile tap → skill (@be/claude v0.2.0): speak → POST /v1/takeover {on} → exit
Gateway v0.2.1 (Docker on the linux box, .26:8765): waits 2.5 s → rom-control Client → Jibo :8160/:8088
  hotword → stopWakeword → awaitSpeech(local, 15s/15s) → converse('takeover') → say → watchWakeword
  exits: double head pat (2 touch-starts ≤1.5 s) | swipe down | OFF_RE voice | idle 30 min | POST {off}
```

`converse()` is shared by `POST /v1/ask` and the worker, so both get the
sessions, speech shaping, end detection and local time/date answers.

## 3. Components

| Path | Version | State |
|---|---|---|
| `gateway/` | 0.2.1 | Built. Run from the clone: root `compose.yaml` includes `gateway/compose.yaml` (project `jibo`); `gateway/setup.sh` 0.1.0 writes `.env`. 36 offline tests pass (16 worker tests with a fake rom-control, 20 HTTP tests with a fake Anthropic API). **Not yet run against the real Jibo.** |
| `skill/claude` | 0.2.0 | Built. 7 harness tests pass. Strict ES2015. |
| `skill/deploy.sh` | 0.3.1 | Generates `config.json` (token, host) from the gateway `.env`, pushed copy only. Tested against a mock BEam tree. |
| `skill/tools/register.js` | 0.2.1 | lazySkills + menu tile "ClaudeOver" + icon. Idempotent, `*.bak-claude` backups. |
| `bridge/jibo_claude.js` | 0.4.0 | Legacy/fallback. **Never run alongside the takeover.** |

**Currently on Jibo:** `@be/claude` **v0.1.0** (the probe) is registered in
lazySkills, with no menu tile. `deploy.sh install` overwrites it with 0.2.0 and
adds the tile.

**Linux box:** `192.168.20.26` (DHCP reservation pending), powered down since
2026-09-23. It still has gateway **v0.1.0** in `~/jibo-gateway` (compose project
`jibo`). The first `docker compose up` from the clone replaces that container
in place, because the project name is the same.

## 4. Deploy / test plan (next session)

All steps run on the **linux box** unless noted.

1. **Clone and set up:**
   ```bash
   git clone <repo> ~/ClaudeOver && cd ~/ClaudeOver
   ./gateway/setup.sh --import ~/jibo-gateway/.env    # keeps the API key and the token Jibo already has
   docker compose up -d --build && docker compose logs -f
   ```
   Check that `/version` shows `0.2.1` and `takeover: off`.
2. **Test the takeover without the tile first:**
   `cd gateway && GATEWAY_TOKEN=$(grep ^GATEWAY_TOKEN .env|cut -d= -f2) GATEWAY_HOST=192.168.20.26 node client/gateway_client.js --takeover on`
   Expect Jibo to say "Claude mode is on…" and show the instruction text. Then
   "Hey Jibo, …" → answer. Then a double pat → "Okay, back to normal Jibo" →
   eyes. This checks the ROM path and the exits with no skill involved.
3. `./skill/deploy.sh install`, then `ssh root@192.168.20.40 reboot`.
4. On Jibo: Menu → **ClaudeOver** → panel + "Switching to Claude mode" →
   takeover starts. Run `./skill/deploy.sh status` to see the launch dump and
   which speech call worked.
5. Check the rest: swipe down, "Claude off", mid-answer double pat (the answer
   finishes first), and the idle timeout (temporarily set `TAKEOVER_IDLE_MIN=1`).
6. **Iterating:** edit on the mac → commit/push → on the linux box `git pull`,
   then `docker compose up -d --build` (gateway) and/or `./skill/deploy.sh code`
   (skill). Delete `~/jibo-gateway` once the clone is running.

## 5. Known unknowns and risks

| Unknown | How it shows up | Fallback |
|---|---|---|
| Menu `destination:"claude"` → `@be/claude` mapping | Tile does nothing / "I don't understand" | Inspect `main-menu/index.js` destination mapping (grep command in `skill/README.md`) |
| `display.showText` rendering in ROM | Odd or blank screen | `TAKEOVER_SCREEN=eye` |
| Head-touch event cadence (`onHeadTouch` fires on every pad change) | Double pat too eager or too hard | Tune `doublePatMs` (currently 1500) in `takeover.js` |
| ROM grabbing the foreground while the skill closes | Takeover never becomes `on` (connect timeout) | Raise `TAKEOVER_START_DELAY_MS` |
| rom-control version | The old bridge on the linux box used an older build; the gateway pins `^2.0.2` (API checked: `content`, `hotword`, `headTouch.activePads`, `gesture.isSwipe/direction`, `display.showText`) | Pin whichever version the bridge ran |
| Long ROM sessions (hours) | Drops | rom-control auto-reconnect + re-arm, and the 30-minute idle off |

## 6. Rules carried forward (see v6.3 for the full list)

- Jibo must be in **normal** mode. A checkmark on screen = dev mode = nothing works.
- The transcript is in `.content`. Stop the wake word before listening, re-arm
  it only **after** speaking, and pass both `time` and `noSpeechTime`.
- BusyBox: `grep` has no `--include`, and recursive grep over skills/ hangs
  (video and WAD files).
- `update-beam.sh` probably wipes the registration, so re-run `deploy.sh install` after it.
- Security: Jibo's :8160 and :10223 are open on the LAN. The token on Jibo is
  LAN-readable. Set a spend limit in the Anthropic console.
