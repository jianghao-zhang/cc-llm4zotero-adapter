import { randomUUID } from "node:crypto";
import type { ClaudeCodeRuntimeClient, RuntimeTurnRequest, RuntimeTurnStream } from "../runtime.js";
import { mapSdkMessageToProviderEvents } from "../event-mapper/map-sdk-message.js";

type QueryFunction = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<unknown>;

export interface ClaudeAgentSdkRuntimeClientOptions {
  cwd?: string;
  settingSources?: Array<"user" | "project" | "local">;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  includePartialMessages?: boolean;
  maxTurns?: number;
  continue?: boolean;
  queryImpl?: QueryFunction;
}

function parseMetadata(metadata: RuntimeTurnRequest["metadata"]): Record<string, unknown> {
  return metadata ? { ...metadata } : {};
}

export class ClaudeAgentSdkRuntimeClient implements ClaudeCodeRuntimeClient {
  private readonly options: ClaudeAgentSdkRuntimeClientOptions;

  constructor(options: ClaudeAgentSdkRuntimeClientOptions = {}) {
    this.options = options;
  }

  async startTurn(request: RuntimeTurnRequest): Promise<RuntimeTurnStream> {
    const query = this.options.queryImpl ?? (await this.loadQuery());
    const metadata = parseMetadata(request.metadata);

    const queryOptions: Record<string, unknown> = {
      cwd: this.options.cwd,
      allowedTools: request.allowedTools,
      settingSources: this.options.settingSources ?? ["user", "project"],
      permissionMode: this.options.permissionMode,
      includePartialMessages: this.options.includePartialMessages,
      maxTurns: this.options.maxTurns,
      continue: this.options.continue,
      resume: request.providerSessionId,
      abortController: request.signal ? this.createAbortController(request.signal) : undefined,
      ...metadata
    };

    const cleanedOptions = Object.fromEntries(
      Object.entries(queryOptions).filter(([, value]) => value !== undefined)
    );

    const sdkStream = query({
      prompt: request.userMessage,
      options: cleanedOptions
    });

    const events = (async function* (): AsyncIterable<import("../runtime.js").ProviderEvent> {
      for await (const message of sdkStream) {
        const mapped = mapSdkMessageToProviderEvents(message);
        for (const event of mapped) {
          yield event;
        }
      }
    })();

    return {
      runId: randomUUID(),
      providerSessionId: request.providerSessionId,
      events
    };
  }

  private async loadQuery(): Promise<QueryFunction> {
    const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
      query: QueryFunction;
    };

    if (typeof sdk.query !== "function") {
      throw new Error("@anthropic-ai/claude-agent-sdk does not export query()");
    }

    return sdk.query;
  }

  private createAbortController(signal: AbortSignal): AbortController {
    const controller = new AbortController();
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller;
    }

    const onAbort = () => {
      controller.abort(signal.reason);
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort);
    return controller;
  }
}
