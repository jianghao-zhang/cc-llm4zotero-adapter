import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ClaudeCodeRuntimeClient, RuntimeTurnRequest, RuntimeTurnStream } from "../runtime.js";
import { mapSdkMessageToProviderEvents } from "../event-mapper/map-sdk-message.js";
import type { PermissionMode, SDKUserMessage, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { globalPermissionStore } from "../permissions/permission-store.js";
import type { PermissionResult } from "../permissions/permission-store.js";
import {
  resolveModelWithCache,
  setCachedModels,
} from "./model-resolver.js";

type QueryFunction = (args: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Record<string, unknown>;
}) => AsyncIterable<unknown>;

type ClaudeModelInfo = {
  value?: string;
  supportedEffortLevels?: string[];
  supportsEffort?: boolean;
};

type ClaudeSlashCommandInfo = {
  name?: string;
  description?: string;
  argumentHint?: string;
};

function normalizeModelName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\[[0-9;]*m\]?/g, "")
    .trim();
}

export interface ClaudeAgentSdkRuntimeClientOptions {
  cwd?: string;
  additionalDirectories?: string[];
  defaultAllowedTools?: string[];
  settingSources?: SettingSource[];
  permissionMode?: PermissionMode;
  includePartialMessages?: boolean;
  maxTurns?: number;
  continue?: boolean;
  appendSystemPrompt?: string;
  forwardFrontendModel?: boolean;
  blockedMetadataKeys?: string[];
  queryImpl?: QueryFunction;
}

type ClaudeSettingsShape = {
  model?: unknown;
  availableModels?: unknown;
  modelOverrides?: unknown;
};

const DEFAULT_BLOCKED_METADATA_KEYS = new Set<string>([
  "allowedTools",
  "abortController",
  "continue",
  "cwd",
  "includePartialMessages",
  "maxTurns",
  "resume",
  "settingSources",
  "runtimeRequest",
  "runtimeCwdRelative",
]);

type RuntimeAttachment = {
  name?: unknown;
  category?: unknown;
  mimeType?: unknown;
  storedPath?: unknown;
};

type RuntimeRequestShape = {
  userText?: unknown;
  selectedTexts?: unknown;
  selectedPaperContexts?: unknown;
  paperContexts?: unknown;
  fullTextPaperContexts?: unknown;
  pinnedPaperContexts?: unknown;
  attachments?: unknown;
  screenshots?: unknown;
  activeNoteContext?: unknown;
};

const IMAGE_MIME_BY_KIND: Record<string, "image/jpeg" | "image/png" | "image/gif" | "image/webp"> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

const IMAGE_MIME_FROM_TYPE: Record<string, "image/jpeg" | "image/png" | "image/gif" | "image/webp"> = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
};

function trimInline(value: unknown, max = 280): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function toRuntimeRequest(
  request: RuntimeTurnRequest,
  metadata: Record<string, unknown>,
): RuntimeRequestShape | undefined {
  const direct = asRecord(request.runtimeRequest);
  if (direct) return direct as RuntimeRequestShape;
  const fromMetadata = asRecord(metadata.runtimeRequest);
  if (fromMetadata) return fromMetadata as RuntimeRequestShape;
  return undefined;
}

function parseImageDataUrl(
  value: unknown,
): { mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string } | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const match = /^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(normalized);
  if (!match) return null;
  const mediaType = IMAGE_MIME_BY_KIND[match[1].toLowerCase()];
  if (!mediaType) return null;
  const data = match[2].replace(/\s+/g, "");
  if (!data) return null;
  return { mediaType, data };
}

function resolveImageMediaType(attachment: RuntimeAttachment): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | null {
  const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim().toLowerCase() : "";
  if (mimeType && IMAGE_MIME_FROM_TYPE[mimeType]) {
    return IMAGE_MIME_FROM_TYPE[mimeType];
  }
  const name = typeof attachment.name === "string" ? attachment.name.trim().toLowerCase() : "";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  return null;
}

