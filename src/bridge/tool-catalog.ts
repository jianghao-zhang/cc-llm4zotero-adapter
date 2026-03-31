import type { Llm4ZoteroToolDescriptor } from "./llm4zotero-contract.js";

const BUILTIN_TOOLS: Llm4ZoteroToolDescriptor[] = [
  {
    name: "Read",
    description: "Read file contents from local workspace",
    inputSchema: { type: "object", properties: { file_path: { type: "string" } } },
    mutability: "read",
    riskLevel: "low",
    requiresConfirmation: false,
    source: "claude-runtime",
  },
  {
    name: "Grep",
    description: "Search text patterns across files",
    inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
    mutability: "read",
    riskLevel: "low",
    requiresConfirmation: false,
    source: "claude-runtime",
  },
  {
    name: "Glob",
    description: "Find files by glob patterns",
    inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
    mutability: "read",
    riskLevel: "low",
    requiresConfirmation: false,
    source: "claude-runtime",
  },
  {
    name: "LS",
    description: "List directory contents",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    mutability: "read",
    riskLevel: "low",
    requiresConfirmation: false,
    source: "claude-runtime",
  },
  {
    name: "WebFetch",
    description: "Fetch and read web pages",
    inputSchema: { type: "object", properties: { url: { type: "string" } } },
    mutability: "read",
    riskLevel: "medium",
    requiresConfirmation: false,
    source: "claude-runtime",
  },
  {
    name: "Write",
    description: "Write new files",
    inputSchema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } } },
    mutability: "write",
    riskLevel: "high",
    requiresConfirmation: true,
    source: "claude-runtime",
  },
  {
    name: "Edit",
    description: "Edit existing file content",
    inputSchema: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } } },
    mutability: "write",
    riskLevel: "high",
    requiresConfirmation: true,
    source: "claude-runtime",
  },
  {
    name: "MultiEdit",
    description: "Apply multiple edits in a single operation",
    inputSchema: { type: "object", properties: { file_path: { type: "string" }, edits: { type: "array" } } },
    mutability: "write",
    riskLevel: "high",
    requiresConfirmation: true,
    source: "claude-runtime",
  },
  {
    name: "Bash",
    description: "Run shell commands",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
    mutability: "write",
    riskLevel: "high",
    requiresConfirmation: true,
    source: "claude-runtime",
  },
];

export function getToolCatalog(): Llm4ZoteroToolDescriptor[] {
  return BUILTIN_TOOLS.map((tool) => ({ ...tool }));
}

export function findToolByName(name: string): Llm4ZoteroToolDescriptor | undefined {
  return BUILTIN_TOOLS.find((tool) => tool.name === name);
}
