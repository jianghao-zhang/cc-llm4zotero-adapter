import type { ProviderEvent } from "../runtime.js";
import { globalPermissionStore } from "../permissions/permission-store.js";


interface ClaudeContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
}

interface MessageContainer {
  content?: ClaudeContentBlock[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function getSessionId(msg: unknown): string | undefined {
  const record = asRecord(msg);
  if (typeof record.sessionId === "string" && record.sessionId.trim()) return record.sessionId.trim();
  if (typeof record.session_id === "string" && record.session_id.trim()) return record.session_id.trim();
  return undefined;
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const block = asRecord(item);
        if (typeof block.text === "string") {
          return block.text;
        }
        return JSON.stringify(block);
      })
      .join("\n");
  }
  if (content === undefined || content === null) {
    return "";
  }
  return JSON.stringify(content);
}

function extractResultOutput(msg: Record<string, unknown>): string {
  if (typeof msg.result === "string" && msg.result.trim()) {
    return msg.result;
  }
  const error = asRecord(msg.error);
  if (typeof error.message === "string" && error.message.trim()) {
    return `Error: ${error.message}`;
  }
  if (Array.isArray(msg.errors) && msg.errors.length > 0) {
    const first = asRecord(msg.errors[0]);
    const message =
      (typeof first.message === "string" && first.message.trim()) ||
      (typeof first.error === "string" && first.error.trim()) ||
      "";
    if (message) {
      return `Error: ${message}`;
    }
    return `Error: ${JSON.stringify(msg.errors)}`;
  }
  if (Boolean(msg.is_error)) {
    return "Error: runtime returned an empty error result.";
  }
  return "";
}

export function mapSdkMessageToProviderEvents(raw: unknown): ProviderEvent[] {
  const msg = asRecord(raw);
  const type = typeof msg.type === "string" ? msg.type : "unknown";
  const sessionId = getSessionId(msg);
  const providerEvent: ProviderEvent = {
    type: "provider_event",
    payload: {
      providerType: type,
      sessionId,
      ts: Date.now(),
      payload: msg,
    },
  };

  if (type === "confirmation_required") {
    const requestId =
      (typeof msg.requestId === "string" && msg.requestId.trim()) ||
      (typeof msg.request_id === "string" && msg.request_id.trim()) ||
      "";
    if (!requestId) {
      // Do not emit actionable confirmation events without a real requestId.
      // A synthetic id cannot be resolved by the permission store.
      return [providerEvent];
    }
    if (!globalPermissionStore.hasPending(requestId)) {
      // SDK can surface confirmation-like events that are not backed by our
      // canUseTool permission store. Rendering those as actionable cards causes
      // frontend "Allow" clicks to be no-ops (resolve endpoint returns 404).
      return [providerEvent];
    }
    const actionCandidate =
      (msg.action && typeof msg.action === "object" ? msg.action : undefined) ??
      (msg.pendingAction && typeof msg.pendingAction === "object"
        ? msg.pendingAction
        : undefined) ??
      (msg.pending_action && typeof msg.pending_action === "object"
        ? msg.pending_action
        : undefined);
    const action =
      (actionCandidate as Record<string, unknown> | undefined) ?? {
        toolName: "action",
        title: "Approval required",
        mode: "approval",
        confirmLabel: "Approve",
        cancelLabel: "Deny",
        description:
          typeof msg.message === "string" ? msg.message : "The runtime requests confirmation.",
        fields: [],
      };
    return [
      providerEvent,
      {
        type: "confirmation_required",
        payload: {
          requestId,
          action,
          sessionId,
        },
      },
    ];
  }

  if (type === "confirmation_resolved") {
    const requestId =
      (typeof msg.requestId === "string" && msg.requestId.trim()) ||
      (typeof msg.request_id === "string" && msg.request_id.trim()) ||
      "";
    if (!requestId) {
      return [providerEvent];
    }
    return [
      providerEvent,
      {
        type: "confirmation_resolved",
        payload: {
          requestId,
          approved: Boolean(msg.approved),
          actionId: typeof msg.actionId === "string" ? msg.actionId : undefined,
          data: msg.data,
          sessionId,
        },
      },
    ];
  }

  if (type === "assistant") {
    const events: ProviderEvent[] = [providerEvent];
    const message = asRecord(msg.message) as MessageContainer;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === "text" && typeof block.text === "string") {
        events.push({
          type: "message_delta",
          payload: {
            delta: block.text,
            sessionId,
            source: "assistant"
          }
        });
      }
    }

    if (events.length === 0) {
      events.push({
        type: "status",
        payload: {
          phase: "assistant",
          sessionId
        }
      });
    }

    return events;
  }

  if (type === "user") {
    const events: ProviderEvent[] = [providerEvent];
    const message = asRecord(msg.message) as MessageContainer;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === "tool_result") {
        events.push({
          type: "tool_result",
          payload: {
            toolUseId: block.tool_use_id,
            content: normalizeToolResultContent(block.content),
            sessionId
          }
        });
      }
    }

    if (events.length > 1) {
      return events;
    }
    return [providerEvent];
  }

  if (type === "result") {
    const output = extractResultOutput(msg);
    return [
      providerEvent,
      {
        type: "final",
        payload: {
          output,
          isError: Boolean(msg.is_error),
          subtype: msg.subtype,
          durationMs: msg.duration_ms,
          numTurns: msg.num_turns,
          sessionId
        }
      }
    ];
  }

  if (type === "system") {
    const subtype = typeof msg.subtype === "string" ? msg.subtype.trim() : "";
    const text =
      subtype === "hook_started"
        ? `Running ${typeof msg.hook_name === "string" && msg.hook_name.trim() ? msg.hook_name.trim() : "runtime hook"}`
        : subtype === "hook_response"
          ? `Finished ${typeof msg.hook_name === "string" && msg.hook_name.trim() ? msg.hook_name.trim() : "runtime hook"}`
          : subtype === "init"
            ? "Initializing Claude session"
            : subtype === "api_retry"
              ? "Retrying provider request"
              : subtype
                ? `System event: ${subtype}`
                : "System event";
    return [
      providerEvent,
      {
        type: "status",
        payload: {
          text,
          phase: "system",
          subtype,
          sessionId
        }
      }
    ];
  }

  if (type === "tool_progress") {
    return [
      providerEvent,
      {
        type: "status",
        payload: {
          phase: "tool_progress",
          ...msg,
          sessionId
        }
      }
    ];
  }

  if (type === "stream_event") {
    const event = asRecord(msg.event);
    if (event.type === "content_block_start") {
      const contentBlock = asRecord(event.content_block);
      if (contentBlock.type === "tool_use") {
        return [
          providerEvent,
          {
            type: "tool_call",
            payload: {
              id: typeof contentBlock.id === "string" ? contentBlock.id : undefined,
              name: typeof contentBlock.name === "string" ? contentBlock.name : undefined,
              input: contentBlock.input,
              sessionId,
            },
          },
        ];
      }
    }
    if (event.type === "content_block_delta") {
      const delta = asRecord(event.delta);
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        return [
          providerEvent,
          {
            type: "message_delta",
            payload: {
              delta: delta.text,
              partial: true,
              sessionId
            }
          }
        ];
      }
      if (
        (delta.type === "thinking_delta" || delta.type === "signature_delta") &&
        typeof delta.text === "string"
      ) {
        return [
          providerEvent,
          {
            type: "reasoning",
            payload: {
              round: 1,
              details: delta.text,
              sessionId,
            },
          },
        ];
      }
    }
  }

  return [providerEvent];
}
