import type { JsonObject } from "./types.js";

export type ProviderEventType =
  | "provider_event"
  | "status"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "tool_error"
  | "confirmation_required"
  | "confirmation_resolved"
  | "message_delta"
  | "message_rollback"
  | "usage"
  | "context_compacted"
  | "final"
  | "unknown";

export interface ProviderEvent {
  type: ProviderEventType;
  payload: JsonObject;
}

export interface RuntimeTurnRequest {
  conversationKey: string;
  userMessage: string;
  providerSessionId?: string;
  allowedTools?: string[];
  runtimeRequest?: JsonObject;
  metadata?: JsonObject;
  signal?: AbortSignal;
}

export interface RuntimeTurnStream {
  runId: string;
  providerSessionId?: string;
  events: AsyncIterable<ProviderEvent>;
}

export interface ClaudeCodeRuntimeClient {
  startTurn(request: RuntimeTurnRequest): Promise<RuntimeTurnStream>;
  retainHotRuntime?(request: RuntimeTurnRequest, mountId: string): Promise<void>;
  releaseHotRuntime?(conversationKey: string, mountId: string): Promise<void>;
  listCommands?(
    options?: {
      settingSources?: Array<"user" | "project" | "local">;
    }
  ): Promise<Array<{ name: string; description: string; argumentHint: string }>>;
  listModels?(
    options?: {
      settingSources?: Array<"user" | "project" | "local">;
    }
  ): Promise<string[]>;
  listEfforts?(
    options?: {
      model?: string;
      settingSources?: Array<"user" | "project" | "local">;
    }
  ): Promise<string[]>;
}
