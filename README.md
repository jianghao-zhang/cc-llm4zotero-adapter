# cc-llm4zotero-adapter

Adapter that connects `llm-for-zotero` frontend-compatible agent flow to Claude Code runtime via literature-agent-harness contracts.

## Goal
- Keep existing `llm-for-zotero` frontend interaction model.
- Replace agent backend runtime path with Claude Code-backed adapter.
- Maintain event compatibility for trace/confirmation UX.

## Scope (v0)
- runTurn bridge wiring
- event mapping compatibility layer
- conversationKey <-> provider session id linking
- trace loading/replay compatibility hooks

## Quick Start

```bash
npm install
npm run build
npm test
```

Local dev (no daemon):

```bash
npm run serve:bridge  # port 8787
```

## CLI / Environment Options

| Flag | Env | Description |
|------|-----|-------------|
| `--host` | `ADAPTER_HOST` | Bind host (default `127.0.0.1`) |
| `--port` | `ADAPTER_PORT` | Bind port (default `8787`) |
| `--runtime-cwd` | `ADAPTER_RUNTIME_CWD` | Workspace root for Claude Agent SDK. Defaults to `$HOME/Zotero/agent-runtime` when `~/Zotero` exists. |
| `--state-dir` | `ADAPTER_STATE_DIR` | Session/trace persistence directory. Defaults to `$HOME/Zotero/agent-state`. |
| `--additional-directories` | `ADAPTER_ADDITIONAL_DIRECTORIES` | Extra readable directories (comma-separated, `~` supported). |
| `--default-allowed-tools` | `ADAPTER_DEFAULT_ALLOWED_TOOLS` | Tools always auto-allowed (comma-separated). Default: `WebFetch,WebSearch`. |
| `--setting-sources` | `ADAPTER_SETTING_SOURCES` | Claude settings sources: `user`, `project`, `local` (comma-separated). Default: `project,local`. |
| `--append-system-prompt` | `ADAPTER_APPEND_SYSTEM_PROMPT` | Inline overlay prompt text. |
| `--append-system-prompt-file` | `ADAPTER_APPEND_SYSTEM_PROMPT_FILE` | File-based overlay prompt. |
| `--forward-frontend-model` | `ADAPTER_FORWARD_FRONTEND_MODEL` | Pass frontend `metadata.model` to runtime (default `true`). |

Default additional readable directories: `$HOME/Zotero`, `$HOME/Downloads`, `$HOME/Documents`.

## Adapter Contract

```ts
runTurn(request, { onStart, onEvent, signal }) -> outcome
```

`request` fields:
- `conversationKey`
- `userMessage`
- optional `allowedTools`
- optional `metadata`

Events emitted to `onEvent` are frontend-compatible `AgentEvent` values.

## Repository Layout

- `src/bridge` — runtime bridge entrypoints
- `src/event-mapper` — event protocol translation
- `src/session-link` — session linking and persistence
- `src/providers` — Claude Agent SDK runtime client
- `src/server` — HTTP bridge server
- `bin/start-bridge-server.ts` — bridge entrypoint

## Non-Goals (v0)
- Rebuilding llm-for-zotero UI
- Hardcoding domain skills in adapter core

## References
- [Claude Agent SDK TypeScript](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Claude Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
