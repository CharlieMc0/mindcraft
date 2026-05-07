#!/usr/bin/env bash
# Read a pidfile, send SIGTERM, wait, escalate to SIGKILL if still alive, remove pidfile.
# Usage: _kill-pidfile.sh PID_FILE [GRACE_SECS]
set -u
PID_FILE="${1:?pid file required}"
GRACE="${2:-2}"
[ -f "$PID_FILE" ] || { echo "no pid file: $PID_FILE"; exit 0; }
PID=$(cat "$PID_FILE" 2>/dev/null) || { rm -f "$PID_FILE"; exit 0; }
kill "$PID" 2>/dev/null || true
sleep "$GRACE"
kill -9 "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
echo "stopped pid=$PID"
