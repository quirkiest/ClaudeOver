# bridge/ (legacy)

`jibo_claude.js` **v0.4.0** is the original ROM bridge (it used to run by hand on the linux box): wake word
→ local ASR → Claude → TTS. It was proven working on 2026-09-22.

It's **superseded by the gateway's takeover worker** (`gateway/src/takeover.js`),
which runs the same loop inside Docker and is switched on and off from Jibo's menu.

It's kept for reference and as a fallback. **Never run it alongside the gateway
takeover**, because two ROM clients will fight.

- `jibo_listen_test.js` v0.1.0 is an ASR isolation test.
