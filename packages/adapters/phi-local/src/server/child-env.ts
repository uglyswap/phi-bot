/**
 * Environment of the phi child process, built from scratch.
 *
 * The Phi Bot server process holds DATABASE_URL, BETTER_AUTH_SECRET,
 * PAPERCLIP_AGENT_JWT_SECRET, PAPERCLIP_SECRETS_MASTER_KEY and possibly the
 * operator's own provider keys. None of them may reach phi. Only the names
 * below are copied from the server environment; the run environment that
 * Paperclip resolved for this run (PAPERCLIP_*, adapterConfig.env, the
 * environment's envVars, scratch and git variables) is kept as-is.
 */
export const INHERITED_ENV_ALLOWLIST: readonly string[] = [
  // POSIX basics
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  // TLS and outbound proxies (reaching the LLM provider from a corporate network)
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  // Windows: Node cannot start without SYSTEMROOT (crypto init aborts)
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "COMMONPROGRAMFILES",
  "SYSTEMDRIVE",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
];

/** Prefixes copied from the server environment (locale categories). */
export const INHERITED_ENV_PREFIX_ALLOWLIST: readonly string[] = ["LC_"];

const ALLOWED = new Set(INHERITED_ENV_ALLOWLIST.map((key) => key.toUpperCase()));

/** Comparison is case-insensitive: Windows keys keep their casing (`Path`, `SystemRoot`). */
export function isInheritedEnvKeyAllowed(key: string): boolean {
  const upper = key.toUpperCase();
  return ALLOWED.has(upper) || INHERITED_ENV_PREFIX_ALLOWLIST.some((prefix) => upper.startsWith(prefix));
}

/** Set `key`, removing any other spelling of it on Windows (`Path` versus `PATH`). */
export function setChildEnvKey(
  env: Record<string, string>,
  key: string,
  value: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") {
    const upper = key.toUpperCase();
    for (const existing of Object.keys(env)) {
      if (existing !== key && existing.toUpperCase() === upper) delete env[existing];
    }
  }
  env[key] = value;
}

/** Name actually used for PATH in `env` (`Path` on most Windows hosts). */
export function pathKeyOf(env: Record<string, string>): string {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

export interface BuildPhiChildEnvInput {
  /** The server process environment (`process.env`); only allowlisted names are kept. */
  inherited: NodeJS.ProcessEnv;
  /** Environment Paperclip resolved for this run; kept as-is. */
  runEnv: Record<string, string>;
  /** Variables the adapter imposes (provider key, PHI_*); applied last. */
  forced: Record<string, string>;
  /** Directories prepended to PATH (skill `bin/` folders). */
  prependPath?: string[];
  platform?: NodeJS.Platform;
}

export function buildPhiChildEnv(input: BuildPhiChildEnvInput): Record<string, string> {
  const platform = input.platform ?? process.platform;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.inherited)) {
    if (typeof value !== "string") continue;
    if (!isInheritedEnvKeyAllowed(key)) continue;
    setChildEnvKey(env, key, value, platform);
  }
  for (const [key, value] of Object.entries(input.runEnv)) {
    if (typeof value === "string") setChildEnvKey(env, key, value, platform);
  }
  for (const [key, value] of Object.entries(input.forced)) {
    setChildEnvKey(env, key, value, platform);
  }
  const additions = (input.prependPath ?? []).filter((dir) => dir.length > 0);
  if (additions.length > 0) {
    const pathKey = pathKeyOf(env);
    const delimiter = platform === "win32" ? ";" : ":";
    const existing = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
    const fresh = additions.filter((dir) => !existing.includes(dir));
    if (fresh.length > 0) env[pathKey] = [...fresh, ...existing].join(delimiter);
  }
  return env;
}
