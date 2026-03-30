import { describe, expect, it } from "vitest";
import { ClaudeCodeRuntimeAdapter } from "../src/bridge/claude-code-runtime-adapter.js";
import type { ClaudeCodeRuntimeClient, ProviderEvent } from "../src/runtime.js";
import { InMemorySessionMapper } from "../src/session-link/session-mapper.js";
import { InMemoryTraceStore } from "../src/trace-store/trace-store.js";

function providerEvents(events: ProviderEvent[]): AsyncIterable<ProviderEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    }
  };
}

describe("ClaudeCodeRuntimeAdapter", () => {
  it("maps runtime events and persists session mapping + traces", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-1",
          providerSessionId: "claude-session-1",
          events: providerEvents([
            { type: "status", payload: { label: "running" } },
            { type: "message_delta", payload: { delta: "Hello " } },
            { type: "message_delta", payload: { delta: "world" } },
            { type: "final", payload: { output: "Hello world" } }
          ])
        };
      }
    };

    const sessionMapper = new InMemorySessionMapper();
    const traceStore = new InMemoryTraceStore();
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper,
      traceStore
    });

    const seenTypes: string[] = [];

    const outcome = await adapter.runTurn(
      {
        conversationKey: "conv-A",
        userMessage: "summarize this"
      },
      {
        onEvent(event) {
          seenTypes.push(event.type);
        }
      }
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.finalText).toBe("Hello world");
    expect(await sessionMapper.get("conv-A")).toBe("claude-session-1");
    expect(seenTypes).toEqual(["status", "message_delta", "message_delta", "final"]);

    const traces = await traceStore.list("conv-A");
    expect(traces).toHaveLength(4);
    expect(traces[0]?.runId).toBe("run-1");
  });

  it("emits fallback on unmapped event", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-2",
          events: providerEvents([{ type: "unknown", payload: { raw: true } }])
        };
      }
    };

    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper()
    });

    const seenTypes: string[] = [];

    await adapter.runTurn(
      {
        conversationKey: "conv-B",
        userMessage: "hello"
      },
      {
        onEvent(event) {
          seenTypes.push(event.type);
        }
      }
    );

    expect(seenTypes).toEqual(["fallback"]);
  });
});
