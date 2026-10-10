import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { PHI_PACKAGE_NAME } from "../index.js";

export interface ResolvedPhiCli {
  /** Executable to spawn: the Node binary running the server, or `phi` from PATH. */
  command: string;
  /** Arguments placed before phi's own arguments (the CLI script when launched through Node). */
  prefixArgs: string[];
  /** Version read from the package, or null when phi comes from PATH. */
  version: string | null;
  source: "env" | "package" | "path";
  /** Location shown in logs and environment checks. */
  displayPath: string;
}

interface PackageJsonShape {
  name?: unknown;
  version?: unknown;
  bin?: unknown;
}

function readPackageJson(file: string): PackageJsonShape | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as PackageJsonShape) : null;
  } catch {
    return null;
  }
}

function readPhiBinEntry(pkg: PackageJsonShape): string | null {
  if (typeof pkg.bin === "string") return pkg.bin;
  if (typeof pkg.bin === "object" && pkg.bin !== null) {
    const entry = (pkg.bin as Record<string, unknown>).phi;
    if (typeof entry === "string") return entry;
  }
  return null;
}

/**
 * Find the installed `@phi-code-admin/phi-code` directory by walking the same
 * node_modules folders Node would use from `fromFile`. `require.resolve` on
 * "<pkg>/package.json" cannot be used: the package declares an "exports" map
 * without "./package.json" (ERR_PACKAGE_PATH_NOT_EXPORTED).
 */
export function findPhiPackageDir(fromFile: string): string | null {
  const require = createRequire(fromFile);
  const lookupDirs = require.resolve.paths(PHI_PACKAGE_NAME) ?? [];
  for (const nodeModulesDir of lookupDirs) {
    const candidate = path.join(nodeModulesDir, PHI_PACKAGE_NAME);
    const pkg = readPackageJson(path.join(candidate, "package.json"));
    if (pkg?.name === PHI_PACKAGE_NAME) return candidate;
  }
  return null;
}

/**
 * Resolve how to launch phi, in this order:
 * 1. `PHIBOT_PHI_CLI` (absolute path to phi's `dist/cli.js`, development and tests),
 * 2. the `@phi-code-admin/phi-code` package installed next to Phi Bot, launched with
 *    the server's own Node binary (no PATH, no shell, no `.cmd` shim on Windows),
 * 3. `phi` from PATH.
 */
export function resolvePhiCli(
  options: { env?: NodeJS.ProcessEnv; fromFile?: string } = {},
): ResolvedPhiCli {
  const env = options.env ?? process.env;
  const override = env.PHIBOT_PHI_CLI?.trim();
  if (override) {
    const script = path.resolve(override);
    return { command: process.execPath, prefixArgs: [script], version: null, source: "env", displayPath: script };
  }

  const packageDir = findPhiPackageDir(options.fromFile ?? fileURLToPath(import.meta.url));
  if (packageDir) {
    const pkg = readPackageJson(path.join(packageDir, "package.json"));
    const binEntry = pkg ? readPhiBinEntry(pkg) : null;
    if (binEntry) {
      const script = path.resolve(packageDir, binEntry);
      if (fs.existsSync(script)) {
        return {
          command: process.execPath,
          prefixArgs: [script],
          version: typeof pkg?.version === "string" ? pkg.version : null,
          source: "package",
          displayPath: script,
        };
      }
    }
  }

  return { command: "phi", prefixArgs: [], version: null, source: "path", displayPath: "phi" };
}

const versionCache = new Map<string, string | null>();

/** Version of the resolved CLI; runs `phi --version` once when the package did not say. */
export async function readPhiCliVersion(
  cli: ResolvedPhiCli,
  input: { cwd: string; env: Record<string, string> },
): Promise<string | null> {
  if (cli.version) return cli.version;
  const cacheKey = `${cli.command}\u0000${cli.prefixArgs.join("\u0000")}`;
  if (versionCache.has(cacheKey)) return versionCache.get(cacheKey) ?? null;
  let version: string | null = null;
  try {
    const result = await runChildProcess(
      `phi-version-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      cli.command,
      [...cli.prefixArgs, "--version"],
      { cwd: input.cwd, env: input.env, timeoutSec: 20, graceSec: 3, onLog: async () => {}, inheritProcessEnv: false },
    );
    const match = /\d+\.\d+\.\d+/.exec(result.stdout);
    version = (result.exitCode ?? 1) === 0 && match ? match[0] : null;
  } catch {
    version = null;
  }
  versionCache.set(cacheKey, version);
  return version;
}

/** Numeric x.y.z comparison; pre-release suffixes are ignored. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) =>
    value.split("-")[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function resetPhiCliVersionCacheForTests() {
  versionCache.clear();
}
