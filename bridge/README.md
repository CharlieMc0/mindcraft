# mindcraft-modbridge

Persistent local Java daemon. Loads modpack mod jars, exposes their network protocol metadata over `localhost:7474` for the JS bot to query during login handshake.

Phase 1 surface (owo-lib only):
- `GET /health` — `{ status, modCount, owoLoaded, ... }`
- `GET /owo/hashes` — `{ requiredChannels, requiredControllers, optionalChannels }` keyed by Identifier (`ns:path`) → int32 hash
- `GET /owo/debug` — raw scan log
- `GET /owo/debug/<channelId>` — single-channel hash lookup

## Build + run
```
./build.sh                                 # downloads ASM 9.7 to lib/, compiles
./run.sh                                   # default mods dir + port 7474
./run.sh /path/to/mods 8080                # custom dir + port
```

Requires JDK 17+ (system JDK 21 is fine; bytecode targets 17).

## Approach
ASM bytecode scan over every jar in mods dir. Finds `OwoNetChannel.create(Identifier)` callsites, tracks following `register*` calls to collect packet record classes, computes hash per owo's algorithm:

```
hash = 31 * Identifier.hashCode() + sum over packets of (index*31 + recordClass.getName().hashCode())
Identifier.hashCode() = 31 * namespace.hashCode() + path.hashCode()
```

No Fabric Loader bootstrap (would need MC stubs + classpath gymnastics). Pure static analysis.

## Limitations (Phase 1)
- Misses dynamic registrations (channels built from runtime config). Static `final` fields cover the common case.
- Misses packets registered via builder DSLs more elaborate than `register*(MyPkt.class, ...)`.
- Identifier construction patterns covered: `new Identifier(ns, path)` and `Identifier.of(ns, path)`. Single-arg `new Identifier("ns:path")` not yet handled.

If a mod's channel is missing from `/owo/hashes`, server kick will name it. Add patterns to `OwoIntrospector` as needed.
