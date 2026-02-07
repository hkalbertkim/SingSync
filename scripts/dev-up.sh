#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
LOG_DIR="$ROOT_DIR/.logs"

mkdir -p "$RUN_DIR" "$LOG_DIR"

is_running() {
  pid_file="$1"
  if [ ! -f "$pid_file" ]; then
    return 1
  fi
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

if is_running "$RUN_DIR/server.pid"; then
  echo "server already running (pid $(cat "$RUN_DIR/server.pid"))"
else
  nohup sh -c "cd \"$ROOT_DIR/server\" && npm run dev" > "$LOG_DIR/server-dev.log" 2>&1 &
  server_pid=$!
  echo "$server_pid" > "$RUN_DIR/server.pid"
  echo "server started (pid $server_pid)"
fi

if is_running "$RUN_DIR/web.pid"; then
  echo "web already running (pid $(cat "$RUN_DIR/web.pid"))"
else
  nohup sh -c "cd \"$ROOT_DIR/web\" && npm run dev" > "$LOG_DIR/web-dev.log" 2>&1 &
  web_pid=$!
  echo "$web_pid" > "$RUN_DIR/web.pid"
  echo "web started (pid $web_pid)"
fi

echo "logs: $LOG_DIR/server-dev.log, $LOG_DIR/web-dev.log"
