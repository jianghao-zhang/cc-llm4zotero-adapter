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

  it("includes paper, attachment, and note context in prompt text", async () => {
    let seenPrompt: unknown;

    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        seenPrompt = args.prompt;
        return makeStream([
          { type: "result", session_id: "session-new", result: "ok", is_error: false }
        ]);
      }
    });

    await runtime.startTurn({
      conversationKey: "conv-light",
      userMessage: "hello",
      runtimeRequest: {
        selectedPaperContexts: [{ title: "Paper A", contextItemId: 1, contextFilePath: "/tmp/a.md" }],
        fullTextPaperContexts: [{ title: "Paper B", contextItemId: 2, contextFilePath: "/tmp/b.md" }],
        pinnedPaperContexts: [{ title: "Paper C", contextItemId: 3, contextFilePath: "/tmp/c.md" }],
        attachments: [{ name: "notes.txt", storedPath: "/tmp/notes.txt", mimeType: "text/plain" }],
        activeNoteContext: { title: "Note", noteText: "content" },
      } as Record<string, unknown>,
    });

    expect(typeof seenPrompt).toBe("string");
    expect(String(seenPrompt)).toContain("Selected papers for this turn:");
    expect(String(seenPrompt)).toContain("Paper A");
    expect(String(seenPrompt)).toContain("Papers marked for full-text reading on this turn:");
    expect(String(seenPrompt)).toContain("Paper B");
    expect(String(seenPrompt)).toContain("Pinned papers:");
    expect(String(seenPrompt)).toContain("Paper C");
    expect(String(seenPrompt)).toContain("Attachments:");
    expect(String(seenPrompt)).toContain("notes.txt");
    expect(String(seenPrompt)).toContain("Active note context:");
    expect(String(seenPrompt)).toContain("Title: Note");
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

  it("bypasses retained hot runtime when forceFreshSession is requested", async () => {
    let queryCount = 0;
    const seenResumes: Array<unknown> = [];
    let turnIndex = 0;

    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        queryCount += 1;
        const options = args.options as Record<string, unknown>;
        seenResumes.push(options.resume);
        const prompt = args.prompt as AsyncIterable<unknown>;
        return {
          async *[Symbol.asyncIterator]() {
            for await (const _message of prompt) {
              turnIndex += 1;
              yield { type: "system", session_id: turnIndex === 1 ? "sess-old" : "sess-fresh", subtype: "init" };
              yield { type: "result", session_id: turnIndex === 1 ? "sess-old" : "sess-fresh", result: `ok-${turnIndex}`, is_error: false };
            }
          }
        } as any;
      }
    });

    await runtime.retainHotRuntime({ conversationKey: "conv-fresh-hot", userMessage: "" }, "mount-1");

    const first = await runtime.startTurn({
      conversationKey: "conv-fresh-hot",
      userMessage: "hello",
    });
    for await (const _event of first.events) {
      void _event;
    }

    const second = await runtime.startTurn({
      conversationKey: "conv-fresh-hot",
      userMessage: "fresh please",
      providerSessionId: "stale-session",
      metadata: { forceFreshSession: true },
    });
    for await (const _event of second.events) {
      void _event;
    }

    expect(queryCount).toBe(2);
    expect(seenResumes).toEqual([undefined, undefined]);
  });

  it("keeps hot runtime alive after release within retention window", async () => {
    let queryCount = 0;
    let turnIndex = 0;

    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        queryCount += 1;
        const prompt = args.prompt as AsyncIterable<unknown>;
        return {
          async *[Symbol.asyncIterator]() {
            for await (const _message of prompt) {
              turnIndex += 1;
              yield { type: "system", session_id: "sess-retained", subtype: "init" };
              yield { type: "result", session_id: "sess-retained", result: `ok-${turnIndex}`, is_error: false };
            }
          }
        } as any;
      }
    });

    await runtime.retainHotRuntime({ conversationKey: "conv-retained", userMessage: "" }, "mount-1");
    const first = await runtime.startTurn({
      conversationKey: "conv-retained",
      userMessage: "hello",
    });
    for await (const _event of first.events) {
      void _event;
    }

    await runtime.releaseHotRuntime("conv-retained", "mount-1");
    await runtime.retainHotRuntime({ conversationKey: "conv-retained", userMessage: "" }, "mount-2");

    const second = await runtime.startTurn({
      conversationKey: "conv-retained",
      userMessage: "again",
    });
    for await (const _event of second.events) {
      void _event;
    }

    expect(queryCount).toBe(1);
  });
});
