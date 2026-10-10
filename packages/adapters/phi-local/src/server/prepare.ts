import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { PHI_PACKAGE_NAME } from "../index.js";
import { ensurePhiAgentDirReady, readPhiAgentDirStamp } from "./agent-dir.js";
import { buildPhiChildEnv } from "./child-env.js";
import { resolvePhiCompanyPaths } from "./paths.js";
import { readPhiCliVersion, resolvePhiCli, type ResolvedPhiCli } from "./phi-binary.js";

/** Embedding model of phi's memory (`phi:packages/sigma-memory/src/vector-store.ts`, q8 by default, about 23 MB). */
export const PHI_EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

/** Marker printed by the warm-up child once the model is loaded and used. */
const EMBEDDING_READY_MARKER = "PHIBOT_EMBEDDING_READY";

/**
 * Child process script (ES module, run with `node --input-type=module -e`).
 * Arguments: phi package dir, throwaway memory dir, model cache dir.
 * sigma-memory is resolved from phi's own package.json, never imported by the
 * adapter: where npm hoists it depends on the installation.
 */
const EMBEDDING_WARMUP_SCRIPT = String.raw`
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [packageDir, memoryDir, modelCacheDir] = process.argv.slice(1);
try {
  const requireFromPhi = createRequire(join(packageDir, "package.json"));
  const { SigmaMemory } = await import(pathToFileURL(requireFromPhi.resolve("sigma-memory")).href);
  const memory = new SigmaMemory({
    memoryDir,
    projectMemoryDir: join(memoryDir, "project"),
    ontologyPath: join(memoryDir, "ontology", "graph.jsonl"),
    modelCacheDir,
  });
  await memory.vectors.init();
  await memory.vectors.addDocument("phibot-prepare.md", "Phi Bot prepares the embedding model of the phi memory.");
  memory.vectors.close?.();
  process.stdout.write("PHIBOT_EMBEDDING_READY\n");
  process.exit(0);
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n");
  process.exit(1);
}
`;

export interface PreparedPhiCompany {
  /** Company agent dir (PHI_CODING_AGENT_DIR of its runs). */
  agentDir: string;
  /** Version of the phi that prepared it. */
  phiVersion: string | null;
  /** `<agentDir>/cache/models/Xenova/all-MiniLM-L6-v2`, where phi's memory loads the model from. */
  embeddingModelDir: string;
}

interface PackageJsonShape {
  name?: unknown;
}

function isPhiManifest(raw: string): boolean {
  try {
    return (JSON.parse(raw) as PackageJsonShape).name === PHI_PACKAGE_NAME;
  } catch {
    // Not a valid manifest, so not phi's.
    return false;
  }
}

/**
 * Real location of the phi package that holds `cli.prefixArgs[0]` (its
 * `dist/cli.js`), or null. The real path matters: npm hoists phi's own
 * dependencies (sigma-memory...) next to it, and a package reached through a
 * link (pnpm, npm link) only finds them from its real location.
 */
export async function findPhiPackageRoot(cli: ResolvedPhiCli): Promise<string | null> {
  const script = cli.prefixArgs[0];
  if (cli.source === "path" || !script) return null;
  let dir = path.dirname(path.resolve(script));
  for (let depth = 0; depth < 4; depth += 1) {
    const raw = await fs.readFile(path.join(dir, "package.json"), "utf8").catch(() => null);
    if (raw !== null && isPhiManifest(raw)) return await fs.realpath(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function lastJsonError(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    } catch {
      // Not the script's error line.
    }
  }
  return null;
}

async function containsOnnxModel(dir: string, depth = 0): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".onnx")) return true;
    if (entry.isDirectory() && depth < 3 && (await containsOnnxModel(path.join(dir, entry.name), depth + 1))) return true;
  }
  return false;
}

