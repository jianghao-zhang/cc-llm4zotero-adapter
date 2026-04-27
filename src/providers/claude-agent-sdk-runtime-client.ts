import type { Query, PermissionMode, SDKUserMessage, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ClaudeCodeRuntimeClient, McpServerStatus, ProviderEvent, RuntimeTurnRequest, RuntimeTurnStream } from "../runtime.js";
import { mapSdkMessageToProviderEvents } from "../event-mapper/map-sdk-message.js";
import { globalPermissionStore } from "../permissions/permission-store.js";
import type { PermissionResult } from "../permissions/permission-store.js";
import { getCachedModels, normalizeProviderModelName, resolveModelAlias, resolveModelWithCache, setCachedModels } from "./model-resolver.js";
import { createHotRuntimeTurn, HotRuntimePool, type HotRuntimeEntry, type HotRuntimeTurn } from "./hotRuntimePool.js";

type QueryFunction = (args: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Record<string, unknown>;
}) => Query;

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

type QueryWithMcpStatus = Query & {
  mcpServerStatus?: () => Promise<unknown>;
};

type RuntimeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
type EffortCapabilitySource = "sdk_explicit" | "heuristic" | "unknown";

type EffortCapabilityInfo = {
  efforts: string[];
  source: EffortCapabilitySource;
};

type EffortSuccessRecord = {
  effort: RuntimeEffortLevel;
  updatedAt: number;
};

type ClaudeSettingsShape = {
  model?: unknown;
  availableModels?: unknown;
  modelOverrides?: unknown;
};

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
  history?: unknown;
  activeNoteContext?: unknown;
};

type CompactTurnOptions = {
  metadata: Record<string, unknown>;
  autoCompactNeeded: boolean;
};

const RUNTIME_EFFORT_DESCENDING: RuntimeEffortLevel[] = ["max", "xhigh", "high", "medium", "low"];
const RUNTIME_EFFORT_ASCENDING: RuntimeEffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
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
  "model",
  "effort",
]);
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

function normalizeModelName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\u001b\[[0-9;]*m/g, "").replace(/\[[0-9;]*m\]?/g, "").trim();
}
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
function redactMcpConfig(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const redacted: Record<string, unknown> = { ...record };
  const headers = asRecord(redacted.headers);
  if (headers) {
    redacted.headers = Object.fromEntries(
      Object.entries(headers).map(([key, headerValue]) => [
        key,
        /authorization|api[-_]?key|token|secret|password/i.test(key) ? "[redacted]" : headerValue,
      ]),
    );
  }
  return redacted;
}
function toRuntimeRequest(request: RuntimeTurnRequest, metadata: Record<string, unknown>): RuntimeRequestShape | undefined {
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
function resolveImageMediaType(
  attachment: RuntimeAttachment,
): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | null {
  const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim().toLowerCase() : "";
  if (mimeType && IMAGE_MIME_FROM_TYPE[mimeType]) return IMAGE_MIME_FROM_TYPE[mimeType];
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
      // ignore
    }
  }
  return payloads;
}
function collectAttachmentPaths(runtimeRequest: RuntimeRequestShape | undefined): string[] {
  if (!runtimeRequest || !Array.isArray(runtimeRequest.attachments)) return [];
  const paths: string[] = [];
  for (const raw of runtimeRequest.attachments) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const attachmentId = typeof entry.id === "string" ? entry.id.trim() : "";
    if (attachmentId.startsWith("pdf-paper-") || attachmentId.startsWith("pdf-page-")) continue;
    const category = trimInline(entry.category, 24).toLowerCase();
    if (category === "image") continue;
    const storedPath = typeof entry.storedPath === "string" ? entry.storedPath.trim() : "";
    if (!storedPath || !storedPath.startsWith("/")) continue;
    const name = trimInline(entry.name, 120);
    const mimeType = trimInline(entry.mimeType, 80);
    const meta = [category, mimeType].filter(Boolean).join(", ");
    const suffix = meta ? ` (${meta})` : "";
    paths.push(`${name || "attachment"}: ${storedPath}${suffix}`);
  }
  return paths;
}
type RuntimePaperPathEntry = {
  title: string;
  contextItemId?: number;
  canonicalTextPath?: string;
  contextFilePath?: string;
  mineruFullMdPath?: string;
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
    const contextItemId = typeof record.contextItemId === "number" && Number.isFinite(record.contextItemId)
      ? Math.floor(record.contextItemId)
      : undefined;
    const contextFilePath = asPath(record.contextFilePath);
    const mineruFullMdPath = asPath(record.mineruFullMdPath);
    const canonicalTextPath = mineruFullMdPath || contextFilePath;
    if (!canonicalTextPath && !contextItemId) continue;
    collected.push({ title, contextItemId, canonicalTextPath, contextFilePath, mineruFullMdPath });
  }
  return collected;
}
function formatPaperPathLines(entries: RuntimePaperPathEntry[]): string[] {
  return entries.map((entry) => {
    const pathHints = [
      entry.canonicalTextPath ? `canonical text source: ${entry.canonicalTextPath}` : "",
      typeof entry.contextItemId === "number" ? `contextItemId=${entry.contextItemId}` : "",
    ].filter(Boolean);
    return `- ${entry.title}${pathHints.length ? ` [${pathHints.join(" | ")}]` : ""}`;
  });
}
function formatFallbackHistory(runtimeRequest: RuntimeRequestShape | undefined): string[] {
  if (!runtimeRequest || !Array.isArray(runtimeRequest.history)) return [];
  const entries = runtimeRequest.history
    .map((entry) => {
      const record = asRecord(entry);
      if (!record) return null;
      const roleRaw = typeof record.role === "string" ? record.role.trim().toLowerCase() : "";
      const role = roleRaw === "assistant" ? "assistant" : roleRaw === "user" ? "user" : "";
      const content = typeof record.content === "string" ? record.content.trim() : "";
      if (!role || !content) return null;
      return { role, content: content.length > 2000 ? `${content.slice(0, 1999).trimEnd()}...` : content };
    })
    .filter((entry): entry is { role: "assistant" | "user"; content: string } => Boolean(entry))
    .slice(-24);
  if (!entries.length) return [];
  return [
    "Local Zotero conversation history for continuity because the prior Claude session could not be resumed:",
    ...entries.map((entry, index) => `${index + 1}. ${entry.role}: ${entry.content}`),
    "Use this transcript only to restore conversation context for the current answer.",
  ];
}
function buildPromptText(
  userMessage: string,
  runtimeRequest: RuntimeRequestShape | undefined,
  metadata?: Record<string, unknown>,
): string {
  const trimmedUserMessage = userMessage.trim();
  if (/^\/compact(?:\s|$)/i.test(trimmedUserMessage)) return "/compact";
  if (trimmedUserMessage.startsWith("/")) return trimmedUserMessage;
  const lines: string[] = [trimmedUserMessage];
  if (!runtimeRequest) return lines.join("\n\n");
  if (metadata?.claudeResumeFallbackHistory === true) {
    lines.push(...formatFallbackHistory(runtimeRequest));
  }
  const selectedTexts = Array.isArray(runtimeRequest.selectedTexts)
    ? runtimeRequest.selectedTexts.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean)
    : [];
  if (selectedTexts.length) {
    lines.push("Selected snippets:", ...selectedTexts.map((text, index) => `${index + 1}. ${text}`));
  }
  const selectedPaperPathEntries = collectPaperPathEntries(runtimeRequest.selectedPaperContexts ?? runtimeRequest.paperContexts, 8);
  const fullTextPaperPathEntries = collectPaperPathEntries(runtimeRequest.fullTextPaperContexts, 6);
  const pinnedPaperPathEntries = collectPaperPathEntries(runtimeRequest.pinnedPaperContexts, 4);
  const attachmentPaths = collectAttachmentPaths(runtimeRequest);
  if (selectedPaperPathEntries.length) {
    lines.push("Selected papers for this turn:", ...formatPaperPathLines(selectedPaperPathEntries), "Use them as available paper context for this answer.");
  }
  if (fullTextPaperPathEntries.length) {
    lines.push("Papers marked for full-text reading on this turn:", ...formatPaperPathLines(fullTextPaperPathEntries), "Treat these as the highest-priority paper reading targets before answering.");
  }
  if (pinnedPaperPathEntries.length) {
    lines.push("Pinned papers:", ...formatPaperPathLines(pinnedPaperPathEntries), "Keep them available as persistent context, but do not treat them as mandatory full-text reads unless they also appear in the full-text group above.");
  }
  if (attachmentPaths.length) {
    lines.push("Attachments:", ...attachmentPaths.map((path) => `- ${path}`));
  }
  const activeNote = asRecord(runtimeRequest.activeNoteContext);
  if (activeNote) {
    const noteTitle = typeof activeNote.title === "string" ? activeNote.title.trim() : "";
    const noteText = typeof activeNote.noteText === "string" ? activeNote.noteText.trim() : "";
    if (noteTitle || noteText) {
      lines.push("Active note context:", noteTitle ? `- Title: ${noteTitle}` : "- Title: (untitled)", noteText ? `- Content:\n${noteText}` : "");
    }
  }
  return lines.filter(Boolean).join("\n\n");
}
async function buildPromptInput(request: RuntimeTurnRequest, metadata: Record<string, unknown>): Promise<string | AsyncIterable<SDKUserMessage>> {
  const runtimeRequest = toRuntimeRequest(request, metadata);
  const promptText = buildPromptText(request.userMessage, runtimeRequest, metadata);
  const screenshotPayloads = Array.isArray(runtimeRequest?.screenshots)
    ? runtimeRequest!.screenshots.map((entry) => parseImageDataUrl(entry)).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)).slice(0, 8)
    : [];
  const attachmentImagePayloads = await loadAttachmentImagePayloads(runtimeRequest, Math.max(0, 8 - screenshotPayloads.length));
  const imagePayloads = [...screenshotPayloads, ...attachmentImagePayloads].slice(0, 8);
  if (!imagePayloads.length) return promptText;
  const userEvent: SDKUserMessage = {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        { type: "text", text: promptText },
        ...imagePayloads.map((entry) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: entry.mediaType, data: entry.data },
        })),
      ],
    },
  };
  return (async function* () { yield userEvent; })();
}
function parseMetadata(metadata: RuntimeTurnRequest["metadata"], options: Pick<ClaudeAgentSdkRuntimeClientOptions, "blockedMetadataKeys">): Record<string, unknown> {
  if (!metadata) return {};
  const blockedKeys = new Set<string>([...DEFAULT_BLOCKED_METADATA_KEYS, ...(options.blockedMetadataKeys ?? [])]);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!blockedKeys.has(key)) result[key] = value;
  }
  return result;
}
function parseSettingSourcesOverride(metadata: Record<string, unknown>): SettingSource[] | undefined {
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
function parsePermissionModeOverride(metadata: Record<string, unknown>): PermissionMode | undefined {
  const raw = metadata.permissionMode;
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "yolo") return "bypassPermissions";
  if (normalized === "safe") return "default";
  if (normalized === "default" || normalized === "acceptedits" || normalized === "bypasspermissions" || normalized === "plan" || normalized === "dontask") {
    if (normalized === "acceptedits") return "acceptEdits";
    if (normalized === "bypasspermissions") return "bypassPermissions";
    if (normalized === "dontask") return "dontAsk";
    return normalized as PermissionMode;
  }
  return undefined;
}
function parseCustomInstruction(metadata: Record<string, unknown>): string {
  return typeof metadata.customInstruction === "string" ? metadata.customInstruction.trim() : "";
}
const BLOCKED_ALLOWED_TOOLS = new Set<string>(["AskUserQuestion"]);

