#!/usr/bin/env bash
# Compile mindcraft-modbridge with javac + plain ASM jars in lib/.
# Outputs runnable bridge classes to bridge/out/.
set -euo pipefail
cd "$(dirname "$0")"

ASM_VER=9.7
LIB=lib
mkdir -p "$LIB" out logs

# Bootstrap ASM jars on first run.
fetch() {
    local url="$1" dst="$2"
    [ -f "$dst" ] && return 0
    echo "Downloading $url"
    curl -fsSL "$url" -o "$dst"
}
fetch "https://repo1.maven.org/maven2/org/ow2/asm/asm/${ASM_VER}/asm-${ASM_VER}.jar"           "$LIB/asm-${ASM_VER}.jar"
fetch "https://repo1.maven.org/maven2/org/ow2/asm/asm-tree/${ASM_VER}/asm-tree-${ASM_VER}.jar" "$LIB/asm-tree-${ASM_VER}.jar"

CP="$LIB/asm-${ASM_VER}.jar:$LIB/asm-tree-${ASM_VER}.jar"
SRC=$(find src/main/java -name "*.java")
javac --release 17 -d out -cp "$CP" $SRC
echo "build ok: out/ + cp=$CP"
