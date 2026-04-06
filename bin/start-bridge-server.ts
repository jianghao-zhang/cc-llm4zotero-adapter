import {
  ClaudeAgentSdkRuntimeClient,
  ClaudeCodeRuntimeAdapter,
  JsonFileSessionMapper,
  JsonFileTraceStore,
  Llm4ZoteroAgentBackendAdapter,
  startHttpBridgeServer,
} from "../src/index.js";
import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function getArg(name: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const value = process.argv[idx + 1];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return defaultValue;
}

function parseSettingSources(value: string | undefined): SettingSource[] {
  const raw = (value || "project,local")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const accepted: SettingSource[] = [];
  for (const source of raw) {
    if (source === "user" || source === "project" || source === "local") {
      accepted.push(source);
    }
  }
  return accepted.length > 0 ? accepted : ["project", "local"];
}

function normalizePathWithHome(value: string, homeDir: string | undefined): string | undefined {
  const raw = value.trim();
  if (!raw) return undefined;
  if (raw === "~") {
    return homeDir ? resolve(homeDir) : undefined;
  }
  if (raw.startsWith("~/")) {
    return homeDir ? resolve(homeDir, raw.slice(2)) : undefined;
  }
  return resolve(raw);
}

function parseDirectoryList(
  value: string | undefined,
  homeDir: string | undefined,
): string[] {
  if (!value || !value.trim()) return [];
  const normalized = value
    .split(",")
    .map((entry) => normalizePathWithHome(entry, homeDir))
    .filter((entry): entry is string => Boolean(entry));
  return Array.from(new Set(normalized));
}

function parseStringList(value: string | undefined): string[] {
  if (!value || !value.trim()) return [];
  return Array.from(
    new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function readTextFile(path: string | undefined): string {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read file: ${path} (${message})`);
  }
}

async function main() {
  const host = getArg("host") || process.env.ADAPTER_HOST || "127.0.0.1";
  const portRaw = getArg("port") || process.env.ADAPTER_PORT || "8787";
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid port: ${portRaw}`);
  }

  const homeDir = process.env.HOME && process.env.HOME.trim()
    ? process.env.HOME.trim()
    : undefined;
  const zoteroRoot = homeDir ? resolve(homeDir, "Zotero") : undefined;
  const defaultRuntimeCwd =
    zoteroRoot && existsSync(zoteroRoot)
      ? resolve(zoteroRoot, "agent-runtime")
      : process.cwd();
  const defaultStateDir = (() => {
    if (zoteroRoot && existsSync(zoteroRoot)) {
      return resolve(zoteroRoot, "agent-state");
    }
    if (homeDir) {
      return resolve(homeDir, "agent-state");
    }
    return resolve(process.cwd(), ".adapter-state");
  })();
  const stateDir =
    getArg("state-dir") ||
    process.env.ADAPTER_STATE_DIR ||
    defaultStateDir;
  const forwardFrontendModel = parseBoolean(
    getArg("forward-frontend-model") ?? process.env.ADAPTER_FORWARD_FRONTEND_MODEL,
    true,
  );
  const runtimeCwdRaw =
    getArg("runtime-cwd") ||
    process.env.ADAPTER_RUNTIME_CWD ||
    defaultRuntimeCwd;
  const runtimeCwd = resolve(runtimeCwdRaw);
  const stateDirResolved = resolve(stateDir);

  mkdirSync(runtimeCwd, { recursive: true });
  mkdirSync(stateDirResolved, { recursive: true });
  const projectClaudeDir = resolve(runtimeCwd, ".claude");
  const projectSettingsFile = resolve(projectClaudeDir, "settings.json");
  mkdirSync(projectClaudeDir, { recursive: true });
  if (!existsSync(projectSettingsFile)) {
    writeFileSync(projectSettingsFile, "{}\n", "utf8");
  }
  const settingSources = parseSettingSources(
    getArg("setting-sources") || process.env.ADAPTER_SETTING_SOURCES,
  );
  const appendPromptInline =
    getArg("append-system-prompt") ||
    process.env.ADAPTER_APPEND_SYSTEM_PROMPT ||
    "";
  const appendPromptFile = readTextFile(
    getArg("append-system-prompt-file") ||
      process.env.ADAPTER_APPEND_SYSTEM_PROMPT_FILE,
  );
  const appendSystemPrompt = [appendPromptInline.trim(), appendPromptFile.trim()]
    .filter(Boolean)
    .join("\n\n");
  const defaultAdditionalDirs = [
    normalizePathWithHome("~/Zotero", homeDir),
    normalizePathWithHome("~/Downloads", homeDir),
    normalizePathWithHome("~/Documents", homeDir),
  ].filter((entry): entry is string => Boolean(entry));
  const configuredAdditionalDirs = parseDirectoryList(
    getArg("additional-directories") || process.env.ADAPTER_ADDITIONAL_DIRECTORIES,
    homeDir,
  );
  const additionalDirectories = Array.from(
    new Set(
      [...defaultAdditionalDirs, ...configuredAdditionalDirs].filter((entry) => entry !== runtimeCwd),
    ),
  );
  const defaultAllowedTools = parseStringList(
    getArg("default-allowed-tools") ||
      process.env.ADAPTER_DEFAULT_ALLOWED_TOOLS ||
      "WebFetch,WebSearch",
  );
  for (const dir of additionalDirectories) {
    mkdirSync(dir, { recursive: true });
  }

  const runtimeClient = new ClaudeAgentSdkRuntimeClient({
    cwd: runtimeCwd,
    additionalDirectories,
    defaultAllowedTools,
    settingSources,
    includePartialMessages: true,
    appendSystemPrompt: appendSystemPrompt || undefined,
    forwardFrontendModel,
    permissionMode: "default",
  });

  const core = new ClaudeCodeRuntimeAdapter({
    runtimeClient,
    sessionMapper: new JsonFileSessionMapper(
      `${stateDirResolved}/session-links/sessions.json`,
    ),
    traceStore: new JsonFileTraceStore(
      `${stateDirResolved}/turn-traces/trace.json`,
    ),
  });

  const compat = new Llm4ZoteroAgentBackendAdapter({
    adapter: core,
    runtimeCwd,
  });
  const server = await startHttpBridgeServer({ adapter: compat, host, port });

  console.log(`[cc-llm4zotero-adapter] listening on http://${server.host}:${server.port}`);
  console.log(`[cc-llm4zotero-adapter] healthz: http://${server.host}:${server.port}/healthz`);
  console.log(`[cc-llm4zotero-adapter] runtime cwd: ${runtimeCwd}`);
  console.log(
    `[cc-llm4zotero-adapter] additional directories: ${
      additionalDirectories.length > 0 ? additionalDirectories.join(", ") : "(none)"
    }`,
  );
  console.log(
    `[cc-llm4zotero-adapter] default allowed tools: ${
      defaultAllowedTools.length > 0 ? defaultAllowedTools.join(", ") : "(none)"
    }`,
  );
  console.log(`[cc-llm4zotero-adapter] state dir: ${stateDirResolved}`);
  console.log(`[cc-llm4zotero-adapter] settingSources: ${settingSources.join(",")}`);
  if (appendSystemPrompt) {
    console.log("[cc-llm4zotero-adapter] appendSystemPrompt: enabled");
  }
  console.log("[cc-llm4zotero-adapter] Press Ctrl+C to stop");

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
