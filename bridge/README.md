# mindcraft-modbridge

Persistent local Java daemon. Loads modpack mod jars, exposes their network
protocol metadata + server-runtime registries on `localhost:7474` for the JS
bot to query during login handshake and post-spawn lookups.

## HTTP surface

| Endpoint                   | Purpose                                                        |
| -------------------------- | -------------------------------------------------------------- |
| `GET /health`              | Daemon status, mod count, scan results                         |
| `GET /owo/hashes`          | 3-map JSON (required/controllers/optional) for `owo:handshake` |
| `GET /owo/debug`           | Full ASM scan log                                              |
| `GET /owo/debug/<channel>` | Hash lookup for a single channel                               |
| `GET /registry/blocks`     | `{ "<rawId>": "<modid>:<path>", ... }` (block registry)        |
| `GET /registry/items`      | Item registry, same shape                                      |

`/owo/*` data comes from the bridge's own ASM static analysis of the mod jars
in the configured mods dir. `/registry/*` reads a JSON file written at
`SERVER_STARTED` by `dumper-mod`'s `RegistryDumper` (path: env
`CHDUMP_REGISTRY_PATH`, else `$TMPDIR/mindcraft-modcompat-registry.json`).
The bridge re-reads on every request so a server restart picks up a fresh
dump without restarting the bridge.

## Build + run

```bash
./build.sh                                 # downloads ASM 9.7 to lib/, compiles
./run.sh                                   # default mods dir + port 7474
./run.sh /path/to/mods 8080                # custom dir + port
```

Requires JDK 17+ (system JDK 21 is fine; bytecode targets 17).

## How owo hash reconstruction works

ASM bytecode scan over every jar in mods dir. The scanner finds:

1. `OwoNetChannel.create(Identifier)` callsites — channel id + the
   `PUTSTATIC` field where the channel object lands.
2. `register*(packetClass, handler)` callsites later in the same or other
   classes — looks back through the bytecode for the matching `GETSTATIC`
   that pushed the channel reference.
3. Identifier construction patterns:
    - `new Identifier(ns, path)`
    - `Identifier.of(ns, path)`
    - `Mod.id(path)` (one-arg static factory whose body contains a literal
      namespace string)
    - falls back to the `fabric.mod.json` `id` field for namespace.
4. The hash is computed exactly as `OwoHandshake.hashChannel`:

```
hash = 31 * Identifier.hashCode() + sum over packets of (index*31 + recordClass.getName().hashCode())
Identifier.hashCode() = 31 * namespace.hashCode() + path.hashCode()
```

with two non-obvious details that took experimentation to nail down:

- **Indices start at 1, not 0.** `OwoNetChannel` pre-pads its handler lists
  with a null sentinel, so the first `register*` call reads `size() == 1`.
- **`registerClientboundDeferred` stores at key `-idx`** in
  `serializersByIndex`. `registerClientbound(class, handler)` for an
  already-deferred class re-uses the existing `-idx` slot — does NOT
  allocate a new index — so the pair contributes once.

The dumper mod (`bridge/dumper-mod/`) verifies these reconstructions by
reflecting into `OwoHandshake` at `SERVER_STARTED` and computing the same
hashes from runtime state. They match for every channel in Homestead 1.3.4.

## How the registry dumper works

`bridge/dumper-mod/src/main/java/com/mindcraft/dumper/RegistryDumper.java`
loads alongside the rest of the modpack. On `SERVER_STARTED` it iterates
`net.minecraft.class_7923.field_41175` (Block registry) and `field_41178`
(Item registry), writes `{rawId: "<modid>:<path>"}` JSON to disk. The bridge
serves slices of that file. ~22.5K block entries + ~23.8K item entries =
~2 MB JSON for Homestead.

## Limitations

- Misses owo channels built dynamically (e.g. registered from a config-driven
  loop). Static `final` fields cover ~all cases observed.
- Mod jars whose `fabric.mod.json` is unparseable, or that build identifiers
  via factories more elaborate than `Mod.id(path)`, may surface as
  `create-no-id` in the scan log.
- Server-side `RegistryDumper` writes to a single global file; concurrent
  servers on the same machine will race. Set `CHDUMP_REGISTRY_PATH` per
  server.

If a kick reports `"channels with mismatched hashes: [list]"`, compare
bridge `/owo/debug/<id>` output against the dumper mod's `[CH-DUMP]` log on
the server. They should agree byte-for-byte; if they don't, the
reconstruction missed a registration pattern in `OwoIntrospector.java`.
