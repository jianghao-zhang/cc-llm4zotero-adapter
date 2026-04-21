# cc-llm4zotero-adapter

HTTP bridge adapter between [llm-for-zotero](https://github.com/yilewang/llm-for-zotero) (Claude Code Bridge backend mode) and Claude Agent SDK runtime.

## Overview

### What this repo does

- Streams `/run-turn` events from Claude runtime into llm-for-zotero compatible agent events.
- Exposes `/commands` for slash command discovery.
- Exposes `/session-info` for conversation/session recovery.
- Persists session links and run traces in adapter state storage.

In practice, this repo is the bridge that lets `llm-for-zotero` talk to a real Claude Code runtime instead of treating Claude Code as a fake in-plugin backend.

## Before you start: Claude Code must already work on this machine

This adapter does not replace Claude Code CLI. It depends on it.

Before starting the bridge, make sure Claude Code itself is installed and authenticated:

- Installation: https://code.claude.com/docs/en/installation.md
- Quickstart: https://code.claude.com/docs/en/quickstart.md
- Authentication: https://code.claude.com/docs/en/authentication.md
- Settings: https://code.claude.com/docs/en/settings.md

Minimum sanity check:

```bash
claude
```

If Claude Code is not installed, not on `PATH`, or not logged in yet, the bridge may start but actual Claude turns will still fail.

## Quick Start (Foreground)

If you do not already have this repo locally:

```bash
git clone https://github.com/jianghao-zhang/cc-llm4zotero-adapter.git
cd cc-llm4zotero-adapter
```

Then start the bridge:

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

Health check:

```bash
curl -fsS http://127.0.0.1:19787/healthz
```

A healthy bridge only means the adapter server is up. It does **not** guarantee that Claude Code CLI is installed, authenticated, or usable yet.

## Quick Install (macOS Daemon)

If you do not already have this repo locally:

```bash
git clone https://github.com/jianghao-zhang/cc-llm4zotero-adapter.git
cd cc-llm4zotero-adapter
```

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

## How this is meant to be used with llm-for-zotero

After the bridge is healthy, go to `llm-for-zotero` settings and:

1. enable Claude Code mode
2. keep Bridge URL at `http://127.0.0.1:19787` unless you intentionally changed it
3. choose a config source mode
4. pick permission/model/reasoning defaults

Then enter Claude Code from the dedicated Claude button in the chat UI. Settings configure the runtime; they are not the main chat entry point.

## Config source in plain English

Claude Code itself supports layered config such as user / project / local settings:

- https://code.claude.com/docs/en/settings.md
- https://code.claude.com/docs/en/settings.md#configuration-scopes
- https://code.claude.com/docs/en/settings.md#settings-precedence

In this Zotero integration, those layers are used like this:

- `user` → your normal machine-level Claude Code setup
- `project` → the shared Zotero Claude runtime root
- `local` → the current conversation-specific runtime folder

That is why this adapter works well for both kinds of users:

- users who want Zotero to reuse their normal Claude setup
- users who want Zotero-specific shared behavior without polluting global Claude usage

## Shared runtime root and skills

The adapter defaults to a shared Claude runtime root under `~/Zotero/agent-runtime` and a state dir under `~/Zotero/agent-state`.

The shared runtime root is where Zotero-level Claude assets are expected to live, including things like:

- `CLAUDE.md`
- `.claude/settings.json`
- `.claude/skills/`
- `.claude/commands/`

For most users, shared Claude skills for Zotero should live in that project-level layer rather than in unrelated global user config.

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
| `--runtime-cwd` | `ADAPTER_RUNTIME_CWD` | Workspace root for Claude Agent SDK. Defaults to the legacy Zotero runtime path when available. |
| `--state-dir` | `ADAPTER_STATE_DIR` | Session/trace persistence directory. Defaults to the legacy Zotero state path when available. |
| `--zotero-root` | `ZOTERO_ROOT` | Override the legacy Zotero root used to derive default runtime/state paths. Useful when Zotero data is not under the home directory. |
| `--additional-directories` | `ADAPTER_ADDITIONAL_DIRECTORIES` | Extra readable directories (comma-separated, `~` supported). |
| `--default-allowed-tools` | `ADAPTER_DEFAULT_ALLOWED_TOOLS` | Tools always auto-allowed (comma-separated). Default: `WebFetch,WebSearch`. |
| `--setting-sources` | `ADAPTER_SETTING_SOURCES` | Claude settings sources: `user`, `project`, `local` (comma-separated). Default: `project,local`. |
| `--append-system-prompt` | `ADAPTER_APPEND_SYSTEM_PROMPT` | Inline overlay prompt text. |
| `--append-system-prompt-file` | `ADAPTER_APPEND_SYSTEM_PROMPT_FILE` | File-based overlay prompt. Missing optional files are ignored. |
| `--forward-frontend-model` | `ADAPTER_FORWARD_FRONTEND_MODEL` | Pass frontend `metadata.model` to runtime (default `true`). Generic aliases like `opus`, `sonnet`, and `haiku` are forwarded when the SDK accepts them. |
| `--log-file` | `ADAPTER_LOG_FILE` | Mirror bridge stdout/stderr to a file. Use `1` / `true` to write to `<state-dir>/bridge.log`. |

Default additional readable directories:

- `$HOME/Zotero`
- `$HOME/Downloads`
- `$HOME/Documents`

## Troubleshooting

### 1) The bridge is not running or got stuck

```bash
launchctl stop com.toha.ccbridge
launchctl start com.toha.ccbridge
curl -fsS http://127.0.0.1:19787/healthz
```

You can also use:

```bash
npm run daemon:status
npm run daemon:restart
```

### 2) Bridge URL or port mismatch

- Make sure llm-for-zotero Bridge URL matches adapter bind address.
- Default is `http://127.0.0.1:19787`.

### 3) Claude Code itself is not ready

If you see `claude: command not found`, install Claude Code CLI first.

If the bridge is healthy but Claude turns still fail, check Claude Code itself separately:

```bash
claude
```

If needed, finish login/auth there first.

### 4) Health is OK, but Zotero still cannot use Claude correctly

That usually means one of these layers is wrong:

- Claude Code CLI is not installed or not logged in
- the bridge is running on a different host/port than Zotero expects
- Zotero config source or permission setup is not what the user intended

### Logs

Daemon logs on macOS still live under:

```bash
~/Library/Logs/cc-llm4zotero-adapter/
```

If the bridge is started without an attached terminal and you also want a plain bridge process log, set `ADAPTER_LOG_FILE=1` (or pass `--log-file`) to mirror stdout/stderr into `<state-dir>/bridge.log`.

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
