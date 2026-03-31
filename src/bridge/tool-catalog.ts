import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import type { Llm4ZoteroToolDescriptor } from "./llm4zotero-contract.js";

type ParsedFrontmatter = {
  description?: string;
  allowedTools?: string[];
};

function parseFrontmatter(content: string): ParsedFrontmatter {
  const parsed: ParsedFrontmatter = {};
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return parsed;
  }
  const lines = trimmed.split("\n");
  if (lines.length < 3) {
    return parsed;
  }
  let idx = 1;
  for (; idx < lines.length; idx += 1) {
    const line = lines[idx].trim();
    if (line === "---") break;
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (key === "description") {
      parsed.description = value.replace(/^["']|["']$/g, "");
    } else if (key === "allowed-tools") {
      parsed.allowedTools = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
  }
  return parsed;
}

function inferRisk(allowedTools: string[] | undefined): {
  mutability: "read" | "write";
  riskLevel: "low" | "medium" | "high";
  requiresConfirmation: boolean;
} {
  const set = new Set((allowedTools || []).map((entry) => entry.toLowerCase()));
  const hasWrite =
    set.has("bash") ||
    set.has("write") ||
    set.has("edit") ||
    set.has("multiedit") ||
    set.has("notebookedit");
  if (hasWrite) {
    return { mutability: "write", riskLevel: "high", requiresConfirmation: true };
  }
  if (set.size > 0) {
    return { mutability: "read", riskLevel: "medium", requiresConfirmation: false };
  }
  return { mutability: "read", riskLevel: "low", requiresConfirmation: false };
}

function walkDirsForCommands(root: string, maxDepth = 6): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "commands") {
          out.push(full);
        }
        visit(full, depth + 1);
      }
    }
  };
  visit(root, 0);
  return out;
}

function getCommandDirs(): string[] {
  const home = homedir();
  const roots = [
    join(home, ".claude", "commands"),
    ...walkDirsForCommands(join(home, ".claude", "plugins", "marketplaces")),
  ];
  return [...new Set(roots)].filter((dir) => existsSync(dir));
}

function listCommandFiles(): string[] {
  const files: string[] = [];
  for (const dir of getCommandDirs()) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (extname(entry.name).toLowerCase() !== ".md") continue;
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

function parseCommandDescriptor(filePath: string): Llm4ZoteroToolDescriptor | null {
  let content = "";
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const commandName = basename(filePath, ".md").trim();
  if (!commandName) {
    return null;
  }
  const frontmatter = parseFrontmatter(content);
  const risk = inferRisk(frontmatter.allowedTools);
  return {
    name: commandName,
    description:
      frontmatter.description || `Claude Code slash command: /${commandName}`,
    inputSchema: {
      type: "object",
      properties: {
        arguments: {
          type: "string",
          description: `Arguments after /${commandName}`,
        },
      },
      required: [],
    },
    mutability: risk.mutability,
    riskLevel: risk.riskLevel,
    requiresConfirmation: risk.requiresConfirmation,
    source: "claude-runtime",
  };
}

export function getToolCatalog(): Llm4ZoteroToolDescriptor[] {
  const seen = new Set<string>();
  const tools: Llm4ZoteroToolDescriptor[] = [];
  for (const file of listCommandFiles()) {
    const descriptor = parseCommandDescriptor(file);
    if (!descriptor) continue;
    if (seen.has(descriptor.name)) continue;
    seen.add(descriptor.name);
    tools.push(descriptor);
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

export function findToolByName(name: string): Llm4ZoteroToolDescriptor | undefined {
  return getToolCatalog().find((tool) => tool.name === name);
}
