# nimbus-boop

**Version:** 0.1.1

Plays a short earcon on Jibo when the answer skill (`@be/nimbus`) starts its thinking animation. That happens once the server has finished transcribing, while it waits on Claude. So the boop tells you:

- "I heard you"
- how fast Whisper was: the gap between you stopping speaking and the boop

It runs **on Jibo**, with Jibo's own node, and edits `/opt/jibo/Jibo/Skills/@be/be/skills/nimbus/index.js` in place, so the file keeps its owner and mode (on BEam 3.1.4 that is `777 root:root`). Before changing anything it makes a backup, `index.js.bak-boop`, with the same owner and mode. It refuses to patch if its anchor (`if (isGQA) {`) isn't found exactly once.

| Command | What it does |
|---|---|
| `node nimbus_boop.js status` | Shows the target's mode/uid/gid, whether it's patched, the anchor match count, the backup, and the sounds available |
| `node nimbus_boop.js apply [--sound NAME]` | Inserts the boop. Default sound: `SFX_VolumeIncDec` (the volume-change blip; preloaded by the SDK) |
| `node nimbus_boop.js revert` | Restores the file from the backup, in place |

To change the sound, run `revert`, then `apply --sound <name from status>`, then reboot.

## Install

Every block says which host it runs on. **Reboot is always the last step, on its own.**

**1. Linux box:** copy the tool to Jibo.

```sh
cd ~/ClaudeOver && git pull
scp tools/nimbus-boop/nimbus_boop.js root@192.168.20.40:/tmp/
```

**2. Jibo:** check first.

```sh
jibo-mount --rw
node /tmp/nimbus_boop.js status
```

`anchor` must say **1 match(es)**. If it doesn't, stop.

**3. Jibo:** apply.

```sh
node /tmp/nimbus_boop.js apply
node /tmp/nimbus_boop.js status
```

Check that `target` and `backup` both show the same mode/uid/gid, and that `patched yes` is shown.

**4. Jibo:** reboot.

```sh
reboot
```

## Rollback (Jibo)

```sh
jibo-mount --rw
node /tmp/nimbus_boop.js revert
ls -l /opt/jibo/Jibo/Skills/@be/be/skills/nimbus/index.js
```

Then reboot on its own:

```sh
reboot
```

`/tmp` is cleared at boot, so run the `scp` from step 1 again before a later revert.

## History

- **0.1.1:** the default sound is now `SFX_VolumeIncDec`, because `SFX_Global_TurnTakingOff` wasn't audible over the thinking animation's sound. Every outcome is logged (`nimbus-boop played …`, `load failed`, `failed`).

- **0.1.0:** first version. Anchors on the `isGQA` block in `ProcessCloudState.onEntry`, and loads the SFX file if its alias isn't loaded yet.
