# ClaudeOver skill (`@be/claude`) v0.2.0

| Component | Version |
|---|---|
| skill (`claude/`) | **0.2.0** (ClaudeOver menu tile) |
| `claude/gateway_client.js` | 0.2.0. A copy of `gateway/client/gateway_client.js`; the tests check they're identical. |
| `deploy.sh` | 0.3.0 |
| `tools/register.js` | 0.2.1 |
| `test/harness.js` | 0.2.0 |

This is an on-robot BEam skill that appears as a **ClaudeOver** tile in Jibo's
main menu, after Bad Apple. Tapping it:

1. shows a panel: **ClaudeOver v0.2.0** with the instructions,
2. says "Switching to Claude mode.",
3. calls `POST /v1/takeover {state:"on"}` on the gateway,
4. exits at once, so the gateway's ROM session can take over about 2.5 s later.

Exiting Claude mode (double head pat, swipe down, "Claude off", idle) is done
by the gateway, not by this skill.

On failure it says what happened (no config, gateway unreachable, or token
rejected) and exits. Jibo is never left stuck on the panel.

The skill still has a `launch.rule` ("ask Claude…") for when voice launch of
community skills works on BEam/5x1. It doesn't work today.

## Deploy (from the gateway host, Jibo in normal mode)

```bash
cd ~/ClaudeOver/skill
./deploy.sh install              # one ssh password prompt ("jibo")
ssh root@192.168.20.40 reboot    # once, so BEam picks up the menu tile
./deploy.sh status               # after tapping the tile
```

`install` does all of the following:

- reads `GATEWAY_TOKEN`, `BIND_ADDR` and `PORT` from the gateway's `.env`
  (`../gateway/.env`, then `~/jibo-gateway/.env`, or `GATEWAY_ENV=`), and
  writes them into **`config.json` in the pushed copy only**. That file is
  never in the repo (it's gitignored).
- copies the skill to `@be/be/skills/claude/`.
- runs `tools/register.js` on Jibo, which:
  - adds `@be/claude` to `jibo.lazySkills`,
  - adds the ClaudeOver tile to `main-menu/resources/views/main-menu-verbal.json`,
  - copies the icon to `main-menu/resources/icons/claude.png`.
  Each file is backed up once as `*.bak-claude`.

Other commands:

- `./deploy.sh code` pushes `index.js`, the client and the config. It
  hot-reloads on the next tap, with no reboot.
- `./deploy.sh uninstall` removes the files and the registration. Reboot afterwards.

**Warning:** `update-beam.sh` will probably overwrite BEam's `package.json` and
the menu files. Re-run `./deploy.sh install` after any BEam update.

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

`node test/harness.js` runs the skill against stubbed `jibo`, be-framework and
DOM, plus a fake gateway. It covers the happy path with three kinds of speech
call, a 401 from the gateway, the gateway being down, a missing config, and a
check that the client copy is identical. `index.js` must stay strict ES2015
(Electron 1.4 / Node 6.9).
