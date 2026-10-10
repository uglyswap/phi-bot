import os from "node:os";
import path from "node:path";

/**
 * Root of the phi data that Phi Bot owns on this server: `$PHIBOT_HOME`, else
 * `~/.phi/phibot`. Kept apart from `~/.phi/agent` so the server operator's own
 * phi profile (auth.json, settings, extensions) never leaks into agent runs:
 * phi reads auth.json before environment variables.
 */
export function resolvePhiBotRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PHIBOT_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".phi", "phibot");
}

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

function safeSegment(value: string, label: string): string {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(`Invalid ${label} for a phi data path: ${JSON.stringify(value)}`);
  }
  return value;
}

export interface PhiCompanyPaths {
  /** `<root>/companies/<companyId>` */
  companyRoot: string;
  /** Dedicated phi agent dir, passed as PHI_CODING_AGENT_DIR. */
  agentDir: string;
  /** Parent of every agent's session directory. */
  sessionsDir: string;
  /** Parent of the per-run scratch directories (system prompt file, MCP config). */
  runsDir: string;
}

export function resolvePhiCompanyPaths(
  companyId: string,
  env: NodeJS.ProcessEnv = process.env,
): PhiCompanyPaths {
  const companyRoot = path.join(resolvePhiBotRoot(env), "companies", safeSegment(companyId, "companyId"));
  return {
    companyRoot,
    agentDir: path.join(companyRoot, "agent"),
    sessionsDir: path.join(companyRoot, "sessions"),
    runsDir: path.join(companyRoot, "runs"),
  };
}

export function resolvePhiAgentSessionsDir(
  companyId: string,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolvePhiCompanyPaths(companyId, env).sessionsDir, safeSegment(agentId, "agentId"));
}

export function resolvePhiRunDir(
  companyId: string,
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolvePhiCompanyPaths(companyId, env).runsDir, safeSegment(runId, "runId"));
}

/** Agent dir used only to read phi's bundled model catalog (`--list-models`). */
export function resolvePhiCatalogAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolvePhiBotRoot(env), "catalog-agent");
}

/** True when `candidate` is `parent` or lies inside it (both absolute). */
export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
