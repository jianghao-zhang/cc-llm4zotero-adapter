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

  private isStreamingDebugEnabled(): boolean {
    return process.env.LLM4ZOTERO_BRIDGE_DEBUG_STREAMING === "1";
  }

  private logStreamingTiming(
    stage: string,
    details: {
      conversationKey: string;
      runId: string;
      textLength?: number;
      eventTs?: number;
    },
  ): void {
    if (!this.isStreamingDebugEnabled()) return;
    const now = Date.now();
    console.log(
      "[STREAMING]",
      JSON.stringify({
        stage,
        conversationKey: details.conversationKey,
        runId: details.runId,
        textLength: details.textLength,
        eventTs: details.eventTs,
        localTs: now,
        lagMs:
          typeof details.eventTs === "number" ? Math.max(0, now - details.eventTs) : undefined,
      }),
    );
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

  async listRuntimeMcpServers(
    options?: {
      settingSources?: Array<"user" | "project" | "local">;
    },
  ) {
    if (typeof this.runtimeClient.listMcpServers !== "function") {
      return [];
    }
    try {
      return await this.runtimeClient.listMcpServers(options);
    } catch {
      return [];
    }
  }

  private buildSessionMapKey(requestOrConversationKey: RunTurnRequest | string): string {
    if (typeof requestOrConversationKey === "string") {
      return requestOrConversationKey;
    }
    const metadata =
      requestOrConversationKey.metadata && typeof requestOrConversationKey.metadata === "object"
        ? (requestOrConversationKey.metadata as Record<string, unknown>)
        : {};
    const providerIdentity =
      typeof metadata.providerIdentity === "string" && metadata.providerIdentity.trim()
        ? metadata.providerIdentity.trim()
        : "";
    return providerIdentity
      ? `${requestOrConversationKey.conversationKey}::provider:${providerIdentity}`
      : requestOrConversationKey.conversationKey;
  }

  async getMappedProviderSessionId(conversationKey: string): Promise<string | undefined> {
    return this.sessionMapper.get(conversationKey);
  }

  async invalidateConversationSession(
    requestOrConversationKey:
      | RunTurnRequest
      | {
          conversationKey: string;
          metadata?: Record<string, unknown>;
        }
      | string,
  ): Promise<void> {
    const baseConversationKey =
      typeof requestOrConversationKey === "string"
        ? requestOrConversationKey
        : requestOrConversationKey.conversationKey;
    const explicitMapKey =
      typeof requestOrConversationKey === "string"
        ? requestOrConversationKey
        : this.buildSessionMapKey({
            conversationKey: requestOrConversationKey.conversationKey,
            userMessage: "",
            metadata: requestOrConversationKey.metadata,
          });
    await this.sessionMapper.delete(baseConversationKey);
    await this.sessionMapper.deleteByPrefix(`${baseConversationKey}::provider:`);
    if (explicitMapKey !== baseConversationKey) {
      await this.sessionMapper.delete(explicitMapKey);
    }
    await this.runtimeClient.invalidateHotRuntime?.(baseConversationKey);
  }

  async retainHotRuntime(request: RunTurnRequest, mountId: string): Promise<{ conversationKey: string; mountId: string; retained: boolean; probeId?: string } | void> {
    await this.runtimeClient.retainHotRuntime?.(request, mountId);
    const metadata = request.metadata && typeof request.metadata === "object"
      ? (request.metadata as Record<string, unknown>)
      : {};
    const sessionMapKey = this.buildSessionMapKey(request);
    const providerSessionId = await this.sessionMapper.get(sessionMapKey);
    await this.runtimeClient.warmHotRuntime?.({
      conversationKey: request.conversationKey,
      userMessage: "",
      providerSessionId,
      allowedTools: request.allowedTools,
      runtimeRequest: request.runtimeRequest,
      metadata: request.metadata,
    });
    return {
      conversationKey: request.conversationKey,
      mountId,
      retained: true,
      probeId: typeof metadata.retentionProbeId === "string" ? metadata.retentionProbeId : undefined,
    };
  }

  async releaseHotRuntime(conversationKey: string, mountId: string): Promise<void> {
    await this.runtimeClient.releaseHotRuntime?.(conversationKey, mountId);
  }

  async invalidateAllHotRuntimes(): Promise<void> {
    await this.runtimeClient.invalidateAllHotRuntimes?.();
  }

  private extractProviderIdentity(request: RunTurnRequest): string {
    const metadata =
      request.metadata && typeof request.metadata === "object"
        ? (request.metadata as Record<string, unknown>)
        : {};
    return typeof metadata.providerIdentity === "string" ? metadata.providerIdentity.trim() : "";
  }

  async runTurn(request: RunTurnRequest, hooks: RunTurnHooks = {}): Promise<RunTurnOutcome> {
    const signal = hooks.signal ?? request.signal;
    if (hooks.onEvent) {
      await hooks.onEvent({
        type: "provider_event",
        ts: Date.now(),
        payload: {
          providerType: "profiling",
          stage: "adapter.run_turn.enter",
        },
      });
    }
    const forceFreshSession = Boolean(
      request.metadata &&
        typeof request.metadata === "object" &&
        (request.metadata as Record<string, unknown>).forceFreshSession === true,
    );
    const sessionMapKey = this.buildSessionMapKey(request);
    if (forceFreshSession) {
      await this.invalidateConversationSession(request);
    }
    const initialSessionId = forceFreshSession
      ? undefined
      : await this.sessionMapper.get(sessionMapKey);
    if (hooks.onEvent) {
      await hooks.onEvent({
        type: "provider_event",
        ts: Date.now(),
        payload: {
          providerType: "profiling",
          stage: "adapter.session_lookup.ready",
          forceFreshSession,
          hasInitialSessionId: Boolean(initialSessionId),
        },
      });
    }
    let providerSessionId = initialSessionId;

    let firstOutcome: RunTurnOutcome;
    try {
      firstOutcome = await this.runTurnOnce(request, hooks, signal, providerSessionId);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (providerSessionId && this.isInvalidThinkingSignatureError(err.message)) {
        await this.sessionMapper.delete(sessionMapKey);
        hooks.onEvent?.({
          type: "status",
          ts: Date.now(),
          payload: {
            text: "Session signature mismatch detected. Retrying with a fresh Claude session.",
          },
        });
        return this.runTurnOnce(request, hooks, signal, undefined);
      }
      throw err;
    }
    if (this.shouldRetryForThinkingSignature(providerSessionId, firstOutcome)) {
      await this.sessionMapper.delete(sessionMapKey);
      hooks.onEvent?.({
        type: "status",
        ts: Date.now(),
        payload: {
          text: "Session signature mismatch detected. Retrying with a fresh Claude session.",
        },
      });
      firstOutcome = await this.runTurnOnce(request, hooks, signal, undefined);
    }
    if (
      providerSessionId &&
      firstOutcome.providerSessionId &&
      firstOutcome.providerSessionId !== providerSessionId &&
      this.extractProviderIdentity(request)
    ) {
      await this.sessionMapper.delete(sessionMapKey);
      hooks.onEvent?.({
        type: "status",
        ts: Date.now(),
        payload: {
          text: "Claude runtime changed. Rebuilding this conversation on the new runtime while keeping local context.",
        },
      });
      return this.runTurnOnce(request, hooks, signal, undefined);
    }
    return firstOutcome;
  }

  private async runTurnOnce(
    request: RunTurnRequest,
    hooks: RunTurnHooks,
    signal: AbortSignal | undefined,
    providerSessionId: string | undefined,
  ): Promise<RunTurnOutcome> {
    const sessionMapKey = this.buildSessionMapKey(request);
    const stream = await this.runtimeClient.startTurn({
      conversationKey: request.conversationKey,
      userMessage: request.userMessage,
      providerSessionId,
      allowedTools: request.allowedTools,
      runtimeRequest: request.runtimeRequest,
      metadata: request.metadata,
      signal,
    });

    let resolvedSessionId = providerSessionId;
    if (stream.providerSessionId) {
      resolvedSessionId = stream.providerSessionId;
      await this.sessionMapper.set(sessionMapKey, stream.providerSessionId);
    }

    hooks.onStart?.({
      runId: stream.runId,
      conversationKey: request.conversationKey,
      providerSessionId: stream.providerSessionId ?? providerSessionId,
    });

    let finalText = "";
    let pendingTextDelta = "";
    let lastTextDeltaTs: number | undefined;

    const flushPendingTextDelta = async (): Promise<void> => {
      if (!pendingTextDelta) return;
      const mergedEvent: AgentEvent = {
        type: "message_delta",
        ts: Date.now(),
        payload: {
          delta: pendingTextDelta,
        },
      };
      this.logStreamingTiming("emit_merged_message_delta", {
        conversationKey: request.conversationKey,
        runId: stream.runId,
        textLength: pendingTextDelta.length,
        eventTs: lastTextDeltaTs,
      });
      pendingTextDelta = "";
      lastTextDeltaTs = undefined;
      await this.emitEvent(stream.runId, request.conversationKey, mergedEvent, hooks);
    };

    try {
      for await (const providerEvent of stream.events) {
        const event = mapProviderEvent(providerEvent);
        const eventSessionId = this.extractSessionId(event.payload);
        const providerType =
          event.type === "provider_event" && event.payload && typeof event.payload === "object"
            ? (event.payload as Record<string, unknown>).providerType
            : undefined;
        const canAdoptSessionId =
          providerType === "assistant" ||
          providerType === "user" ||
          providerType === "result" ||
          event.type === "tool_call" ||
          event.type === "tool_result" ||
          event.type === "message_delta" ||
          event.type === "final";
        if (canAdoptSessionId && eventSessionId && eventSessionId !== resolvedSessionId) {
          resolvedSessionId = eventSessionId;
          await this.sessionMapper.set(sessionMapKey, eventSessionId);
        }
        if (event.type === "message_delta") {
          const delta = event.payload.delta;
          if (typeof delta === "string") {
            pendingTextDelta += delta;
            finalText += delta;
            lastTextDeltaTs = event.ts;
            continue;
          }
        }

        await flushPendingTextDelta();
        if (event.type === "final") {
          const output = event.payload.output;
          this.logStreamingTiming("emit_final", {
            conversationKey: request.conversationKey,
            runId: stream.runId,
            textLength: typeof output === "string" ? output.length : finalText.length,
            eventTs: event.ts,
          });
        }
        await this.emitEvent(stream.runId, request.conversationKey, event, hooks);

        if (event.type === "final") {
          const output = event.payload.output;
          if (typeof output === "string" && output.length > 0) {
            finalText = output;
          }
        }
      }

      await flushPendingTextDelta();
      this.logStreamingTiming("return_outcome", {
        conversationKey: request.conversationKey,
        runId: stream.runId,
        textLength: finalText.length,
      });

      return {
        runId: stream.runId,
        conversationKey: request.conversationKey,
        providerSessionId: resolvedSessionId,
        status: signal?.aborted ? "cancelled" : "completed",
        finalText,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const fallbackEvent: AgentEvent = {
        type: "fallback",
        ts: Date.now(),
        payload: {
          reason: "runtime_error",
          message: err.message,
        },
      };
      await this.emitEvent(stream.runId, request.conversationKey, fallbackEvent, hooks);

      return {
        runId: stream.runId,
        conversationKey: request.conversationKey,
        providerSessionId: resolvedSessionId,
        status: signal?.aborted ? "cancelled" : "failed",
        finalText,
        error: err.message,
      };
    }
  }

  private async emitEvent(
    runId: string,
    conversationKey: string,
    event: AgentEvent,
    hooks: RunTurnHooks,
  ): Promise<void> {
    hooks.onEvent?.(event);
    if (this.traceStore) {
      void this.traceStore.append({ runId, conversationKey, event });
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
      (normalized.includes("thinking block") && normalized.includes("invalid signature"))
    );
  }

  private shouldRetryForThinkingSignature(
    initialSessionId: string | undefined,
    outcome: RunTurnOutcome,
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