async function loadAttachmentImagePayloads(
  runtimeRequest: RuntimeRequestShape | undefined,
  limit: number,
): Promise<Array<{ mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string }>> {
  if (!runtimeRequest || !Array.isArray(runtimeRequest.attachments) || limit <= 0) return [];
  const payloads: Array<{ mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string }> = [];
  for (const raw of runtimeRequest.attachments as RuntimeAttachment[]) {
    if (payloads.length >= limit) break;
    if (!raw || typeof raw !== "object") continue;
    const storedPath = typeof raw.storedPath === "string" ? raw.storedPath.trim() : "";
    if (!storedPath || !storedPath.startsWith("/")) continue;
    const category = typeof raw.category === "string" ? raw.category.trim().toLowerCase() : "";
    const mediaType = resolveImageMediaType(raw);
    const isImage = category === "image" || Boolean(mediaType);
    if (!isImage || !mediaType) continue;
    try {
      const buffer = await readFile(storedPath);
      const data = buffer.toString("base64");
      if (!data) continue;
      payloads.push({ mediaType, data });
    } catch {
      // best effort: keep prompt text path fallback, but skip block if unreadable
    }
  }
  return payloads;
}

function collectAttachmentPaths(runtimeRequest: RuntimeRequestShape | undefined): string[] {
  if (!runtimeRequest || !Array.isArray(runtimeRequest.attachments)) return [];
  const paths: string[] = [];
  for (const entry of runtimeRequest.attachments as RuntimeAttachment[]) {
    if (!entry || typeof entry !== "object") continue;
    const storedPath = typeof entry.storedPath === "string" ? entry.storedPath.trim() : "";
    if (!storedPath || !storedPath.startsWith("/")) continue;
    const name = trimInline(entry.name, 120);
    const mimeType = trimInline(entry.mimeType, 80);
    const category = trimInline(entry.category, 24);
    const meta = [category, mimeType].filter(Boolean).join(", ");
    const suffix = meta ? ` (${meta})` : "";
    paths.push(`- ${name || "attachment"}: ${storedPath}${suffix}`);
  }
  return paths;
}

function collectPaperTitles(entries: unknown, limit: number): string[] {
  if (!Array.isArray(entries)) return [];
  const titles: string[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) continue;
    const title = trimInline(record.title, 140);
    if (!title) continue;
    titles.push(title);
    if (titles.length >= limit) break;
  }
  return titles;
}

type RuntimePaperPathEntry = {
  title: string;
  contextItemId?: number;
  contextFilePath?: string;
  mineruFullMdPath?: string;
  mineruCacheDir?: string;
};

function asPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || !normalized.startsWith("/")) return undefined;
  return normalized;
}

function collectPaperPathEntries(entries: unknown, limit: number): RuntimePaperPathEntry[] {
  if (!Array.isArray(entries) || limit <= 0) return [];
  const collected: RuntimePaperPathEntry[] = [];
  for (const raw of entries) {
    if (collected.length >= limit) break;
    const record = asRecord(raw);
    if (!record) continue;
    const title = trimInline(record.title, 140) || "paper";
    const contextItemId =
      typeof record.contextItemId === "number" && Number.isFinite(record.contextItemId)
        ? Math.floor(record.contextItemId)
        : undefined;
    const contextFilePath = asPath(record.contextFilePath);
    const mineruFullMdPath = asPath(record.mineruFullMdPath);
    const mineruCacheDir = asPath(record.mineruCacheDir);
    if (!contextFilePath && !mineruFullMdPath && !mineruCacheDir && !contextItemId) {
      continue;
    }
    collected.push({
      title,
      contextItemId,
      contextFilePath,
      mineruFullMdPath,
      mineruCacheDir,
    });
  }
  return collected;
}

function formatPaperPathLines(entries: RuntimePaperPathEntry[]): string[] {
  return entries.map((entry) => {
    const pathHints = [
      entry.mineruFullMdPath ? `MinerU md: ${entry.mineruFullMdPath}` : "",
      entry.contextFilePath ? `attachment: ${entry.contextFilePath}` : "",
      entry.mineruCacheDir ? `MinerU dir: ${entry.mineruCacheDir}` : "",
      typeof entry.contextItemId === "number"
        ? `contextItemId=${entry.contextItemId}`
        : "",
    ].filter(Boolean);
    return `- ${entry.title}${pathHints.length ? ` [${pathHints.join(" | ")}]` : ""}`;
  });
}

