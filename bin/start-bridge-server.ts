import {
  ClaudeAgentSdkRuntimeClient,
  ClaudeCodeRuntimeAdapter,
  JsonFileSessionMapper,
  JsonFileTraceStore,
  Llm4ZoteroAgentBackendAdapter,
  startHttpBridgeServer,
} from "../src/index.js";

function getArg(name: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const value = process.argv[idx + 1];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function main() {
  const host = getArg("host") || process.env.ADAPTER_HOST || "127.0.0.1";
  const portRaw = getArg("port") || process.env.ADAPTER_PORT || "8787";
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid port: ${portRaw}`);
  }

  const stateDir =
    getArg("state-dir") ||
    process.env.ADAPTER_STATE_DIR ||
    `${process.cwd()}/.adapter-state`;

  const runtimeClient = new ClaudeAgentSdkRuntimeClient({
    settingSources: ["user", "project"],
    includePartialMessages: true,
  });

  const core = new ClaudeCodeRuntimeAdapter({
    runtimeClient,
    sessionMapper: new JsonFileSessionMapper(`${stateDir}/sessions.json`),
    traceStore: new JsonFileTraceStore(`${stateDir}/trace.json`),
  });

  const compat = new Llm4ZoteroAgentBackendAdapter(core);
  const server = await startHttpBridgeServer({ adapter: compat, host, port });

  console.log(`[cc-llm4zotero-adapter] listening on http://${server.host}:${server.port}`);
  console.log(`[cc-llm4zotero-adapter] healthz: http://${server.host}:${server.port}/healthz`);
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
