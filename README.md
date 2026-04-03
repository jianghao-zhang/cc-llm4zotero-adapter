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

## Current Status
- Implemented `runTurn(request, { onStart, onEvent, signal })`.
- Implemented event mapping for:
  - `status/tool_call/tool_result/tool_error`
  - `confirmation_required/confirmation_resolved`
  - `message_delta/message_rollback`
  - `final/fallback`
- Implemented session mapping:
  - `InMemorySessionMapper`
  - `JsonFileSessionMapper`
- Implemented trace stores:
  - `InMemoryTraceStore`
  - `JsonFileTraceStore`
- Implemented Claude Agent SDK runtime client:
  - `ClaudeAgentSdkRuntimeClient`
  - SDK message -> frontend-compatible event mapping
- Added unit tests for event flow + session/trace behavior.

## Quick Start
```bash
npm install
npm run build
npm test
```

Start bridge server:

```bash
npx tsx bin/start-bridge-server.ts --host 127.0.0.1 --port 18787
```

Zotero-focused default startup (recommended):

```bash
npm run serve:bridge:zotero
```

This uses:
- `runtime-cwd = $HOME/Zotero/agent-runtime` (forced into Zotero workspace)
- `state-dir = $HOME/Zotero/agent-state`
  - session links: `session-links/sessions.json`
  - traces: `turn-traces/trace.json`

Isolation-first recommendation (keep Zotero runs separate from your daily Claude Code usage):

```bash
npx tsx bin/start-bridge-server.ts \
  --host 127.0.0.1 \
  --port 18787 \
  --runtime-cwd "$HOME/claude-profiles/zotero-harness" \
  --setting-sources project,local \
  --append-system-prompt-file "$HOME/claude-profiles/zotero-harness/prompts/literature-overlay.md"
```

CLI/env options:
- `--runtime-cwd` or `ADAPTER_RUNTIME_CWD`: workspace root Claude Agent SDK should run in.
- `--additional-directories` or `ADAPTER_ADDITIONAL_DIRECTORIES`: extra readable directories (comma-separated absolute paths, `~` supported).
- `--setting-sources` or `ADAPTER_SETTING_SOURCES`: comma-separated settings sources (`user,project,local`).
- `--append-system-prompt` or `ADAPTER_APPEND_SYSTEM_PROMPT`: inline overlay prompt text.
- `--append-system-prompt-file` or `ADAPTER_APPEND_SYSTEM_PROMPT_FILE`: file-based overlay prompt text.
- Default `runtime-cwd` is `$HOME/Zotero/agent-runtime` when `~/Zotero` exists.
- Default additional readable directories are `$HOME/Zotero`, `$HOME/Downloads`, `$HOME/Documents`.
- Runtime cwd is validated:
  - using HOME directly is forbidden
  - runtime cwd must be inside `~/Zotero` when that directory exists
- Default `state-dir` is `$HOME/Zotero/agent-state` when `~/Zotero` exists (otherwise `$HOME/agent-state`).
- Default `settingSources` is `project,local` (does not load global `user` settings unless explicitly requested).

Model/profile behavior:
- By default, frontend `metadata.model` is ignored.
- Runtime model selection follows your local Claude Code profile (for example `cc-switch` active profile).
- If you explicitly want frontend model passthrough, start with:

```bash
ADAPTER_FORWARD_FRONTEND_MODEL=true npx tsx bin/start-bridge-server.ts --host 127.0.0.1 --port 18787
```

## Adapter Contract
```ts
runTurn(request, { onStart, onEvent, signal }) -> outcome
```

`request` contains:
- `conversationKey`
- `userMessage`
- optional `allowedTools`
- optional `metadata`

Events emitted to `onEvent` are frontend-compatible `AgentEvent` values.

## Next Step (Runtime Binding)
The adapter runtime interface remains intentionally minimal:

```ts
interface ClaudeCodeRuntimeClient {
  startTurn(request: RuntimeTurnRequest): Promise<RuntimeTurnStream>;
}
```

`ClaudeAgentSdkRuntimeClient` already binds real `@anthropic-ai/claude-agent-sdk` streaming output into adapter events.

Remaining integration focus is wiring this adapter into `llm-for-zotero` backend entrypoints.

## Official References
- Agent SDK TS reference: [TypeScript SDK](https://platform.claude.com/docs/en/agent-sdk/typescript)
- Agent SDK overview: [Overview](https://platform.claude.com/docs/en/agent-sdk/overview)

## Repository Layout
- `src/bridge`: runtime bridge entrypoints
- `src/event-mapper`: event protocol translation
- `src/session-link`: session linking and persistence
- `docs`: integration notes and migration checklist

## Non-Goals (v0)
- Rebuilding llm-for-zotero UI
- Hardcoding domain skills in adapter core