function buildPromptText(
  userMessage: string,
  runtimeRequest: RuntimeRequestShape | undefined,
): string {
  const trimmedUserMessage = userMessage.trim();
  if (trimmedUserMessage.startsWith("/")) {
    return trimmedUserMessage;
  }
  const lines: string[] = [trimmedUserMessage];

  if (!runtimeRequest) {
    return lines.join("\n\n");
  }

  const selectedTexts = Array.isArray(runtimeRequest.selectedTexts)
    ? runtimeRequest.selectedTexts
        .slice(0, 3)
        .map((entry) => trimInline(entry, 320))
        .filter(Boolean)
    : [];
  if (selectedTexts.length) {
    lines.push(
      "Selected snippets:",
      ...selectedTexts.map((text, index) => `${index + 1}. ${text}`),
    );
  }

  const screenshotCount = Array.isArray(runtimeRequest.screenshots)
    ? runtimeRequest.screenshots.length
    : 0;
  const attachmentPathCount = collectAttachmentPaths(runtimeRequest).length;
  const selectedPaperPathEntries = collectPaperPathEntries(
    runtimeRequest.selectedPaperContexts ?? runtimeRequest.paperContexts,
    8,
  );
  const fullTextPaperPathEntries = collectPaperPathEntries(
    runtimeRequest.fullTextPaperContexts,
    6,
  );

  lines.push(
    "Response protocol for this turn:",
    `- Start with one short receipt line: RECEIVED papers=${selectedPaperPathEntries.length + fullTextPaperPathEntries.length}, attachments=${attachmentPathCount}, screenshots=${screenshotCount}.`,
    "- If any referenced file path cannot be read, explicitly report: READ_FAIL <absolute_path> (<reason>).",
    "- Prefer reading MinerU markdown path before PDF path when both are available.",
  );

  const selectedPapers = collectPaperTitles(
    runtimeRequest.selectedPaperContexts,
    6,
  );
  if (selectedPapers.length) {
    lines.push(
      "Selected papers:",
      ...selectedPapers.map((title) => `- ${title}`),
    );
  }

  if (selectedPaperPathEntries.length) {
    lines.push(
      "Selected paper contexts with local readable paths (prefer MinerU md, then attachment path):",
      ...formatPaperPathLines(selectedPaperPathEntries),
    );
  }

  const fullTextPapers = collectPaperTitles(runtimeRequest.fullTextPaperContexts, 4);
  if (fullTextPapers.length) {
    lines.push(
      "Papers marked for full-text reading:",
      ...fullTextPapers.map((title) => `- ${title}`),
    );
  }

  if (fullTextPaperPathEntries.length) {
    lines.push(
      "Full-text paper contexts with local readable paths:",
      ...formatPaperPathLines(fullTextPaperPathEntries),
    );
  }

  const pinnedPapers = collectPaperTitles(runtimeRequest.pinnedPaperContexts, 4);
  if (pinnedPapers.length) {
    lines.push(
      "Pinned papers:",
      ...pinnedPapers.map((title) => `- ${title}`),
    );
  }

  const attachmentPaths = collectAttachmentPaths(runtimeRequest);
  if (attachmentPaths.length) {
    lines.push(
      "Local attachment files (absolute paths). Read these files directly when needed:",
      ...attachmentPaths,
    );
  }

  const activeNote = asRecord(runtimeRequest.activeNoteContext);
  if (activeNote) {
    const noteTitle = trimInline(activeNote.title, 140);
    const preview = trimInline(activeNote.noteText, 420);
    if (noteTitle || preview) {
      lines.push(
        "Active note context:",
        noteTitle ? `- Title: ${noteTitle}` : "- Title: (untitled)",
        preview ? `- Preview: ${preview}` : "",
      );
    }
  }

  return lines.filter(Boolean).join("\n\n");
}

