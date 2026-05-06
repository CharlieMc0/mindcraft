# CLAUDE.md

Guide for Claude / future AI agents working in this fork of [mindcraft](https://github.com/kolbytn/mindcraft).
The vanilla project is unchanged for vanilla servers; this fork adds a **modded
Fabric server compatibility layer** so the LLM bot can connect to heavily-modded
modpacks (initial target: Modrinth's *Homestead*, Fabric 1.20.1).

This file is auto-loaded by Claude Code in each session — keep it tight and
updated.

---

## Architecture (modcompat layer)

Three pieces work together:

```
┌────────────────────┐         ┌──────────────────────┐
│  mindcraft (Node)  │  HTTP   │  mindcraft-modbridge │
│  src/utils/        │◀───────▶│  bridge/ (Java daemon)│
│    modcompat/      │  :7474  │  ASM scan of mod jars│
└────────────────────┘         └──────────────────────┘
            ▲                              ▲
            │                              │  reads
            │  bot connects                │  registry-dump.json
            ▼                              │  (written by mod below)
   ┌────────────────────┐         ┌────────┴─────────┐
   │  Fabric 1.20.1     │ ◀───────│  ChannelHashDumper│
   │  Modded server     │  loads  │  bridge/dumper-mod│
   │  (e.g. Homestead)  │         │  (Fabric mod jar) │
   └────────────────────┘         └──────────────────┘
```

- **`bridge/`** — persistent Java daemon (no Gradle, plain `javac` + ASM 9.7 +
  JDK built-in `com.sun.net.httpserver`). On startup, ASM-scans the modpack
  mod jars to reconstruct each owo-lib `OwoNetChannel` registration including
  the sentinel-offset and signed CLIENT-side keys, computes the canonical
  `OwoHandshake.hashChannel` value byte-for-byte, exposes results on HTTP.
- **`bridge/dumper-mod/`** — server-side Fabric mod. Two jobs:
    1. Reflectively dumps the live `OwoHandshake` registry on
       `SERVER_STARTED` for verification (compare bridge static recon vs
       runtime truth).
    2. Dumps the Block + Item registries to a JSON file the bridge serves
       via `/registry/blocks` and `/registry/items`.
- **`src/utils/modcompat/`** — JS layer. Strips mineflayer's permissive
  built-in `login_plugin_request` listener, then routes each gate to a
  dedicated handler:
    - `owo_responder.js` — fetches hashes from bridge, encodes the 3-map
      HandshakeResponse per owo's wire format (varint Integer values, NOT
      int32-BE).
    - `frozenlib_responder.js` — pre-emptively replies on
      `frozenlib:registry_sync/handshake_client` (note the `_client`
      suffix — server's hello is on `/handshake`) at LOGIN_SUCCESS so the
      reply lands ahead of mineflayer's auto-pong on the GOODBYE_PING.
    - `bridge_client.js` — promise-cached HTTP client, deduplicates
      concurrent calls.
    - `registry_client.js` — same, for `/registry/blocks` + `/registry/items`.
    - `codec.js` — pure-JS varint + identifier-string + map encoders.
    - `handshake_router.js` — entry point. `attachModCompat(bot, settings)`.

---

## Critical invariants (don't break these)

1. **Owo `Integer` wire encoding is varint, NOT int32.** owo registers
   `class_2540.method_10804(I)` (writeVarInt) for Integer in
   `PacketBufSerializer.<clinit>`. Negative hashes (common) take 5 bytes.
2. **Owo serializer indices start at 1, not 0.** `OwoNetChannel`'s constructor
   pre-pads `clientHandlers` and `serverHandlers` with a null sentinel, so the
   first `registerServerbound` reads `size() == 1`. With indices starting at
   1, there is no `0/-0` collision in `serializersByIndex`.
3. **Frozenlib uses two channels.** Server hello on
   `frozenlib:registry_sync/handshake`; client reply on
   `.../handshake_client`. They are NOT the same id.
4. **Mineflayer auto-replies success=false** to every `login_plugin_request`
   via `node_modules/minecraft-protocol/src/client/pluginChannels.js`.
   `attachModCompat` removes that listener before our owo responder attaches —
   otherwise our async hash response loses the race and the server reads
   "client did not respond".
5. **Plugin order**: `mineflayer/lib/plugins/game.js` registers
   `client.once('success', onLogin)` first (sets state to PLAY synchronously).
   Our `client.once('success', ...)` fires after, so by the time we write the
   pre-emptive frozenlib reply, the state is already PLAY and the play-state
   schema applies. Don't add `setImmediate` — that defers our write past
   buffered pings and the auto-pong race kicks in.

---

## Run + test

Two long-lived processes (start once, leave running):

```bash
./bridge/run.sh                                  # bridge daemon, :7474
./scripts/dev/start-homestead-server.sh          # local Fabric server, :25567
```

Bot:

```bash
MODE=homestead-local ./scripts/dev/run-bot.sh    # local (offline auth, safe)
MODE=vanilla         ./scripts/dev/run-bot.sh    # Paper test, :25566
ALLOW_REMOTE=1 MODE=homestead ./scripts/dev/run-bot.sh   # friend's server (gated)
```

Friend's remote server (`208.83.184.145:25565`) is **off limits for unattended
runs**. The `ALLOW_REMOTE=1` gate makes that explicit. Use the local server
for everything.

End-to-end smoke test (reproducible, ~120s on first run for chunk gen):

```bash
node scripts/dev/smoke-test.mjs
```

Unit tests:

```bash
node --test src/utils/modcompat/codec.test.js
node --test src/utils/modcompat/owo_responder.test.js
```

---

## Onboarding a new modpack

1. Install the modpack via the Modrinth App so `~/Library/Application Support/ModrinthApp/profiles/<NAME>/mods` exists.
2. Set up a server with the same mod set:
   ```bash
   tmp/server-tools/mrpack-install <pack>.mrpack --server-dir tmp/<NAME>-server
   cp bridge/dumper-mod/channelhashdumper-1.0.0.jar tmp/<NAME>-server/mods/
   ```
3. Edit `bridge/run.sh`'s default mods dir if needed (or pass as arg 1).
4. Restart bridge — it scans the new modpack on boot and re-exposes hashes.
5. Restart the server — `RegistryDumper` re-writes the registry JSON.
6. Test: `MODE=homestead-local ./scripts/dev/run-bot.sh`.

If the bot kicks with `"channels with mismatched hashes: <list>"`, the bridge's
ASM reconstruction missed a registration pattern. Check `OwoIntrospector.java`'s
walk-back routines and extend.

If a new mod brings a new login-plugin gate (server log shows
`[modcompat] unhandled login_plugin_request channel=<new>:...` then a kick),
either ack with `data: undefined` (success=false) and trust that the mod's
handler short-circuits (most do) — or write a real responder under
`src/utils/modcompat/<mod>_responder.js` and wire it through `handshake_router.js`.

---

## Don't / be careful

- **Don't connect to friend's `208.83.184.145:25565`** without explicit user
  approval. The `ALLOW_REMOTE=1` gate is there for a reason — every connection
  is visible to admin.
- **Don't add new dependencies** to `bridge/`. It's intentionally `javac` +
  ASM only. The pure-JS codec in `src/utils/modcompat/codec.js` is also a
  conscious choice — protodef would work but couples to mineflayer's
  compiled serializer state.
- **Don't `setImmediate` / `Promise.then`** the frozenlib pre-empt write. It
  must be synchronous in the `success` handler.
- **Don't commit** unless the user explicitly asks. The `feat/modded-fabric-support`
  branch lives on the user's fork (`charlie` remote = `CharlieMc0/mindcraft`).
- **Don't gold-plate.** Bridge currently does a 2-pass scan over 372 mod jars
  in ~2s. Functional. Refactoring to 1-pass would be a divergence with no
  user-visible win.

---

## Open work (in rough priority)

- Wire `registry_client.js` into mindcraft's existing block/item APIs so
  `pathfinder`, `collectBlock`, etc. resolve modded names automatically.
- Per-mod gameplay adapters (Tom's Storage open-terminal, Accessories
  equip-slot, Farmer's Delight crops). Each is small + research-heavy.
- Auto-restart bridge daemon (launchd plist) — only worth it if it actually
  crashes (hasn't yet).

---

## Status docs

`logs/phase{1..4}-status.md` are session-bound investigation notes from when
this layer was being built. They have historical value for understanding
*why* certain choices were made (e.g. the owo index-1 sentinel discovery
trail) but should not be treated as living docs.
