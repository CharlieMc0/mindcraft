# Phase 4 Status — REAL FROZENLIB FIX (no bypass) ✅

## Result
Bot connects to **friend's remote server** (`208.83.184.145:25565`) via Microsoft auth. All login plugin gates cleared, frozenlib registry sync handshake completes, bot spawns in world.

```
[owo] writing response: required=2 controllers=1 optional=0 (67 bytes)
[frozenlib] success event: client.state=play
[frozenlib] sent handshake reply v=1 (pre-emptive on login_success)
[frozenlib] hello received versions=[1]; pre-empted=true
[frozenlib] sent handshake reply v=1 (echo after pre-empt)
[modcompat] custom_payload channel=frozenlib:registry_sync/end len=0
GGChloe spawned.
```

## Root cause
**Channel name asymmetry.** Server sends Hello on `frozenlib:registry_sync/handshake`. Client must reply on `frozenlib:registry_sync/handshake_client` — different channel for the c2s direction.

Confirmed in frozenlib bytecode:
- `ServerPackets$Handshake.<clinit>` registers id `registry_sync/handshake`
- `ClientPackets$Handshake.<clinit>` registers id `registry_sync/handshake_client`

I'd been replying on the same channel as the hello, so server's `method_12075` never matched the packet to `ClientPackets$Handshake.PACKET_TYPE` and `syncVersion` stayed `-1`. Server's case-1 path then kicked with `noRegistrySyncMessage` (empty `Component.empty()`).

## What this fix means
- **Local Homestead server** (no `forceDisable=true` bypass): bot joins ✅
- **Friend's server** (no patches): bot joins ✅
- The pre-empt-on-`success` design works, race never matters because the reply lands well before the GOODBYE_PING round trip on either route.

## Files changed in this fix
- `src/utils/modcompat/frozenlib_responder.js`: separated `SERVER_HELLO_CHANNEL` (read) from `CLIENT_REPLY_CHANNEL` (write).

## Regression sweep (all green)
- ✅ T3 codec — 11/11
- ✅ T4 owo responder — 1/1
- ✅ T0 vanilla Paper — bot spawns
- ✅ T6 Homestead local strict (bypass off) — bot spawns
- ✅ Real friend's server `208.83.184.145:25565` — bot spawns

## Server-side bypass status
The `disableFrozenlibSync()` reflection patch in `bridge/dumper-mod` is now **disabled** (commented out in `ChannelHashDumper.java:31`). Local server runs strict frozenlib protocol identical to friend's server. Re-enable only if needed for some other debugging.

## How to run
```
./bridge/run.sh                                  # bridge daemon
MODE=homestead ./scripts/dev/run-bot.sh          # friend's real server
# OR
MODE=homestead-local ./scripts/dev/run-bot.sh    # local Homestead (start via start-homestead-server.sh)
```
