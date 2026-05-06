#!/usr/bin/env bash
# Start Paper 1.20.1 vanilla test server on :25566 (offline mode).
# Idempotent: skips download if jar present, skips start if already running.
set -euo pipefail
cd "$(dirname "$0")/../.."

PAPER_DIR="tmp/paper"
PAPER_JAR="$PAPER_DIR/paper.jar"
PORT=25566
LOG="logs/paper-server.log"

mkdir -p "$PAPER_DIR" logs

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Paper already listening on :$PORT"
    exit 0
fi

if [ ! -f "$PAPER_JAR" ]; then
    echo "Downloading Paper 1.20.1..."
    # Resolve latest 1.20.1 build via PaperMC API
    BUILD=$(curl -fsSL "https://api.papermc.io/v2/projects/paper/versions/1.20.1" | grep -oE '"builds":\[[^]]+\]' | grep -oE '[0-9]+' | tail -1)
    URL="https://api.papermc.io/v2/projects/paper/versions/1.20.1/builds/${BUILD}/downloads/paper-1.20.1-${BUILD}.jar"
    curl -fsSL "$URL" -o "$PAPER_JAR"
fi

cd "$PAPER_DIR"
echo "eula=true" > eula.txt
cat > server.properties <<EOF
server-port=$PORT
online-mode=false
motd=mindcraft-test
spawn-protection=0
gamemode=creative
difficulty=peaceful
max-players=4
view-distance=4
simulation-distance=4
EOF

echo "Starting Paper on :$PORT (log: $LOG)..."
nohup java -Xms512M -Xmx1G -jar paper.jar --nogui >"../../$LOG" 2>&1 &
PID=$!
echo $PID > paper.pid
echo "PID=$PID  LOG=$LOG"
