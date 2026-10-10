import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { compareVersions } from "./phi-binary.js";

/**
 * First phi version that reads an MCP config file named by the caller
 * (`PHI_MCP_CONFIG`) and waits, bounded, for `eager` servers before the first
 * turn when there is no UI. phi 0.99.x only reads `<agentDir>/mcp.json`
 * (`phi-release/packages/coding-agent/extensions/phi/mcp/config.ts:200-219`),
 * which concurrent runs of one company would overwrite with each other's
 * run-scoped tokens, and starts `eager` servers without waiting.
 */
export const PHI_MCP_CONFIG_MIN_VERSION = "0.100.0";
export const PHI_MCP_CONFIG_ENV = "PHI_MCP_CONFIG";

export function phiSupportsMcpConfigFile(version: string | null): boolean {
  return version !== null && compareVersions(version, PHI_MCP_CONFIG_MIN_VERSION) >= 0;
}

/** `Paperclip projects` -> `paperclip_projects`; unique within one config. */
export function phiMcpServerName(rawName: string, taken: Set<string>): string {
  const base =
    rawName
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24) || "server";
  let name = base;
  for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}_${suffix}`;
  taken.add(name);
  return name;
}

/**
 * phi MCP config (schema: `extensions/phi/mcp/config.ts:41-136`) for the
 * run-scoped servers Paperclip hands to native-MCP adapters through
 * `ctx.runtimeMcp` (gateway connectors `/mcp/gateways/<id>` with a `pcgw_`
 * token, runtime connection tools, and the project tools carrying the run JWT).
 * phi does no `${VAR}` interpolation in this file, so tokens are literal:
 * the file is written with mode 0600 in the per-run directory and deleted at
 * the end of the run.
 */
export function buildPhiMcpConfig(servers: AdapterRuntimeMcpServer[]): {
  settings: { toolPrefix: string; requestTimeoutMs: number };
  mcpServers: Record<string, Record<string, unknown>>;
} {
  const taken = new Set<string>();
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const server of servers) {
    mcpServers[phiMcpServerName(server.name, taken)] = {
      transport: "streamable-http",
      url: server.url,
      headers: { Authorization: `Bearer ${server.token}` },
      lifecycle: "eager",
    };
  }
  return { settings: { toolPrefix: "mcp", requestTimeoutMs: 60_000 }, mcpServers };
}

export async function writePhiMcpConfig(runDir: string, servers: AdapterRuntimeMcpServer[]): Promise<string> {
  const file = path.join(runDir, "mcp.json");
  await fs.writeFile(file, `${JSON.stringify(buildPhiMcpConfig(servers), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return file;
}
