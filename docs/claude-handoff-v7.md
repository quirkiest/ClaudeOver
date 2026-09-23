# ClaudeOver — Claude Handoff v0.7.2

Supersedes `claude-handoff-v6.3.md` (kept in this folder for history: dead
ends, BEam internals, the gate results). Written 2026-09-23.

**Terms (agreed 2026-09-23):**

- **linux box**: the always-on Ubuntu gateway host, `192.168.20.26`
- **mac**: Waz's laptop, where the repo is edited and committed
- **Jibo**: the robot, `192.168.20.40`

Never say "the laptop"; it's ambiguous.

**Status (2026-09-23 evening):**

- **Gateway 0.2.3 is live and verified on Jibo.** The takeover works via CLI and
  Claude answers. The swipe-down, double-pat and head-hold exits all work, and
  there's no self-wake.
- **"Claude off" by voice doesn't work yet.** It needs the `onListenResult`
  transcript with `TAKEOVER_DEBUG=1` so `OFF_RE` can be extended. Set
  `TAKEOVER_DEBUG` back to 0 afterwards.
- **Skill: not installed.** The first `deploy.sh` 0.3.1 install broke the menu,
  and a restore later caused a no-eye boot (see §7). Jibo is **fully reverted and
  healthy**: eye, menu and "Hey Jibo" all work, `@be/claude` is not in
  lazySkills, and there is no tile. `deploy.sh` 0.3.2 / `register.js` 0.3.0 fix
  the cause, but they haven't been run on Jibo yet.

Repo: `~/GitHub/ClaudeOver` on the mac (Waz commits and pushes), and
`~/ClaudeOver` on the linux box (a clone over SSH with the deploy-key alias
`github-claudeover`).

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
Tile tap → skill (@be/claude v0.2.1): speak → POST /v1/takeover {on} → exit
Gateway v0.2.3 (Docker on the linux box, .26:8765): waits 2.5 s → rom-control Client → Jibo :8160/:8088
  hotword → stopWakeword → awaitSpeech(local, 15s/15s) → converse('takeover') → say → watchWakeword
  exits: double head pat (2 touch-starts ≤1.5 s, gap >280 ms) | head hold ≥2 s | swipe down | OFF_RE voice | idle 30 min | POST {off}
```

`converse()` is shared by `POST /v1/ask` and the worker, so both get the
sessions, speech shaping, end detection and local time/date answers.

## 3. Components

| Path | Version | State |
|---|---|---|
| `gateway/` | 0.2.3 | **Running on the linux box, verified with Jibo.** Gap-based double pat and hold, greeting before arming the wakeword, close code 4000 → off, `TAKEOVER_DEBUG`. 24 worker tests + 20 HTTP tests. |
| `skill/claude` | 0.2.1 | Built, not installed. 7 harness tests. Strict ES2015. |
| `skill/deploy.sh` | 0.3.2 | Two-stage install (`install` = skill + lazySkills; `tile` = tile + icon). `umask 022`, `chmod -R a+rX`, and a permission check after every action. New `check`, `fixperms` and `untile` commands. `test/deploy.test.sh`: 19 checks against a mock tree with umask 077. |
| `skill/tools/register.js` | 0.3.0 | Writes files in place (keeps the owner and mode) and forces them world-readable. Backups copy the original's mode. Refuses to add anything to an unreadable tree. |
| `bridge/jibo_claude.js` | 0.4.0 | Legacy/fallback. **Never run alongside the takeover.** |

**Currently on Jibo:** nothing of ours. The original `package.json` and
`main-menu-verbal.json` were restored from `*.bak-claude` and are now 644. The
`*.bak-claude` files are 644 (identical to the current files). The `*.broken`
copies are 600 and can be deleted.

**Linux box:** `192.168.20.26` (DHCP reservation pending). Gateway 0.2.3 runs
from `~/ClaudeOver` (compose project `jibo`, container `jibo-gateway`). You can
delete `~/jibo-gateway`.

## 4. Next steps

All steps run on the **linux box** unless noted.

1. `git pull` (brings in `deploy.sh` 0.3.2), then `./skill/deploy.sh check`.
   Expect `perms ok`.
2. `./skill/deploy.sh install`, then reboot Jibo. **Check that the eye comes back
   and the menu opens.** If not, run `./skill/deploy.sh fixperms` and reboot; if
   that fails too, run `./skill/deploy.sh uninstall` and reboot.
3. `./skill/deploy.sh tile`, then reboot. Check the menu again, then tap
   **ClaudeOver**. Run `./skill/deploy.sh status` to see the launch dump, which
   confirms the `destination:"claude"` → `@be/claude` mapping.
   Menu broken? Run `./skill/deploy.sh untile` and reboot.
4. "Claude off": set `TAKEOVER_DEBUG=1` in `gateway/.env`, run `docker compose up -d`,
   say "Hey Jibo … Claude off", then read the transcript with
   `docker compose logs | grep -i listen`. Extend `OFF_RE` to match, then set
   `TAKEOVER_DEBUG=0`.
5. Test the idle timeout (temporarily set `TAKEOVER_IDLE_MIN=1`).

## 5. Known unknowns and risks

| Unknown | How it shows up | Fallback |
|---|---|---|
| Menu `destination:"claude"` → `@be/claude` mapping | Tile does nothing / "I don't understand" | Inspect `main-menu/index.js` destination mapping (grep command in `skill/README.md`) |
| `display.showText` rendering in ROM | Odd or blank screen | `TAKEOVER_SCREEN=eye` |
| Head-touch cadence: **resolved**. `onHeadTouch` arrives only while touched (one per pat, a stream every 50–210 ms while held), with **no release event** | — | Gap-based detection in 0.2.3 (`touchGapMs` 280, `doublePatMs` 1500, `holdMs` 2000) |
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

## 7. Incident 2026-09-23: menu dead, then no eye (root cause: permissions)

- **What happened:** `deploy.sh` 0.3.1 ran `install`. Afterwards, tapping the
  eye only dimmed the screen: no menu. Restoring the menu JSON from its backup
  didn't help. A full revert (`package.json` from `.bak-claude`, then a reboot)
  left **no eye at all**. SSH still worked.
- **Root cause:** BEam's skill host (electron `skill-main.js`,
  `--remote-debugging-port=9222`) runs as the user **`jibo-skill`**, not root.
  Root's umask on Jibo is **077**. `cp -r` into the new skill dir, and
  `register.js` 0.2.1's `writeFileSync` for the backups and the icon, both
  created **600 root:root** files. Restoring from those backups then made
  `package.json` itself 600, so Be couldn't read its registry and never started.
  The BEam originals are 777.
- **Fix on Jibo:** `chmod 644 package.json skills/main-menu/resources/views/main-menu-verbal.json`
  (plus the backups), then reboot. The eye and menu came back.
- **Prevention:** `deploy.sh` 0.3.2 / `register.js` 0.3.0 (see §3), plus a
  recovery section in `skill/README.md`.
- **Rule:** before hand-editing anything under `@be/be` on Jibo, run
  `umask 022`, then check the result with `ls -l`. After *any* change, the test
  is `find . -maxdepth 6 ! -perm -004 | grep -v node_modules`, which must print nothing.
