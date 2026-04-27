import type { ClaudeCodeRuntimeAdapter } from "./claude-code-runtime-adapter.js";
import { resolve } from "node:path";
import type {
  Llm4ZoteroRunActionParams,
  Llm4ZoteroRunTurnRequest,
  Llm4ZoteroRunTurnOutcome,
  Llm4ZoteroRunTurnParams,
  Llm4ZoteroRuntimeRetentionRequest,
  Llm4ZoteroSessionInvalidationRequest,
} from "./llm4zotero-contract.js";
import { mapToLlm4ZoteroEvent } from "../event-mapper/map-to-llm4zotero-event.js";
import { findToolByName, getToolCatalog } from "./tool-catalog.js";
import { globalPermissionStore } from "../permissions/permission-store.js";

const CATASTROPHIC_ARG_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\/(?!\S)/i,
  /\bsudo\s+rm\s+-rf\b/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+if=.*\sof=\/dev\//i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/i,
];

function hasCatastrophicCommandPattern(argumentText: string): boolean {
  const text = argumentText.trim();
  if (!text) return false;
  return CATASTROPHIC_ARG_PATTERNS.some((pattern) => pattern.test(text));
}

type ScopeType = "paper" | "open" | "folder" | "tag" | "tagset" | "custom";

type ScopeInfo = {
  scopeType: ScopeType;
  scopeId: string;
  scopeLabel?: string;
};

const VALID_SCOPE_TYPES = new Set<ScopeType>([
  "paper",
  "open",
  "folder",
  "tag",
  "tagset",
  "custom",
]);

function normalizeScopeType(value: unknown): ScopeType | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (VALID_SCOPE_TYPES.has(normalized as ScopeType)) {
    return normalized as ScopeType;
  }
  return undefined;
}

