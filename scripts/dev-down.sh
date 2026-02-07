#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"

stop_pid_file() {
  name="$1"
  pid_file="$2"

  if [ ! -f "$pid_file" ]; then
    echo "$name not running (no pid file)"
    return
  fi

  pid="$(cat "$pid_file" || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    echo "$name stopped (pid $pid)"
  else
    echo "$name already stopped"
  fi
  rm -f "$pid_file"
}

stop_pid_file "web" "$RUN_DIR/web.pid"
stop_pid_file "server" "$RUN_DIR/server.pid"
