#!/usr/bin/env bash
set -u
PID_FILE="tmp/homestead-server/homestead.pid"
[ -f "$PID_FILE" ] || { echo "no pid file"; exit 0; }
kill "$(cat "$PID_FILE")" 2>/dev/null || true
sleep 2
kill -9 "$(cat "$PID_FILE")" 2>/dev/null || true
rm -f "$PID_FILE"
echo "stopped"
