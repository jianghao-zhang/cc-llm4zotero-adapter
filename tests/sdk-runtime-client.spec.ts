import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeRuntimeAdapter } from "../src/bridge/claude-code-runtime-adapter.js";
import { ClaudeAgentSdkRuntimeClient } from "../src/providers/claude-agent-sdk-runtime-client.js";
import { setCachedModels } from "../src/providers/model-resolver.js";
import { InMemorySessionMapper } from "../src/session-link/session-mapper.js";

function makeStream(items: unknown[]): any {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield item;
      }
    }
  };
}

describe("ClaudeAgentSdkRuntimeClient", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("passes resume/allowedTools into query options and maps messages", async () => {
    let seenPrompt = "";
    let seenOptions: Record<string, unknown> = {};

    const runtime = new ClaudeAgentSdkRuntimeClient({
      settingSources: ["user", "project"],
      queryImpl(args) {
        seenPrompt = typeof args.prompt === "string" ? args.prompt : "";
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

    expect(types).toEqual([
      "provider_event",
      "provider_event",
      "status",
      "provider_event",
      "message_delta",
      "provider_event",
      "final"
    ]);
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

  it("forwards appendSystemPrompt option to sdk query options", async () => {
    let seenOptions: Record<string, unknown> = {};

    const runtime = new ClaudeAgentSdkRuntimeClient({
      appendSystemPrompt: "Use evidence-first reading style.",
      queryImpl(args) {
        seenOptions = args.options;
        return makeStream([
          { type: "result", session_id: "session-new", result: "ok", is_error: false }
        ]);
      }
    });

    await runtime.startTurn({
      conversationKey: "conv-1",
      userMessage: "hello"
    });

    expect(seenOptions.appendSystemPrompt).toBe("Use evidence-first reading style.");
  });

  it("falls back to USERPROFILE for user settings path", async () => {
    let seenOptions: Record<string, unknown> = {};

    delete process.env.HOME;
    process.env.USERPROFILE = "/tmp/windows-home";

    const runtime = new ClaudeAgentSdkRuntimeClient({
      settingSources: ["user"],
      queryImpl(args) {
        seenOptions = args.options;
        return makeStream([
          { type: "result", session_id: "session-new", result: "ok", is_error: false }
        ]);
      }
    });

    await runtime.startTurn({
      conversationKey: "conv-1",
      userMessage: "hello"
    });

    expect(String(seenOptions.appendSystemPrompt)).toContain("/tmp/windows-home/.claude/settings.json");
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

  it("keeps hot runtime when resolved model changes after cache warmup", async () => {
    setCachedModels(["user", "project"], []);
    let queryCount = 0;
    const seenResumes: Array<unknown> = [];
    let turnIndex = 0;

    const runtime = new ClaudeAgentSdkRuntimeClient({
      forwardFrontendModel: true,
      settingSources: ["user", "project"],
      queryImpl(args) {
        queryCount += 1;
        const options = args.options as Record<string, unknown>;
        seenResumes.push(options.resume);
        const prompt = args.prompt as AsyncIterable<unknown>;
        return {
          async *[Symbol.asyncIterator]() {
            for await (const _message of prompt) {
              turnIndex += 1;
              yield { type: "system", session_id: "sess-hot", subtype: "init" };
              yield { type: "result", session_id: "sess-hot", result: `ok-${turnIndex}`, is_error: false };
            }
          }
        } as any;
      }
    });

    await runtime.retainHotRuntime({ conversationKey: "conv-hot", userMessage: "" }, "mount-1");

    const first = await runtime.startTurn({
      conversationKey: "conv-hot",
      userMessage: "hello",
      metadata: { model: "sonnet" }
    });
    for await (const _event of first.events) {
      void _event;
    }

    setCachedModels(["user", "project"], [{ value: "claude-sonnet-4-6" }]);

    const second = await runtime.startTurn({
      conversationKey: "conv-hot",
      userMessage: "again",
      metadata: { model: "sonnet" }
    });
    for await (const _event of second.events) {
      void _event;
    }

    expect(queryCount).toBe(1);
    expect(seenResumes).toEqual([undefined]);
  });
});
