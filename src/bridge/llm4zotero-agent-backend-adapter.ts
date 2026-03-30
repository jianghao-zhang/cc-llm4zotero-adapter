import type { ClaudeCodeRuntimeAdapter } from "./claude-code-runtime-adapter.js";
import type {
  Llm4ZoteroRunTurnOutcome,
  Llm4ZoteroRunTurnParams
} from "./llm4zotero-contract.js";
import { mapToLlm4ZoteroEvent } from "../event-mapper/map-to-llm4zotero-event.js";

export class Llm4ZoteroAgentBackendAdapter {
  constructor(private readonly adapter: ClaudeCodeRuntimeAdapter) {}

  async runTurn(params: Llm4ZoteroRunTurnParams): Promise<Llm4ZoteroRunTurnOutcome> {
    let lastFallbackReason = "";
    let finalText = "";

    const outcome = await this.adapter.runTurn(
      {
        conversationKey: String(params.request.conversationKey),
        userMessage: params.request.userText,
        allowedTools: params.request.allowedTools,
        metadata: params.request.metadata,
        signal: params.signal
      },
      {
        signal: params.signal,
        onStart: async (start) => {
          await params.onStart?.(start.runId);
        },
        onEvent: async (event) => {
          const mapped = mapToLlm4ZoteroEvent(event);
          if (!mapped) {
            return;
          }

          if (mapped.type === "fallback") {
            lastFallbackReason = mapped.reason;
          }
          if (mapped.type === "final") {
            finalText = mapped.text;
          }
          if (mapped.type === "message_delta" && !finalText) {
            finalText += mapped.text;
          }

          await params.onEvent?.(mapped);
        }
      }
    );

    if (outcome.status === "failed") {
      return {
        kind: "fallback",
        runId: outcome.runId,
        reason: lastFallbackReason || outcome.error || "runtime_failed",
        usedFallback: true
      };
    }

    if (!finalText && outcome.finalText) {
      finalText = outcome.finalText;
    }

    return {
      kind: "completed",
      runId: outcome.runId,
      text: finalText,
      usedFallback: false
    };
  }
}