function normalizeScopeId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function toSafePathSegment(value: string): string {
  const invalidChars = process.platform === "win32" ? /[^\w.\-@]/g : /[^\w.\-:@]/g;
  return value
    .trim()
    .replace(/[\/\\]/g, "_")
    .replace(/\s+/g, "_")
    .replace(invalidChars, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "unknown";
}

function toScopeInfo(
  request: Pick<Llm4ZoteroRunTurnRequest, "scopeType" | "scopeId" | "scopeLabel" | "metadata">,
): ScopeInfo | undefined {
  const metadata = request.metadata && typeof request.metadata === "object"
    ? request.metadata
    : undefined;
  const scopeType = normalizeScopeType(request.scopeType ?? metadata?.scopeType);
  const scopeId = normalizeScopeId(request.scopeId ?? metadata?.scopeId);
  if (!scopeType || !scopeId) return undefined;
  const scopeLabelRaw = request.scopeLabel ?? metadata?.scopeLabel;
  const scopeLabel =
    typeof scopeLabelRaw === "string" && scopeLabelRaw.trim().length > 0
      ? scopeLabelRaw.trim()
      : undefined;
  return { scopeType, scopeId, scopeLabel };
}

function buildScopedConversationKey(conversationKey: string, scope?: ScopeInfo): string {
  if (!scope) return conversationKey;
  return `${conversationKey}::${scope.scopeType}:${scope.scopeId}`;
}

function buildRuntimeCwdRelative(
  scope: ScopeInfo | undefined,
  originalConversationKey: string,
): string | undefined {
  if (!scope) return undefined;
  const profileSegment = scope.scopeId.match(/^(profile-[a-zA-Z0-9_-]+)(?::|$)/)?.[1];
  const profilePrefix = profileSegment ? `${toSafePathSegment(profileSegment)}/` : "";
  const scopeType = toSafePathSegment(scope.scopeType);
  const scopeId = toSafePathSegment(scope.scopeId);
  const conversationDir = toSafePathSegment(originalConversationKey);
  return `${profilePrefix}scopes/${scopeType}/${scopeId}/conversations/${conversationDir}`;
}

function resolveSessionCwd(
  runtimeCwd: string | undefined,
  runtimeCwdRelative: string | undefined,
): string | undefined {
  if (!runtimeCwd) return undefined;
  if (!runtimeCwdRelative) return resolve(runtimeCwd);
  return resolve(runtimeCwd, runtimeCwdRelative);
}

export class Llm4ZoteroAgentBackendAdapter {
  private readonly adapter: ClaudeCodeRuntimeAdapter;
  private readonly runtimeCwd?: string;
  private readonly pendingExternalConfirmations = new Map<
    string,
    (resolution: { approved: boolean; actionId?: string; data?: unknown }) => void
  >();

  constructor(options: { adapter: ClaudeCodeRuntimeAdapter; runtimeCwd?: string }) {
    this.adapter = options.adapter;
    this.runtimeCwd = options.runtimeCwd;
  }

  resolveExternalConfirmation(
    requestId: string,
    resolution: { approved: boolean; actionId?: string; data?: unknown },
  ): {
    accepted: boolean;
    source: "pending_map" | "permission_store" | "none";
    pendingPermissionCount: number;
    recentPendingRequestIds: string[];
  } {
    // First check internal pending confirmations (for debug probes, etc.)
    const resolve = this.pendingExternalConfirmations.get(requestId);
    if (resolve) {
      this.pendingExternalConfirmations.delete(requestId);
      resolve({
        approved: Boolean(resolution.approved),
        actionId: resolution.actionId,
        data: resolution.data,
      });
      return {
        accepted: true,
        source: "pending_map",
        pendingPermissionCount: globalPermissionStore.pendingCount(),
        recentPendingRequestIds: globalPermissionStore.listPendingRequestIds(3),
      };
    }

    // Then check global permission store (for SDK canUseTool callback)
    const accepted = globalPermissionStore.resolve(requestId, {
      approved: resolution.approved,
      data: resolution.data,
    });
    return {
      accepted,
      source: accepted ? "permission_store" : "none",
      pendingPermissionCount: globalPermissionStore.pendingCount(),
      recentPendingRequestIds: globalPermissionStore.listPendingRequestIds(3),
    };
  }

  async listTools(options?: {
    settingSources?: Array<"user" | "project" | "local">;
  }) {
    const catalog = getToolCatalog({
      runtimeCwd: this.runtimeCwd,
      settingSources: options?.settingSources,
    });
    const mcpTools = await this.listMcpToolDescriptors(options);
    const seen = new Set<string>();
    return [...catalog, ...mcpTools].filter((tool) => {
      if (seen.has(tool.name)) return false;
      seen.add(tool.name);
      return true;
    });
  }

  private async listMcpToolDescriptors(options?: {
    settingSources?: Array<"user" | "project" | "local">;
  }) {
    const servers = await this.adapter.listRuntimeMcpServers(options);
    return servers.flatMap((server) => {
      if (server.status !== "connected" || !Array.isArray(server.tools)) return [];
      return server.tools.map((tool) => {
        const destructive = Boolean(tool.annotations?.destructive);
        return {
          name: `${server.name}.${tool.name}`,
          description: tool.description || `MCP tool ${tool.name} from ${server.name}`,
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: true,
          },
          mutability: destructive ? "write" as const : "read" as const,
          riskLevel: destructive ? "high" as const : "medium" as const,
          requiresConfirmation: destructive,
          source: "mcp" as const,
        };
      });
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  async listCommands(
    options?: {
      settingSources?: Array<"user" | "project" | "local">;
    },
  ): Promise<Array<{ name: string; description: string; argumentHint: string; source: "sdk" | "fallback" }>> {
    const fromSdk = await this.adapter.listRuntimeCommands(options);
    const normalizedFromSdk = fromSdk
      .map((entry) => ({
        name: (entry.name || "").trim().replace(/^\/+/, ""),
        description: (entry.description || "").trim(),
        argumentHint: (entry.argumentHint || "").trim(),
      }))
      .filter((entry) => entry.name.length > 0);
    return normalizedFromSdk.map((entry) => ({
      ...entry,
      source: "sdk" as const,
    }));
  }

  async listModels(
    options?: {
      settingSources?: Array<"user" | "project" | "local">;
    },
  ): Promise<string[]> {
    const models = await this.adapter.listRuntimeModels(options);
    const unique = new Set<string>();
    unique.add("default");
    for (const model of models) {
      const normalized = (model || "").trim();
      if (normalized) unique.add(normalized);
    }
    const envCandidates = [
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      process.env.ANTHROPIC_CUSTOM_MODEL_OPTION,
    ];
    for (const candidate of envCandidates) {
      const normalized = (candidate || "").trim();
      if (normalized) unique.add(normalized);
    }
    return Array.from(unique);
  }

  async listEfforts(
    options?: {
      model?: string;
      settingSources?: Array<"user" | "project" | "local">;
    },
  ): Promise<string[]> {
    const efforts = await this.adapter.listRuntimeEfforts(options);
    const unique = new Set<string>();
    unique.add("default");
    for (const effort of efforts) {
      const normalized = (effort || "").trim().toLowerCase();
      if (normalized) unique.add(normalized);
    }
    return Array.from(unique);
  }

  async listMcpServers(
    options?: {
      settingSources?: Array<"user" | "project" | "local">;
    },
  ) {
    return this.adapter.listRuntimeMcpServers(options);
  }

  async getSessionInfo(params: {
    conversationKey: string | number;
    scopeType?: ScopeType;
    scopeId?: string;
    scopeLabel?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    originalConversationKey: string;
    scopedConversationKey: string;
    providerSessionId?: string;
    scopeType?: ScopeType;
    scopeId?: string;
    scopeLabel?: string;
    runtimeCwdRelative?: string;
    cwd?: string;
  }> {
    const originalConversationKey = String(params.conversationKey);
    const scope = toScopeInfo({
      scopeType: params.scopeType,
      scopeId: params.scopeId,
      scopeLabel: params.scopeLabel,
      metadata: params.metadata,
    });
    const scopedConversationKey = buildScopedConversationKey(
      originalConversationKey,
      scope,
    );
    const runtimeCwdRelative = buildRuntimeCwdRelative(scope, originalConversationKey);
    const providerSessionId = await this.adapter.getMappedProviderSessionId(
      scopedConversationKey,
    );
    return {
      originalConversationKey,
      scopedConversationKey,
      providerSessionId,
      scopeType: scope?.scopeType,
      scopeId: scope?.scopeId,
      scopeLabel: scope?.scopeLabel,
      runtimeCwdRelative,
      cwd: resolveSessionCwd(this.runtimeCwd, runtimeCwdRelative),
    };
  }

  async updateRuntimeRetention(params: Llm4ZoteroRuntimeRetentionRequest): Promise<{
    originalConversationKey: string;
    scopedConversationKey: string;
    retained: boolean;
  }> {
    const originalConversationKey = String(params.conversationKey);
    const scope = toScopeInfo(params);
    const scopedConversationKey = buildScopedConversationKey(
      originalConversationKey,
      scope,
    );
    if (params.retain) {
      await this.adapter.retainHotRuntime?.(
        {
          conversationKey: scopedConversationKey,
          userMessage: "",
          metadata: {
            originalConversationKey,
            scopeType: scope?.scopeType,
            scopeId: scope?.scopeId,
            scopeLabel: scope?.scopeLabel,
            runtimeCwdRelative: buildRuntimeCwdRelative(scope, originalConversationKey),
            retentionProbeId: params.probeId,
          },
          providerSessionId: params.providerSessionId,
        },
        params.mountId,
      );
    } else {
      await this.adapter.releaseHotRuntime?.(scopedConversationKey, params.mountId);
    }
    return {
      originalConversationKey,
      scopedConversationKey,
      retained: Boolean(params.retain),
    };
  }

  async invalidateSession(params: Llm4ZoteroSessionInvalidationRequest): Promise<{
    originalConversationKey: string;
    scopedConversationKey: string;
    invalidated: boolean;
  }> {
    const originalConversationKey = String(params.conversationKey);
    const scope = toScopeInfo(params);
    const scopedConversationKey = buildScopedConversationKey(
      originalConversationKey,
      scope,
    );
    await this.adapter.invalidateConversationSession({
      conversationKey: scopedConversationKey,
      metadata: params.metadata,
    });
    return {
      originalConversationKey,
      scopedConversationKey,
      invalidated: true,
    };
  }

  async invalidateAllHotRuntimes(): Promise<{ invalidated: boolean }> {
    await this.adapter.invalidateAllHotRuntimes?.();
    return { invalidated: true };
  }

  async runTurn(params: Llm4ZoteroRunTurnParams): Promise<Llm4ZoteroRunTurnOutcome> {
    let lastFallbackReason = "";
    let finalText = "";

    const originalConversationKey = String(params.request.conversationKey);
    const scope = toScopeInfo(params.request);
    const scopedConversationKey = buildScopedConversationKey(
      originalConversationKey,
      scope,
    );
    const runtimeCwdRelative = buildRuntimeCwdRelative(scope, originalConversationKey);
    const mergedMetadata: Record<string, unknown> = {
      ...(params.request.metadata || {}),
      originalConversationKey,
      scopeType: scope?.scopeType,
      scopeId: scope?.scopeId,
      scopeLabel: scope?.scopeLabel,
    };
    if (runtimeCwdRelative) {
      mergedMetadata.runtimeCwdRelative = runtimeCwdRelative;
    }

    const outcome = await this.adapter.runTurn(
      {
        conversationKey: scopedConversationKey,
        userMessage: params.request.userText,
        providerSessionId: params.request.providerSessionId,
        allowedTools: params.request.allowedTools,
        runtimeRequest: params.request.runtimeRequest,
        metadata: mergedMetadata,
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

    if (!finalText.trim()) {
      return {
        kind: "fallback",
        runId: outcome.runId,
        reason: "runtime_empty_response",
        usedFallback: true,
      };
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
          toolName: `/${requested.toolName}`,
          title: `Approve /${requested.toolName}`,
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

    const argumentText = this.readCommandArguments(requested.args);
    if (hasCatastrophicCommandPattern(argumentText)) {
      await params.onEvent?.({
        type: "status",
        text: "Blocked a potentially destructive command pattern.",
      });
      return {
        kind: "fallback",
        runId: `action-${Date.now()}`,
        reason: "dangerous_command_blocked",
        usedFallback: true,
      };
    }

    const slashPrompt = argumentText
      ? `/${requested.toolName} ${argumentText}`
      : `/${requested.toolName}`;

    return this.runTurn({
      request: {
        conversationKey: requested.conversationKey,
        userText: slashPrompt,
        scopeType: requested.scopeType,
        scopeId: requested.scopeId,
        scopeLabel: requested.scopeLabel,
        metadata: {
          ...(requested.metadata || {}),
          runType: "action",
          toolName: `/${requested.toolName}`,
          actionArgs: requested.args,
          activeItemId: requested.activeItemId,
          libraryID: requested.libraryID,
          contextEnvelope: requested.contextEnvelope,
          scopeType: requested.scopeType,
          scopeId: requested.scopeId,
          scopeLabel: requested.scopeLabel,
        },
      },
      onStart: params.onStart,
      onEvent: params.onEvent,
      signal: params.signal,
    });
  }

  private readCommandArguments(args: unknown): string {
    if (typeof args === "string") {
      return args.trim();
    }
    if (args && typeof args === "object") {
      const record = args as Record<string, unknown>;
      if (typeof record.arguments === "string") {
        return record.arguments.trim();
      }
    }
    return "";
  }
}
