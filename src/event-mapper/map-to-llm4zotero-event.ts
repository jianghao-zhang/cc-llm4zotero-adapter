import type { AgentEvent } from "../types.js";
import type { Llm4ZoteroAgentEvent } from "../bridge/llm4zotero-contract.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function mapToLlm4ZoteroEvent(event: AgentEvent): Llm4ZoteroAgentEvent | null {
  const payload = asRecord(event.payload);

  switch (event.type) {
    case "status": {
      const text =
        asString(payload.text) ||
        asString(payload.label) ||
        asString(payload.phase) ||
        "running";
      return { type: "status", text };
    }
    case "tool_call": {
      return {
        type: "tool_call",
        callId: asString(payload.callId) || asString(payload.id),
        name: asString(payload.name),
        args: payload.args ?? payload.input ?? {}
      };
    }
    case "tool_result": {
      return {
        type: "tool_result",
        callId: asString(payload.callId) || asString(payload.toolUseId),
        name: asString(payload.name),
        ok: typeof payload.ok === "boolean" ? payload.ok : true,
        content: payload.content,
        artifacts: Array.isArray(payload.artifacts) ? payload.artifacts : undefined
      };
    }
    case "tool_error": {
      return {
        type: "tool_error",
        callId: asString(payload.callId) || asString(payload.id),
        name: asString(payload.name),
        error: asString(payload.error) || asString(payload.message) || "tool_error",
        round: asNumber(payload.round, 0)
      };
    }
    case "confirmation_required": {
      return {
        type: "confirmation_required",
        requestId: asString(payload.requestId) || asString(payload.id),
        action: payload.action
      };
    }
    case "confirmation_resolved": {
      return {
        type: "confirmation_resolved",
        requestId: asString(payload.requestId) || asString(payload.id),
        approved: Boolean(payload.approved),
        actionId: asString(payload.actionId) || undefined,
        data: payload.data
      };
    }
    case "message_delta": {
      return {
        type: "message_delta",
        text: asString(payload.text) || asString(payload.delta)
      };
    }
    case "message_rollback": {
      return {
        type: "message_rollback",
        length: asNumber(payload.length),
        text: asString(payload.text)
      };
    }
    case "fallback": {
      const reason = asString(payload.reason) || "fallback";
      // Claude SDK streams include many informational event variants.
      // Keep them in backend trace, but suppress noisy unmapped markers in UI.
      if (reason === "unmapped_provider_event") {
        return null;
      }
      return {
        type: "fallback",
        reason
      };
    }
    case "final": {
      return {
        type: "final",
        text: asString(payload.text) || asString(payload.output)
      };
    }
    default:
      return null;
  }
}
