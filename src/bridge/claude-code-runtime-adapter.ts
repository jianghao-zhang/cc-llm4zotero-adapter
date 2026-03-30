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

  async runTurn(request: RunTurnRequest, hooks: RunTurnHooks = {}): Promise<RunTurnOutcome> {
    const signal = hooks.signal ?? request.signal;
    const providerSessionId = await this.sessionMapper.get(request.conversationKey);

    const stream = await this.runtimeClient.startTurn({
      conversationKey: request.conversationKey,
      userMessage: request.userMessage,
      providerSessionId,
      allowedTools: request.allowedTools,
      metadata: request.metadata,
      signal
    });

    if (stream.providerSessionId) {
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
        providerSessionId: stream.providerSessionId ?? providerSessionId,
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
        providerSessionId: stream.providerSessionId ?? providerSessionId,
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
}
