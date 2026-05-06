#!/usr/bin/env bash
# Tail logfile, exit 0 when PATTERN seen, 1 if timeout reached.
# Usage: assert-log.sh PATTERN LOGFILE [timeout_sec=60]
set -u
pattern="${1:?pattern required}"
logfile="${2:?logfile required}"
timeout="${3:-60}"

deadline=$(( $(date +%s) + timeout ))
while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -f "$logfile" ] && grep -E -q -- "$pattern" "$logfile"; then
        echo "MATCH: $pattern"
        exit 0
    fi
    sleep 1
done
echo "TIMEOUT after ${timeout}s waiting for: $pattern" >&2
echo "--- last 50 lines of $logfile ---" >&2
[ -f "$logfile" ] && tail -50 "$logfile" >&2
exit 1
