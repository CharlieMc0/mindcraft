#!/usr/bin/env bash
set -u
PID_FILE="tmp/paper/paper.pid"
[ -f "$PID_FILE" ] || { echo "no pid file"; exit 0; }
kill "$(cat "$PID_FILE")" 2>/dev/null || true
rm -f "$PID_FILE"
echo "stopped"
