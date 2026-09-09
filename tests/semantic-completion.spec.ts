import { describe, expect, it } from "vitest";
import { ClaudeAgentSdkRuntimeClient } from "../src/providers/claude-agent-sdk-runtime-client.js";

describe("isolated semantic completion", () => {
  it("uses existing authentication with no tools, hooks, settings, or persisted conversation", async () => {
    let options: any;
    let closed = false;
    const client = new ClaudeAgentSdkRuntimeClient({
      queryImpl: ((input: any) => {
        options = input.options;
        return { async *[Symbol.asyncIterator]() {
          yield { type: "result", subtype: "success", result: '{"actionIntents":[]}' };
        }, close() { closed = true; } };
      }) as any,
    });
    const result = await client.completeStructured({ prompt: "Interpret this request", model: "sonnet", timeoutMs: 1000 });
    expect(result).toEqual({ text: '{"actionIntents":[]}' });
    expect(options.tools).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
    expect(options.plugins).toEqual([]);
    expect(options.settings.disableAllHooks).toBe(true);
    expect(options.settingSources).toEqual([]);
    expect(options.hooks).toEqual({});
    expect(options.persistSession).toBe(false);
    expect(options.resume).toBeUndefined();
    expect(closed).toBe(true);
  });
  it("cancels promptly even when the SDK iterator stops responding", async () => {
    const controller = new AbortController();
    let closed = false;
    const client = new ClaudeAgentSdkRuntimeClient({
      queryImpl: (() => ({
        async *[Symbol.asyncIterator]() { await new Promise(() => {}); },
        close() { closed = true; },
      })) as any,
    });
    const pending = client.completeStructured({prompt: "Interpret", timeoutMs: 10000, signal: controller.signal});
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(closed).toBe(true);
  }, 500);

});
