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

## Diagnosing a kick: server log signal map

When a connect attempt fails, the FIRST thing to check is the server log. Two
specific lines map to two very different problems:

| Server log line | Means |
| --- | --- |
| `[Handshake] Handshake failed, client did not respond to channel query` | Bot's owo response was treated as `success=false`. Either bot didn't reply, or mineflayer's built-in `pluginChannels.js` auto-responder beat ours. Check that `attachModCompat` ran and stripped the built-in listener. |
| `[Handshake] Receiving client channels` then disconnect with `"channels with mismatched hashes: [<list>]"` | Bot replied successfully; hashes don't match. Compare bridge `/owo/debug/<id>` output against the dumper mod's `[CH-DUMP]` log on the server — they should agree byte-for-byte. If they don't, the bridge's ASM walk-back missed a registration pattern; extend `OwoIntrospector`. |
| `[Handshake] Handshake completed successfully` then disconnect with `{"text":""}` | Owo passed; frozenlib's case-1 path kicked with `Component.empty()`. syncVersion was -1 when GOODBYE_PING arrived. Reply landed too late on the wire. |
| `[Handshake] Handshake completed successfully` then bot stays connected, joins | Working as intended. |

The dumper mod (`bridge/dumper-mod/`) is the verification layer for the bridge:
its reflection-based `[CH-DUMP]` output is the ground truth for what the
runtime computed. When in doubt, drop the jar in the server's `mods/` and
restart.

---

## Performance traps (lessons from real regressions)

- **`getAllBlocks()` and `getAllItems()` run on every planner tick.** The
  registry overlay's synthetic record arrays must be built ONCE at fetch
  time, not per call. ~21K modded blocks × per-tick allocation tanks the
  LLM planner. See `registry_overlay.js:loadKind`.
- **Synthetic minecraft-data records are sparse.** They have `id`, `name`,
  `displayName`, `stackSize`, `diggable`, `drops:[]` — and that's it.
  Anywhere the codebase reads a deeper field (e.g. `block.harvestTools`,
  `block.boundingBox`), wrap with `?.` or expect `undefined`. The
  `getItemBlockSources` crash on `block.drops.includes` came from this.
- **Bridge HTTP handlers are single-threaded** (default `setExecutor(null)`).
  `/registry/*` reads a 2 MB file; cache by mtime so the bot's startup
  doesn't pay 2 fetches × 2 MB on every reconnect. See
  `MindcraftModBridge.readRegistryCached`.
- **Smoke test budget is ~60s.** mineflayer's default `checkTimeoutInterval`
  kicks the bot if no keepalive round-trips for 60s. The smoke test must
  finish all in-game steps inside that window, or the timeout fires
  mid-test and reports false failures. Don't add slow assertions naively.

---

## Static analysis pattern for ASM scanning

`OwoIntrospector` and any future ASM-based scanner should use the shared
`scanBack(arr, from, window, predicate)` helper in `OwoIntrospector.java`,
not hand-rolled `for (int j = from-1; j >= 0 && j >= from-N; j--)` loops.
Five copies of that loop existed before being collapsed; same shape is
likely to keep recurring as new mod patterns surface.

When you find a kick like `"channels with mismatched hashes: <new mod>"`:
1. Drop the dumper mod into the server, capture the runtime `[CH-DUMP]`
   for that channel.
2. Compare to the bridge's `/owo/debug/<id>` reconstruction.
3. The diff tells you which registration pattern was missed.
4. Add a new `walkBackForXxxIdentifier` flavour using `scanBack`.

---

## When bot writes need synchronous timing

`frozenlib_responder` writes the pre-emptive registry-sync reply
synchronously inside `client.once('success', ...)`. NOT `setImmediate`,
NOT `Promise.then`. Reasons (relearn-the-hard-way list):

1. After the LOGIN_SUCCESS packet is read, mineflayer immediately processes
   any buffered PLAY-state packets that arrived in the same TCP segment.
   Those include frozenlib's hello + `play.ping(id=0)` + `play.ping(id=1)`.
2. Mineflayer's `lib/plugins/game.js` auto-pongs every `play.ping` from a
   sync listener.
3. If our reply is deferred to a later macrotask, the auto-pongs land on
   the wire FIRST. Server's frozenlib case-1 fires with `syncVersion=-1`
   and kicks.
