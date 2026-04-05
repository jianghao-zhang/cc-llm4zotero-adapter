import type { ClaudeCodeRuntimeClient } from "../runtime.js";
import type { SessionMapper } from "../session-link/session-mapper.js";
import type { TraceStore } from "../trace-store/trace-store.js";
import type { AgentEvent, RunTurnHooks, RunTurnOutcome, RunTurnRequest } from "../types.js";
import { mapProviderEvent } from "../event-mapper/map-provider-event.js";

export interface ClaudeCodeRuntimeAdapterOptions {
  runtimeClient: ClaudeCodeRuntimeClient;
  sessionMapper: SessionMapper;
  traceStore?: TraceStore;
}

export class ClaudeCodeRuntimeAdapter {
  private readonly runtimeClient: ClaudeCodeRuntimeClient;
  private readonly sessionMapper: SessionMapper;
  private readonly traceStore?: TraceStore;

  constructor(options: ClaudeCodeRuntimeAdapterOptions) {
    this.runtimeClient = options.runtimeClient;
    this.sessionMapper = options.sessionMapper;
    this.traceStore = options.traceStore;
  }

  async listRuntimeModels(
    options?: {
      settingSources?: Array<"user" | "project" | "local">;
    },
  ): Promise<string[]> {
    if (typeof this.runtimeClient.listModels !== "function") {
      return [];
    }
    try {
      return await this.runtimeClient.listModels(options);
    } catch {
      return [];
    }
  }

  async listRuntimeCommands(
    options?: {
      settingSources?: Array<"user" | "project" | "local">;
    },
  ): Promise<Array<{ name: string; description: string; argumentHint: string }>> {
    if (typeof this.runtimeClient.listCommands !== "function") {
      return [];
    }
    try {
      return await this.runtimeClient.listCommands(options);
    } catch {
      return [];
    }
  }

  async listRuntimeEfforts(
    options?: {
      model?: string;
      settingSources?: Array<"user" | "project" | "local">;
    },
  ): Promise<string[]> {
    if (typeof this.runtimeClient.listEfforts !== "function") {
      return ["default", "low", "medium", "high"];
    }
    try {
      return await this.runtimeClient.listEfforts(options);
    } catch {
      return ["default", "low", "medium", "high"];
    }
  }

  async getMappedProviderSessionId(conversationKey: string): Promise<string | undefined> {
    return this.sessionMapper.get(conversationKey);
  }

  async runTurn(request: RunTurnRequest, hooks: RunTurnHooks = {}): Promise<RunTurnOutcome> {
    const signal = hooks.signal ?? request.signal;
    const initialSessionId = await this.sessionMapper.get(request.conversationKey);
    let firstOutcome: RunTurnOutcome;
    try {
      firstOutcome = await this.runTurnOnce(request, hooks, signal, initialSessionId);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (initialSessionId && this.isInvalidThinkingSignatureError(err.message)) {
        await this.sessionMapper.delete(request.conversationKey);
        await hooks.onEvent?.({
          type: "status",
          ts: Date.now(),
          payload: {
            text: "Session signature mismatch detected. Retrying with a fresh Claude session."
          }
        });
        return this.runTurnOnce(request, hooks, signal, undefined);
      }
      throw err;
    }
    if (this.shouldRetryForThinkingSignature(initialSessionId, firstOutcome)) {
      await this.sessionMapper.delete(request.conversationKey);
      await hooks.onEvent?.({
        type: "status",
        ts: Date.now(),
        payload: {
          text: "Session signature mismatch detected. Retrying with a fresh Claude session."
        }
      });
      firstOutcome = await this.runTurnOnce(request, hooks, signal, undefined);
    }
    return firstOutcome;
  }

  private async runTurnOnce(
    request: RunTurnRequest,
    hooks: RunTurnHooks,
    signal: AbortSignal | undefined,
    providerSessionId: string | undefined
  ): Promise<RunTurnOutcome> {
    const stream = await this.runtimeClient.startTurn({
      conversationKey: request.conversationKey,
      userMessage: request.userMessage,
      providerSessionId,
      allowedTools: request.allowedTools,
      runtimeRequest: request.runtimeRequest,
      metadata: request.metadata,
      signal
    });

    let resolvedSessionId = providerSessionId;
    if (stream.providerSessionId) {
      resolvedSessionId = stream.providerSessionId;
      await this.sessionMapper.set(request.conversationKey, stream.providerSessionId);
    }

    hooks.onStart?.({
      runId: stream.runId,
      conversationKey: request.conversationKey,
      providerSessionId: stream.providerSessionId ?? providerSessionId
    });

    let finalText = "";

    try {
      for await (const providerEvent of stream.events) {
        const event = mapProviderEvent(providerEvent);
        const eventSessionId = this.extractSessionId(event.payload);
        if (eventSessionId && eventSessionId !== resolvedSessionId) {
          resolvedSessionId = eventSessionId;
          await this.sessionMapper.set(request.conversationKey, eventSessionId);
        }
        await this.emitEvent(stream.runId, request.conversationKey, event, hooks);

        if (event.type === "message_delta") {
          const delta = event.payload.delta;
          if (typeof delta === "string") {
            finalText += delta;
          }
        }

        if (event.type === "final") {
          const output = event.payload.output;
          if (typeof output === "string" && output.length > 0) {
            finalText = output;
          }
        }
      }

      return {
        runId: stream.runId,
        conversationKey: request.conversationKey,
        providerSessionId: resolvedSessionId,
        status: signal?.aborted ? "cancelled" : "completed",
        finalText
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const fallbackEvent: AgentEvent = {
        type: "fallback",
        ts: Date.now(),
        payload: {
          reason: "runtime_error",
          message: err.message
        }
      };
      await this.emitEvent(stream.runId, request.conversationKey, fallbackEvent, hooks);

      return {
        runId: stream.runId,
        conversationKey: request.conversationKey,
        providerSessionId: resolvedSessionId,
        status: signal?.aborted ? "cancelled" : "failed",
        finalText,
        error: err.message
      };
    }
  }

  private async emitEvent(
    runId: string,
    conversationKey: string,
    event: AgentEvent,
    hooks: RunTurnHooks
  ): Promise<void> {
    hooks.onEvent?.(event);
    if (this.traceStore) {
      await this.traceStore.append({ runId, conversationKey, event });
    }
  }

  private extractSessionId(payload: unknown): string | undefined {
    if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      if (typeof record.sessionId === "string") {
        return record.sessionId;
      }
      if (typeof record.session_id === "string") {
        return record.session_id;
      }
    }
    return undefined;
  }

  private isInvalidThinkingSignatureError(message: string | undefined): boolean {
    if (!message) return false;
    const normalized = message.toLowerCase();
    return (
      normalized.includes("invalid signature in thinking block") ||
      normalized.includes("thinking block") && normalized.includes("invalid signature")
    );
  }

  private shouldRetryForThinkingSignature(
    initialSessionId: string | undefined,
    outcome: RunTurnOutcome
  ): boolean {
    if (!initialSessionId) return false;
    if (outcome.status === "failed" && this.isInvalidThinkingSignatureError(outcome.error)) {
      return true;
    }
    if (outcome.status === "completed" && this.isInvalidThinkingSignatureError(outcome.finalText)) {
      return true;
    }
    return false;
  }

}
