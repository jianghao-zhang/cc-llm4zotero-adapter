# cc-llm4zotero-adapter

HTTP bridge adapter between `llm-for-zotero` (Claude Code Bridge backend mode) and Claude Agent SDK runtime.

## Overview

### What this repo does

- Streams `/run-turn` events from Claude runtime into llm-for-zotero compatible agent events.
- Exposes `/commands` for slash command discovery.
- Exposes `/session-info` for conversation/session recovery.
- Persists session links and run traces in adapter state storage.

## Quick Start (Foreground)

```bash
npm install
npm run build
npm test
npm run serve:bridge
```

Default bind:

- Host: `127.0.0.1`
- Port: `19787`
- Health: `http://127.0.0.1:19787/healthz`

## Quick Install (macOS Daemon)

For non-technical users, run:

```bash
./scripts/install-macos-daemon.sh
```

This installs a LaunchAgent service: `com.toha.ccbridge`.

Useful daemon commands:

```bash
npm run daemon:status
npm run daemon:start
npm run daemon:stop
npm run daemon:restart
npm run daemon:uninstall
```

## HTTP Endpoints

### GET `/healthz`

Health check endpoint.

### GET `/commands`

Returns Claude slash commands.

- Query: `settingSources=user,project,local` (optional)

### GET `/session-info`

Returns session mapping information for a conversation.

- Query: `conversationKey` (required)
- Query: `scopeType`, `scopeId`, `scopeLabel` (optional)

### POST `/run-turn`

Runs one agent turn with streaming events.

- Required body: `conversationKey`, `userText`
- Optional body: `allowedTools`, `scopeType`, `scopeId`, `scopeLabel`, `runtimeRequest`, `metadata`

### POST `/run-action`

Runs a tool/action request.

- Required body: `conversationKey`, `toolName`
- Optional body: `args`, `approved`, scope fields, metadata/context fields

### POST `/resolve-confirmation`

Resolves pending confirmation requests.

- Required body: `requestId`, `approved`
- Optional body: `actionId`, `data`

### Additional read endpoints

- `GET /tools`
- `GET /models`
- `GET /efforts`

## Runtime / Environment Options

Server start command:

```bash
npm run serve:bridge
```

| Flag | Env | Description |
|------|-----|-------------|
| `--host` | `ADAPTER_HOST` | Bind host (default `127.0.0.1`) |
| `--port` | `ADAPTER_PORT` | Bind port (default `19787`) |
| `--runtime-cwd` | `ADAPTER_RUNTIME_CWD` | Workspace root for Claude Agent SDK. Defaults to `$HOME/Zotero/agent-runtime` when `~/Zotero` exists. |
| `--state-dir` | `ADAPTER_STATE_DIR` | Session/trace persistence directory. Defaults to `$HOME/Zotero/agent-state`. |
| `--additional-directories` | `ADAPTER_ADDITIONAL_DIRECTORIES` | Extra readable directories (comma-separated, `~` supported). |
| `--default-allowed-tools` | `ADAPTER_DEFAULT_ALLOWED_TOOLS` | Tools always auto-allowed (comma-separated). Default: `WebFetch,WebSearch`. |
| `--setting-sources` | `ADAPTER_SETTING_SOURCES` | Claude settings sources: `user`, `project`, `local` (comma-separated). Default: `project,local`. |
| `--append-system-prompt` | `ADAPTER_APPEND_SYSTEM_PROMPT` | Inline overlay prompt text. |
| `--append-system-prompt-file` | `ADAPTER_APPEND_SYSTEM_PROMPT_FILE` | File-based overlay prompt. |
| `--forward-frontend-model` | `ADAPTER_FORWARD_FRONTEND_MODEL` | Pass frontend `metadata.model` to runtime (default `true`). |

Default additional readable directories:

- `$HOME/Zotero`
- `$HOME/Downloads`
- `$HOME/Documents`

## Troubleshooting

### 1) Daemon is not running

```bash
launchctl stop com.toha.ccbridge
launchctl start com.toha.ccbridge
curl -fsS http://127.0.0.1:19787/healthz
```

### 2) Bridge URL or port mismatch

- Make sure llm-for-zotero Bridge URL matches adapter bind address.
- Default is `http://127.0.0.1:19787`.

### 3) Claude CLI not ready

If you see `claude: command not found`, install and configure Claude Code CLI first.

### Logs

```bash
~/Library/Logs/cc-llm4zotero-adapter/
```

## Repository Layout

- `src/bridge` — bridge/runtime adapter contracts and wrappers
- `src/event-mapper` — Claude SDK events to llm-for-zotero event mapping
- `src/session-link` — conversationKey ↔ provider session mapping
- `src/trace-store` — run trace persistence
- `src/providers` — Claude Agent SDK runtime client
- `src/server` — HTTP bridge server
- `bin/start-bridge-server.ts` — foreground server entrypoint
- `bin/manage-daemon.ts` — macOS daemon manager

## References

- [Claude Agent SDK TypeScript](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Claude Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