async function downloadEmbeddingModel(input: { packageDir: string; agentDir: string; modelCacheDir: string }): Promise<void> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "phibot-embedding-"));
  try {
    const env = buildPhiChildEnv({
      inherited: process.env,
      runEnv: {},
      forced: { PHI_CODING_AGENT_DIR: input.agentDir, PHI_TELEMETRY: "0" },
    });
    const result = await runChildProcess(
      `phi-embedding-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      process.execPath,
      ["--input-type=module", "-e", EMBEDDING_WARMUP_SCRIPT, input.packageDir, scratch, input.modelCacheDir],
      { cwd: scratch, env, timeoutSec: 600, graceSec: 5, onLog: async () => {}, inheritProcessEnv: false },
    );
    if (result.timedOut) {
      throw new Error(`Downloading the embedding model ${PHI_EMBEDDING_MODEL_ID} timed out after 10 minutes.`);
    }
    if ((result.exitCode ?? 1) !== 0 || !result.stdout.includes(EMBEDDING_READY_MARKER)) {
      const detail =
        lastJsonError(result.stdout) ??
        (result.stderr.trim().split(/\r?\n/).pop() || `exit code ${result.exitCode ?? "unknown"}`);
      throw new Error(`Downloading the embedding model ${PHI_EMBEDDING_MODEL_ID} into ${input.modelCacheDir} failed: ${detail}`);
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Prepare phi for one company (spec 8.3 and 12.1), as `phibot setup` and
 * `phibot doctor --repair` do: create the company agent dir, let phi copy its
 * bundled extensions there (version stamp checked), set `defaultTools`, then
 * download the embedding model of phi's memory into `<agentDir>/cache/models`
 * through phi's own sigma-memory, with a throwaway memory dir (the real
 * `~/.phi/memory` is not touched). Throws an explicit error on any failure.
 */
export async function preparePhiForCompany(companyId: string): Promise<PreparedPhiCompany> {
  const paths = resolvePhiCompanyPaths(companyId);
  await fs.mkdir(paths.agentDir, { recursive: true });
  const cli = resolvePhiCli();
  const packageDir = await findPhiPackageRoot(cli);
  if (!packageDir) {
    throw new Error(
      `phi is not installed: ${PHI_PACKAGE_NAME} was not found next to Phi Bot (resolved "${cli.displayPath}"). ` +
        "Reinstall Phi Bot, or set PHIBOT_PHI_CLI to phi's dist/cli.js.",
    );
  }
  const env = buildPhiChildEnv({
    inherited: process.env,
    runEnv: {},
    forced: { PHI_CODING_AGENT_DIR: paths.agentDir, PHI_OFFLINE: "1", PHI_TELEMETRY: "0" },
  });
  const phiVersion = await readPhiCliVersion(cli, { cwd: paths.agentDir, env });
  if (!phiVersion) {
    throw new Error(`Cannot read the version of phi (${cli.displayPath}).`);
  }
  await ensurePhiAgentDirReady({ cli, version: phiVersion, agentDir: paths.agentDir, cwd: paths.agentDir, env });
  const stamp = await readPhiAgentDirStamp(paths.agentDir);
  if (stamp !== phiVersion) {
    throw new Error(
      `phi ${phiVersion} did not prepare its agent directory ${paths.agentDir} (version stamp: ${stamp ?? "missing"}).`,
    );
  }
  const modelCacheDir = path.join(paths.agentDir, "cache", "models");
  await downloadEmbeddingModel({ packageDir, agentDir: paths.agentDir, modelCacheDir });
  const embeddingModelDir = path.join(modelCacheDir, ...PHI_EMBEDDING_MODEL_ID.split("/"));
  if (!(await containsOnnxModel(embeddingModelDir))) {
    throw new Error(`The embedding model ${PHI_EMBEDDING_MODEL_ID} was not found in ${embeddingModelDir} after the download.`);
  }
  return { agentDir: paths.agentDir, phiVersion, embeddingModelDir };
}
