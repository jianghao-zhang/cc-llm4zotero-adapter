export type Llm4ZoteroAgentEvent =
  | { type: "status"; text: string }
  | { type: "reasoning"; round: number; summary?: string; details?: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | {
      type: "tool_result";
      callId: string;
      name: string;
      ok: boolean;
      content: unknown;
      artifacts?: unknown[];
    }
  | { type: "tool_error"; callId: string; name: string; error: string; round: number }
  | { type: "confirmation_required"; requestId: string; action: unknown }
  | {
      type: "confirmation_resolved";
      requestId: string;
      approved: boolean;
      actionId?: string;
      data?: unknown;
    }
  | { type: "message_delta"; text: string }
  | { type: "message_rollback"; length: number; text: string }
  | { type: "fallback"; reason: string }
  | { type: "final"; text: string };

export interface Llm4ZoteroRunTurnRequest {
  conversationKey: string | number;
  userText: string;
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
}

export interface Llm4ZoteroRunTurnParams {
  request: Llm4ZoteroRunTurnRequest;
  onEvent?: (event: Llm4ZoteroAgentEvent) => void | Promise<void>;
  onStart?: (runId: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export type Llm4ZoteroRunTurnOutcome =
  | {
      kind: "completed";
      runId: string;
      text: string;
      usedFallback: false;
    }
  | {
      kind: "fallback";
      runId: string;
      reason: string;
      usedFallback: true;
    };