4. The same logic explains why we DON'T strip mineflayer's `'ping'`
   listener: it's registered later in plugin init, and stripping it
   (a) races plugin init and (b) leaves the bot mute on legitimate
   keepalives. The fix is timing-of-our-write, not stripping theirs.

For any future protocol that runs in the early-PLAY window, follow the
same pattern: hook `success`, write synchronously, set a flag, then
optionally re-confirm reactively when the server's hello arrives.

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

Friend's remote server (`207.66.126.94:25565`) is **off limits for unattended
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

- **Don't connect to friend's `207.66.126.94:25565`** without explicit user
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

## Process-level error guards (`src/process/init_agent.js`)

Each mindcraft bot runs as its own `node` subprocess spawned from
`src/process/agent_process.js`. Guards on the *parent* (`main.js`) don't
catch errors inside the agent — they must live in `init_agent.js`.

Three guards installed at the top of `init_agent.js`:

1. **`console.log` monkey-patch** — protodef's `FullPacketParser` does
   `console.log(e.stack)` on every `PartialReadError`. Heavily-modded servers
   emit recipe/command packets large enough that protodef can't decode them,
   producing 4+ multi-KB sync stderr writes per spawn. Those writes stall the
   event loop long enough that the bot's `keep_alive` ACK goes out late, the
   server stops sending more `keep_alive`s, and the bot kicks itself at
   `checkTimeoutInterval`. The patch silently drops these stack dumps after
   logging one summary line per unique signature (Set capped at 64 entries).
   The decode failure itself is non-fatal — protodef returns `cb()`, the bad
   packet is dropped, the stream survives.

2. **`unhandledRejection`** — narrow swallow list: `PathStopped` and
   `GoalChanged` only. mineflayer-pathfinder's `goto.js` emits these from
   the `stop()` teardown chain; `action_manager` catches the first, but the
   teardown reject has no awaiter and would otherwise crash the process.
   **Don't widen** to `NoPath` / `Timeout` / generic names — `NoPath` is a
   legitimate caller-observable failure and `Timeout` is shared with many
   libs.

3. **`uncaughtException`** — narrow guard: requires BOTH the stack path
   `mineflayer/lib/plugins/block_actions.js` AND the message `Cannot convert
   undefined or null to object`. This is the `FACING_MAP[parseChestMetadata
   (block).facing]` crash on modded chests where `.facing` is undefined.
   **Don't widen** the predicate to OR — common JS errors are common, and
   broad swallow hides real bugs in our own code.

Companion at `src/utils/mcdata.js`:

- `bot._client.on('error', () => {})` + `bot.on('error', () => {})` — empty
  swallowers for the dual-emit chain. mineflayer's `loader.js:109` forwards
  client-level errors to the bot, so a listener is needed on each event
  emitter. Without the bot-level one, node's "unhandled 'error' event"
  formatter prints + crashes BEFORE `uncaughtException` can intervene.
- `checkTimeoutInterval: 120000` — 60 s default isn't enough headroom on
  remote modded servers that are slow to send the first keep_alive while
  still pushing registry payloads. Bumping helps; doesn't fix the underlying
  cause (event-loop stall above).

## Diagnosing a quit: what to check, in order

If the bot logs in then dies after a short time, check the agent log
(`logs/bot-*.log`) for one of these signatures:

| Signature | Cause | Fix |
| --- | --- | --- |
| Many `PartialReadError:` stack dumps followed by `client timed out after Nms` / `Disconnected: keepaliveerror` | console.log spam stalled the event loop → keepalive miss | Confirm `init_agent.js` console patch is in place; check `node --check` passes |
| `TypeError: Cannot convert undefined or null to object` at `block_actions.js:79` (single sync trace, immediate exit) | mineflayer chokes on a modded chest's missing `facing` | Confirm `uncaughtException` guard is in place; if same crash from a different plugin, narrow-extend the guard |
| `PathStopped` stack trace twice + `Agent process exited` | pathfinder dual-reject; `action_manager` caught first, teardown reject was uncaught | Confirm `unhandledRejection` guard is in place |
| `Ollama Status: 500` or `llama runner process no longer running: GGML_ASSERT failed` | Ollama runner crash (llama.cpp bug) | `pkill -f "ollama runner"` (serve auto-respawns); try smaller quant if crash recurs same prompt |
| `Disconnected: keepaliveerror` after several minutes of clean activity | Server stopped sending keep_alive (network or server-side anti-bot rate-limit) | Accept the auto-restart cycle, or bump `checkTimeoutInterval` further |
| `[LoginGuard] Connection Failed: Server is under maintenance or restarting.` | Server's LoginGuard mod kicked the bot at login | Usually transient — server still warming after restart. Retry once |
| `EADDRINUSE` on `:8080` | A previous mindcraft process is still holding the mindserver port | `pkill -f "node main.js"` then retry; or set `mindserver_port` to a free port |

