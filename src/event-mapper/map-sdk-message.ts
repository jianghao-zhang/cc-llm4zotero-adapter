import type { ProviderEvent } from "../runtime.js";

interface SessionLikeMessage {
  session_id?: string;
  type?: string;
}

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
  const record = asRecord(msg) as SessionLikeMessage;
  return typeof record.session_id === "string" ? record.session_id : undefined;
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

export function mapSdkMessageToProviderEvents(raw: unknown): ProviderEvent[] {
  const msg = asRecord(raw);
  const type = typeof msg.type === "string" ? msg.type : "unknown";
  const sessionId = getSessionId(msg);

  if (type === "assistant") {
    const events: ProviderEvent[] = [];
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

      if (block.type === "tool_use") {
        events.push({
          type: "tool_call",
          payload: {
            id: block.id,
            name: block.name,
            input: block.input,
            sessionId
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
    const events: ProviderEvent[] = [];
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

    if (events.length > 0) {
      return events;
    }
  }

  if (type === "result") {
    return [
      {
        type: "final",
        payload: {
          output: typeof msg.result === "string" ? msg.result : "",
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
    return [
      {
        type: "status",
        payload: {
          phase: "system",
          subtype: msg.subtype,
          sessionId
        }
      }
    ];
  }

  if (type === "tool_progress") {
    return [
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

  if (type === "assistant_partial") {
    const partial = asRecord(msg.partial_message);
    const content = partial.content;
    if (Array.isArray(content)) {
      const text = content
        .map((entry) => {
          const block = asRecord(entry);
          return typeof block.text === "string" ? block.text : "";
        })
        .join("");

      if (text.length > 0) {
        return [
          {
            type: "message_delta",
            payload: {
              delta: text,
              partial: true,
              sessionId
            }
          }
        ];
      }
    }
  }

  return [
    {
      type: "unknown",
      payload: {
        sourceType: type,
        sessionId,
        raw: msg
      }
    }
  ];
}
