#!/bin/sh
# JARVIS sandbox supervisor.
#
# Processes spawned from a tool-session Bash call are reaped when the call
# ends, but processes spawned by the Next.js dev server (a boot-time process)
# survive — including after that parent dies, as orphans reparented to init.
# This script is started that way: the /api/spawn route on the dev server
# launches it detached, the tool call that started the dev server then ends,
# the dev server dies with it, and this supervisor — now an orphan — takes
# over port 3000 and keeps the JARVIS bridge alive there for good.
#
# The bridge serves everything: the built face from dist/, the websocket on
# /ws, and the HTTP endpoints (/img /media /page /file /health /tts /stt).

JARVIS_DIR=/home/z/jarvis
LOG=/tmp/jarvis-bridge.log
SUP=/tmp/jarvis-supervisor.log

log() { echo "$(date -u +%FT%TZ) $*" >> "$SUP"; }

log 'supervisor up'

# Wait for port 3000 to be free — the Next.js dev server that spawned us
# dies with the tool call that started it, and the bridge cannot bind until
# it has gone.
i=0
while [ $i -lt 300 ]; do
  if ss -tln 2>/dev/null | grep -q ':3000 '; then
    sleep 1
    i=$((i + 1))
  else
    break
  fi
done
log "port 3000 free after ${i}s"

start_bridge() {
  cd "$JARVIS_DIR" || return 1
  JARVIS_BRIDGE_PORT=3000 JARVIS_ALLOW_NO_ORIGIN=1 \
    setsid nohup node bridge/server.mjs >> "$LOG" 2>&1 &
  log "bridge started (pid $!)"
}

# Start once, then keep it alive forever.
first=1
while true; do
  if ! pgrep -f 'bridge/server[.]mjs' >/dev/null 2>&1; then
    if [ "$first" = 1 ]; then
      first=0
    else
      log 'bridge died - restarting in 3s'
      sleep 3
    fi
    start_bridge
  fi
  sleep 5
done