function mergeAllowedTools(requestAllowedTools: string[] | undefined, defaultAllowedTools: string[] | undefined): string[] | undefined {
  const merged = new Set<string>();
  for (const tool of defaultAllowedTools ?? []) {
    const normalized = tool.trim();
    if (normalized && !BLOCKED_ALLOWED_TOOLS.has(normalized)) merged.add(normalized);
  }
  for (const tool of requestAllowedTools ?? []) {
    const normalized = tool.trim();
    if (normalized && !BLOCKED_ALLOWED_TOOLS.has(normalized)) merged.add(normalized);
  }
  return merged.size > 0 ? Array.from(merged) : undefined;
}
function isRuntimeEffortLevel(value: unknown): value is RuntimeEffortLevel {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}
function effortRank(effort: RuntimeEffortLevel): number {
  return RUNTIME_EFFORT_ASCENDING.indexOf(effort);
}
function isHigherEffort(left: RuntimeEffortLevel, right: RuntimeEffortLevel): boolean {
  return effortRank(left) > effortRank(right);
}
function normalizeSupportedEfforts(efforts: string[]): string[] {
  return Array.from(new Set(efforts.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry === "default" || isRuntimeEffortLevel(entry))));
}
function nearestSupportedEffort(
  requestedEffort: RuntimeEffortLevel,
  supportedEfforts: string[],
): RuntimeEffortLevel | undefined {
  const supportedEffortSet = new Set(supportedEfforts.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  if (supportedEffortSet.has(requestedEffort)) return requestedEffort;
  const requestedIndex = RUNTIME_EFFORT_DESCENDING.indexOf(requestedEffort);
  if (requestedIndex === -1) return undefined;
  for (let i = requestedIndex + 1; i < RUNTIME_EFFORT_DESCENDING.length; i += 1) {
    const candidate = RUNTIME_EFFORT_DESCENDING[i];
    if (supportedEffortSet.has(candidate)) return candidate;
  }
  return undefined;
}
function fallbackEffortAfterFailedInit(
  failedEffort: RuntimeEffortLevel,
  supportedEfforts: string[],
): RuntimeEffortLevel | undefined {
  if (failedEffort !== "xhigh" && failedEffort !== "max") return undefined;
  const supportedEffortSet = new Set(supportedEfforts.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  for (const candidate of ["high", "medium", "low"] as RuntimeEffortLevel[]) {
    if (supportedEffortSet.has(candidate)) return candidate;
  }
  return undefined;
}
function makeEffortSuccessKey(providerKey: string, modelName: string | undefined): string {
  const normalizedModel = normalizeProviderModelName(modelName || "default") || "default";
  return `${providerKey || "default"}::${normalizedModel}`;
}
function formatEffortLabel(effort: RuntimeEffortLevel | "default"): string {
  if (effort === "xhigh") return "XHigh";
  if (effort === "max") return "Max";
  if (effort === "high") return "High";
  if (effort === "medium") return "Medium";
  if (effort === "low") return "Low";
  return "Default";
}
function toStableStringList(value: unknown, sort = false): string[] | null {
  if (!Array.isArray(value)) return null;
  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  if (!normalized.length) return null;
  if (sort) normalized.sort();
  return normalized;
}
function shouldAutoCompact(
  metadata: Record<string, unknown>,
  usageSnapshot: { contextTokens: number; contextWindow?: number } | undefined,
): boolean {
  if (metadata.claudeAutoCompactEligible !== true) return false;
  const rawThreshold = Number(metadata.claudeAutoCompactThresholdPercent);
  if (!Number.isFinite(rawThreshold)) return false;
  const threshold = Math.max(0, Math.min(99, Math.round(rawThreshold)));
  const contextTokens = Math.max(0, Number(usageSnapshot?.contextTokens) || 0);
  if (threshold === 0) return contextTokens > 0;
  const contextWindow = Math.max(0, Number(usageSnapshot?.contextWindow) || 0);
  if (contextTokens <= 0 || contextWindow <= 0) return false;
  const percentage = Math.round((contextTokens / contextWindow) * 100);
  return percentage >= threshold;
}
async function buildSettingsStackIdentity(
  settingSources: SettingSource[],
  resolveSettingsPathBySource: (source: "user" | "project" | "local", cwdOverride?: string) => string | undefined,
  cwdOverride?: string,
): Promise<string | null> {
  const parts: string[] = [];
  for (const source of settingSources) {
    const path = resolveSettingsPathBySource(source, cwdOverride);
    if (!path) continue;
    try {
      const raw = await readFile(path, "utf8");
      parts.push(`${source}:${path}:${raw}`);
    } catch {
      parts.push(`${source}:${path}:missing`);
    }
  }
  if (!parts.length) return null;
  return createHash("sha256").update(parts.join("\n\n")).digest("hex");
}
function buildHotRuntimeSignature(
  queryOptions: Record<string, unknown>,
  metadata: Record<string, unknown>,
): string {
  const requestedModel =
    typeof queryOptions.requestedModel === "string" && queryOptions.requestedModel.trim()
      ? queryOptions.requestedModel.trim()
      : typeof queryOptions.model === "string" && queryOptions.model.trim()
        ? queryOptions.model.trim()
        : null;
  const requestedEffort =
    typeof queryOptions.requestedEffort === "string" && queryOptions.requestedEffort.trim()
      ? queryOptions.requestedEffort.trim()
      : null;
  return JSON.stringify({
    model: requestedModel,
    effort: requestedEffort,
    cwd: typeof queryOptions.cwd === "string" && queryOptions.cwd.trim() ? queryOptions.cwd : null,
    settingSources: toStableStringList(queryOptions.settingSources),
    permissionMode:
      typeof queryOptions.permissionMode === "string" && queryOptions.permissionMode.trim()
        ? queryOptions.permissionMode
        : null,
    appendSystemPrompt:
      typeof queryOptions.appendSystemPrompt === "string" && queryOptions.appendSystemPrompt.trim()
        ? queryOptions.appendSystemPrompt
        : null,
    allowedTools: toStableStringList(queryOptions.allowedTools, true),
    configSourceMode:
      typeof metadata.claudeConfigSource === "string" && metadata.claudeConfigSource.trim()
        ? metadata.claudeConfigSource.trim()
        : null,
  });
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

export class ClaudeAgentSdkRuntimeClient implements ClaudeCodeRuntimeClient {
  private readonly options: ClaudeAgentSdkRuntimeClientOptions;
  private modelInfoCache = new Map<string, { expiresAt: number; infos: ClaudeModelInfo[] }>();
  private commandInfoCache = new Map<string, { expiresAt: number; commands: ClaudeSlashCommandInfo[] }>();
  private effortSuccessCache = new Map<string, EffortSuccessRecord>();
  private readonly modelInfoTtlMs = 60_000;
  private readonly commandInfoTtlMs = 5 * 60_000;
  private readonly effortSuccessTtlMs = 5 * 60_000;
  private readonly hotRuntimePool = new HotRuntimePool({ graceMs: 5 * 60_000 });
  private readonly usageSnapshots = new Map<string, { contextTokens: number; contextWindow?: number }>();
  private readonly runtimeClientInstanceId = `runtime-client-${Math.random().toString(36).slice(2, 10)}`;
  private readonly hotRuntimePoolInstanceId = `hot-pool-${Math.random().toString(36).slice(2, 10)}`;

  private mergeUsageSnapshot(
    conversationKey: string,
    next: { contextTokens?: number; contextWindow?: number },
  ): { contextTokens: number; contextWindow?: number } {
    const previous = this.usageSnapshots.get(conversationKey);
    const contextTokens =
      typeof next.contextTokens === "number" && Number.isFinite(next.contextTokens)
        ? Math.max(0, next.contextTokens)
        : previous?.contextTokens ?? 0;
    const contextWindow =
      typeof next.contextWindow === "number" && Number.isFinite(next.contextWindow) && next.contextWindow > 0
        ? next.contextWindow
        : previous?.contextWindow;
    const merged = { contextTokens, contextWindow };
    this.usageSnapshots.set(conversationKey, merged);
    const liveEntry = this.hotRuntimePool.get(conversationKey);
    if (liveEntry) {
      liveEntry.lastUsageSnapshot = merged;
    }
    return merged;
  }

  constructor(options: ClaudeAgentSdkRuntimeClientOptions = {}) {
    this.options = options;
  }

  async retainHotRuntime(request: RuntimeTurnRequest, mountId: string): Promise<void> {
    const metadata = parseMetadata(request.metadata, this.options);
    const probeId = typeof metadata.retentionProbeId === "string" ? metadata.retentionProbeId : undefined;
    const entry = this.hotRuntimePool.retain(request.conversationKey, mountId);
    entry.lastUsageSnapshot = entry.lastUsageSnapshot;
    console.log("[RETENTION_PROBE]", JSON.stringify({
      stage: "runtime.retain_hot_runtime",
      probeId,
      conversationKey: request.conversationKey,
      mountId,
      runtimeClientInstanceId: this.runtimeClientInstanceId,
      hotRuntimePoolInstanceId: this.hotRuntimePoolInstanceId,
      mountCount: entry.mounts.size,
    }));
  }

  async warmHotRuntime(request: RuntimeTurnRequest): Promise<void> {
    const entry = this.hotRuntimePool.get(request.conversationKey);
    if (!entry || entry.mounts.size === 0 || entry.query || entry.bootstrapPromise) return;
    entry.bootstrapPromise = (async () => {
      try {
        await this.bootstrapHotRuntime(request, entry);
      } catch {
        // ignore bootstrap warmup failures
      } finally {
        if (entry.bootstrapPromise) {
          entry.bootstrapPromise = null;
        }
      }
    })();
    await entry.bootstrapPromise;
  }

  async releaseHotRuntime(conversationKey: string, mountId: string): Promise<void> {
    this.hotRuntimePool.release(conversationKey, mountId, (entry) => {
      void this.closeHotRuntime(entry);
    });
  }

  async invalidateHotRuntime(conversationKey: string): Promise<void> {
    const entry = this.hotRuntimePool.get(conversationKey);
    if (!entry) {
      this.usageSnapshots.delete(conversationKey);
      return;
    }
    await this.closeHotRuntime(entry);
    this.hotRuntimePool.delete(conversationKey);
    this.usageSnapshots.delete(conversationKey);
  }

  async invalidateAllHotRuntimes(): Promise<void> {
    const keys = Array.from(this.hotRuntimePool["entries"].keys()) as string[];
    for (const key of keys) {
      await this.invalidateHotRuntime(key);
    }
  }

  private createProfilingEvent(
    conversationKey: string,
    stage: string,
    payload?: Record<string, unknown>,
  ): ProviderEvent {
    return {
      type: "provider_event",
      payload: {
        providerType: "profiling",
        ts: Date.now(),
        payload: {
          stage,
          conversationKey,
          ...(payload || {}),
        },
      },
    };
  }

  async startTurn(request: RuntimeTurnRequest): Promise<RuntimeTurnStream> {
    const metadata = parseMetadata(request.metadata, this.options);
    const probeId = typeof metadata.retentionProbeId === "string" ? metadata.retentionProbeId : undefined;
    const hotEntry = this.hotRuntimePool.get(request.conversationKey);
    const forceFreshSession = metadata.forceFreshSession === true;
    const hotEntrySnapshot = hotEntry
      ? {
          hasHotEntry: true,
          mountCount: hotEntry.mounts.size,
          hasQuery: Boolean(hotEntry.query),
          hasProviderSessionId: Boolean(hotEntry.providerSessionId),
          hasConfigSignature: Boolean(hotEntry.configSignature),
          hasProviderIdentity: Boolean(hotEntry.providerIdentity),
          closeRequested: hotEntry.closeRequested,
          runtimeClientInstanceId: this.runtimeClientInstanceId,
          hotRuntimePoolInstanceId: this.hotRuntimePoolInstanceId,
          probeId,
        }
      : {
          hasHotEntry: false,
          mountCount: 0,
          hasQuery: false,
          hasProviderSessionId: false,
          hasConfigSignature: false,
          hasProviderIdentity: false,
          closeRequested: false,
          runtimeClientInstanceId: this.runtimeClientInstanceId,
          hotRuntimePoolInstanceId: this.hotRuntimePoolInstanceId,
          probeId,
        };
    const autoCompactNeeded =
      !/^\/compact(?:\s|$)/i.test(request.userMessage.trim()) &&
      shouldAutoCompact(
        metadata,
        this.usageSnapshots.get(request.conversationKey) ?? hotEntry?.lastUsageSnapshot,
      );
    const createProfilingEvent = this.createProfilingEvent.bind(this);
    if (forceFreshSession) {
      await this.invalidateHotRuntime(request.conversationKey);
      const stream = await this.startColdTurn({
        ...request,
        providerSessionId: undefined,
      }, { metadata, autoCompactNeeded });
      async function* withProfiling() {
        yield createProfilingEvent(request.conversationKey, "runtime.start_turn.force_fresh_cold", hotEntrySnapshot);
        for await (const event of stream.events) {
          yield event;
        }
      }
      return { ...stream, events: withProfiling() };
    }
    if (hotEntry && hotEntry.mounts.size > 0) {
      const stream = await this.startHotTurn(request, hotEntry, { metadata, autoCompactNeeded });
      async function* withProfiling() {
        yield createProfilingEvent(request.conversationKey, "runtime.start_turn.hot_entry_found", hotEntrySnapshot);
        for await (const event of stream.events) {
          yield event;
        }
      }
      return { ...stream, events: withProfiling() };
    }
    const stream = await this.startColdTurn(request, { metadata, autoCompactNeeded });
    async function* withProfiling() {
      yield createProfilingEvent(request.conversationKey, "runtime.start_turn.cold_entry", hotEntrySnapshot);
      for await (const event of stream.events) {
        yield event;
      }
    }
    return { ...stream, events: withProfiling() };
  }

  private async startHotTurn(
    request: RuntimeTurnRequest,
    entry: HotRuntimeEntry,
    options?: CompactTurnOptions,
  ): Promise<RuntimeTurnStream> {
    const metadata = parseMetadata(request.metadata, this.options);
    if (entry.bootstrapPromise) {
      await entry.bootstrapPromise;
    }
    const settingSourcesOverride = parseSettingSourcesOverride(metadata);
    const effectiveSettingSources = settingSourcesOverride ?? this.options.settingSources ?? ["user", "project", "local"];
    const effectiveCwd = this.resolveScopedCwd(request.metadata);
    const providerIdentity = await buildSettingsStackIdentity(
      effectiveSettingSources,
      this.resolveSettingsPathBySource.bind(this),
      effectiveCwd,
    );
    const resumeSessionId = request.providerSessionId || entry.providerSessionId;

    let queryOptions = await this.buildQueryOptions(
      request,
      metadata,
      resumeSessionId,
    );
    let signature = buildHotRuntimeSignature(queryOptions, metadata);
    const shouldRestartForConfigChange =
      Boolean(entry.query || entry.configSignature) && entry.configSignature !== signature;
    const shouldRestartForProviderChange =
      Boolean(providerIdentity && entry.providerIdentity && entry.providerIdentity !== providerIdentity);
    const shouldRestartForResumeChange =
      Boolean(entry.query && request.providerSessionId && entry.providerSessionId !== request.providerSessionId);
    const shouldRestartRuntime =
      shouldRestartForConfigChange || shouldRestartForProviderChange || shouldRestartForResumeChange;
    const restartReasons = [
      shouldRestartForConfigChange ? "config_signature" : "",
      shouldRestartForProviderChange ? "provider_identity" : "",
      shouldRestartForResumeChange ? "resume_session" : "",
    ].filter(Boolean);

    const hotDecisionEvent = this.createProfilingEvent(request.conversationKey,"runtime.start_hot_turn.decision", {
      mountCount: entry.mounts.size,
      hasExistingQuery: Boolean(entry.query),
      hasExistingProviderSessionId: Boolean(entry.providerSessionId),
      hasExistingConfigSignature: Boolean(entry.configSignature),
      hasExistingProviderIdentity: Boolean(entry.providerIdentity),
      shouldRestartForConfigChange,
      shouldRestartForProviderChange,
      shouldRestartForResumeChange,
      shouldRestartRuntime,
      restartReason: restartReasons.join(",") || null,
      droppedSession: false,
      resumeSessionId: resumeSessionId || null,
      configSignatureMatched: entry.configSignature === signature,
      providerIdentityMatched:
        !providerIdentity || !entry.providerIdentity || entry.providerIdentity === providerIdentity,
    });

    if (!entry.query || entry.configSignature !== signature || shouldRestartRuntime) {
      try {
        entry = await this.bootstrapHotRuntime(request, entry, {
          metadata,
          queryOptions,
          signature,
          providerIdentity,
          shouldRestartRuntime,
          shouldDropSession: false,
        });
      } catch (error) {
        const retryOptions = this.buildFailedInitEffortRetryOptions(queryOptions);
        if (!retryOptions) throw error;
        queryOptions = retryOptions;
        signature = buildHotRuntimeSignature(queryOptions, metadata);
        entry = await this.bootstrapHotRuntime(request, entry, {
          metadata,
          queryOptions,
          signature,
          providerIdentity,
          shouldRestartRuntime: true,
          shouldDropSession: false,
        });
      }
    }
    const runId = randomUUID();
    const turn = createHotRuntimeTurn(runId);
    entry.currentTurn = turn;
    const providerSessionId = request.providerSessionId || entry.providerSessionId;
    const shouldInjectCompact = options?.autoCompactNeeded === true;
    turn.awaitingAutoCompact = shouldInjectCompact || /^\/compact(?:\s|$)/i.test(request.userMessage.trim());
    turn.compactOnly = /^\/compact(?:\s|$)/i.test(request.userMessage.trim());
    const message = await this.buildHotUserMessage({
      ...request,
      userMessage: shouldInjectCompact ? "/compact" : request.userMessage,
      providerSessionId,
    });
    entry.currentTurnMessage = message;
    const pendingEarlyRuntimeError = entry.pendingEarlyRuntimeError;
    const pendingEarlyRuntimeQueryOptions = entry.pendingEarlyRuntimeQueryOptions;
    entry.pendingEarlyRuntimeError = undefined;
    entry.pendingEarlyRuntimeQueryOptions = undefined;
    if (pendingEarlyRuntimeError) {
      const retryOptions = this.buildFailedInitEffortRetryOptions(pendingEarlyRuntimeQueryOptions ?? queryOptions);
      if (retryOptions) {
        const retryNotice =
          typeof retryOptions.effortFallbackNotice === "string"
            ? retryOptions.effortFallbackNotice
            : "Claude effort failed before session initialization. Retrying with a lower effort.";
        turn.queueEvent({ type: "status", payload: { text: retryNotice } });
        try {
          entry = await this.restartHotRuntimeForEffortRetry(entry, metadata, retryOptions, turn, message);
        } catch (retryError) {
          turn.fail(retryError instanceof Error ? retryError : new Error(String(retryError)));
        }
      } else {
        turn.fail(pendingEarlyRuntimeError);
      }
    } else {
      entry.pushMessage(message);
    }
    async function* withHotDecision() {
      yield hotDecisionEvent;
      if (shouldRestartRuntime && providerSessionId) {
        yield {
          type: "status" as const,
          payload: {
            text: "Claude runtime changed. Rebuilding runtime and resuming the existing Claude session.",
          },
        };
      }
      for await (const event of turn.events) {
        yield event;
      }
    }
    return {
      runId,
      providerSessionId: entry.providerSessionId,
      events: withHotDecision(),
    };
  }

  private async bootstrapHotRuntime(
    request: RuntimeTurnRequest,
    entry: HotRuntimeEntry,
    seed?: {
      metadata?: Record<string, unknown>;
      queryOptions?: Record<string, unknown>;
      signature?: string;
      providerIdentity?: string | null;
      shouldRestartRuntime?: boolean;
      shouldDropSession?: boolean;
    },
  ): Promise<HotRuntimeEntry> {
    const metadata = seed?.metadata ?? parseMetadata(request.metadata, this.options);
    const settingSourcesOverride = parseSettingSourcesOverride(metadata);
    const effectiveSettingSources = settingSourcesOverride ?? this.options.settingSources ?? ["user", "project", "local"];
    const effectiveCwd = this.resolveScopedCwd(request.metadata);
    const providerIdentity = seed?.providerIdentity ?? await buildSettingsStackIdentity(
      effectiveSettingSources,
      this.resolveSettingsPathBySource.bind(this),
      effectiveCwd,
    );
    const resumeSessionId = request.providerSessionId || entry.providerSessionId;
    let queryOptions = seed?.queryOptions ?? await this.buildQueryOptions(
      request,
      metadata,
      resumeSessionId,
    );
    let signature = seed?.signature ?? buildHotRuntimeSignature(queryOptions, metadata);
    const shouldRestartForConfigChange =
      Boolean(entry.query || entry.configSignature) && entry.configSignature !== signature;
    const shouldRestartForProviderChange =
      Boolean(providerIdentity && entry.providerIdentity && entry.providerIdentity !== providerIdentity);
    const shouldRestartForResumeChange =
      Boolean(entry.query && request.providerSessionId && entry.providerSessionId !== request.providerSessionId);
    const shouldDropSession = seed?.shouldDropSession === true;
    const shouldRestartRuntime = seed?.shouldRestartRuntime ?? (
      shouldDropSession ||
      shouldRestartForConfigChange ||
      shouldRestartForProviderChange ||
      shouldRestartForResumeChange
    );

    if (shouldDropSession) {
      queryOptions = await this.buildQueryOptions(request, metadata, undefined);
      signature = buildHotRuntimeSignature(queryOptions, metadata);
    }

    if (entry.query || entry.configSignature || entry.providerSessionId || shouldRestartRuntime) {
      const preservedMounts = Array.from(entry.mounts);
      const preservedSessionId = shouldDropSession
        ? undefined
        : shouldRestartForResumeChange
          ? request.providerSessionId
          : entry.providerSessionId;
      await this.closeHotRuntime(entry);
      this.hotRuntimePool.delete(request.conversationKey);
      entry = this.hotRuntimePool.ensure(request.conversationKey);
      for (const mountId of preservedMounts) {
        entry.mounts.add(mountId);
      }
      entry.providerSessionId = shouldDropSession ? undefined : preservedSessionId ?? request.providerSessionId;
    } else if (request.providerSessionId && !entry.providerSessionId) {
      entry.providerSessionId = request.providerSessionId;
    }

    const query = this.options.queryImpl ?? (await this.loadQuery());
    const liveQuery = query({ prompt: entry.input, options: queryOptions });
    entry.query = liveQuery;
    entry.configSignature = signature;
    entry.providerIdentity = providerIdentity || undefined;
    void this.consumeHotRuntime(entry, metadata, queryOptions);
    return entry;
  }

  private async restartHotRuntimeForEffortRetry(
    entry: HotRuntimeEntry,
    metadata: Record<string, unknown>,
    retryOptions: Record<string, unknown>,
    turn: HotRuntimeTurn,
    message: SDKUserMessage,
  ): Promise<HotRuntimeEntry> {
    const conversationKey = entry.conversationKey;
    const preservedMounts = Array.from(entry.mounts);
    const preservedSessionId = entry.providerSessionId;
    const preservedUsageSnapshot = entry.lastUsageSnapshot;
    const preservedProviderIdentity = entry.providerIdentity;
    await this.closeHotRuntime(entry);
    this.hotRuntimePool.delete(conversationKey);
    const nextEntry = this.hotRuntimePool.ensure(conversationKey);
    for (const mountId of preservedMounts) {
      nextEntry.mounts.add(mountId);
    }
    nextEntry.providerSessionId = preservedSessionId;
    nextEntry.lastUsageSnapshot = preservedUsageSnapshot;
    nextEntry.currentTurn = turn;
    nextEntry.currentTurnMessage = message;
    const retryQuery = this.options.queryImpl ?? (await this.loadQuery());
    const liveQuery = retryQuery({ prompt: nextEntry.input, options: retryOptions });
    nextEntry.query = liveQuery;
    nextEntry.configSignature = buildHotRuntimeSignature(retryOptions, metadata);
    nextEntry.providerIdentity = preservedProviderIdentity;
    void this.consumeHotRuntime(nextEntry, metadata, retryOptions);
    nextEntry.pushMessage(message);
    return nextEntry;
  }

  private async consumeHotRuntime(
    entry: HotRuntimeEntry,
    metadata: Record<string, unknown>,
    queryOptions: Record<string, unknown>,
  ): Promise<void> {
    const query = entry.query;
    if (!query) return;
    const supportedEfforts = Array.isArray((queryOptions as Record<string, unknown>).supportedEfforts)
      ? ((queryOptions as Record<string, unknown>).supportedEfforts as string[])
      : ["default", "low", "medium", "high", "xhigh"];
    const effortFallbackNotice =
      typeof (queryOptions as Record<string, unknown>).effortFallbackNotice === "string"
        ? String((queryOptions as Record<string, unknown>).effortFallbackNotice)
        : undefined;
    let sawSdkInit = false;
    let sawModelOutput = false;
    try {
      for await (const raw of query) {
        const currentTurn = entry.currentTurn;
        if (!currentTurn) continue;
        const mapped = mapSdkMessageToProviderEvents(raw);
        for (const event of mapped) {
          if (event.type === "provider_event") {
            const payload = event.payload as Record<string, unknown>;
            const providerType = payload.providerType;
            const nested = payload.payload as Record<string, unknown> | undefined;
            if (providerType === "runtime_config") {
              continue;
            }
            if (providerType === "system" && nested?.subtype === "init") {
              sawSdkInit = true;
              const sessionId =
                (typeof nested.session_id === "string" && nested.session_id) ||
                (typeof nested.sessionId === "string" && nested.sessionId) ||
                undefined;
              if (sessionId) {
                entry.providerSessionId = sessionId;
                currentTurn.sessionId = sessionId;
              }
              currentTurn.queueEvent({
                type: "provider_event",
                payload: {
                  providerType: "runtime_config",
                  sessionId: entry.providerSessionId,
                  ts: Date.now(),
                  payload: {
                    requestedModel: (queryOptions as Record<string, unknown>).requestedModel ?? null,
                    requestedEffort: (queryOptions as Record<string, unknown>).requestedEffort ?? null,
                    resolvedEffort: queryOptions.effort ?? null,
                    supportedEfforts,
                    effortCapabilitySource: queryOptions.effortCapabilitySource ?? null,
                    effortResolutionSource: queryOptions.effortResolutionSource ?? null,
                    effortRetryFrom: queryOptions.effortRetryFrom ?? null,
                    effortFallbackNotice: effortFallbackNotice ?? null,
                    resolvedPermissionMode: queryOptions.permissionMode ?? null,
                    settingSources: queryOptions.settingSources ?? null,
                    configSourceMode: metadata.claudeConfigSource ?? null,
                    cwd: queryOptions.cwd ?? null,
                  },
                },
              });
              if (effortFallbackNotice) {
                currentTurn.queueEvent({ type: "status", payload: { text: effortFallbackNotice } });
              }
            }
          }
          if (event.type === "usage") {
            const payload = event.payload as Record<string, unknown>;
            const nextContextTokens = Number(payload.contextTokens);
            const nextContextWindow = Number(payload.contextWindow);
            const merged = this.mergeUsageSnapshot(entry.conversationKey, {
              contextTokens: Number.isFinite(nextContextTokens) && nextContextTokens > 0
                ? Math.max(0, nextContextTokens)
                : undefined,
              contextWindow:
                Number.isFinite(nextContextWindow) && nextContextWindow > 0
                  ? nextContextWindow
                  : undefined,
            });
            entry.lastUsageSnapshot = merged;
          }
          if (currentTurn.awaitingAutoCompact) {
            if (event.type === "context_compacted") {
              currentTurn.queueEvent({
                type: "context_compacted",
                payload: { automatic: true },
              });
              continue;
            }
            if (event.type === "final") {
              currentTurn.awaitingAutoCompact = false;
              if (currentTurn.compactOnly) {
                currentTurn.finish();
                entry.currentTurn = null;
                entry.currentTurnMessage = undefined;
                this.hotRuntimePool.scheduleCloseIfIdle(entry, (expired) => {
                  void this.closeHotRuntime(expired);
                });
              }
              continue;
            }
            continue;
          }
          if (event.type === "message_delta") {
            sawModelOutput = true;
            const payload = event.payload as Record<string, unknown>;
            if (typeof payload.delta === "string") {
              currentTurn.finalText += payload.delta;
            }
          }
          if (event.type === "tool_call" || event.type === "final") {
            sawModelOutput = true;
          }
          currentTurn.queueEvent(event);
          if (event.type === "final") {
            this.rememberEffortSuccess(queryOptions);
            const payload = event.payload as Record<string, unknown>;
            if (typeof payload.output === "string" && payload.output) {
              currentTurn.finalText = payload.output;
            }
            currentTurn.finish();
            entry.currentTurn = null;
            entry.currentTurnMessage = undefined;
            this.hotRuntimePool.scheduleCloseIfIdle(entry, (expired) => {
              void this.closeHotRuntime(expired);
            });
          }
        }
      }
    } catch (error) {
      const retryOptions = !sawSdkInit && !sawModelOutput
        ? this.buildFailedInitEffortRetryOptions(queryOptions)
        : undefined;
      if (retryOptions && entry.currentTurn && entry.currentTurnMessage) {
        const preservedTurn = entry.currentTurn;
        const preservedMessage = entry.currentTurnMessage;
        const retryNotice =
          typeof retryOptions.effortFallbackNotice === "string"
            ? retryOptions.effortFallbackNotice
            : "Claude effort failed before session initialization. Retrying with a lower effort.";
        preservedTurn.queueEvent({ type: "status", payload: { text: retryNotice } });
        try {
          await this.restartHotRuntimeForEffortRetry(entry, metadata, retryOptions, preservedTurn, preservedMessage);
          return;
        } catch (retryError) {
          preservedTurn.fail(retryError instanceof Error ? retryError : new Error(String(retryError)));
          const liveEntry = this.hotRuntimePool.get(entry.conversationKey);
          if (liveEntry) {
            liveEntry.currentTurn = null;
            liveEntry.currentTurnMessage = undefined;
          }
          return;
        }
      }
      if (!entry.currentTurn) {
        entry.pendingEarlyRuntimeError = error instanceof Error ? error : new Error(String(error));
        entry.pendingEarlyRuntimeQueryOptions = queryOptions;
        return;
      }
      if (entry.currentTurn) {
        entry.currentTurn.fail(error instanceof Error ? error : new Error(String(error)));
        entry.currentTurn = null;
        entry.currentTurnMessage = undefined;
      }
    }
  }

  async mapSdkMessageToProviderEvents(raw: unknown): Promise<ProviderEvent[]> {
    return mapSdkMessageToProviderEvents(raw);
  }

  async buildHotUserMessage(request: RuntimeTurnRequest): Promise<SDKUserMessage> {
    const metadata = parseMetadata(request.metadata, this.options);
    const runtimeRequest = toRuntimeRequest(request, metadata);
    const promptText = buildPromptText(request.userMessage, runtimeRequest, metadata);
    const screenshotPayloads = Array.isArray(runtimeRequest?.screenshots)
      ? runtimeRequest!.screenshots.map((entry) => parseImageDataUrl(entry)).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)).slice(0, 8)
      : [];
    const attachmentImagePayloads = await loadAttachmentImagePayloads(runtimeRequest, Math.max(0, 8 - screenshotPayloads.length));
    const imagePayloads = [...screenshotPayloads, ...attachmentImagePayloads].slice(0, 8);
    if (!imagePayloads.length) {
      return {
        type: "user",
        parent_tool_use_id: null,
        session_id: request.providerSessionId,
        message: { role: "user", content: promptText },
      };
    }
    return {
      type: "user",
      parent_tool_use_id: null,
      session_id: request.providerSessionId,
      message: {
        role: "user",
        content: [
          { type: "text", text: promptText },
          ...imagePayloads.map((entry) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: entry.mediaType, data: entry.data },
          })),
        ],
      },
    };
  }

  private async startColdTurn(
    request: RuntimeTurnRequest,
    options?: CompactTurnOptions,
  ): Promise<RuntimeTurnStream> {
    const query = this.options.queryImpl ?? (await this.loadQuery());
    const metadata = options?.metadata ?? parseMetadata(request.metadata, this.options);
    const shouldInjectCompact = options?.autoCompactNeeded === true;
    const effectiveUserMessage = shouldInjectCompact ? "/compact" : request.userMessage;
    const effectiveRequest = shouldInjectCompact
      ? { ...request, userMessage: effectiveUserMessage }
      : request;
    const queryOptions = await this.buildQueryOptions(effectiveRequest, metadata, request.providerSessionId);
    const prompt: string | AsyncIterable<SDKUserMessage> = await buildPromptInput(effectiveRequest, metadata);
    const sdkStream = query({ prompt, options: queryOptions });
    return {
      runId: randomUUID(),
      providerSessionId: request.providerSessionId,
      events: this.createColdProviderEventStream(
        sdkStream,
        async (nextQueryOptions) => {
          const nextPrompt = await buildPromptInput(effectiveRequest, metadata);
          return query({ prompt: nextPrompt, options: nextQueryOptions });
        },
        request,
        metadata,
        queryOptions,
        shouldInjectCompact || /^\/compact(?:\s|$)/i.test(request.userMessage.trim()),
      ),
    };
  }


  private createColdProviderEventStream(
    initialSdkStream: Query,
    createSdkStream: (queryOptions: Record<string, unknown>) => Promise<Query> | Query,
    request: RuntimeTurnRequest,
    metadata: Record<string, unknown>,
    initialQueryOptions: Record<string, unknown>,
    awaitingAutoCompact = false,
  ): AsyncIterable<ProviderEvent> {
    const usageSnapshots = this.usageSnapshots;
    const hotRuntimePool = this.hotRuntimePool;
    const rememberEffortSuccess = this.rememberEffortSuccess.bind(this);
    const buildFailedInitEffortRetryOptions = this.buildFailedInitEffortRetryOptions.bind(this);
    return (async function* () {
      let queryOptions = initialQueryOptions;
      let nextSdkStream: Query | undefined = initialSdkStream;
      for (;;) {
        let sdkStream: Query | undefined = nextSdkStream;
        nextSdkStream = undefined;
        let sawSdkInit = false;
        let sawModelOutput = false;
        const supportedEfforts = Array.isArray((queryOptions as Record<string, unknown>).supportedEfforts)
          ? ((queryOptions as Record<string, unknown>).supportedEfforts as string[])
          : ["default", "low", "medium", "high", "xhigh", "max"];
        const effortFallbackNotice =
          typeof (queryOptions as Record<string, unknown>).effortFallbackNotice === "string"
            ? String((queryOptions as Record<string, unknown>).effortFallbackNotice)
            : undefined;
        yield {
          type: "provider_event",
          payload: {
            providerType: "runtime_config",
            sessionId: request.providerSessionId,
            ts: Date.now(),
            payload: {
              requestedModel: (queryOptions as Record<string, unknown>).requestedModel ?? null,
              requestedEffort: (queryOptions as Record<string, unknown>).requestedEffort ?? null,
              resolvedEffort: queryOptions.effort ?? null,
              supportedEfforts,
              effortCapabilitySource: queryOptions.effortCapabilitySource ?? null,
              effortResolutionSource: queryOptions.effortResolutionSource ?? null,
              effortRetryFrom: queryOptions.effortRetryFrom ?? null,
              effortFallbackNotice: effortFallbackNotice ?? null,
              resolvedPermissionMode: queryOptions.permissionMode ?? null,
              settingSources: queryOptions.settingSources ?? null,
              configSourceMode: metadata.claudeConfigSource ?? null,
              cwd: queryOptions.cwd ?? null,
            },
          },
        };
        if (effortFallbackNotice) {
          yield { type: "status", payload: { text: effortFallbackNotice } };
        }
        try {
          sdkStream = sdkStream ?? await createSdkStream(queryOptions);
          for await (const raw of sdkStream) {
            const mapped = mapSdkMessageToProviderEvents(raw);
            for (const event of mapped) {
              if (event.type === "provider_event") {
                const payload = event.payload as Record<string, unknown>;
                const providerType = payload.providerType;
                const nested = payload.payload as Record<string, unknown> | undefined;
                if (providerType === "system" && nested?.subtype === "init") {
                  sawSdkInit = true;
                }
              }
              if (event.type === "message_delta" || event.type === "tool_call" || event.type === "final") {
                sawModelOutput = true;
              }
              if (event.type === "usage") {
                const payload = event.payload as Record<string, unknown>;
                const nextContextTokens = Number(payload.contextTokens);
                const nextContextWindow = Number(payload.contextWindow);
                const previous = usageSnapshots.get(request.conversationKey);
                const merged = {
                  contextTokens:
                    Number.isFinite(nextContextTokens) && nextContextTokens > 0
                      ? Math.max(0, nextContextTokens)
                      : previous?.contextTokens ?? 0,
                  contextWindow:
                    Number.isFinite(nextContextWindow) && nextContextWindow > 0
                      ? nextContextWindow
                      : previous?.contextWindow,
                };
                usageSnapshots.set(request.conversationKey, merged);
                const liveEntry = hotRuntimePool.get(request.conversationKey);
                if (liveEntry) {
                  liveEntry.lastUsageSnapshot = merged;
                }
              }
              if (awaitingAutoCompact) {
                if (event.type === "context_compacted") {
                  yield {
                    type: "context_compacted",
                    payload: { automatic: true },
                  };
                  continue;
                }
                if (event.type === "final") {
                  awaitingAutoCompact = false;
                  rememberEffortSuccess(queryOptions);
                  continue;
                }
                continue;
              }
              if (event.type === "final") {
                rememberEffortSuccess(queryOptions);
              }
              yield event;
            }
          }
          return;
        } catch (error) {
          const retryOptions = !sawSdkInit && !sawModelOutput
            ? buildFailedInitEffortRetryOptions(queryOptions)
            : undefined;
          if (retryOptions) {
            try { sdkStream?.close(); } catch {}
            queryOptions = retryOptions;
            continue;
          }
          throw error;
        } finally {
          try { sdkStream?.close(); } catch {}
        }
      }
    })();
  }

  async listModels(options?: { settingSources?: Array<"user" | "project" | "local">; providerKey?: string }): Promise<string[]> {
    const sdkInfos = await this.readSupportedModelsFromSdk(options);
    const requestedSources = options?.settingSources;
    const settingSources = Array.isArray(requestedSources) && requestedSources.length > 0 ? requestedSources : this.options.settingSources ?? ["user", "project", "local"];
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

  async listCommands(options?: { settingSources?: Array<"user" | "project" | "local">; providerKey?: string }): Promise<Array<{ name: string; description: string; argumentHint: string }>> {
    const infos = await this.readSupportedCommandsFromSdk(options);
    return infos
      .map((entry) => ({ name: (entry.name || "").trim().replace(/^\/+/, ""), description: (entry.description || "").trim(), argumentHint: (entry.argumentHint || "").trim() }))
      .filter((entry) => entry.name.length > 0);
  }

  async listEfforts(options?: { model?: string; settingSources?: Array<"user" | "project" | "local">; providerKey?: string }): Promise<string[]> {
    return (await this.listEffortCapabilities(options)).efforts;
  }

  private async listEffortCapabilities(options?: { model?: string; settingSources?: Array<"user" | "project" | "local">; providerKey?: string }): Promise<EffortCapabilityInfo> {
    const sdkInfos = await this.readSupportedModelsFromSdk({ settingSources: options?.settingSources, providerKey: options?.providerKey });
    const model = normalizeProviderModelName(options?.model);
    const base = ["default", "low", "medium", "high"] as string[];
    if (model) {
      const matched = sdkInfos.find((info) => {
        const value = normalizeProviderModelName(info.value);
        return value === model;
      });
      if (matched?.supportsEffort && Array.isArray(matched.supportedEffortLevels)) {
        const efforts = normalizeSupportedEfforts(["default", ...matched.supportedEffortLevels]);
        return { efforts: efforts.length > 0 ? efforts : base, source: "sdk_explicit" };
      }
    }
    if (/(?:^|[._-])max(?:$|[._-])/.test(model) || /opus[\s._-]*4[\s._-]*6/.test(model) || /claude-opus-4-6/.test(model)) {
      return { efforts: [...base, "xhigh", "max"], source: "heuristic" };
    }
    return { efforts: [...base, "xhigh", "max"], source: "unknown" };
  }

  private resolveEffortFromCapabilities(input: {
    requestedEffort: RuntimeEffortLevel | undefined;
    capabilityInfo: EffortCapabilityInfo;
    effortSuccessKey: string;
  }): {
    resolvedEffort: RuntimeEffortLevel | undefined;
    effortFallbackNotice?: string;
    effortResolutionSource: string;
  } {
    const { requestedEffort, capabilityInfo, effortSuccessKey } = input;
    if (!requestedEffort) {
      return { resolvedEffort: undefined, effortResolutionSource: "none" };
    }
    const remembered = this.effortSuccessCache.get(effortSuccessKey);
    if (remembered && Date.now() - remembered.updatedAt > this.effortSuccessTtlMs) {
      this.effortSuccessCache.delete(effortSuccessKey);
    } else if (remembered && isHigherEffort(requestedEffort, remembered.effort)) {
      return {
        resolvedEffort: remembered.effort,
        effortResolutionSource: "last_good",
        effortFallbackNotice: `${formatEffortLabel(requestedEffort)} recently failed for this provider/model. Using ${formatEffortLabel(remembered.effort)}.`,
      };
    }
    const resolvedEffort = nearestSupportedEffort(requestedEffort, capabilityInfo.efforts);
    if (!resolvedEffort) {
      return {
        resolvedEffort: undefined,
        effortResolutionSource: capabilityInfo.source,
        effortFallbackNotice: `${formatEffortLabel(requestedEffort)} is unavailable for this model. Using Default.`,
      };
    }
    if (requestedEffort !== resolvedEffort) {
      return {
        resolvedEffort,
        effortResolutionSource: capabilityInfo.source,
        effortFallbackNotice: `${formatEffortLabel(requestedEffort)} is unavailable for this model. Using ${formatEffortLabel(resolvedEffort)}.`,
      };
    }
    return { resolvedEffort, effortResolutionSource: capabilityInfo.source };
  }

  private buildFailedInitEffortRetryOptions(queryOptions: Record<string, unknown>): Record<string, unknown> | undefined {
    const currentEffort = queryOptions.effort;
    if (!isRuntimeEffortLevel(currentEffort)) return undefined;
    if (queryOptions.effortRetryFrom) return undefined;
    const supportedEfforts = Array.isArray(queryOptions.supportedEfforts)
      ? normalizeSupportedEfforts(queryOptions.supportedEfforts as string[])
      : ["default", "low", "medium", "high", "xhigh", "max"];
    const retryEffort = fallbackEffortAfterFailedInit(currentEffort, supportedEfforts);
    if (!retryEffort || retryEffort === currentEffort) return undefined;
    const requestedEffort = isRuntimeEffortLevel(queryOptions.requestedEffort)
      ? queryOptions.requestedEffort
      : currentEffort;
    return {
      ...queryOptions,
      requestedEffort,
      effort: retryEffort,
      effortRetryFrom: currentEffort,
      effortResolutionSource: "failed_init_retry",
      effortFallbackNotice: `${formatEffortLabel(requestedEffort)} failed before Claude session start. Retrying with ${formatEffortLabel(retryEffort)}.`,
    };
  }

  private rememberEffortSuccess(queryOptions: Record<string, unknown>): void {
    const effort = queryOptions.effort;
    const effortSuccessKey = typeof queryOptions.effortSuccessKey === "string" ? queryOptions.effortSuccessKey : "";
    if (!effortSuccessKey || !isRuntimeEffortLevel(effort)) return;
    this.effortSuccessCache.set(effortSuccessKey, { effort, updatedAt: Date.now() });
  }

  async listMcpServers(options?: { settingSources?: Array<"user" | "project" | "local"> }): Promise<McpServerStatus[]> {
    const requestedSources = options?.settingSources;
    const settingSources = Array.isArray(requestedSources) && requestedSources.length > 0 ? requestedSources : this.options.settingSources ?? ["user", "project", "local"];
    try {
      const query = this.options.queryImpl ?? (await this.loadQuery());
      const session = query({
        prompt: "",
        options: {
          cwd: this.options.cwd ? resolve(this.options.cwd) : process.cwd(),
          settingSources,
          permissionMode: this.options.permissionMode,
        },
      }) as QueryWithMcpStatus;
      if (typeof session.mcpServerStatus !== "function") {
        try { await session.return(undefined); } catch {}
        try { session.close(); } catch {}
        return [];
      }
      const statusesRaw = await session.mcpServerStatus();
      try { await session.return(undefined); } catch {}
      try { session.close(); } catch {}
      return Array.isArray(statusesRaw) ? statusesRaw.map((entry) => this.normalizeMcpServerStatus(entry)).filter((entry): entry is McpServerStatus => Boolean(entry)) : [];
    } catch {
      return [];
    }
  }

  private normalizeMcpServerStatus(value: unknown): McpServerStatus | null {
    const record = asRecord(value);
    if (!record || typeof record.name !== "string" || typeof record.status !== "string") return null;
    return {
      name: record.name,
      status: record.status,
      serverInfo: asRecord(record.serverInfo),
      error: typeof record.error === "string" ? record.error : undefined,
      config: redactMcpConfig(record.config),
      scope: typeof record.scope === "string" ? record.scope : undefined,
      tools: Array.isArray(record.tools)
        ? record.tools
            .map((tool) => {
              const toolRecord = asRecord(tool);
              if (!toolRecord || typeof toolRecord.name !== "string") return null;
              return {
                name: toolRecord.name,
                description: typeof toolRecord.description === "string" ? toolRecord.description : undefined,
                annotations: asRecord(toolRecord.annotations),
              };
            })
            .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))
        : undefined,
    };
  }

  private buildConfigSourcePrompt(effectiveSettingSources: SettingSource[], effectiveCwd: string | undefined, metadata: Record<string, unknown>): string {
    const configSourceMode = typeof metadata.claudeConfigSource === "string" ? String(metadata.claudeConfigSource).trim().toLowerCase() : "default";
    const configPathMap = {
      user: this.resolveSettingsPathBySource("user", effectiveCwd),
      project: this.resolveSettingsPathBySource("project", effectiveCwd),
      local: this.resolveSettingsPathBySource("local", effectiveCwd),
    };
    const pathLines = effectiveSettingSources.map((source) => {
      const path = configPathMap[source];
      if (!path) return "";
      if (source === "user") return `- user: ${path} (global defaults shared across Claude Code on this machine)`;
      if (source === "project") return `- project: ${path} (shared across all Claude runtimes launched by Zotero)`;
      return `- local: ${path} (current conversation window only)`;
    }).filter(Boolean);
    if (!pathLines.length) return "";
    return ["Claude config source for this Zotero conversation:", `- mode: ${configSourceMode || "default"}`, `- active setting sources: ${effectiveSettingSources.join(", ")}`, ...pathLines, "Treat these paths as the active Claude Code config stack for this run."].join("\n");
  }

  private async buildQueryOptions(request: RuntimeTurnRequest, metadata: Record<string, unknown>, providerSessionId: string | undefined): Promise<Record<string, unknown>> {
    const rawRequestMetadata = asRecord(request.metadata) ?? {};
    const shouldForwardFrontendModel = this.options.forwardFrontendModel === true;
    const requestedModelRaw = typeof rawRequestMetadata.model === "string" ? rawRequestMetadata.model.trim() : "";
    const requestedModel = shouldForwardFrontendModel && requestedModelRaw && requestedModelRaw.toLowerCase() !== "default" && requestedModelRaw.toLowerCase() !== "auto" ? requestedModelRaw : undefined;
    const requestedEffortRaw = typeof rawRequestMetadata.effort === "string" ? rawRequestMetadata.effort.trim().toLowerCase() : "";
    const requestedEffort = isRuntimeEffortLevel(requestedEffortRaw) ? requestedEffortRaw : undefined;
    const settingSourcesOverride = parseSettingSourcesOverride(metadata);
    const permissionModeOverride = parsePermissionModeOverride(metadata);
    const customInstruction = parseCustomInstruction(metadata);
    const effectiveCwd = this.resolveScopedCwd(request.metadata);
    const effectiveSettingSources = settingSourcesOverride ?? this.options.settingSources ?? ["user", "project", "local"];
    const providerKey =
      (await buildSettingsStackIdentity(
        effectiveSettingSources,
        this.resolveSettingsPathBySource.bind(this),
        effectiveCwd,
      )) ||
      (typeof metadata.claudeConfigSource === "string" && metadata.claudeConfigSource.trim()
        ? metadata.claudeConfigSource.trim()
        : "default");
    let resolvedModel: string | undefined;
    if (shouldForwardFrontendModel && requestedModelRaw && requestedModelRaw.toLowerCase() !== "default" && requestedModelRaw.toLowerCase() !== "auto") {
      const cachedResolution = resolveModelWithCache(
        requestedModelRaw,
        effectiveSettingSources,
        providerKey,
      );
      if (cachedResolution.model) {
        resolvedModel = normalizeProviderModelName(cachedResolution.model);
      } else {
        const modelInfos = await this.readSupportedModelsFromSdk({
          settingSources: effectiveSettingSources,
          providerKey,
        });
        const normalizedResolved = resolveModelAlias(
          requestedModelRaw,
          modelInfos,
        );
        if (normalizedResolved) {
          resolvedModel = normalizeProviderModelName(normalizedResolved);
        } else {
          const rawLower = normalizeProviderModelName(requestedModelRaw);
          if (rawLower === "opus" || rawLower === "sonnet" || rawLower === "haiku") {
            resolvedModel = rawLower;
          }
        }
      }
    }
    const modelForSdk = resolvedModel;
    const effortSuccessKey = makeEffortSuccessKey(providerKey, modelForSdk || requestedModel);
    const capabilityInfo = requestedEffort
      ? await this.listEffortCapabilities({ model: modelForSdk || requestedModel, settingSources: effectiveSettingSources, providerKey })
      : { efforts: ["default", "low", "medium", "high", "xhigh", "max"], source: "unknown" as const };
    const {
      resolvedEffort,
      effortFallbackNotice,
      effortResolutionSource,
    } = this.resolveEffortFromCapabilities({
      requestedEffort,
      capabilityInfo,
      effortSuccessKey,
    });
    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      sdkOptions: { signal: AbortSignal; title?: string; description?: string; displayName?: string; toolUseID: string; blockedPath?: string; decisionReason?: string },
    ): Promise<PermissionResult> => {
      const { promise } = globalPermissionStore.create(sdkOptions.toolUseID, toolName, input, {
        title: sdkOptions.title,
        description: sdkOptions.description,
        displayName: sdkOptions.displayName,
        blockedPath: sdkOptions.blockedPath,
        decisionReason: sdkOptions.decisionReason,
      });
      return promise;
    };
    return Object.fromEntries(
      Object.entries({
        ...metadata,
        model: modelForSdk,
        requestedModel,
        requestedEffort,
        supportedEfforts: capabilityInfo.efforts,
        effortCapabilitySource: capabilityInfo.source,
        effortResolutionSource,
        effortSuccessKey,
        effortFallbackNotice,
        effort: resolvedEffort,
        cwd: effectiveCwd,
        additionalDirectories: this.options.additionalDirectories,
        allowedTools: mergeAllowedTools(request.allowedTools, this.options.defaultAllowedTools),
        settingSources: effectiveSettingSources,
        permissionMode: permissionModeOverride ?? this.options.permissionMode,
        includePartialMessages: this.options.includePartialMessages,
        maxTurns: this.options.maxTurns,
        continue: this.options.continue,
        appendSystemPrompt: [
          this.options.appendSystemPrompt,
          customInstruction,
          this.options.appendSystemPrompt || customInstruction ? undefined : this.buildConfigSourcePrompt(effectiveSettingSources, effectiveCwd, metadata),
        ].filter((entry): entry is string => Boolean(entry && entry.trim())).join("\n\n") || undefined,
        resume: providerSessionId,
        abortController: request.signal ? this.createAbortController(request.signal) : undefined,
        canUseTool,
      }).filter(([, value]) => value !== undefined),
    );
  }

  private resolveScopedCwd(metadata: RuntimeTurnRequest["metadata"]): string | undefined {
    const baseCwd = this.options.cwd ? resolve(this.options.cwd) : undefined;
    if (!baseCwd) return undefined;
    const runtimeCwdRelative = metadata && typeof metadata.runtimeCwdRelative === "string" ? metadata.runtimeCwdRelative.trim() : "";
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

  private resolveSettingsPathBySource(source: "user" | "project" | "local", cwdOverride?: string): string | undefined {
    const homeDirRaw = (process.env.HOME || process.env.USERPROFILE || "").trim();
    const homeDir = homeDirRaw ? resolve(homeDirRaw) : undefined;
    const baseCwd = this.options.cwd ? resolve(this.options.cwd) : process.cwd();
    const effectiveCwd = cwdOverride ? resolve(cwdOverride) : baseCwd;
    if (source === "user") {
      if (!homeDir) return undefined;
      return resolve(homeDir, ".claude/settings.json");
    }
    if (source === "project") {
      return resolve(baseCwd, ".claude/settings.json");
    }
    return resolve(effectiveCwd, ".claude/settings.local.json");
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

  private collectModelsFromSettings(settings: ClaudeSettingsShape, unique: Set<string>): void {
    if (!settings || typeof settings !== "object") return;
    const defaultModel = normalizeModelName(settings.model);
    if (defaultModel) unique.add(defaultModel);
    if (Array.isArray(settings.availableModels)) {
      for (const entry of settings.availableModels) {
        const normalized = normalizeModelName(entry);
        if (normalized) unique.add(normalized);
      }
    }
    if (settings.modelOverrides && typeof settings.modelOverrides === "object" && !Array.isArray(settings.modelOverrides)) {
      for (const [key, value] of Object.entries(settings.modelOverrides as Record<string, unknown>)) {
        const normalizedKey = normalizeModelName(key);
        if (normalizedKey) unique.add(normalizedKey);
        const normalizedValue = normalizeModelName(value);
        if (normalizedValue) unique.add(normalizedValue);
      }
    }
  }

  private async loadQuery(): Promise<QueryFunction> {
    const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as { query: QueryFunction };
    if (typeof sdk.query !== "function") throw new Error("@anthropic-ai/claude-agent-sdk does not export query()");
    return sdk.query;
  }

  private async readSupportedModelsFromSdk(options?: { settingSources?: Array<"user" | "project" | "local">; providerKey?: string }): Promise<ClaudeModelInfo[]> {
    const requestedSources = options?.settingSources;
    const settingSources = Array.isArray(requestedSources) && requestedSources.length > 0 ? requestedSources : this.options.settingSources ?? ["user", "project", "local"];
    const providerKey = options?.providerKey || "default";
    const cacheKey = `${providerKey}::${settingSources.join(",")}`;
    const cached = this.modelInfoCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.infos;
    const sharedCached = getCachedModels(settingSources, providerKey);
    if (sharedCached && sharedCached.length > 0) {
      const infos = sharedCached as ClaudeModelInfo[];
      this.modelInfoCache.set(cacheKey, { infos, expiresAt: Date.now() + this.modelInfoTtlMs });
      return infos;
    }
    try {
      const query = this.options.queryImpl ?? (await this.loadQuery());
      const session = query({
        prompt: "",
        options: { cwd: this.options.cwd ? resolve(this.options.cwd) : process.cwd(), settingSources, permissionMode: this.options.permissionMode },
      }) as Query;
      const infosRaw = await session.supportedModels();
      try { await session.return(undefined); } catch {}
      try { session.close(); } catch {}
      const infos = Array.isArray(infosRaw) ? infosRaw : [];
      this.modelInfoCache.set(cacheKey, { infos, expiresAt: Date.now() + this.modelInfoTtlMs });
      setCachedModels(settingSources, infos, providerKey);
      return infos;
    } catch {
      return [];
    }
  }

  private async readSupportedCommandsFromSdk(options?: { settingSources?: Array<"user" | "project" | "local">; providerKey?: string }): Promise<ClaudeSlashCommandInfo[]> {
    const requestedSources = options?.settingSources;
    const settingSources = Array.isArray(requestedSources) && requestedSources.length > 0 ? requestedSources : this.options.settingSources ?? ["user", "project", "local"];
    const cacheKey = `${options?.providerKey || "default"}::${settingSources.join(",")}`;
    const cached = this.commandInfoCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.commands;
    try {
      const query = this.options.queryImpl ?? (await this.loadQuery());
      const session = query({
        prompt: "",
        options: { cwd: this.options.cwd ? resolve(this.options.cwd) : process.cwd(), settingSources, permissionMode: this.options.permissionMode },
      }) as Query;
      const commandsRaw = await session.supportedCommands();
      try { await session.return(undefined); } catch {}
      try { session.close(); } catch {}
      const commands = Array.isArray(commandsRaw) ? commandsRaw : [];
      this.commandInfoCache.set(cacheKey, { commands, expiresAt: Date.now() + this.commandInfoTtlMs });
      return commands;
    } catch {
      return [];
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

  private async closeHotRuntime(entry: HotRuntimeEntry): Promise<void> {
    try { entry.closeInput(); } catch {}
    try { entry.query?.close(); } catch {}
    entry.query = null;
    entry.bootstrapPromise = null;
    entry.currentTurn = null;
    entry.currentTurnMessage = undefined;
    entry.pendingEarlyRuntimeError = undefined;
    entry.pendingEarlyRuntimeQueryOptions = undefined;
    entry.configSignature = undefined;
    entry.providerIdentity = undefined;
  }
}
