#!/usr/bin/env bash
set -u
MODE="${MODE:-vanilla}"
exec "$(dirname "$0")/_kill-pidfile.sh" "logs/bot-${MODE}.pid" 1