async function buildPromptInput(
  request: RuntimeTurnRequest,
  metadata: Record<string, unknown>,
): Promise<string | AsyncIterable<SDKUserMessage>> {
  const runtimeRequest = toRuntimeRequest(request, metadata);
  const promptText = buildPromptText(request.userMessage, runtimeRequest);

  const screenshotPayloads = Array.isArray(runtimeRequest?.screenshots)
    ? runtimeRequest!.screenshots
        .map((entry) => parseImageDataUrl(entry))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .slice(0, 8)
    : [];
  const attachmentImagePayloads = await loadAttachmentImagePayloads(
    runtimeRequest,
    Math.max(0, 8 - screenshotPayloads.length),
  );
  const imagePayloads = [...screenshotPayloads, ...attachmentImagePayloads].slice(0, 8);
  if (!imagePayloads.length) {
    return promptText;
  }

  const userEvent: SDKUserMessage = {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        { type: "text", text: promptText },
        ...imagePayloads.map((entry) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: entry.mediaType,
            data: entry.data,
          },
        })),
      ],
    },
  };

  return (async function* () {
    yield userEvent;
  })();
}

function parseMetadata(
  metadata: RuntimeTurnRequest["metadata"],
  options: Pick<ClaudeAgentSdkRuntimeClientOptions, "blockedMetadataKeys">
): Record<string, unknown> {
  if (!metadata) {
    return {};
  }

  const blockedKeys = new Set<string>([
    ...DEFAULT_BLOCKED_METADATA_KEYS,
    ...(options.blockedMetadataKeys ?? []),
  ]);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!blockedKeys.has(key)) {
      result[key] = value;
    }
  }

  return result;
}

function parseSettingSourcesOverride(
  metadata: Record<string, unknown>,
): SettingSource[] | undefined {
  const raw = metadata.claudeSettingSources;
  if (!Array.isArray(raw)) return undefined;
  const allowed = new Set<SettingSource>(["user", "project", "local"]);
  const next: SettingSource[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const normalized = entry.trim().toLowerCase() as SettingSource;
    if (!allowed.has(normalized)) continue;
    if (!next.includes(normalized)) next.push(normalized);
  }
  return next.length > 0 ? next : undefined;
}

function parsePermissionModeOverride(
  metadata: Record<string, unknown>,
): PermissionMode | undefined {
  const raw = metadata.permissionMode;
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "yolo") return "bypassPermissions";
  if (normalized === "safe") return "default";
  if (
    normalized === "default" ||
    normalized === "acceptedits" ||
    normalized === "bypasspermissions" ||
    normalized === "plan" ||
    normalized === "dontask"
  ) {
    if (normalized === "acceptedits") return "acceptEdits";
    if (normalized === "bypasspermissions") return "bypassPermissions";
    if (normalized === "dontask") return "dontAsk";
    return normalized as PermissionMode;
  }
  return undefined;
}

function mergeAllowedTools(
  requestAllowedTools: string[] | undefined,
  defaultAllowedTools: string[] | undefined,
): string[] | undefined {
  const merged = new Set<string>();
  for (const tool of defaultAllowedTools ?? []) {
    const normalized = tool.trim();
    if (normalized) merged.add(normalized);
  }
  for (const tool of requestAllowedTools ?? []) {
    const normalized = tool.trim();
    if (normalized) merged.add(normalized);
  }
  return merged.size > 0 ? Array.from(merged) : undefined;
}

export class ClaudeAgentSdkRuntimeClient implements ClaudeCodeRuntimeClient {
  private readonly options: ClaudeAgentSdkRuntimeClientOptions;
  private modelInfoCache = new Map<
    string,
    { expiresAt: number; infos: ClaudeModelInfo[] }
  >();
  private commandInfoCache = new Map<
    string,
    { expiresAt: number; commands: ClaudeSlashCommandInfo[] }
  >();
  private readonly modelInfoTtlMs = 60_000;
  private readonly commandInfoTtlMs = 60_000;

  constructor(options: ClaudeAgentSdkRuntimeClientOptions = {}) {
    this.options = options;
  }

