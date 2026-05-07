#!/usr/bin/env bash
exec "$(dirname "$0")/_kill-pidfile.sh" tmp/homestead-server/homestead.pid 2
