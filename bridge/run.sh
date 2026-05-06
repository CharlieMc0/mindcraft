#!/usr/bin/env bash
# Launch mindcraft-modbridge daemon. Args: [modsDir] [port].
set -euo pipefail
cd "$(dirname "$0")"

[ -d out ] || ./build.sh

ASM_VER=9.7
CP="out:lib/asm-${ASM_VER}.jar:lib/asm-tree-${ASM_VER}.jar"
exec java -cp "$CP" com.mindcraft.modbridge.MindcraftModBridge "$@"
