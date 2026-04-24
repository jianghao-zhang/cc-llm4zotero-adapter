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
    const compat = new Llm4ZoteroAgentBackendAdapter({ adapter: base });
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

  it("merges connected MCP tools into /tools", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-http-mcp-tools",
          events: providerEvents([])
        };
      },
      async listMcpServers() {
        return [
          {
            name: "grok-search",
            status: "connected",
            scope: "user",
            tools: [
              { name: "web_search", description: "Search with Grok" },
              { name: "switch_model", annotations: { destructive: true } },
            ],
          },
          {
            name: "broken-mcp",
            status: "failed",
            tools: [{ name: "should_not_show" }],
          },
        ];
      }
    };
    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper()
    });
    const compat = new Llm4ZoteroAgentBackendAdapter({ adapter: base });
    const server = await startHttpBridgeServer({ adapter: compat });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/tools?settingSources=user`);
      expect(response.ok).toBe(true);
      const payload = await response.json() as { tools?: Array<{ name: string; source: string; mutability: string; requiresConfirmation: boolean }> };
      const tools = payload.tools || [];
      expect(tools.some((tool) => tool.name === "grok-search.web_search" && tool.source === "mcp")).toBe(true);
      expect(tools.some((tool) => tool.name === "broken-mcp.should_not_show")).toBe(false);
      expect(tools.find((tool) => tool.name === "grok-search.switch_model")).toMatchObject({
        mutability: "write",
        requiresConfirmation: true,
      });
    } finally {
      await server.close();
    }
  });

  it("streams a single start line with the runtime runId", async () => {
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
    const compat = new Llm4ZoteroAgentBackendAdapter({ adapter: base });
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
      const starts = lines.filter((line) => line.type === "start");
      expect(starts).toEqual([{ type: "start", runId: "run-http-1" }]);
      expect(lines.at(-1)).toEqual({
        type: "outcome",
        outcome: {
          kind: "completed",
          runId: "run-http-1",
          text: "hello",
          usedFallback: false,
        },
      });
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
    const compat = new Llm4ZoteroAgentBackendAdapter({ adapter: base });
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

  it("preserves string conversationKey and scoped session info contract", async () => {
    const seenKeys: string[] = [];
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn(request) {
        seenKeys.push(request.conversationKey);
        return {
          runId: "run-http-string-key",
          providerSessionId: "sess-http-string-key",
          events: providerEvents([{ type: "final", payload: { output: "ok" } }]),
        };
      }
    };

    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper()
    });
    const compat = new Llm4ZoteroAgentBackendAdapter({
      adapter: base,
      runtimeCwd: "/tmp/adapter-runtime",
    });
    const server = await startHttpBridgeServer({ adapter: compat });

    try {
      const runResponse = await fetch(`http://${server.host}:${server.port}/run-turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationKey: "0042",
          userText: "hello",
          scopeType: "paper",
          scopeId: "1:42",
          scopeLabel: "Paper 42",
        })
      });
      expect(runResponse.ok).toBe(true);
      await readNdjsonLines(runResponse);

      const sessionInfoResponse = await fetch(
        `http://${server.host}:${server.port}/session-info?conversationKey=0042&scopeType=paper&scopeId=1%3A42&scopeLabel=Paper%2042`
      );
      expect(sessionInfoResponse.ok).toBe(true);
      const payload = await sessionInfoResponse.json() as {
        session?: {
          originalConversationKey: string;
          scopedConversationKey: string;
          providerSessionId?: string;
          runtimeCwdRelative?: string;
          cwd?: string;
        };
      };
      expect(seenKeys).toEqual(["0042::paper:1:42"]);
      expect(payload.session).toEqual({
        originalConversationKey: "0042",
        scopedConversationKey: "0042::paper:1:42",
        providerSessionId: "sess-http-string-key",
        scopeType: "paper",
        scopeId: "1:42",
        scopeLabel: "Paper 42",
        runtimeCwdRelative: "scopes/paper/1:42/conversations/0042",
        cwd: "/tmp/adapter-runtime/scopes/paper/1:42/conversations/0042",
      });
    } finally {
      await server.close();
    }
  });

  it("streams run-action endpoint with a single start line", async () => {
    const compat = {
      listTools() {
        return [];
      },
      async listCommands() {
        return [];
      },
      async listModels() {
        return [];
      },
      async listEfforts() {
        return [];
      },
      async getSessionInfo() {
        return {
          originalConversationKey: "conv-action-1",
          scopedConversationKey: "conv-action-1",
        };
      },
      resolveExternalConfirmation() {
        return {
          accepted: false,
          source: "none" as const,
          pendingPermissionCount: 0,
          recentPendingRequestIds: [],
        };
      },
      async runTurn() {
        throw new Error("runTurn should not be called in this test");
      },
      async runAction(params: {
        request: { conversationKey: string; toolName: string; args?: unknown };
        onStart?: (runId: string) => void | Promise<void>;
        onEvent?: (event: Record<string, unknown>) => void | Promise<void>;
      }) {
        expect(params.request.conversationKey).toBe("conv-action-1");
        expect(params.request.toolName).toBe("Read");
        expect(params.request.args).toEqual({ file_path: "README.md" });
        await params.onStart?.("run-http-action");
        await params.onEvent?.({
          type: "tool_call",
          callId: "call_1",
          name: "Read",
          args: { file_path: "README.md" },
        });
        return {
          kind: "completed" as const,
          runId: "run-http-action",
          text: "done",
          usedFallback: false as const,
        };
      },
    } as unknown as Llm4ZoteroAgentBackendAdapter;
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
      const starts = lines.filter((line) => line.type === "start");
      expect(starts).toEqual([{ type: "start", runId: "run-http-action" }]);
      expect(lines.at(-1)).toEqual({
        type: "outcome",
        outcome: {
          kind: "completed",
          runId: "run-http-action",
          text: "done",
          usedFallback: false,
        },
      });
    } finally {
      await server.close();
    }
  });
});
