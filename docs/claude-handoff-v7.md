# ClaudeOver — Claude Handoff v0.7.8

Supersedes `claude-handoff-v6.3.md` (kept in this folder for history: dead
ends, BEam internals, the gate results). Written 2026-09-23.

**Terms (agreed 2026-09-23):**

- **linux box**: the always-on Ubuntu gateway host, `192.168.20.26`
- **mac**: Waz's laptop, where the repo is edited and committed
- **Jibo**: the robot, `192.168.20.40`

Never say "the laptop"; it's ambiguous.

**Status (2026-09-23 night): ClaudeOver WORKS end-to-end.**

- The skill is installed with `deploy.sh` 0.3.2 in two stages, and the permissions are clean.
- The ClaudeOver tile shows in the menu after Bad Apple.
- A tap gives "Switching to Claude mode", then `POST /v1/takeover`, then gateway `on` in about 6 s.
- The pat, hold and swipe exits are verified.
- The first tap failed ("thinking cap") only because the gateway container was down.
- **Gateway 0.2.4 and skill 0.2.2 are deployed and verified** (2026-09-23 night): the new icon,
  the formatted `/screen.svg` screen, and the "Claude off" voice exit all work on Jibo (§8).
- **Bug found in 0.2.4:** after leaving Claude mode, Jibo doesn't respond to "Hey Jibo".
  The suspect is rom-control's `destroy()`, which does `ws.terminate()` with no close frame, so
  Jibo never sees the session end. **0.2.5** (deployed) closes the ROM session cleanly (code 1000
  acknowledged), but Jibo still took **about 3 min** to hear "Hey Jibo" again. **0.2.6** (built, not
  deployed) also closes the :8088 wake-word stream cleanly (§9). **0.2.6 result: about 1 min.**
  **0.2.7** (deployed) shortened the ACO `recoveryTimeout` from 20 s to 3 s: **no change, still about 1 min.**
  The cause is on Jibo's side. Next step: Jibo's own logs during the deaf minute (location still to be found).
- **Double pat is dead** (0.2.7 debug log): Jibo sends `onHeadTouch` only when the pad pattern changes,
  with no release, so a 2nd pat on the same pad produces no event. **0.2.8 / skill 0.2.3** make
  **double-tap the screen** the exit instead (every `onTap` arrives). With 0.2.5, double pat also stopped
  working in one run, probably because Jibo was carrying stale sessions from earlier unclean
  exits. Re-test it on a freshly rebooted Jibo with `TAKEOVER_DEBUG=1`.

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
| `gateway/` | 0.2.8 | 0.2.7 is running. 0.2.8 = double-tap screen exit. 0.2.6 = clean close of the :8088 wake-word stream. 0.2.5 = clean ROM close. 0.2.4: Fuzzy voice exit, `[[EXIT]]` safety net, `/screen.svg` screen. Gap-based double pat and hold, greeting before arming the wakeword, close code 4000 → off, `TAKEOVER_DEBUG`. 24 worker tests + 20 HTTP tests. |
| `skill/claude` | 0.2.3 | 0.2.2 **installed and working** (0.2.3 = exit hint text; deploy with `./skill/deploy.sh code`) (tile after Bad Apple, original speech-bubble-and-spark icon; source `skill/assets/claude-icon.svg`). Waz may swap in his own icon later, which must be a 300×300 PNG with a **transparent** background. 7 harness tests. Strict ES2015. |
| `skill/deploy.sh` | 0.3.2 | Two-stage install (`install` = skill + lazySkills; `tile` = tile + icon). `umask 022`, `chmod -R a+rX`, and a permission check after every action. New `check`, `fixperms` and `untile` commands. `test/deploy.test.sh`: 19 checks against a mock tree with umask 077. |
| `skill/tools/register.js` | 0.3.0 | Writes files in place (keeps the owner and mode) and forces them world-readable. Backups copy the original's mode. Refuses to add anything to an unreadable tree. |
| `bridge/jibo_claude.js` | 0.4.0 | Legacy/fallback. **Never run alongside the takeover.** |

**Currently on Jibo:** `@be/claude` 0.2.1 is in lazySkills, and the tile and icon are
installed. `./skill/deploy.sh status` shows `perms ok`. The `*.broken` files can be deleted.

**Linux box:** `192.168.20.26` (DHCP reservation pending). Gateway 0.2.3 runs
from `~/ClaudeOver` (compose project `jibo`, container `jibo-gateway`). You can
delete `~/jibo-gateway`.

## 4. Next steps

1. Idle timeout test (`TAKEOVER_IDLE_MIN=1`).
2. Docker autostart on the linux box: `systemctl is-enabled docker` returned `not-found`,
   so it's probably a snap install. Check with `snap services docker`.
