import { describe, expect, it } from "vitest";
import { ClaudeCodeRuntimeAdapter } from "../src/bridge/claude-code-runtime-adapter.js";
import { Llm4ZoteroAgentBackendAdapter } from "../src/bridge/llm4zotero-agent-backend-adapter.js";
import type { ClaudeCodeRuntimeClient, ProviderEvent } from "../src/runtime.js";
import { InMemorySessionMapper } from "../src/session-link/session-mapper.js";

function providerEvents(events: ProviderEvent[]): AsyncIterable<ProviderEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    }
  };
}

describe("Llm4ZoteroAgentBackendAdapter", () => {
  it("maps canonical adapter events to llm-for-zotero event contract", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-z-1",
          events: providerEvents([
            { type: "status", payload: { label: "running" } },
            { type: "message_delta", payload: { delta: "hello " } },
            { type: "tool_call", payload: { id: "call_1", name: "Read", input: { path: "a.ts" } } },
            { type: "tool_result", payload: { toolUseId: "call_1", name: "Read", content: "ok" } },
            { type: "final", payload: { output: "hello world" } }
          ])
        };
      }
    };

    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper()
    });

    const compat = new Llm4ZoteroAgentBackendAdapter(base);

    const seen: Array<{ type: string; payload: unknown }> = [];

    const outcome = await compat.runTurn({
      request: {
        conversationKey: 42,
        userText: "test"
      },
      onEvent(event) {
        seen.push({ type: event.type, payload: event });
      }
    });

    expect(outcome.kind).toBe("completed");
    expect(outcome.text).toBe("hello world");
    expect(seen.map((x) => x.type)).toEqual([
      "status",
      "message_delta",
      "tool_call",
      "tool_result",
      "final"
    ]);
  });

  it("returns fallback outcome when runtime fails", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-z-2",
          events: providerEvents([
            { type: "status", payload: { text: "starting" } }
          ])
        };
      }
    };

    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient: {
        async startTurn(request) {
          const stream = await runtimeClient.startTurn(request);
          return {
            ...stream,
            events: (async function* () {
              for await (const ev of stream.events) {
                yield ev;
              }
              throw new Error("boom");
            })()
          };
        }
      },
      sessionMapper: new InMemorySessionMapper()
    });

    const compat = new Llm4ZoteroAgentBackendAdapter(base);
    const outcome = await compat.runTurn({
      request: { conversationKey: "conv-fail", userText: "x" }
    });

    expect(outcome.kind).toBe("fallback");
    expect(outcome.usedFallback).toBe(true);
  });
});
