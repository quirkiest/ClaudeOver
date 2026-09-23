# ClaudeOver skill (`@be/claude`) v0.2.3 · deploy v0.3.2

| Component | Version |
|---|---|
| skill (`claude/`) | **0.2.3** (exit hint: double-tap screen). 0.2.2: new icon |
| `assets/claude-icon.svg` | icon source: white speech bubble + spark on transparent, 300×300. Render to `claude/resources/icons/claude.png` (same style as the other menu icons; the tile gradient shows through) |
| `claude/gateway_client.js` | 0.2.0. A copy of `gateway/client/gateway_client.js`; the tests check they're identical. |
| `deploy.sh` | **0.3.2** (two-stage install, umask 022, permission check/repair) |
| `tools/register.js` | **0.3.0** (mode-preserving writes, `check`, `fixperms`, `skill`/`tile`/`untile`) |
| `test/harness.js` | 0.2.0 |
| `test/deploy.test.sh` | 0.1.0 (runs `deploy.sh` against a mock BEam tree with Jibo's 077 umask) |

This is an on-robot BEam skill that appears as a **ClaudeOver** tile in Jibo's
main menu, after Bad Apple. Tapping it:

1. shows a panel: **ClaudeOver v0.2.3** with the instructions,
2. says "Switching to Claude mode.",
3. calls `POST /v1/takeover {state:"on"}` on the gateway,
4. exits at once, so the gateway's ROM session can take over about 2.5 s later.

Exiting Claude mode (double-tap the screen, swipe down, head hold, "Claude off", idle) is done
by the gateway, not by this skill.

On failure it says what happened (no config, gateway unreachable, or token
rejected) and exits. Jibo is never left stuck on the panel.

The skill still has a `launch.rule` ("ask Claude…") for when voice launch of
community skills works on BEam/5x1. It doesn't work today.

## ⚠ Permissions: read this first

BEam's skill host (electron `skill-main.js`) runs as the user **`jibo-skill`**,
not root. Root's umask on Jibo is **077**, so any file root *creates* over SSH
is `600` and invisible to Be. If `@be/be/package.json` (or the menu JSON) can't
be read, Jibo boots with **no eye and no menu**. This happened on 2026-09-23
after a restore from 600 backups. It was fixed with `chmod 644` and a reboot.

When hand-editing anything under `/opt/jibo/Jibo/Skills/@be/be` on Jibo, run
`umask 022` first and check the result with `ls -l`. From the linux box,
`./deploy.sh check` verifies the tree and `./deploy.sh fixperms` repairs it.

## Deploy (from the linux box, Jibo in normal mode)

The install happens in **two stages**, so a bad tile can't take the menu down
with it:

```bash
cd ~/ClaudeOver/skill
./deploy.sh install              # STAGE 1: skill files + lazySkills entry only
ssh root@192.168.20.40 reboot    # wait for the eye, tap it, and check the menu opens
./deploy.sh tile                 # STAGE 2: ClaudeOver tile + icon
ssh root@192.168.20.40 reboot    # check the menu again, then tap ClaudeOver
./deploy.sh status               # registration, permissions, last launch dump
```

Each action is one SSH session (one password prompt, "jibo"). Every remote
session:

- runs `umask 022`,
- chmods what it writes to be world-readable,
- **ends with a permission check** (`register.js check`), which exits non-zero
  if any file Be reads is unreadable by `jibo-skill`.

Stage 1 and stage 2 also *refuse to start* if the tree is already broken.

`install` does the following:

- It reads `GATEWAY_TOKEN`, `BIND_ADDR` and `PORT` from the gateway's `.env`
  (`../gateway/.env`, then `~/jibo-gateway/.env`, or `GATEWAY_ENV=`). It writes
  them into **`config.json` in the pushed copy only**, which is gitignored and
  never in the repo.
- It copies the skill to `@be/be/skills/claude/`, then runs `chmod -R a+rX`.
- It adds `@be/claude` to `jibo.lazySkills`.

`tile` adds the ClaudeOver tile to `main-menu/resources/views/main-menu-verbal.json`
and copies the icon to `main-menu/resources/icons/claude.png` (644).

Each edited file is backed up once as `*.bak-claude`, **with the original's
mode**. Edits are written in place, which keeps the owner, the inode and the
mode (for example BEam's 777).

Other commands:

- `./deploy.sh code` pushes `index.js`, the client and the config. They
  hot-reload on the next tap, with no reboot.
- `./deploy.sh check` runs only the permission check.
- `./deploy.sh fixperms` makes everything Be reads world-readable again
  (`package.json`, the menu JSON and icon dir, `skills/claude/**`). Reboot afterwards.
- `./deploy.sh untile` removes only the tile and the icon. The skill stays.
- `./deploy.sh uninstall` removes the tile, the icon, the lazySkills entry and
  the skill files. Reboot afterwards.

## Recovery: no eye, or the menu won't open

On Jibo, as root:

```sh
cd /opt/jibo/Jibo/Skills/@be/be
find . -maxdepth 6 ! -perm -004 2>/dev/null | grep -v node_modules   # anything listed = unreadable by Be
chmod 644 package.json skills/main-menu/resources/views/main-menu-verbal.json
reboot
```

If that isn't enough, restore the originals with `cp package.json.bak-claude package.json`
(the same for the menu JSON), then `chmod 644` both files and reboot.

**Warning:** `update-beam.sh` will probably overwrite BEam's `package.json` and
the menu files. Re-run `./deploy.sh install` and `./deploy.sh tile` after any BEam update.

## First-run checks

- **The tile does nothing, or Jibo says "I don't understand":** the menu's
  `destination` → skill mapping may not map `claude` to `@be/claude`. Run
  `./deploy.sh status`. If there's no launch dump, check on Jibo:
  `grep -o ".\{80\}destination.\{120\}" /opt/jibo/Jibo/Skills/@be/be/skills/main-menu/index.js | head`
- **"I could not reach the Claude server":** check that the gateway is up
  (`curl http://192.168.20.26:8765/version` from Jibo) and that the token matches.
- `/tmp/claude-skill-last.json` on Jibo holds the launch data from the last tap.
  `/tmp/claude-skill-last-speak.txt` records which speech call worked.

## Local tests

`bash test/deploy.test.sh` runs 19 checks of the real `deploy.sh` against a
mock BEam tree, with "ssh" being a local shell under umask 077. It checks that
both stages and the code push leave every path readable, that the
2026-09-23 failure (600 `package.json`) is caught by `check` and `status` and
repaired by `fixperms`, and that a refused `tile` leaves the menu untouched.

`node test/harness.js` runs the skill against stubbed `jibo`, be-framework and
DOM, plus a fake gateway. It covers the happy path with three kinds of speech
call, a 401 from the gateway, the gateway being down, a missing config, and a
check that the client copy is identical. `index.js` must stay strict ES2015
(Electron 1.4 / Node 6.9).
