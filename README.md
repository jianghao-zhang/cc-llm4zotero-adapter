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

## Repository Layout
- `src/bridge`: runtime bridge entrypoints
- `src/event-mapper`: event protocol translation
- `src/session-link`: session linking and persistence
- `docs`: integration notes and migration checklist

## Non-Goals (v0)
- Rebuilding llm-for-zotero UI
- Hardcoding domain skills in adapter core
