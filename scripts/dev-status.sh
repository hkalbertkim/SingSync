#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"

print_status() {
  name="$1"
  pid_file="$2"
  port="$3"

  if [ -f "$pid_file" ]; then
    pid="$(cat "$pid_file" || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "$name: running (pid $pid, port $port)"
      return
    fi
  fi

  echo "$name: stopped (port $port)"
}

print_status "server" "$RUN_DIR/server.pid" "4000"
print_status "web" "$RUN_DIR/web.pid" "3000"