  async startTurn(request: RuntimeTurnRequest): Promise<RuntimeTurnStream> {
    const query = this.options.queryImpl ?? (await this.loadQuery());
    const metadata = parseMetadata(request.metadata, this.options);
    const shouldForwardFrontendModel = this.options.forwardFrontendModel === true;
    const requestedModelRaw =
      typeof metadata.model === "string" ? metadata.model.trim() : "";
    const requestedModel =
      shouldForwardFrontendModel &&
      requestedModelRaw &&
      requestedModelRaw.toLowerCase() !== "default" &&
      requestedModelRaw.toLowerCase() !== "auto"
        ? requestedModelRaw
        : undefined;
    const requestedEffortRaw =
      typeof metadata.effort === "string"
        ? metadata.effort.trim().toLowerCase()
        : "";
    const requestedEffort =
      requestedEffortRaw === "low" ||
      requestedEffortRaw === "medium" ||
      requestedEffortRaw === "max"
        ? requestedEffortRaw
        : undefined;

    const settingSourcesOverride = parseSettingSourcesOverride(metadata);
    const permissionModeOverride = parsePermissionModeOverride(metadata);
    const effectiveCwd = this.resolveScopedCwd(request.metadata);

    // Dynamic model resolution with cache
    const effectiveSettingSources =
      settingSourcesOverride ?? this.options.settingSources ?? ["user", "project"];

    let resolvedModel: string | undefined;
    if (
      shouldForwardFrontendModel &&
      requestedModelRaw &&
      requestedModelRaw.toLowerCase() !== "default" &&
      requestedModelRaw.toLowerCase() !== "auto"
    ) {
      // Try to resolve from cache or environment variables
      const { model: resolvedFromCache, cacheHit } = resolveModelWithCache(
        requestedModelRaw,
        effectiveSettingSources
      );

      if (resolvedFromCache) {
        // Use resolved model (from cache or env vars)
        resolvedModel = resolvedFromCache;
      }

      if (!cacheHit) {
        // Cache miss: trigger async fetch to populate cache for next time
        this.fetchAndCacheModels(effectiveSettingSources).catch(() => {
          // Silently ignore, will retry on next request
        });
      }
    }

    // Permission event buffer for canUseTool callback
    const permissionEventBuffer: Array<import("../runtime.js").ProviderEvent> = [];

    // Create canUseTool handler that buffers permission events
    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      sdkOptions: {
        signal: AbortSignal;
        title?: string;
        description?: string;
        displayName?: string;
        toolUseID: string;
        blockedPath?: string;
        decisionReason?: string;
      }
    ): Promise<PermissionResult> => {
      const { requestId, promise } = globalPermissionStore.create(
        sdkOptions.toolUseID,
        toolName,
        input,
        {
          title: sdkOptions.title,
          description: sdkOptions.description,
          displayName: sdkOptions.displayName,
          blockedPath: sdkOptions.blockedPath,
          decisionReason: sdkOptions.decisionReason,
        }
      );

      // Build confirmation_required event
      const eventAction: Record<string, unknown> = {
        toolName,
        title: sdkOptions.title || `Approve ${toolName}`,
        mode: "approval",
        confirmLabel: "Allow",
        cancelLabel: "Deny",
        description:
          sdkOptions.description ||
          sdkOptions.decisionReason ||
          "Claude Code requests permission to use a tool.",
        fields: [],
      };

      // Add command preview for Bash tool
      if (toolName === "Bash" && input.command) {
        const commandStr = String(input.command).slice(0, 200);
        (eventAction.fields as Array<Record<string, unknown>>).push({
          type: "text",
          id: "command",
          label: "Command",
          value: commandStr,
        });
      }

      // Add blocked path if present
      if (sdkOptions.blockedPath) {
        (eventAction.fields as Array<Record<string, unknown>>).push({
          type: "text",
          id: "blockedPath",
          label: "Path",
          value: sdkOptions.blockedPath,
        });
      }

      // Push to buffer for events generator to yield
      permissionEventBuffer.push({
        type: "confirmation_required",
        payload: {
          requestId,
          action: eventAction,
          sessionId: request.providerSessionId,
        },
      });

      return promise;
    };

