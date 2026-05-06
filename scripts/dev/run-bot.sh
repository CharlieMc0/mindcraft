#!/usr/bin/env bash
# Run mindcraft bot with mode-specific settings overrides.
# Usage: MODE={vanilla|homestead} ./scripts/dev/run-bot.sh
# Logs to logs/bot-<mode>-<ts>.log. Prints PID + log path. Backgrounds via nohup.
set -euo pipefail
cd "$(dirname "$0")/../.."

MODE="${MODE:-vanilla}"
TS=$(date +%s)
LOG="logs/bot-${MODE}-${TS}.log"
mkdir -p logs

case "$MODE" in
    vanilla)
        OVERRIDES='{"host":"localhost","port":25566,"auth":"offline","modpack":null,"only_chat_with":[],"init_message":"hello world"}'
        ;;
    homestead)
        OVERRIDES='{"host":"208.83.184.145","port":25565,"auth":"microsoft","modpack":"homestead","init_message":"hello world"}'
        ;;
    homestead-local)
        # Local Homestead Fabric server on :25567 (offline-mode). Safe to spam.
        OVERRIDES='{"host":"localhost","port":25567,"auth":"offline","modpack":"homestead","init_message":"hello world"}'
        ;;
    *)
        echo "unknown MODE: $MODE (vanilla|homestead)"; exit 2 ;;
esac

# Make sure no previous bot is still holding mindserver_port (8080).
# Idempotent — quietly ignores when no PID file or already gone.
for prev in logs/bot-*.pid; do
    [ -f "$prev" ] || continue
    PID=$(cat "$prev" 2>/dev/null) || continue
    if kill -0 "$PID" 2>/dev/null; then
        kill "$PID" 2>/dev/null || true
        sleep 1
        kill -9 "$PID" 2>/dev/null || true
    fi
    rm -f "$prev"
done

echo "MODE=$MODE LOG=$LOG"
echo "OVERRIDES=$OVERRIDES" >>"$LOG"
NODE_ARGS=""
if [ "${WIRE_DUMP:-}" = "1" ]; then
    NODE_ARGS="-r /tmp/wire-dump-bot.js"
fi
DEBUG_ARG=""
if [ "${PROTO_DEBUG:-}" = "1" ]; then
    DEBUG_ARG="DEBUG=minecraft-protocol"
fi
env $DEBUG_ARG SETTINGS_JSON="$OVERRIDES" nohup node $NODE_ARGS main.js >>"$LOG" 2>&1 &
PID=$!
echo $PID > "logs/bot-${MODE}.pid"
echo "PID=$PID"
