import fs from "node:fs/promises";
import path from "node:path";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { writeFileAtomically } from "./fs-atomic.js";
import type { ResolvedPhiCli } from "./phi-binary.js";

/**
 * File phi writes in the agent dir once its bundled extensions, agents and
 * skills are copied there (`phi-release/packages/coding-agent/src/core/bundled-assets.ts:33-34`).
 */
export const PHI_BUNDLED_ASSETS_STAMP = ".bundled-assets-version";

/**
 * Built-in tools active at the start of every run. Without this setting phi
 * activates only read, bash, edit and write
 * (`phi:packages/coding-agent/src/core/sdk.ts:251-258`); grep, find and ls
 * are phi's own search tools (they use rg and fd from the PATH).
 */
export const PHIBOT_DEFAULT_TOOLS: readonly string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const warmUps = new Map<string, Promise<void>>();

export async function readPhiAgentDirStamp(agentDir: string): Promise<string | null> {
  const raw = await fs.readFile(path.join(agentDir, PHI_BUNDLED_ASSETS_STAMP), "utf8").catch(() => null);
  return raw?.trim() || null;
}

/**
 * Merge `"defaultTools"` into `<agentDir>/settings.json`, keeping every other
 * key (phi's first start writes `quietStartup` there). Atomic write; nothing
 * is written when the value is already in place. A settings file that is not
 * a JSON object is reported, never overwritten.
 */
export async function ensurePhiDefaultTools(agentDir: string): Promise<{ changed: boolean }> {
  const file = path.join(agentDir, "settings.json");
  let raw: string | null = null;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let settings: Record<string, unknown> = {};
  if (raw !== null && raw.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`phi settings file ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`phi settings file ${file} must contain a JSON object.`);
    }
    settings = parsed as Record<string, unknown>;
  }
  const current = settings.defaultTools;
  if (
    Array.isArray(current) &&
    current.length === PHIBOT_DEFAULT_TOOLS.length &&
    current.every((tool, index) => tool === PHIBOT_DEFAULT_TOOLS[index])
  ) {
    return { changed: false };
  }
  await fs.mkdir(agentDir, { recursive: true });
  await writeFileAtomically(file, `${JSON.stringify({ ...settings, defaultTools: [...PHIBOT_DEFAULT_TOOLS] }, null, 2)}\n`);
  return { changed: true };
}

/**
 * phi copies its bundled extensions into the agent dir at the first start after
 * an install or an upgrade (`bundled-assets.ts:64-79`, synchronous, up to 60 s).
 * Two runs of one company starting together would copy into the same folder at
 * the same time, and a half-copied extension is fatal outside interactive mode.
 * The first caller runs one short phi command (it triggers the copy, then lists
 * no model); concurrent callers wait for it. One server process: an in-memory
 * lock is enough. Unknown version (phi from PATH without --version): no warm-up.
 * Then `defaultTools` is merged into the agent's settings.json (after the
 * warm-up, which writes that file when it is missing).
 */
export async function ensurePhiAgentDirReady(input: {
  cli: ResolvedPhiCli;
  version: string | null;
  agentDir: string;
  cwd: string;
  env: Record<string, string>;
}): Promise<void> {
  if (input.version && (await readPhiAgentDirStamp(input.agentDir)) !== input.version) {
    let pending = warmUps.get(input.agentDir);
    if (!pending) {
      pending = runChildProcess(
        `phi-warmup-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        input.cli.command,
        [...input.cli.prefixArgs, "--no-skills", "--no-prompt-templates", "--no-context-files", "--list-models", "phibot-warmup"],
        { cwd: input.cwd, env: input.env, timeoutSec: 180, graceSec: 3, onLog: async () => {}, inheritProcessEnv: false },
      )
        .then(
          () => undefined,
          // The run itself retries the copy; never fail a run because of the warm-up.
          () => undefined,
        )
        .finally(() => {
          warmUps.delete(input.agentDir);
        });
      warmUps.set(input.agentDir, pending);
    }
    await pending;
  }
  await ensurePhiDefaultTools(input.agentDir);
}