    // IMPORTANT:
    // If alias resolution fails (e.g., frontend "sonnet" with non-Anthropic provider),
    // do NOT forward raw alias to SDK. Omit `model` and let runtime defaults decide.
    const modelForSdk = resolvedModel;
    const queryOptions: Record<string, unknown> = {
      ...metadata,
      model: modelForSdk,
      effort: requestedEffort,
      cwd: effectiveCwd,
      additionalDirectories: this.options.additionalDirectories,
      allowedTools: mergeAllowedTools(request.allowedTools, this.options.defaultAllowedTools),
      settingSources:
        settingSourcesOverride ?? this.options.settingSources ?? ["user", "project"],
      permissionMode: permissionModeOverride ?? this.options.permissionMode,
      includePartialMessages: this.options.includePartialMessages,
      maxTurns: this.options.maxTurns,
      continue: this.options.continue,
      appendSystemPrompt: this.options.appendSystemPrompt,
      resume: request.providerSessionId,
      abortController: request.signal ? this.createAbortController(request.signal) : undefined,
      // Add canUseTool callback for permission handling
      canUseTool,
    };

    const cleanedOptions = Object.fromEntries(
      Object.entries(queryOptions).filter(([, value]) => value !== undefined)
    );
    console.log(`[MODEL] Frontend: ${requestedModelRaw || "(none)"} -> SDK: ${String(cleanedOptions.model ?? "(runtime default)")}`);

    const prompt = await buildPromptInput(request, metadata);
    const sdkStream = query({
      prompt,
      options: cleanedOptions,
    });
    const client = this;

    const events = (async function* (): AsyncIterable<import("../runtime.js").ProviderEvent> {
      yield {
        type: "provider_event",
        payload: {
          providerType: "runtime_config",
          sessionId: request.providerSessionId,
          ts: Date.now(),
          payload: {
            requestedModel: requestedModel ?? null,
            resolvedEffort: requestedEffort ?? null,
            resolvedPermissionMode:
              permissionModeOverride ?? client.options.permissionMode ?? null,
            settingSources: effectiveSettingSources,
            cwd: effectiveCwd,
          },
        },
      };

      // Create iterator for SDK stream
      const sdkIterator = sdkStream[Symbol.asyncIterator]();
      let sdkDone = false;

      // Process both SDK events and permission events
      while (!sdkDone || permissionEventBuffer.length > 0) {
        // First, yield any pending permission events
        while (permissionEventBuffer.length > 0) {
          const event = permissionEventBuffer.shift();
          if (event) yield event;
        }

        if (sdkDone) continue;

        // Race between SDK next value and a short delay to check for permission events
        const timeoutPromise = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), 50)
        );

        const result = await Promise.race([sdkIterator.next(), timeoutPromise]);

        if (result === null) {
          // Timeout - check if permission events were added during the wait
          continue;
        }

        if (result.done) {
          sdkDone = true;
          continue;
        }

