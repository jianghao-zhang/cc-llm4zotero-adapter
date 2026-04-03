import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ClaudeCodeRuntimeClient, RuntimeTurnRequest, RuntimeTurnStream } from "../runtime.js";
import { mapSdkMessageToProviderEvents } from "../event-mapper/map-sdk-message.js";
import type { PermissionMode, SDKUserMessage, SettingSource } from "@anthropic-ai/claude-agent-sdk";

type QueryFunction = (args: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Record<string, unknown>;
}) => AsyncIterable<unknown>;

export interface ClaudeAgentSdkRuntimeClientOptions {
  cwd?: string;
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

const DEFAULT_BLOCKED_METADATA_KEYS = new Set<string>([
  "allowedTools",
  "abortController",
  "continue",
  "cwd",
  "includePartialMessages",
  "maxTurns",
  "permissionMode",
  "resume",
  "settingSources",
  "runtimeRequest",
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

function buildPromptText(
  userMessage: string,
  runtimeRequest: RuntimeRequestShape | undefined,
): string {
  const lines: string[] = [userMessage.trim()];

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

  const selectedPapers = collectPaperTitles(runtimeRequest.selectedPaperContexts, 6);
  if (selectedPapers.length) {
    lines.push(
      "Selected papers:",
      ...selectedPapers.map((title) => `- ${title}`),
    );
  }

  const fullTextPapers = collectPaperTitles(runtimeRequest.fullTextPaperContexts, 4);
  if (fullTextPapers.length) {
    lines.push(
      "Papers marked for full-text reading:",
      ...fullTextPapers.map((title) => `- ${title}`),
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
  options: Pick<ClaudeAgentSdkRuntimeClientOptions, "forwardFrontendModel" | "blockedMetadataKeys">
): Record<string, unknown> {
  if (!metadata) {
    return {};
  }

  const blockedKeys = new Set<string>([
    ...DEFAULT_BLOCKED_METADATA_KEYS,
    ...(options.blockedMetadataKeys ?? []),
  ]);

  if (!options.forwardFrontendModel) {
    blockedKeys.add("model");
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!blockedKeys.has(key)) {
      result[key] = value;
    }
  }

  return result;
}

export class ClaudeAgentSdkRuntimeClient implements ClaudeCodeRuntimeClient {
  private readonly options: ClaudeAgentSdkRuntimeClientOptions;

  constructor(options: ClaudeAgentSdkRuntimeClientOptions = {}) {
    this.options = options;
  }

  async startTurn(request: RuntimeTurnRequest): Promise<RuntimeTurnStream> {
    const query = this.options.queryImpl ?? (await this.loadQuery());
    const metadata = parseMetadata(request.metadata, this.options);

    const queryOptions: Record<string, unknown> = {
      ...metadata,
      cwd: this.options.cwd,
      allowedTools: request.allowedTools,
      settingSources: this.options.settingSources ?? ["user", "project"],
      permissionMode: this.options.permissionMode,
      includePartialMessages: this.options.includePartialMessages,
      maxTurns: this.options.maxTurns,
      continue: this.options.continue,
      appendSystemPrompt: this.options.appendSystemPrompt,
      resume: request.providerSessionId,
      abortController: request.signal ? this.createAbortController(request.signal) : undefined,
    };

    const cleanedOptions = Object.fromEntries(
      Object.entries(queryOptions).filter(([, value]) => value !== undefined)
    );

    const prompt = await buildPromptInput(request, metadata);
    const sdkStream = query({
      prompt,
      options: cleanedOptions
    });

    const events = (async function* (): AsyncIterable<import("../runtime.js").ProviderEvent> {
      for await (const message of sdkStream) {
        const mapped = mapSdkMessageToProviderEvents(message);
        for (const event of mapped) {
          yield event;
        }
      }
    })();

    return {
      runId: randomUUID(),
      providerSessionId: request.providerSessionId,
      events
    };
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
