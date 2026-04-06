#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer currently supports macOS only."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but not found in PATH."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but not found in PATH."
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "Warning: 'claude' command not found. Install Claude Code CLI before using the bridge runtime."
fi

if [[ ! -d node_modules ]]; then
  echo "Installing npm dependencies..."
  npm install
fi

echo "Installing LaunchAgent..."
npm run daemon:install

echo "Starting daemon..."
npm run daemon:start

echo
echo "Done. Diagnostic commands:"
echo "  npm run daemon:status"
echo "  npm run daemon:restart"
echo "  launchctl stop com.toha.ccbridge"
echo "  launchctl start com.toha.ccbridge"
echo "  curl -fsS http://127.0.0.1:19787/healthz"
echo "Logs: ~/Library/Logs/cc-llm4zotero-adapter/"
