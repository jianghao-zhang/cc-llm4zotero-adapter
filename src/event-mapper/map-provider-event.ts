import type { ProviderEvent } from "../runtime.js";
import type { AgentEvent } from "../types.js";

const SUPPORTED_TYPES = new Set([
  "status",
  "tool_call",
  "tool_result",
  "tool_error",
  "confirmation_required",
  "confirmation_resolved",
  "message_delta",
  "message_rollback",
  "final"
]);

export function mapProviderEvent(event: ProviderEvent, ts = Date.now()): AgentEvent {
  if (SUPPORTED_TYPES.has(event.type)) {
    return {
      type: event.type,
      ts,
      payload: event.payload
    } as AgentEvent;
  }

  return {
    type: "fallback",
    ts,
    payload: {
      reason: "unmapped_provider_event",
      sourceType: event.type,
      sourcePayload: event.payload
    }
  };
}
