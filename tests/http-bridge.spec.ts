import { describe, expect, it } from "vitest";
import { ClaudeCodeRuntimeAdapter } from "../src/bridge/claude-code-runtime-adapter.js";
import { Llm4ZoteroAgentBackendAdapter } from "../src/bridge/llm4zotero-agent-backend-adapter.js";
import type { ClaudeCodeRuntimeClient, ProviderEvent } from "../src/runtime.js";
import { InMemorySessionMapper } from "../src/session-link/session-mapper.js";
import { startHttpBridgeServer } from "../src/server/http-bridge.js";

function providerEvents(events: ProviderEvent[]): AsyncIterable<ProviderEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    }
  };
}

async function readNdjsonLines(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("http bridge server", () => {
  it("returns tool catalog from /tools", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-http-tools",
          events: providerEvents([])
        };
      }
    };
    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper()
    });
    const compat = new Llm4ZoteroAgentBackendAdapter(base);
    const server = await startHttpBridgeServer({ adapter: compat });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/tools`);
      expect(response.ok).toBe(true);
      const payload = await response.json() as { tools?: Array<{ name: string }> };
      expect(Array.isArray(payload.tools)).toBe(true);
      expect((payload.tools || []).length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it("streams start/event/outcome lines", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-http-1",
          events: providerEvents([
            { type: "message_delta", payload: { delta: "hello" } },
            { type: "final", payload: { output: "hello" } }
          ])
        };
      }
    };

    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper()
    });
    const compat = new Llm4ZoteroAgentBackendAdapter(base);
    const server = await startHttpBridgeServer({ adapter: compat });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/run-turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationKey: "conv-1",
          userText: "hello"
        })
      });

      expect(response.ok).toBe(true);
      const lines = await readNdjsonLines(response);
      const types = lines.map((line) => line.type);
      expect(types).toContain("start");
      expect(types).toContain("outcome");
    } finally {
      await server.close();
    }
  });

  it("returns 400 for invalid payload", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-http-2",
          events: providerEvents([])
        };
      }
    };

    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper()
    });
    const compat = new Llm4ZoteroAgentBackendAdapter(base);
    const server = await startHttpBridgeServer({ adapter: compat });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/run-turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userText: "missing conversation key" })
      });

      expect(response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("streams run-action endpoint", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-http-action",
          events: providerEvents([
            { type: "tool_call", payload: { id: "call_1", name: "Read", input: { file_path: "README.md" } } },
            { type: "tool_result", payload: { toolUseId: "call_1", name: "Read", content: "ok" } },
            { type: "final", payload: { output: "done" } }
          ])
        };
      }
    };

    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper()
    });
    const compat = new Llm4ZoteroAgentBackendAdapter(base);
    const server = await startHttpBridgeServer({ adapter: compat });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/run-action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationKey: "conv-action-1",
          toolName: "Read",
          args: { file_path: "README.md" },
          approved: true
        })
      });

      expect(response.ok).toBe(true);
      const lines = await readNdjsonLines(response);
      const types = lines.map((line) => line.type);
      expect(types).toContain("start");
      expect(types).toContain("outcome");
    } finally {
      await server.close();
    }
  });
});