3. Optional: delete the `*.broken` files on Jibo, and `~/jibo-gateway` on the linux box.
4. Optional: Waz's own tile icon (300×300 PNG, transparent background). Run `install`, then `tile`, then reboot.

## 5. Known unknowns and risks

| Unknown | How it shows up | Fallback |
|---|---|---|
| Menu mapping: **resolved**. `main-menu/index.js` `redirectToSkill(dest)` → `@be/${dest}` with `nlu {intent:'menu', entities:{domain}}`. There's no filtering; the tile list is `main-menu-verbal.json` verbatim | — | — |
| `display.showText` is a **single line with no wrapping**. `display.showImage(url)` with an SVG **works** (0.2.4 verified) | — | `TAKEOVER_SCREEN=text` or `eye` if needed |
| Head touch: `onHeadTouch` fires only on a **pad-pattern change** (one per pat, a stream while held because the pads flicker), with **no release event**. So a 2nd pat on the same pad is invisible | Double pat misses | 0.2.8: double-tap the screen instead; hold still works |
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

## 8. Gateway 0.2.4 (2026-09-23)

- **Voice exit:** Jibo's local speech recognition doesn't know "Claude". "Hey Jibo … Claude off"
  got "I'm not understanding" from Claude. There are two likely causes: the recogniser mishearing it
  ("cloud of", "clawed off"), or a comma ("Claude, off") that slipped past `OFF_RE`, after which
  `stripPrefix()` passed just "off" to Claude.
  - **Fix:** `isOffCommand()` normalises the text (lowercase, no punctuation, no leading "hey jibo")
    and matches a list of garbles for "Claude".
  - **Safety net:** in takeover, Claude's system prompt tells it to reply exactly `[[EXIT]]` to an
    exit request. The worker then stops (reason `voice (claude)`).
  - Takeover no longer strips a leading "claude," from what it passes to Claude.
  - Every utterance logs `takeover heard {words, off}`. The text itself is logged only with
    `TAKEOVER_DEBUG=1` or `LOG_TRANSCRIPTS=1`.
- **Screen:** `src/screen.js` renders a 1280×720 SVG, served at `GET /screen.svg` (allowlisted IPs,
  no token). Jibo shows it with `display.showImage`.
  - `TAKEOVER_SCREEN=image` is the new default, with `text` (one short line) and `eye` as fallbacks.
  - `HOST_PORT` in `compose.yaml` builds the default `SCREEN_URL`.
- Tests: 27 worker tests + 22 HTTP tests.

## 9. Gateway 0.2.5: Jibo deaf after Claude mode (2026-09-23)

- **Symptom:** after any exit (pat, hold, swipe or voice), native Jibo doesn't respond to "Hey Jibo".
- **Suspect:** `rom-control` `destroy()` → `disconnect()` → `ws.terminate()` drops the TCP connection
  with no WebSocket close frame. Jibo's ROM server likely keeps the remote session, and with it the
  suppressed native listening, until an inactivity timeout. `CLOSE.Inactivity` is 4003.
  The old bridge mostly exited via Jibo's own head-touch exit (code 4000, closed by Jibo), so it never hit this.
- **Fix:** `Takeover._release()` stops the wakeword watcher and sets `_destroyed` / `autoReconnect=false`
  so the close doesn't trigger a reconnect. It then sends `ws.close(1000)`, waits for Jibo to
  acknowledge (at most `releaseMs`, 2 s), and only then calls `destroy()`. Server shutdown awaits the
  same release. The logs show `rom session closed cleanly {code}`.
- **0.2.5 result:** the clean ROM close worked (code 1000 acknowledged), but Jibo only heard "Hey Jibo"
  again after **about 3 minutes**. So something on Jibo times out.
- **0.2.6:** the wake-word stream (`ws://jibo:8088/simple_port`, rom-control's `WakewordWatcher`) was also
  `terminate()`d, and it's stopped and re-armed on **every turn**, so half-open sockets pile up on
  Jibo. `_stopWake()` now closes it cleanly, both per turn and in `_release()`.
- **0.2.6 result:** about 1 min (down from about 3). Double pat: the second pat didn't register (needs the
  `headTouch` debug log). Swipe down worked.
- **0.2.7:** rom-control's `_postAco()` sends `POST http://jibo:8160/request` with `{aco:{keepAliveTimeout:10000,
  recoveryTimeout:20000, remoteConfig:{inactivityTimeout:3600000}}}`. `recoveryTimeout` is most likely Jibo's
  grace period for the client to reconnect. `_tuneAco()` replaces `_postAco` to send `TAKEOVER_RECOVERY_MS`
  (default 3000) instead.
- **If there's still a delay:** look for an explicit end-session command in the ROM protocol,
  or at whether the `Speech` subscription (`Listen: true`) needs to be unsubscribed before closing.
