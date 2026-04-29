import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeRuntimeAdapter } from "../src/bridge/claude-code-runtime-adapter.js";
import { ClaudeAgentSdkRuntimeClient } from "../src/providers/claude-agent-sdk-runtime-client.js";
import { setCachedModels } from "../src/providers/model-resolver.js";
import { globalPermissionStore } from "../src/permissions/permission-store.js";
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

function makeFailingStream(error: Error): any {
  return {
    async *[Symbol.asyncIterator]() {
      throw error;
    },
    close() {},
  };
}

function makeModelProbe(models: unknown[] = []): any {
  return {
    async supportedModels() {
      return models;
    },
    close() {},
    async return() {
      return undefined;
    },
  };
}

async function nextEvent(
  iterator: AsyncIterator<any>,
  timeoutMs = 1_000,
): Promise<IteratorResult<any>> {
  return Promise.race([
    iterator.next(),
    new Promise<IteratorResult<any>>((_, reject) => {
      setTimeout(() => reject(new Error("Timed out waiting for event")), timeoutMs);
    }),
  ]);
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
    globalPermissionStore.cleanup();
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
      "provider_event",
      "status",
      "provider_event",
      "message_delta",
      "provider_event",
      "final"
    ]);
  });

  it("emits SDK canUseTool permission requests on cold streams before resolution", async () => {
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        const canUseTool = args.options.canUseTool as (
          toolName: string,
          input: Record<string, unknown>,
          options: {
            signal: AbortSignal;
            title?: string;
            description?: string;
            displayName?: string;
            toolUseID: string;
          },
        ) => Promise<{ behavior: string }>;
        return {
          async *[Symbol.asyncIterator]() {
            const result = await canUseTool(
              "Bash",
              { command: "mkdir -p .claude/skills/example" },
              {
                signal: new AbortController().signal,
                title: "Allow Bash?",
                description: "Claude wants to create a skill directory.",
                displayName: "Bash",
                toolUseID: "tool-use-cold-permission",
              },
            );
            yield {
              type: "result",
              session_id: "session-permission",
              result: result.behavior,
              is_error: false,
            };
          },
          close() {},
        } as any;
      },
    });

    const stream = await runtime.startTurn({
      conversationKey: "conv-permission-cold",
      userMessage: "install a skill",
    });
    const iterator = stream.events[Symbol.asyncIterator]();
    let confirmation: any;
    for (let i = 0; i < 5; i += 1) {
      const next = await nextEvent(iterator);
      if (next.done) break;
      if (next.value.type === "confirmation_required") {
        confirmation = next.value;
        break;
      }
    }

    expect(confirmation?.payload?.requestId).toMatch(/^perm-/);
    expect(confirmation?.payload?.action?.toolName).toBe("Bash");
    expect(globalPermissionStore.resolve(confirmation.payload.requestId, { approved: true })).toBe(true);

    const remainingTypes: string[] = [];
    for (;;) {
      const next = await nextEvent(iterator);
      if (next.done) break;
      remainingTypes.push(next.value.type);
    }
    expect(remainingTypes).toContain("final");
  });

  it("omits host permission callback in yolo/bypass mode", async () => {
    let seenOptions: Record<string, unknown> = {};
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        seenOptions = args.options;
        return makeStream([
          { type: "result", session_id: "session-yolo", result: "ok", is_error: false }
        ]);
      },
    });

    const stream = await runtime.startTurn({
      conversationKey: "conv-yolo-permission",
      userMessage: "edit a file",
      metadata: {
        permissionMode: "yolo",
      },
    });
    for await (const _event of stream.events) {
      void _event;
    }

    expect(seenOptions.permissionMode).toBe("bypassPermissions");
    expect(seenOptions.canUseTool).toBeUndefined();
    expect(globalPermissionStore.pendingCount()).toBe(0);
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

  it("falls back unsupported xhigh effort when SDK capabilities are explicit", async () => {
    let seenOptions: Record<string, unknown> = {};

    const runtime = new ClaudeAgentSdkRuntimeClient({
      forwardFrontendModel: true,
      queryImpl(args) {
        if (args.prompt === "") {
          return makeModelProbe([
            {
              value: "haiku",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high"],
            },
          ]);
        }
        seenOptions = args.options;
        return makeStream([
          { type: "result", session_id: "session-new", result: "ok", is_error: false }
        ]);
      }
    });

    await runtime.startTurn({
      conversationKey: "conv-effort",
      userMessage: "hello",
      metadata: { model: "haiku", effort: "xhigh" }
    });

    expect(seenOptions.effort).toBe("high");
    expect(String(seenOptions.effortFallbackNotice)).toBe("XHigh is unavailable for this model. Using High.");
  });

  it("retries unknown xhigh effort with high when SDK init fails early", async () => {
    process.env.HOME = "/tmp/cc-l4z-effort-retry";
    const seenEfforts: unknown[] = [];
    const seenStatus: string[] = [];

    const runtime = new ClaudeAgentSdkRuntimeClient({
      forwardFrontendModel: true,
      queryImpl(args) {
        if (args.prompt === "") return makeModelProbe([]);
        seenEfforts.push(args.options.effort);
        if (args.options.effort === "xhigh") {
          return makeFailingStream(new Error("unsupported effort"));
        }
        return makeStream([
          { type: "system", session_id: "session-new", subtype: "init" },
          { type: "result", session_id: "session-new", result: "ok", is_error: false }
        ]);
      }
    });

    const stream = await runtime.startTurn({
      conversationKey: "conv-effort-retry",
      userMessage: "hello",
      metadata: { model: "haiku", effort: "xhigh" }
    });

    const events = [];
    for await (const event of stream.events) {
      events.push(event.type);
      if (event.type === "status" && typeof event.payload.text === "string") {
        seenStatus.push(event.payload.text);
      }
    }

    expect(seenEfforts).toEqual(["xhigh", "high"]);
    expect(events).toContain("final");
    expect(seenStatus.some((text) => text.includes("Retrying with High"))).toBe(true);
  });

  it("remembers the last good effort after an early retry", async () => {
    process.env.HOME = "/tmp/cc-l4z-effort-cache";
    const seenEfforts: unknown[] = [];

    const runtime = new ClaudeAgentSdkRuntimeClient({
      forwardFrontendModel: true,
      queryImpl(args) {
        if (args.prompt === "") return makeModelProbe([]);
        seenEfforts.push(args.options.effort);
        if (seenEfforts.length === 1 && args.options.effort === "xhigh") {
          return makeFailingStream(new Error("unsupported effort"));
        }
        return makeStream([
          { type: "system", session_id: `session-${seenEfforts.length}`, subtype: "init" },
          { type: "result", session_id: `session-${seenEfforts.length}`, result: "ok", is_error: false }
        ]);
      }
    });

    for (const conversationKey of ["conv-effort-cache-a", "conv-effort-cache-b"]) {
      const stream = await runtime.startTurn({
        conversationKey,
        userMessage: "hello",
        metadata: { model: "haiku", effort: "xhigh" }
      });
      for await (const _event of stream.events) {
        void _event;
      }
    }

    const cache = (runtime as any).effortSuccessCache as Map<string, { updatedAt: number }>;
    for (const record of cache.values()) {
      record.updatedAt = Date.now() - 10 * 60_000;
    }

    const stream = await runtime.startTurn({
      conversationKey: "conv-effort-cache-c",
      userMessage: "hello",
      metadata: { model: "haiku", effort: "xhigh" }
    });
    for await (const _event of stream.events) {
      void _event;
    }

    expect(seenEfforts).toEqual(["xhigh", "high", "high", "xhigh"]);
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
      userMessage: "hello",
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

  it("injects local Zotero history only for resume fallback turns", async () => {
    let fallbackPrompt: unknown;
    let normalPrompt: unknown;

    const fallbackRuntime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        fallbackPrompt = args.prompt;
        return makeStream([
          { type: "result", session_id: "session-fallback", result: "ok", is_error: false }
        ]);
      }
    });
    await fallbackRuntime.startTurn({
      conversationKey: "conv-fallback-history",
      userMessage: "continue",
      metadata: { claudeResumeFallbackHistory: true },
      runtimeRequest: {
        history: [
          { role: "user", content: "old question" },
          { role: "assistant", content: "old answer" },
        ],
      } as Record<string, unknown>,
    });

    const normalRuntime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        normalPrompt = args.prompt;
        return makeStream([
          { type: "result", session_id: "session-normal", result: "ok", is_error: false }
        ]);
      }
    });
    await normalRuntime.startTurn({
      conversationKey: "conv-normal-history",
      userMessage: "continue",
      runtimeRequest: {
        history: [
          { role: "user", content: "old question" },
          { role: "assistant", content: "old answer" },
        ],
      } as Record<string, unknown>,
    });

    expect(String(fallbackPrompt)).toContain("Local Zotero conversation history");
    expect(String(fallbackPrompt)).toContain("old answer");
    expect(String(normalPrompt)).not.toContain("Local Zotero conversation history");
    expect(String(normalPrompt)).not.toContain("old answer");
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

  it("passes Claude 1m context model aliases through to SDK", async () => {
    const seenModels: Array<unknown> = [];

    const runtime = new ClaudeAgentSdkRuntimeClient({
      forwardFrontendModel: true,
      queryImpl(args) {
        const options = args.options as Record<string, unknown>;
        seenModels.push(options.model);
        return makeStream([
          { type: "system", session_id: "sess-1m", subtype: "init" },
          { type: "result", session_id: "sess-1m", result: "ok", is_error: false }
        ]);
      }
    });

    const stream = await runtime.startTurn({
      conversationKey: "conv-1m-model",
      userMessage: "hello",
      metadata: { model: "sonnet[1m]" }
    });
    for await (const _event of stream.events) {
      void _event;
    }

    expect(seenModels).toEqual(["sonnet[1m]"]);
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
        const options = args.options as Record<string, unknown>;
        const prompt = args.prompt;
        if (typeof prompt !== "string") {
          queryCount += 1;
          seenResumes.push(options.resume);
        }
        return {
          async *[Symbol.asyncIterator]() {
            for await (const _message of prompt as AsyncIterable<unknown>) {
              turnIndex += 1;
              yield { type: "system", session_id: "sess-hot", subtype: "init" };
              yield { type: "result", session_id: "sess-hot", result: `ok-${turnIndex}`, is_error: false };
            }
          },
          close() {},
        } as any;
      }
    });

    await runtime.retainHotRuntime({ conversationKey: "conv-hot", userMessage: "" }, "mount-1");
    await runtime.warmHotRuntime?.({
      conversationKey: "conv-hot",
      userMessage: "",
      metadata: { model: "sonnet" }
    });

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

  it("rebuilds retained hot runtime on option changes while resuming the same session", async () => {
    let queryCount = 0;
    const seenResumes: Array<unknown> = [];
    let turnIndex = 0;

    const runtime = new ClaudeAgentSdkRuntimeClient({
      forwardFrontendModel: true,
      queryImpl(args) {
        const options = args.options as Record<string, unknown>;
        const prompt = args.prompt;
        if (typeof prompt !== "string") {
          queryCount += 1;
          seenResumes.push(options.resume);
        }
        return {
          async *[Symbol.asyncIterator]() {
            for await (const _message of prompt as AsyncIterable<unknown>) {
              turnIndex += 1;
              yield { type: "system", session_id: "sess-hot-rebuild", subtype: "init" };
              yield { type: "result", session_id: "sess-hot-rebuild", result: `ok-${turnIndex}`, is_error: false };
            }
          },
          close() {},
        } as any;
      }
    });

    await runtime.retainHotRuntime({ conversationKey: "conv-hot-rebuild", userMessage: "" }, "mount-1");
    const first = await runtime.startTurn({
      conversationKey: "conv-hot-rebuild",
      userMessage: "hello",
      metadata: { model: "sonnet" }
    });
    for await (const _event of first.events) {
      void _event;
    }

    const second = await runtime.startTurn({
      conversationKey: "conv-hot-rebuild",
      userMessage: "again",
      metadata: { model: "opus" }
    });
    for await (const _event of second.events) {
      void _event;
    }

    expect(queryCount).toBe(2);
    expect(seenResumes).toEqual([undefined, "sess-hot-rebuild"]);
  });

  it("retries retained hot runtime with high when unknown xhigh effort fails before init", async () => {
    process.env.HOME = "/tmp/cc-l4z-hot-effort-retry";
    const seenEfforts: Array<unknown> = [];
    const seenStatus: string[] = [];

    const runtime = new ClaudeAgentSdkRuntimeClient({
      forwardFrontendModel: true,
      queryImpl(args) {
        if (args.prompt === "") return makeModelProbe([]);
        const options = args.options as Record<string, unknown>;
        seenEfforts.push(options.effort);
        const prompt = args.prompt as AsyncIterable<unknown>;
        return {
          async *[Symbol.asyncIterator]() {
            if (options.effort === "xhigh") {
              throw new Error("unsupported effort");
            }
            for await (const _message of prompt) {
              yield { type: "system", session_id: "sess-hot-effort", subtype: "init" };
              yield { type: "result", session_id: "sess-hot-effort", result: "ok", is_error: false };
            }
          },
          close() {},
        } as any;
      }
    });

    await runtime.retainHotRuntime({ conversationKey: "conv-hot-effort", userMessage: "" }, "mount-1");
    const stream = await runtime.startTurn({
      conversationKey: "conv-hot-effort",
      userMessage: "hello",
      metadata: { model: "haiku", effort: "xhigh" }
    });

    const seenEvents = [];
    for await (const event of stream.events) {
      seenEvents.push(event.type);
      if (event.type === "status" && typeof event.payload.text === "string") {
        seenStatus.push(event.payload.text);
      }
    }

    expect(seenEfforts).toEqual(["xhigh", "high"]);
    expect(seenEvents).toContain("final");
    expect(seenStatus.some((text) => text.includes("Retrying with High"))).toBe(true);
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
          },
          close() {},
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

  it("warms retained hot runtime before the first follow-up turn", async () => {
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
              yield { type: "system", session_id: "sess-warm", subtype: "init" };
              yield { type: "result", session_id: "sess-warm", result: `ok-${turnIndex}`, is_error: false };
            }
          },
          close() {},
        } as any;
      }
    });

    await runtime.retainHotRuntime({ conversationKey: "conv-warm", userMessage: "" }, "mount-1");
    await runtime.warmHotRuntime?.({
      conversationKey: "conv-warm",
      userMessage: "",
      providerSessionId: "sess-existing",
    });

    const warmedEntry = (runtime as any).hotRuntimePool.get("conv-warm");
    expect(Boolean(warmedEntry?.query)).toBe(true);
    expect(warmedEntry?.providerSessionId).toBe("sess-existing");

    const first = await runtime.startTurn({
      conversationKey: "conv-warm",
      userMessage: "hello after retain",
      providerSessionId: "sess-existing",
    });
    for await (const _event of first.events) {
      void _event;
    }

    expect(queryCount).toBe(1);
    expect(seenResumes).toEqual(["sess-existing"]);
  });

  it("emits SDK canUseTool permission requests from warmed hot runtimes", async () => {
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl(args) {
        const options = args.options as Record<string, unknown>;
        const prompt = args.prompt as AsyncIterable<unknown>;
        const canUseTool = options.canUseTool as (
          toolName: string,
          input: Record<string, unknown>,
          options: {
            signal: AbortSignal;
            title?: string;
            description?: string;
            displayName?: string;
            toolUseID: string;
          },
        ) => Promise<{ behavior: string }>;
        return {
          async *[Symbol.asyncIterator]() {
            for await (const _message of prompt) {
              const result = await canUseTool(
                "Bash",
                { command: "mkdir -p .claude/skills/example" },
                {
                  signal: new AbortController().signal,
                  title: "Allow Bash?",
                  description: "Claude wants to create a skill directory.",
                  displayName: "Bash",
                  toolUseID: "tool-use-hot-permission",
                },
              );
              yield {
                type: "result",
                session_id: "sess-hot-permission",
                result: result.behavior,
                is_error: false,
              };
            }
          },
          close() {},
        } as any;
      }
    });

    await runtime.retainHotRuntime({ conversationKey: "conv-hot-permission", userMessage: "" }, "mount-1");
    await runtime.warmHotRuntime?.({
      conversationKey: "conv-hot-permission",
      userMessage: "",
    });

    const stream = await runtime.startTurn({
      conversationKey: "conv-hot-permission",
      userMessage: "install a skill",
    });
    const iterator = stream.events[Symbol.asyncIterator]();
    let confirmation: any;
    for (let i = 0; i < 6; i += 1) {
      const next = await nextEvent(iterator);
      if (next.done) break;
      if (next.value.type === "confirmation_required") {
        confirmation = next.value;
        break;
      }
    }

    expect(confirmation?.payload?.requestId).toMatch(/^perm-/);
    expect(confirmation?.payload?.action?.toolName).toBe("Bash");
    expect(globalPermissionStore.resolve(confirmation.payload.requestId, { approved: true })).toBe(true);

    const remainingTypes: string[] = [];
    for (;;) {
      const next = await nextEvent(iterator);
      if (next.done) break;
      remainingTypes.push(next.value.type);
    }
    expect(remainingTypes).toContain("final");
  });
});
