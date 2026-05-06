#!/usr/bin/env bash
# Compile dumper mod jar from local mod jars on classpath.
set -euo pipefail
cd "$(dirname "$0")"

OUT=out
MODS_DIR="/Users/charlie/Library/Application Support/ModrinthApp/profiles/Homestead/mods"
mkdir -p "$OUT"

# Build classpath from key mods (fabric-api, owo-lib, fabric-loader from server installation)
SERVER_DIR="/Users/charlie/Git/mindcraft/tmp/homestead-server"
CP=""
for jar in lib/*.jar; do
    CP="$CP:$jar"
done

# fabric-loader API + owo's MC remapped classes are inside their jars; intermediary
# Minecraft classes only available via Fabric Loom-style remapping. For dumper to
# compile we just need the Fabric API + owo + JDK. The dumper doesn't reference
# net.minecraft.* directly, only via reflection.
echo "CP=$CP"

javac --release 17 -d "$OUT" -cp "$CP" $(find src/main/java -name "*.java")

# Package as jar with fabric.mod.json
cp -R src/main/resources/* "$OUT/" 2>/dev/null || true
JAR=channelhashdumper-1.0.0.jar
( cd "$OUT" && jar cf "../$JAR" . )
echo "built: $JAR"
ls -lh "$JAR"
