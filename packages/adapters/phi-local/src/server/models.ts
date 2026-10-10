import fs from "node:fs/promises";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { PHIBOT_PROVIDERS } from "../providers.js";
import { buildPhiChildEnv } from "./child-env.js";
import { resolvePhiCatalogAgentDir } from "./paths.js";
import { resolvePhiCli, type ResolvedPhiCli } from "./phi-binary.js";
import { ALIBABA_CODING_PLAN_MODELS, PHI_PROVIDER_KEY_ENV } from "./runtime-config.js";

/** The catalog only changes when phi is upgraded, which restarts the server. */
const MODELS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

/**
 * Rows of `phi --list-models`: a header `provider  model  context  max-out
 * thinking  images` then one row per model, columns separated by two spaces or
 * more (`phi-release/packages/coding-agent/src/cli/list-models.ts:92-114`).
 */
export function parsePhiModelsOutput(output: string): Array<{ provider: string; model: string }> {
  const rows: Array<{ provider: string; model: string }> = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s{2,}/);
    if (parts.length < 6) continue;
    const provider = parts[0]!.trim();
    const model = parts[1]!.trim();
    if (!provider || !model || (provider === "provider" && model === "model")) continue;
    rows.push({ provider, model });
  }
  return rows;
}

/** Phi Bot ids: `<phibot provider>/<model id>`, the format the UI filters on (R3 4.2). */
export function toPhiBotModels(rows: Array<{ provider: string; model: string }>): AdapterModel[] {
  // Built-in phi providers only: models.json providers have no catalog in phi.
  const phiToPhiBot = new Map(
    PHIBOT_PROVIDERS.filter((provider) => !provider.modelsJson).map((provider) => [provider.phiProvider, provider.id]),
  );
  const seen = new Set<string>();
  const models: AdapterModel[] = [];
  const push = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    models.push({ id, label: id });
  };
  for (const row of rows) {
    const phibotProvider = phiToPhiBot.get(row.provider);
    if (phibotProvider) push(`${phibotProvider}/${row.model}`);
  }
  for (const model of ALIBABA_CODING_PLAN_MODELS) push(`alibaba/${model.id}`);
  return models.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));
}

/**
 * Read phi's bundled catalog without any real credential: placeholder keys make
 * every supported provider "available" to `--list-models`, PHI_OFFLINE avoids
 * the network, PHI_SKIP_POSTINSTALL and the --no-* flags avoid copying and
 * loading the bundled extensions. Output is read from stdout first (phi prints
 * the table with console.log; warnings go to stderr), unlike pi_local which
 * read stderr first.
 */
export async function discoverPhiModels(input: { cli?: ResolvedPhiCli } = {}): Promise<AdapterModel[]> {
  const cli = input.cli ?? resolvePhiCli();
  const agentDir = resolvePhiCatalogAgentDir();
  await fs.mkdir(agentDir, { recursive: true });
  const env = buildPhiChildEnv({
    inherited: process.env,
    runEnv: {},
    forced: {
      ...Object.fromEntries(PHI_PROVIDER_KEY_ENV.map((key) => [key, "phibot-model-catalog"])),
      PHI_CODING_AGENT_DIR: agentDir,
      PHI_OFFLINE: "1",
      PHI_SKIP_POSTINSTALL: "1",
      PHI_TELEMETRY: "0",
    },
  });
  const result = await runChildProcess(
    `phi-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    cli.command,
    [
      ...cli.prefixArgs,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--list-models",
    ],
    { cwd: agentDir, env, timeoutSec: 90, graceSec: 3, onLog: async () => {}, inheritProcessEnv: false },
  );
  if (result.timedOut) throw new Error("`phi --list-models` timed out.");
  if ((result.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(detail ? `\`phi --list-models\` failed: ${detail}` : "`phi --list-models` failed.");
  }
  const rows = parsePhiModelsOutput(result.stdout);
  return toPhiBotModels(rows.length > 0 ? rows : parsePhiModelsOutput(result.stderr));
}

const discoveryCache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();

export async function discoverPhiModelsCached(input: { cli?: ResolvedPhiCli } = {}): Promise<AdapterModel[]> {
  const cli = input.cli ?? resolvePhiCli();
  const key = `${cli.displayPath}\u0000${cli.version ?? ""}`;
  const now = Date.now();
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;
  const models = await discoverPhiModels({ cli });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

/** `listModels` of the server module: never throws (an empty list keeps free-text entry). */
export async function listPhiModels(): Promise<AdapterModel[]> {
  try {
    return await discoverPhiModelsCached();
  } catch {
    return [];
  }
}

/** `refreshModels` of the server module: bypass the cache. */
export async function refreshPhiModels(): Promise<AdapterModel[]> {
  discoveryCache.clear();
  return listPhiModels();
}

export function resetPhiModelsCacheForTests() {
  discoveryCache.clear();
}
