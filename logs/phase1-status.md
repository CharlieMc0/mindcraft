# Phase 1 Status — DONE ✅

## Result
**Owo handshake gate passed.** Server log:
```
[Handshake] Sending channel query
[Handshake] Receiving client channels
[Handshake] Handshake completed successfully
```

Bot now exits login phase. Bridge's hashes match server's exactly:
- `friendsforlife:main` = **535407720** ✓
- `things:main` = **1564460738** ✓
- `things:particles` (controller) = **1249300216** ✓

## Two bugs fixed this session
1. **Mineflayer ships a built-in `login_plugin_request` handler** in `node_modules/minecraft-protocol/src/client/pluginChannels.js` that always replies `data: undefined` (= success=false on the wire). Owo treated that as "client did not respond" and kicked. Fix: `client.removeAllListeners('login_plugin_request')` before attaching ours. See `src/utils/modcompat/handshake_router.js`.

2. **Owo's index counters start at 1, not 0.** OwoNetChannel's constructor pre-adds a null sentinel to both `clientHandlers` and `serverHandlers`, so the first registerServerbound's `size()` returns 1. My initial reconstruction simulated indices 0..N (with a -0/0 collision) instead of 1..N (no collision). Fix: `serverIdx = clientIdx = 1` in `OwoIntrospector.computeChannelHash`.

## Tooling built this session
- **`bridge/dumper-mod/`** — Server-side Fabric mod that reflects into owo's runtime state on `SERVER_STARTED` and prints every channel's serializersByIndex + computed hash to the server log. Drop-in jar = ground truth source for any future hash-mismatch debugging.
- **`scripts/dev/start-homestead-server.sh`** — local Homestead 1.20.1 server on :25567, offline-mode (auth bypassed). Aikar's-flags-lite GC tuning. Used for fast iteration without touching friend's :25565.
- **`mrpack-install`** at `tmp/server-tools/mrpack-install` — installs Modrinth modpack as a server (filtered to server-side mods).
- **`MODE=homestead-local`** in `run-bot.sh` — points bot at localhost:25567 with offline auth.

## Test results
- ✅ T0 baseline (vanilla) — bot spawns on Paper :25566
- ✅ T1 bridge boots — listens on :7474
- ✅ T2 owo hashes — 2 required channels + 1 controller, all match server
- ✅ T3 codec round-trip
- ✅ T4 owo responder bytes (byte-exact)
- ✅ T5 vanilla regression with new code
- ✅ **T6 Homestead — owo gate cleared end-to-end**

## Next blocker (Phase 3)
After login phase succeeds, server transitions to PLAY state and the first thing we see is:
```
[modcompat] custom_payload channel=frozenlib:registry_sync/handshake len=2
[LoginGuard] Disconnected: {"text":""}
```

`frozenlib:registry_sync/handshake` is FrozenLib's post-login registry sync. That's a play-state custom payload, not a login plugin request. Different protocol. Phase 2 (forgeconfigapiport handshakes) silently passed because their handlers tolerate success=false. Phase 3 = frozenlib (and possibly others) needs a play-state handler.

## How to run end-to-end
```
./bridge/run.sh                                     # Java bridge daemon, persistent
./scripts/dev/start-homestead-server.sh             # local Homestead server
MODE=homestead-local ./scripts/dev/run-bot.sh       # bot
```

Server log: `logs/homestead-server.log`. Bot log: `logs/bot-homestead-local-*.log`.
