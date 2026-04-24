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
  it("coalesces adjacent text deltas before forwarding them", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-coalesce",
          providerSessionId: "claude-session-coalesce",
          events: providerEvents([
            { type: "message_delta", payload: { delta: "Hello" } },
            { type: "message_delta", payload: { delta: " " } },
            { type: "message_delta", payload: { delta: "world" } },
            { type: "final", payload: { output: "Hello world" } }
          ])
        };
      }
    };

    const seen: Array<{ type: string; delta?: string }> = [];
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper()
    });

    const outcome = await adapter.runTurn(
      {
        conversationKey: "conv-coalesce",
        userMessage: "hello"
      },
      {
        onEvent(event) {
          seen.push({
            type: event.type,
            delta: event.type === "message_delta" ? event.payload.delta : undefined,
          });
        }
      }
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.finalText).toBe("Hello world");
    expect(seen).toEqual([
      { type: "message_delta", delta: "Hello world" },
      { type: "final", delta: undefined },
    ]);
  });

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
    expect(seenTypes).toEqual(["status", "message_delta", "final"]);

    const traces = await traceStore.list("conv-A");
    expect(traces).toHaveLength(3);
    expect(traces[0]?.runId).toBe("run-1");
  });

  it("emits provider_event on unmapped event", async () => {
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

    expect(seenTypes).toEqual(["provider_event"]);
  });

  it("retries with fresh session when thinking signature is invalid", async () => {
    let callCount = 0;
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn(request) {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("API Error: 400 Invalid signature in thinking block");
        }
        return {
          runId: "run-ok",
          providerSessionId: "fresh-session-id",
          events: providerEvents([
            { type: "message_delta", payload: { delta: "ok" } },
            { type: "final", payload: { output: "ok" } }
          ])
        };
      }
    };

    const sessionMapper = new InMemorySessionMapper();
    await sessionMapper.set("conv-retry", "stale-session");
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper
    });

    const seenStatuses: string[] = [];
    const outcome = await adapter.runTurn(
      {
        conversationKey: "conv-retry",
        userMessage: "retry me"
      },
      {
        onEvent(event) {
          if (event.type === "status" && typeof event.payload.text === "string") {
            seenStatuses.push(event.payload.text);
          }
        }
      }
    );

    expect(callCount).toBe(2);
    expect(outcome.status).toBe("completed");
    expect(outcome.finalText).toBe("ok");
    expect(await sessionMapper.get("conv-retry")).toBe("fresh-session-id");
    expect(seenStatuses.some((line) => line.includes("Session signature mismatch"))).toBe(true);
  });

  it("clears mapper and hot runtime on explicit invalidation", async () => {
    let invalidatedConversationKey = "";
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "noop",
          events: providerEvents([]),
        };
      },
      async invalidateHotRuntime(conversationKey) {
        invalidatedConversationKey = conversationKey;
      },
    };

    const sessionMapper = new InMemorySessionMapper();
    await sessionMapper.set("conv-invalidate", "stale-session");
    await sessionMapper.set("conv-invalidate::provider:provider-a", "stale-session-provider");
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper,
    });

    await sessionMapper.set("conv-invalidate::provider:provider-b", "stale-session-provider-b");

    await adapter.invalidateConversationSession({
      conversationKey: "conv-invalidate",
      metadata: { providerIdentity: "provider-a" },
    });

    expect(await sessionMapper.get("conv-invalidate")).toBeUndefined();
    expect(await sessionMapper.get("conv-invalidate::provider:provider-a")).toBeUndefined();
    expect(await sessionMapper.get("conv-invalidate::provider:provider-b")).toBeUndefined();
    expect(invalidatedConversationKey).toBe("conv-invalidate");
  });

  it("deletes stale mappings before force-fresh retry", async () => {
    const seenResumes: Array<string | undefined> = [];
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn(request) {
        seenResumes.push(request.providerSessionId);
        return {
          runId: "run-fresh",
          providerSessionId: "fresh-session",
          events: providerEvents([
            { type: "final", payload: { output: "fresh" } },
          ]),
        };
      },
      async invalidateHotRuntime() {},
    };

    const sessionMapper = new InMemorySessionMapper();
    await sessionMapper.set("conv-fresh::provider:provider-a", "stale-session");
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper,
    });

    const outcome = await adapter.runTurn({
      conversationKey: "conv-fresh",
      userMessage: "new chat",
      metadata: { forceFreshSession: true, providerIdentity: "provider-a" },
    });

    expect(outcome.status).toBe("completed");
    expect(seenResumes).toEqual([undefined]);
    expect(await sessionMapper.get("conv-fresh::provider:provider-a")).toBe("fresh-session");
  });
});
