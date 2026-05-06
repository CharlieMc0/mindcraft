#!/usr/bin/env bash
set -u
MODE="${MODE:-vanilla}"
PID_FILE="logs/bot-${MODE}.pid"
[ -f "$PID_FILE" ] || { echo "no pid file: $PID_FILE"; exit 0; }
PID=$(cat "$PID_FILE")
kill "$PID" 2>/dev/null || true
sleep 1
kill -9 "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
echo "stopped $MODE bot ($PID)"
