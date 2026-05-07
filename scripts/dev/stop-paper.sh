#!/usr/bin/env bash
exec "$(dirname "$0")/_kill-pidfile.sh" tmp/paper/paper.pid 2
