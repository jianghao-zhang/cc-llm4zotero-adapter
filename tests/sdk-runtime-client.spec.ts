import { describe, expect, it } from "vitest";
import { ClaudeCodeRuntimeAdapter } from "../src/bridge/claude-code-runtime-adapter.js";
import { ClaudeAgentSdkRuntimeClient } from "../src/providers/claude-agent-sdk-runtime-client.js";
import { InMemorySessionMapper } from "../src/session-link/session-mapper.js";

function makeStream(items: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield item;
      }
    }
  };
}

describe("ClaudeAgentSdkRuntimeClient", () => {
  it("passes resume/allowedTools into query options and maps messages", async () => {
    let seenPrompt = "";
    let seenOptions: Record<string, unknown> = {};

    const runtime = new ClaudeAgentSdkRuntimeClient({
      settingSources: ["user", "project"],
      queryImpl(args) {
        seenPrompt = args.prompt;
        seenOptions = args.options;
        return makeStream([
          { type: "system", session_id: "session-new", subtype: "init" },
          { type: "assistant", session_id: "session-new", message: { content: [{ type: "text", text: "hi" }] } },
          { type: "result", session_id: "session-new", result: "hi", is_error: false }
        ]);
      }
    });

    const stream = await runtime.startTurn({
      conversationKey: "conv-1",
      userMessage: "hello",
      providerSessionId: "session-old",
      allowedTools: ["Read", "Bash"]
    });

    expect(seenPrompt).toBe("hello");
    expect(seenOptions.resume).toBe("session-old");
    expect(seenOptions.allowedTools).toEqual(["Read", "Bash"]);

    const types: string[] = [];
    for await (const event of stream.events) {
      types.push(event.type);
    }

    expect(types).toEqual(["status", "message_delta", "final"]);
  });

  it("ignores frontend model metadata by default", async () => {
    let seenOptions: Record<string, unknown> = {};

    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        seenOptions = args.options;
        return makeStream([
          { type: "result", session_id: "session-new", result: "ok", is_error: false }
        ]);
      }
    });

    await runtime.startTurn({
      conversationKey: "conv-1",
      userMessage: "hello",
      metadata: { model: "gemini-3.1-pro-preview", activeItemId: 123 }
    });

    expect(seenOptions.model).toBeUndefined();
    expect(seenOptions.activeItemId).toBe(123);
  });

  it("can forward frontend model metadata when explicitly enabled", async () => {
    let seenOptions: Record<string, unknown> = {};

    const runtime = new ClaudeAgentSdkRuntimeClient({
      forwardFrontendModel: true,
      queryImpl(args) {
        seenOptions = args.options;
        return makeStream([
          { type: "result", session_id: "session-new", result: "ok", is_error: false }
        ]);
      }
    });

    await runtime.startTurn({
      conversationKey: "conv-1",
      userMessage: "hello",
      metadata: { model: "gemini-3.1-pro-preview" }
    });

    expect(seenOptions.model).toBe("gemini-3.1-pro-preview");
  });

  it("adapter updates session mapper from streamed sessionId", async () => {
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl() {
        return makeStream([
          { type: "system", session_id: "sess-live", subtype: "init" },
          { type: "result", session_id: "sess-live", result: "ok", is_error: false }
        ]);
      }
    });

    const sessionMapper = new InMemorySessionMapper();
    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient: runtime,
      sessionMapper
    });

    const outcome = await adapter.runTurn({
      conversationKey: "conv-session",
      userMessage: "ping"
    });

    expect(outcome.providerSessionId).toBe("sess-live");
    expect(await sessionMapper.get("conv-session")).toBe("sess-live");
  });
});
