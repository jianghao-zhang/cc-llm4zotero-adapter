import type { ClaudeCodeRuntimeAdapter } from "./claude-code-runtime-adapter.js";
import type {
  Llm4ZoteroRunActionParams,
  Llm4ZoteroRunTurnOutcome,
  Llm4ZoteroRunTurnParams
} from "./llm4zotero-contract.js";
import { mapToLlm4ZoteroEvent } from "../event-mapper/map-to-llm4zotero-event.js";
import { findToolByName, getToolCatalog } from "./tool-catalog.js";

export class Llm4ZoteroAgentBackendAdapter {
  constructor(private readonly adapter: ClaudeCodeRuntimeAdapter) {}

  listTools() {
    return getToolCatalog();
  }

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

  async runAction(params: Llm4ZoteroRunActionParams): Promise<Llm4ZoteroRunTurnOutcome> {
    const requested = params.request;
    const tool = findToolByName(requested.toolName);
    if (!tool) {
      return {
        kind: "fallback",
        runId: `action-${Date.now()}`,
        reason: `Unknown tool: ${requested.toolName}`,
        usedFallback: true,
      };
    }

    if (tool.requiresConfirmation && !requested.approved) {
      await params.onEvent?.({
        type: "confirmation_required",
        requestId: `confirm-${Date.now()}`,
        action: {
          toolName: requested.toolName,
          title: `Approve ${requested.toolName}`,
          mode: "approval",
          confirmLabel: "Run",
          cancelLabel: "Cancel",
          description: `This action is marked as ${tool.riskLevel} risk.`,
          fields: [
            {
              type: "textarea",
              id: "args",
              label: "Arguments",
              value: JSON.stringify(requested.args ?? {}, null, 2),
              editorMode: "json",
              spellcheck: false,
            },
          ],
        },
      });
      return {
        kind: "fallback",
        runId: `action-${Date.now()}`,
        reason: "approval_required",
        usedFallback: true,
      };
    }

    const instruction = [
      `Execute exactly one tool call: ${requested.toolName}.`,
      "Do not choose a different tool.",
      `Use these arguments JSON:\n${JSON.stringify(requested.args ?? {}, null, 2)}`,
      "After the tool returns, provide a concise result summary.",
    ].join("\n\n");

    return this.runTurn({
      request: {
        conversationKey: requested.conversationKey,
        userText: instruction,
        allowedTools: [requested.toolName],
        metadata: {
          ...(requested.metadata || {}),
          runType: "action",
          toolName: requested.toolName,
          actionArgs: requested.args,
          activeItemId: requested.activeItemId,
          libraryID: requested.libraryID,
          contextEnvelope: requested.contextEnvelope,
        },
      },
      onStart: params.onStart,
      onEvent: params.onEvent,
      signal: params.signal,
    });
  }
}
