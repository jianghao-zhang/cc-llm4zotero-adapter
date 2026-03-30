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
      expect(types).toContain("event");
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
});
