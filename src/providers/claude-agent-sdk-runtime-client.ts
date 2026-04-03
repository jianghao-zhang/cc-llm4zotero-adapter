import { randomUUID } from "node:crypto";
import type { ClaudeCodeRuntimeClient, RuntimeTurnRequest, RuntimeTurnStream } from "../runtime.js";
import { mapSdkMessageToProviderEvents } from "../event-mapper/map-sdk-message.js";
import type { PermissionMode, SettingSource } from "@anthropic-ai/claude-agent-sdk";

type QueryFunction = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<unknown>;

export interface ClaudeAgentSdkRuntimeClientOptions {
  cwd?: string;
  settingSources?: SettingSource[];
  permissionMode?: PermissionMode;
  includePartialMessages?: boolean;
  maxTurns?: number;
  continue?: boolean;
  appendSystemPrompt?: string;
  forwardFrontendModel?: boolean;
  blockedMetadataKeys?: string[];
  queryImpl?: QueryFunction;
}

const DEFAULT_BLOCKED_METADATA_KEYS = new Set<string>([
  "allowedTools",
  "abortController",
  "continue",
  "cwd",
  "includePartialMessages",
  "maxTurns",
  "permissionMode",
  "resume",
  "settingSources",
]);

function parseMetadata(
  metadata: RuntimeTurnRequest["metadata"],
  options: Pick<ClaudeAgentSdkRuntimeClientOptions, "forwardFrontendModel" | "blockedMetadataKeys">
): Record<string, unknown> {
  if (!metadata) {
    return {};
  }

  const blockedKeys = new Set<string>([
    ...DEFAULT_BLOCKED_METADATA_KEYS,
    ...(options.blockedMetadataKeys ?? []),
  ]);

  if (!options.forwardFrontendModel) {
    blockedKeys.add("model");
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!blockedKeys.has(key)) {
      result[key] = value;
    }
  }

  return result;
}

export class ClaudeAgentSdkRuntimeClient implements ClaudeCodeRuntimeClient {
  private readonly options: ClaudeAgentSdkRuntimeClientOptions;

  constructor(options: ClaudeAgentSdkRuntimeClientOptions = {}) {
    this.options = options;
  }

  async startTurn(request: RuntimeTurnRequest): Promise<RuntimeTurnStream> {
    const query = this.options.queryImpl ?? (await this.loadQuery());
    const metadata = parseMetadata(request.metadata, this.options);

    const queryOptions: Record<string, unknown> = {
      ...metadata,
      cwd: this.options.cwd,
      allowedTools: request.allowedTools,
      settingSources: this.options.settingSources ?? ["user", "project"],
      permissionMode: this.options.permissionMode,
      includePartialMessages: this.options.includePartialMessages,
      maxTurns: this.options.maxTurns,
      continue: this.options.continue,
      appendSystemPrompt: this.options.appendSystemPrompt,
      resume: request.providerSessionId,
      abortController: request.signal ? this.createAbortController(request.signal) : undefined,
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
