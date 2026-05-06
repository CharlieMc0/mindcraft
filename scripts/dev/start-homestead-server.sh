#!/usr/bin/env bash
# Start local Homestead Fabric server on :25567 (offline-mode).
# Idempotent: skips start if already listening.
set -euo pipefail
cd "$(dirname "$0")/../.."

DIR="tmp/homestead-server"
PORT=25567
LOG="logs/homestead-server.log"

mkdir -p logs

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Homestead server already listening on :$PORT"
    exit 0
fi

JAR=$(ls "$DIR"/fabric-server-*.jar | head -1)
[ -n "$JAR" ] || { echo "no fabric-server jar in $DIR"; exit 1; }

echo "Starting Homestead server on :$PORT (log: $LOG)..."
cd "$DIR"
# 36GB host: 8G heap is generous for Homestead. Bump if OOM.
# G1GC + GC tuning are Aikar's Flags lite — better pause times for modded servers.
nohup java \
    -Xms8G -Xmx12G \
    -XX:+UseG1GC \
    -XX:+ParallelRefProcEnabled \
    -XX:MaxGCPauseMillis=200 \
    -XX:+UnlockExperimentalVMOptions \
    -XX:+DisableExplicitGC \
    -XX:+AlwaysPreTouch \
    -XX:G1NewSizePercent=30 \
    -XX:G1MaxNewSizePercent=40 \
    -XX:G1HeapRegionSize=8M \
    -XX:G1ReservePercent=20 \
    -XX:G1HeapWastePercent=5 \
    -XX:G1MixedGCCountTarget=4 \
    -XX:InitiatingHeapOccupancyPercent=15 \
    -XX:G1MixedGCLiveThresholdPercent=90 \
    -XX:G1RSetUpdatingPauseTimePercent=5 \
    -XX:SurvivorRatio=32 \
    -XX:+PerfDisableSharedMem \
    -XX:MaxTenuringThreshold=1 \
    -jar "$(basename "$JAR")" --nogui >"../../$LOG" 2>&1 &
PID=$!
echo $PID > homestead.pid
echo "PID=$PID  LOG=$LOG"
