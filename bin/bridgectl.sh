#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${BRIDGE_HOST:-127.0.0.1}"
PORT="${BRIDGE_PORT:-18787}"
PID_FILE="${BRIDGE_PID_FILE:-/tmp/cc-llm4zotero-bridge.pid}"
LOG_FILE="${BRIDGE_LOG_FILE:-/tmp/cc-llm4zotero-bridge.log}"

export ADAPTER_RUNTIME_CWD="${ADAPTER_RUNTIME_CWD:-$HOME/Zotero/agent-runtime}"
export ADAPTER_STATE_DIR="${ADAPTER_STATE_DIR:-$HOME/Zotero/agent-state}"
export ADAPTER_ADDITIONAL_DIRECTORIES="${ADAPTER_ADDITIONAL_DIRECTORIES:-$HOME/Zotero,$HOME/Downloads,$HOME/Documents}"
export ADAPTER_DEFAULT_ALLOWED_TOOLS="${ADAPTER_DEFAULT_ALLOWED_TOOLS:-WebFetch,WebSearch}"

is_running() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && ps -p "$pid" >/dev/null 2>&1; then
      return 0
    fi
  fi
  return 1
}

start_bridge() {
  if is_running; then
    echo "bridge already running (pid=$(cat "$PID_FILE"))"
    return 0
  fi

  mkdir -p "$(dirname "$LOG_FILE")"
  rm -f "$PID_FILE"
  nohup bash -lc "cd \"$ROOT_DIR\" && exec npx tsx bin/start-bridge-server.ts --host \"$HOST\" --port \"$PORT\"" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"

  sleep 1
  if curl -sS "http://${HOST}:${PORT}/healthz" >/dev/null 2>&1; then
    echo "bridge started (pid=$(cat "$PID_FILE"))"
    echo "healthz: http://${HOST}:${PORT}/healthz"
  else
    echo "bridge start failed, check logs: $LOG_FILE"
    return 1
  fi
}

stop_bridge() {
  if is_running; then
    local pid
    pid="$(cat "$PID_FILE")"
    kill "$pid" >/dev/null 2>&1 || true
    sleep 0.3
    kill -9 "$pid" >/dev/null 2>&1 || true
    rm -f "$PID_FILE"
    echo "bridge stopped (pid=${pid})"
  else
    pkill -f "bin/start-bridge-server.ts --host ${HOST} --port ${PORT}" >/dev/null 2>&1 || true
    echo "bridge not running"
  fi
}

status_bridge() {
  if is_running; then
    echo "running (pid=$(cat "$PID_FILE"))"
  else
    echo "stopped"
  fi
  if curl -sS "http://${HOST}:${PORT}/healthz" >/dev/null 2>&1; then
    echo "healthz ok: http://${HOST}:${PORT}/healthz"
  else
    echo "healthz down: http://${HOST}:${PORT}/healthz"
  fi
}

logs_bridge() {
  touch "$LOG_FILE"
  tail -n 120 "$LOG_FILE"
}

case "${1:-}" in
  start) start_bridge ;;
  stop) stop_bridge ;;
  restart) stop_bridge; start_bridge ;;
  status) status_bridge ;;
  logs) logs_bridge ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
