import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  Llm4ZoteroAgentBackendAdapter
} from "../bridge/llm4zotero-agent-backend-adapter.js";
import type {
  Llm4ZoteroAgentEvent,
  Llm4ZoteroRunTurnRequest
} from "../bridge/llm4zotero-contract.js";

export interface HttpBridgeServerOptions {
  adapter: Llm4ZoteroAgentBackendAdapter;
  host?: string;
  port?: number;
}

export interface HttpBridgeServerHandle {
  host: string;
  port: number;
  close(): Promise<void>;
}

type BridgeStreamLine =
  | { type: "start"; runId: string }
  | { type: "event"; event: Llm4ZoteroAgentEvent }
  | {
      type: "outcome";
      outcome:
        | { kind: "completed"; runId: string; text: string; usedFallback: false }
        | { kind: "fallback"; runId: string; reason: string; usedFallback: true };
    }
  | { type: "error"; error: string };

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

function toRequestPayload(body: unknown): Llm4ZoteroRunTurnRequest {
  const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const conversationKey = record.conversationKey;
  const userText = record.userText;

  if (!(typeof conversationKey === "string" || typeof conversationKey === "number")) {
    throw new Error("conversationKey must be string or number");
  }

  if (typeof userText !== "string" || userText.length === 0) {
    throw new Error("userText must be a non-empty string");
  }

  return {
    conversationKey,
    userText,
    allowedTools: Array.isArray(record.allowedTools)
      ? record.allowedTools.filter((x): x is string => typeof x === "string")
      : undefined,
    metadata:
      record.metadata && typeof record.metadata === "object"
        ? (record.metadata as Record<string, unknown>)
        : undefined
  };
}

function writeLine(res: ServerResponse, line: BridgeStreamLine): void {
  res.write(JSON.stringify(line));
  res.write("\n");
}

export async function startHttpBridgeServer(
  options: HttpBridgeServerOptions
): Promise<HttpBridgeServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        sendJson(res, 200, { ok: true, ts: Date.now() });
        return;
      }

      if (req.method === "POST" && req.url === "/run-turn") {
        let payload: Llm4ZoteroRunTurnRequest;
        try {
          payload = toRequestPayload(await readJson(req));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");

        const startRunId = randomUUID();
        writeLine(res, { type: "start", runId: startRunId });

        const outcome = await options.adapter.runTurn({
          request: payload,
          onStart: (runId) => {
            writeLine(res, { type: "start", runId });
          },
          onEvent: (event) => {
            writeLine(res, { type: "event", event });
          }
        });

        writeLine(res, { type: "outcome", outcome });
        res.end();
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: message });
      } else {
        writeLine(res, { type: "error", error: message });
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("failed to resolve server address");
  }

  return {
    host,
    port: addr.port,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
