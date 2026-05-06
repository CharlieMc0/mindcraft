# Phase 3 Status — bot SPAWNED on local server ✅ (with server-side bypass)

## Result
Bot connects to local Homestead server, gets through every login plugin gate (owo + forgeconfigapiport + others), transitions to PLAY, joins the world, runs init_message, gets dropped in spawn point.

```
[Server] GGChloe joined the game
[Bot]    GGChloe spawned.
[Bot]    received message from system : hello world
```

Subsequent disconnect (~4s later) is a mindcraft app-level error in `getBiomeName` for a modded biome the bot doesn't recognize. Unrelated to the protocol layer.

## What this took
1. ✅ `owo:handshake` — full client-side responder via bridge daemon (Phase 1).
2. ✅ `forgeconfigapiport:sync_configs` + others — `data: undefined` (success=false) ack lets server's Fabric API handlers short-circuit (Phase 2).
3. ⚠️ `frozenlib:registry_sync/handshake` — bot-side responder works but races mineflayer's auto-pong. Race resolution attempts (defer-strip, write-gate) all failed: an early `play.ping(id=1)` arrives before frozenlib's hello, mineflayer auto-pongs, server's frozenlib listener treats as case-1 GOODBYE_PING with syncVersion=-1 + requiresSync=true → kicks with empty text.
4. ✅ **Server-side bypass** — `bridge/dumper-mod` sets `ServerRegistrySync.forceDisable=true` via reflection on `SERVER_STARTED`. With `forceDisable=true`, `requiresSync()` returns false → case-1 path falls through to `continueLogin()` instead of disconnect. Server still runs the registry sync dance but doesn't enforce.

## Friend's-server caveat
The server-side bypass is dev-only. Friend's `208.83.184.145:25565` still has frozenlib's strict registry sync. Bot will hit the same kick there. Real fix needs bot-side resolution of the play.ping race (open question — see "next steps"). For now: bot works on `localhost:25567` for development, won't work on friend's server.

## Files of note
- `bridge/dumper-mod/src/main/java/com/mindcraft/dumper/ChannelHashDumper.java` — server-side mod. Dumps owo channel hashes for ground-truth + sets `ServerRegistrySync.forceDisable=true`. Drop-in jar in server's mods/ dir. Already deployed.
- `src/utils/modcompat/frozenlib_responder.js` — bot-side handshake responder + write-level pong gate. Currently disabled via comment in `handshake_router.js:22`. Keep around — needed for friend's server eventually.
- `tmp/homestead-server/` — local Fabric server, mods filtered to server-side via mrpack-install.

## Next steps (Phase 4 candidates)

A. **Real frozenlib bot-side fix.** Why does mineflayer's debug log show `play.ping(id=1)` arriving BEFORE the frozenlib hello custom_payload? FrozenLib's constructor only sends `class_6373(0)` (id=0). One of:
   - mineflayer's debug ordering is misleading; pings actually arrive in correct order, but my listener-removal races plugin init.
   - Some other mod sends a ping(1) during PLAY init.
   - vanilla MC sends a ping(1) somewhere I haven't found.
   Pin down with packet-level wireshark/tcpdump on the local server's port.

B. **mindcraft `getBiomeName` crash.** `src/agent/library/world.js:430` — biome lookup returns undefined for some modded biome IDs. App-level bug. Wrap in null-check.

C. **Bot-mod data plumbing.** Bot can now join, walk, mine vanilla. Mod blocks/items appear with mod IDs but no understanding. To "use mods" per original goal, need per-mod adapters (Tom's Storage GUI, Accessories, Farmer's Delight crops). Phase 5+ work.

## How to reproduce
```
./bridge/run.sh                                # bridge daemon (java)
./scripts/dev/start-homestead-server.sh        # local Homestead server (forceDisable patched)
MODE=homestead-local ./scripts/dev/run-bot.sh  # bot
```

Confirms bot joins. Watch `logs/homestead-server.log` for `GGChloe joined the game`.
