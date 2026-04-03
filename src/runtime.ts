import type { JsonObject } from "./types.js";

export type ProviderEventType =
  | "status"
  | "tool_call"
  | "tool_result"
  | "tool_error"
  | "confirmation_required"
  | "confirmation_resolved"
  | "message_delta"
  | "message_rollback"
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
}
