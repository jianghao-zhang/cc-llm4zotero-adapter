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
- Added unit tests for event flow + session/trace behavior.

## Quick Start
```bash
npm install
npm run build
npm test
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
The current runtime interface is intentionally minimal:

```ts
interface ClaudeCodeRuntimeClient {
  startTurn(request: RuntimeTurnRequest): Promise<RuntimeTurnStream>;
}
```

To bind real Claude Code SDK/CLI, implement `startTurn` and stream provider events into this adapter.

## Repository Layout
- `src/bridge`: runtime bridge entrypoints
- `src/event-mapper`: event protocol translation
- `src/session-link`: session linking and persistence
- `docs`: integration notes and migration checklist

## Non-Goals (v0)
- Rebuilding llm-for-zotero UI
- Hardcoding domain skills in adapter core