        console.log(`[SDK] Received message:`, JSON.stringify(result.value));
        const mapped = mapSdkMessageToProviderEvents(result.value);
        console.log(`[SDK] Mapped to ${mapped.length} events:`, mapped.map(e => e.type));
        for (const event of mapped) {
          yield event;
        }
      }
    })();

    return {
      runId: randomUUID(),
      providerSessionId: request.providerSessionId,
      events,
    };
  }

  async listModels(
    options?: {
      settingSources?: Array<"user" | "project" | "local">;
    },
  ): Promise<string[]> {
    const sdkInfos = await this.readSupportedModelsFromSdk(options);
    const requestedSources = options?.settingSources;
    const settingSources = Array.isArray(requestedSources) && requestedSources.length > 0
      ? requestedSources
      : this.options.settingSources ?? ["user", "project"];
    const unique = new Set<string>();
    for (const info of sdkInfos) {
      const value = normalizeModelName(info.value);
      if (value) unique.add(value);
    }
    for (const source of settingSources) {
      const settingsPath = this.resolveSettingsPathBySource(source);
      if (!settingsPath) continue;
      const settings = await this.readSettingsFile(settingsPath);
      this.collectModelsFromSettings(settings, unique);
    }
    return Array.from(unique);
  }

  async listCommands(
    options?: {
      settingSources?: Array<"user" | "project" | "local">;
    },
  ): Promise<Array<{ name: string; description: string; argumentHint: string }>> {
    const infos = await this.readSupportedCommandsFromSdk(options);
    const commands = infos
      .map((entry) => ({
        name: (entry.name || "").trim().replace(/^\/+/, ""),
        description: (entry.description || "").trim(),
        argumentHint: (entry.argumentHint || "").trim(),
      }))
      .filter((entry) => entry.name.length > 0);
    return commands;
  }

  async listEfforts(
    options?: {
      model?: string;
      settingSources?: Array<"user" | "project" | "local">;
    },
  ): Promise<string[]> {
    const sdkInfos = await this.readSupportedModelsFromSdk({
      settingSources: options?.settingSources,
    });
    const model = (options?.model || "").trim().toLowerCase();
    const base = ["default", "low", "medium", "high"] as string[];
    if (model) {
      const matched = sdkInfos.find((info) => {
        const value = typeof info.value === "string" ? info.value.trim().toLowerCase() : "";
        return value === model;
      });
      if (matched?.supportsEffort && Array.isArray(matched.supportedEffortLevels)) {
        const efforts = Array.from(
          new Set(
            matched.supportedEffortLevels
              .map((entry) => entry.trim().toLowerCase())
              .filter(
                (entry) =>
                  entry === "low" ||
                  entry === "medium" ||
                  entry === "high" ||
                  entry === "max",
              ),
          ),
        );
        return efforts.length > 0 ? ["default", ...efforts] : base;
      }
    }
    if (
      /(?:^|[._-])max(?:$|[._-])/.test(model) ||
      /opus[\s._-]*4[\s._-]*6/.test(model) ||
      /claude-opus-4-6/.test(model)
    ) {
      return [...base, "max"];
    }
    return base;
  }

  private resolveScopedCwd(metadata: RuntimeTurnRequest["metadata"]): string | undefined {
    const baseCwd = this.options.cwd ? resolve(this.options.cwd) : undefined;
    if (!baseCwd) return undefined;
    const runtimeCwdRelative =
      metadata && typeof metadata.runtimeCwdRelative === "string"
        ? metadata.runtimeCwdRelative.trim()
        : "";
    if (!runtimeCwdRelative) {
      mkdirSync(baseCwd, { recursive: true });
      return baseCwd;
    }
    if (isAbsolute(runtimeCwdRelative)) {
      mkdirSync(baseCwd, { recursive: true });
      return baseCwd;
    }
    const candidate = resolve(baseCwd, runtimeCwdRelative);
    const rel = relative(baseCwd, candidate);
    const insideBase = rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
    if (!insideBase) {
      mkdirSync(baseCwd, { recursive: true });
      return baseCwd;
    }
    mkdirSync(candidate, { recursive: true });
    return candidate;
  }

  private resolveSettingsPathBySource(
    source: "user" | "project" | "local",
  ): string | undefined {
    const homeDir = process.env.HOME && process.env.HOME.trim()
      ? resolve(process.env.HOME.trim())
      : undefined;
    const baseCwd = this.options.cwd ? resolve(this.options.cwd) : process.cwd();
    if (source === "user") {
      if (!homeDir) return undefined;
      return resolve(homeDir, ".claude/settings.json");
    }
    if (source === "project") {
      return resolve(baseCwd, ".claude/settings.json");
    }
    return resolve(baseCwd, ".claude/settings.local.json");
  }

  private async readSettingsFile(path: string): Promise<ClaudeSettingsShape> {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as ClaudeSettingsShape;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private collectModelsFromSettings(
    settings: ClaudeSettingsShape,
    unique: Set<string>,
  ): void {
    if (!settings || typeof settings !== "object") return;
    const defaultModel = normalizeModelName(settings.model);
    if (defaultModel) {
      unique.add(defaultModel);
    }
    if (Array.isArray(settings.availableModels)) {
      for (const entry of settings.availableModels) {
        const normalized = normalizeModelName(entry);
        if (normalized) unique.add(normalized);
      }
    }
    if (
      settings.modelOverrides &&
      typeof settings.modelOverrides === "object" &&
      !Array.isArray(settings.modelOverrides)
    ) {
      for (const [key, value] of Object.entries(
        settings.modelOverrides as Record<string, unknown>,
      )) {
        const normalizedKey = normalizeModelName(key);
        if (normalizedKey) unique.add(normalizedKey);
        const normalizedValue = normalizeModelName(value);
        if (normalizedValue) unique.add(normalizedValue);
      }
    }
  }

  private async loadQuery(): Promise<QueryFunction> {
    const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
      query: QueryFunction;
    };

    if (typeof sdk.query !== "function") {
      throw new Error("@anthropic-ai/claude-agent-sdk does not export query()");
    }

    return sdk.query;
  }

  private async readSupportedModelsFromSdk(
    options?: {
      settingSources?: Array<"user" | "project" | "local">;
    },
  ): Promise<ClaudeModelInfo[]> {
    const requestedSources = options?.settingSources;
    const settingSources = Array.isArray(requestedSources) && requestedSources.length > 0
      ? requestedSources
      : this.options.settingSources ?? ["user", "project"];
    const cacheKey = settingSources.join(",");
    const cached = this.modelInfoCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.infos;
    }
    try {
      const query = this.options.queryImpl ?? (await this.loadQuery());
      const session = query({
        prompt: "",
        options: {
          cwd: this.options.cwd ? resolve(this.options.cwd) : process.cwd(),
          settingSources,
          permissionMode: this.options.permissionMode,
        },
      }) as AsyncIterable<unknown> & {
        supportedModels?: () => Promise<ClaudeModelInfo[]>;
        return?: (value?: unknown) => Promise<unknown>;
      };
      if (typeof session.supportedModels !== "function") {
        return [];
      }
      const infosRaw = await session.supportedModels();
      if (typeof session.return === "function") {
        try {
          await session.return(undefined);
        } catch {
          // ignore
        }
      }
      const infos = Array.isArray(infosRaw) ? infosRaw : [];
      this.modelInfoCache.set(cacheKey, {
        infos,
        expiresAt: Date.now() + this.modelInfoTtlMs,
      });
      return infos;
    } catch {
      return [];
    }
  }

  private async readSupportedCommandsFromSdk(
    options?: {
      settingSources?: Array<"user" | "project" | "local">;
    },
  ): Promise<ClaudeSlashCommandInfo[]> {
    const requestedSources = options?.settingSources;
    const settingSources = Array.isArray(requestedSources) && requestedSources.length > 0
      ? requestedSources
      : this.options.settingSources ?? ["user", "project"];
    const cacheKey = settingSources.join(",");
    const cached = this.commandInfoCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.commands;
    }
    try {
      const query = this.options.queryImpl ?? (await this.loadQuery());
      const session = query({
        prompt: "",
        options: {
          cwd: this.options.cwd ? resolve(this.options.cwd) : process.cwd(),
          settingSources,
          permissionMode: this.options.permissionMode,
        },
      }) as AsyncIterable<unknown> & {
        supportedCommands?: () => Promise<ClaudeSlashCommandInfo[]>;
        return?: (value?: unknown) => Promise<unknown>;
      };
      if (typeof session.supportedCommands !== "function") {
        return [];
      }
      const commandsRaw = await session.supportedCommands();
      if (typeof session.return === "function") {
        try {
          await session.return(undefined);
        } catch {
          // ignore
        }
      }
      const commands = Array.isArray(commandsRaw) ? commandsRaw : [];
      this.commandInfoCache.set(cacheKey, {
        commands,
        expiresAt: Date.now() + this.commandInfoTtlMs,
      });
      return commands;
    } catch {
      return [];
    }
  }

  private async fetchAndCacheModels(
    settingSources: string[],
  ): Promise<void> {
    try {
      const models = await this.readSupportedModelsFromSdk({
        settingSources: settingSources as Array<"user" | "project" | "local">,
      });
      setCachedModels(
        settingSources,
        models.map((m) => ({
          value: m.value,
          supportsEffort: m.supportsEffort,
          supportedEffortLevels: m.supportedEffortLevels,
        })),
      );
    } catch {
      // Silently ignore, will retry on next request
    }
  }

  private createAbortController(signal: AbortSignal): AbortController {
    const controller = new AbortController();
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller;
    }

    const onAbort = () => {
      controller.abort(signal.reason);
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort);
    return controller;
  }

}
