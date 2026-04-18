#!/usr/bin/env tsx

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveLegacyAdapterPaths } from "../src/zotero-profile-paths.js";

const SERVICE_LABEL = "com.toha.ccbridge";
const DEFAULT_PORT = "19787";
const HEALTH_PATH = "/healthz";
const HELP_BASE_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

type CommandName = "install" | "start" | "stop" | "restart" | "status" | "uninstall";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const homeDir = homedir();
const launchAgentsDir = resolve(homeDir, "Library", "LaunchAgents");
const plistPath = resolve(launchAgentsDir, `${SERVICE_LABEL}.plist`);
const logsDir = resolve(homeDir, "Library", "Logs", "cc-llm4zotero-adapter");
const stdoutPath = resolve(logsDir, "bridge.stdout.log");
const stderrPath = resolve(logsDir, "bridge.stderr.log");
const legacyPaths = resolveLegacyAdapterPaths(homeDir, repoRoot);
const defaultRuntimeCwd = legacyPaths.runtimeCwd;
const defaultStateDir = legacyPaths.stateDir;
const runtimeCwd = process.env.ADAPTER_RUNTIME_CWD || defaultRuntimeCwd;
const stateDir = process.env.ADAPTER_STATE_DIR || defaultStateDir;
const port = process.env.ADAPTER_PORT || DEFAULT_PORT;
const uid = String(process.getuid?.() ?? 0);

function run(cmd: string, args: string[], opts?: { allowFailure?: boolean; silent?: boolean }): string {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: opts?.silent ? ["ignore", "pipe", "pipe"] : ["inherit", "pipe", "pipe"],
  });
  const out = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.status !== 0 && !opts?.allowFailure) {
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}\n${out}`);
  }
  return out;
}

function ensureDirectories(): void {
  mkdirSync(launchAgentsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(runtimeCwd, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildPlistXml(): string {
  const serveCommand = `cd ${JSON.stringify(repoRoot)} && npm run serve:bridge`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${escapeXml(serveCommand)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(homeDir)}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>ADAPTER_HOST</key>
    <string>127.0.0.1</string>
    <key>ADAPTER_PORT</key>
    <string>${escapeXml(port)}</string>
    <key>ADAPTER_RUNTIME_CWD</key>
    <string>${escapeXml(runtimeCwd)}</string>
    <key>ADAPTER_STATE_DIR</key>
    <string>${escapeXml(stateDir)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(repoRoot)}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
}

function ensureNodeAndNpm(): void {
  run("/usr/bin/env", ["node", "--version"]);
  run("/usr/bin/env", ["npm", "--version"]);
}

function hasLaunchdEntry(): boolean {
  const output = run("launchctl", ["list"], { allowFailure: true, silent: true });
  return output.split("\n").some((line) => line.includes(SERVICE_LABEL));
}

function bootstrap(): void {
  run("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { allowFailure: true });
  run("launchctl", ["enable", `gui/${uid}/${SERVICE_LABEL}`], { allowFailure: true });
}

function install(): void {
  ensureNodeAndNpm();
  ensureDirectories();
  const xml = buildPlistXml();
  writeFileSync(plistPath, xml, "utf8");
  run("launchctl", ["bootout", `gui/${uid}/${SERVICE_LABEL}`], { allowFailure: true });
  bootstrap();
  console.log(`Installed ${SERVICE_LABEL}`);
  console.log(`plist: ${plistPath}`);
  console.log(`logs: ${logsDir}`);
}

function start(): void {
  if (!existsSync(plistPath)) {
    throw new Error(`Missing plist: ${plistPath}. Run install first.`);
  }
  if (!hasLaunchdEntry()) {
    bootstrap();
  }
  run("launchctl", ["start", SERVICE_LABEL], { allowFailure: true });
  console.log(`Started ${SERVICE_LABEL}`);
}

function stop(): void {
  run("launchctl", ["stop", SERVICE_LABEL], { allowFailure: true });
  console.log(`Stopped ${SERVICE_LABEL}`);
}

async function healthCheck(): Promise<{ ok: boolean; status?: number; error?: string }> {
  const target = `${HELP_BASE_URL}${HEALTH_PATH}`;
  try {
    const response = await fetch(target, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(2000),
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function status(): Promise<void> {
  const loaded = hasLaunchdEntry();
  const serviceSummary = run("launchctl", ["list", SERVICE_LABEL], {
    allowFailure: true,
    silent: true,
  });
  const health = await healthCheck();
  console.log(`Service: ${SERVICE_LABEL}`);
  console.log(`Loaded: ${loaded ? "yes" : "no"}`);
  console.log(`Plist: ${plistPath} ${existsSync(plistPath) ? "(exists)" : "(missing)"}`);
  if (serviceSummary) {
    console.log("launchctl:");
    console.log(serviceSummary);
  }
  if (health.ok) {
    console.log(`Health: OK (${HELP_BASE_URL}${HEALTH_PATH}, HTTP ${health.status})`);
  } else {
    console.log(`Health: DOWN (${HELP_BASE_URL}${HEALTH_PATH})`);
    if (health.error) {
      console.log(`Health error: ${health.error}`);
    }
  }
  console.log(`Logs: ${logsDir}`);
  console.log("Quick fix:");
  console.log(`  launchctl stop ${SERVICE_LABEL}`);
  console.log(`  launchctl start ${SERVICE_LABEL}`);
  console.log(`  curl -fsS ${HELP_BASE_URL}${HEALTH_PATH}`);
}

function uninstall(): void {
  run("launchctl", ["stop", SERVICE_LABEL], { allowFailure: true });
  run("launchctl", ["bootout", `gui/${uid}/${SERVICE_LABEL}`], { allowFailure: true });
  run("launchctl", ["disable", `gui/${uid}/${SERVICE_LABEL}`], { allowFailure: true });
  if (existsSync(plistPath)) {
    rmSync(plistPath, { force: true });
  }
  console.log(`Uninstalled ${SERVICE_LABEL}`);
  console.log(`Removed plist: ${plistPath}`);
  console.log(`Logs kept at: ${logsDir}`);
}

function restart(): void {
  stop();
  start();
}

function printUsage(): void {
  const pkg = readFileSync(resolve(repoRoot, "package.json"), "utf8");
  const version = JSON.parse(pkg).version as string;
  console.log(`cc-llm4zotero-adapter daemon manager v${version}`);
  console.log("Usage: tsx bin/manage-daemon.ts <install|start|stop|restart|status|uninstall>");
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("This daemon manager currently supports macOS only.");
  }
  const cmd = (process.argv[2] || "").trim().toLowerCase() as CommandName;
  if (!cmd) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  switch (cmd) {
    case "install":
      install();
      break;
    case "start":
      start();
      break;
    case "stop":
      stop();
      break;
    case "restart":
      restart();
      break;
    case "status":
      await status();
      break;
    case "uninstall":
      uninstall();
      break;
    default:
      printUsage();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