## Sleep-at-night mode (`sleep_at_night`)

Auto-trigger at dusk (`bot.time.timeOfDay ∈ [13000, 23000]`). Once-per-night:
sets `attempted_this_night` true, fires `goToBed`, doesn't retry until
`t < 12000` (dawn reset). Code in `src/agent/modes.js`, skill in
`src/agent/library/skills.js:goToBed`.

`goToBed` order:
1. Find vanilla bed within 32 blocks → `bot.sleep(block)`.
2. Find Comforts sleeping-bag *block* within 32 blocks → `bot.activateBlock`.
3. (Modded support on) Find sleeping-bag *item* in inventory → equip, deploy
   on the block under feet via `bot.placeBlock`, then `activateBlock` if not
   asleep within 500 ms. Comforts auto-returns the bag on wake.

Modded fallback gated by `settings.allow_modded_sleeping_bag` (default true).
Set `false` for vanilla-only behavior.

Wake wait uses `bot.once('wake', ...)` with 10-min safety timeout. The
`'unstuck'` mode is paused during sleep and unpaused in a `finally` so a
hung wake doesn't leave unstuck disabled.

## Quick commands cheatsheet

```bash
# Bot lifecycle
ALLOW_REMOTE=1 MODE=homestead ./scripts/dev/run-bot.sh   # friend's server (gated)
MODE=homestead-local ./scripts/dev/run-bot.sh            # local Fabric server
pkill -f "node main.js" && pkill -f init_agent           # full stop (parent + subprocess)

# Logs
tail -F logs/bot-homestead-*.log

# Ollama health
curl -s http://localhost:11434/api/tags | jq '.models[].name'
curl -s -X POST http://localhost:11434/api/generate \
  -d '{"model":"sweaterdog/andy-4:q8_0","prompt":"hi","stream":false}' | jq .response
pkill -f "ollama runner"   # kill stuck runner; serve auto-respawns

# Bridge health
curl -s http://localhost:7474/registry/blocks | jq 'length'
```

## Worktree workflow for parallel feature work

The user actively plays on the bot from the main checkout. For any
non-trivial feature, branch off into a worktree so they can keep their
session running:

```bash
git worktree add -b feat/<name> ../mindcraft-<name> feat/modded-fabric-support
ln -s ../mindcraft/node_modules ../mindcraft-<name>/node_modules   # share deps
# do all edits in ../mindcraft-<name>/...
git -C ../mindcraft-<name> commit ...
git merge --ff-only feat/<name>          # fast-forward base branch
git worktree remove ../mindcraft-<name>
git branch -d feat/<name>
```

## Modded-feature toggle convention

Every new feature that depends on modded items/blocks must be gated by a
`settings.js` flag named `allow_modded_<feature>`, default `true`, that
short-circuits the modded code path when set to `false`. The vanilla path
must continue to work as if the feature didn't exist. See
`allow_modded_sleeping_bag` for the canonical example.

---

## Open work (in rough priority)

- Wire `registry_client.js` into mindcraft's existing block/item APIs so
  `pathfinder`, `collectBlock`, etc. resolve modded names automatically.
- Per-mod gameplay adapters (Tom's Storage open-terminal, Accessories
  equip-slot, Farmer's Delight crops). Each is small + research-heavy.
- Auto-restart bridge daemon (launchd plist) — only worth it if it actually
  crashes (hasn't yet).
- Per-agent keep-alive proactive write — current 120 s timeout is workable
  but on the slowest spawns the server still drops the bot. Investigate
  whether mineflayer can be patched to send empty keep_alive proactively
  if the server's first one is late.
- Investigate `parseChestMetadata` for ALL modded chests — current guard
  papers over the crash; a real fix would teach mineflayer's `FACING_MAP`
  about modded blockstate keys via the bridge overlay.

---

## Status docs

`logs/phase{1..4}-status.md` are session-bound investigation notes from when
this layer was being built. They have historical value for understanding
*why* certain choices were made (e.g. the owo index-1 sentinel discovery
trail) but should not be treated as living docs.
