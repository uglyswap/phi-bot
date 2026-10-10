import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { updateEnvFileContents, writeEnvFileAtomicallyIfChanged } from "@paperclipai/shared/env-file";
import { ensureAgentJwtSecret, ensureToolActionSigningSecret, readPaperclipEnvEntries } from "../config/env.js";
import { type AuthConfig, type PaperclipConfig, paperclipConfigSchema } from "../config/schema.js";
import { ensureLocalSecretsKeyFile } from "../config/secrets-key.js";
import { buildCustomServerConfig } from "../config/server-bind.js";
import { readConfig, writeConfig } from "../config/store.js";
import { PHIBOT_DB_PORT, PHIBOT_LOCAL_URL, PHIBOT_SERVER_PORT, PHIBOT_SSH_PUBLIC_URL } from "./constants.js";
import { normalizeDomain } from "./units.js";

export type PhibotAccess = "domain" | "ssh" | "tailscale";

export interface PhibotExposure {
  access: PhibotAccess | "container";
  publicUrl: string;
  allowedHostnames: string[];
  /** auth.baseUrlMode "explicit" with publicUrl, otherwise "auto". */
  explicitBaseUrl: boolean;
  bindHost: "127.0.0.1" | "0.0.0.0";
}

export const PHIBOT_ADAPTERS_JSON = '[{"adapterType":"phi_local"}]\n';
export const PHIBOT_HIDDEN_SETTINGS =
  "instance.adapters,instance.plugins,instance.experimental,instance.environments,company.import,instance.general.feedbackDataSharingPreference";

/** Spec 4.4 and 6.2 step 6 for a systemd install. */
export function resolveExposure(input: { access: PhibotAccess; domain?: string; tailnetName?: string }): PhibotExposure {
  if (input.access === "domain") {
    if (!input.domain) throw new Error("L'accès « domain » exige --domain <fqdn>.");
    const domain = normalizeDomain(input.domain);
    return { access: "domain", publicUrl: `https://${domain}`, allowedHostnames: [domain], explicitBaseUrl: true, bindHost: "127.0.0.1" };
  }
  if (input.access === "tailscale") {
    if (!input.tailnetName) throw new Error("Nom Tailscale introuvable (tailscale status --json, champ Self.DNSName).");
    const name = input.tailnetName.toLowerCase();
    return { access: "tailscale", publicUrl: `https://${name}`, allowedHostnames: [name], explicitBaseUrl: true, bindHost: "127.0.0.1" };
  }
  return { access: "ssh", publicUrl: PHIBOT_SSH_PUBLIC_URL, allowedHostnames: [], explicitBaseUrl: false, bindHost: "127.0.0.1" };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Spec 14: inside the Docker image the URL and host names come from the environment. */
export function resolveContainerExposure(env: NodeJS.ProcessEnv): PhibotExposure {
  const publicUrl = (env.PAPERCLIP_PUBLIC_URL?.trim() || PHIBOT_SSH_PUBLIC_URL).replace(/\/+$/, "");
  let host: string;
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
    host = url.hostname.toLowerCase();
  } catch {
    throw new Error(`PAPERCLIP_PUBLIC_URL invalide : « ${publicUrl} » (attendu : http(s)://<nom>[:port]).`);
  }
  const fromEnv = (env.PAPERCLIP_ALLOWED_HOSTNAMES ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const isLocal = LOCAL_HOSTS.has(host);
  const allowedHostnames = [...new Set([...fromEnv, ...(isLocal ? [] : [host])])];
  return { access: "container", publicUrl, allowedHostnames, explicitBaseUrl: !isLocal, bindHost: "0.0.0.0" };
}

function joinFor(root: string): (...parts: string[]) => string {
  // Linux paths stay POSIX even when this code runs on Windows (tests).
  return root.startsWith("/") ? (...parts) => path.posix.join(root, ...parts) : (...parts) => path.join(root, ...parts);
}

/** buildCustomServerConfig only writes "explicit" for public exposure: the auth block is always set here. */
export function buildPhibotAuth(exposure: PhibotExposure): AuthConfig {
  return exposure.explicitBaseUrl
    ? { baseUrlMode: "explicit", publicBaseUrl: exposure.publicUrl, disableSignUp: false }
    : { baseUrlMode: "auto", disableSignUp: false };
}

/** config.json of spec 6.2 step 6: upstream onboarding defaults plus the Phi Bot server and auth values. */
export function buildPhibotConfig(input: { instanceRoot: string; exposure: PhibotExposure; now: Date }): PaperclipConfig {
  const join = joinFor(input.instanceRoot);
  const { server } = buildCustomServerConfig({
    deploymentMode: "authenticated",
    exposure: "private",
    host: input.exposure.bindHost,
    port: PHIBOT_SERVER_PORT,
    allowedHostnames: input.exposure.allowedHostnames,
    serveUi: true,
  });
  return {
    $meta: { version: 1, updatedAt: input.now.toISOString(), source: "onboard" },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: join("db"),
      embeddedPostgresPort: PHIBOT_DB_PORT,
      backup: { enabled: true, intervalMinutes: 60, retentionDays: 30, dir: join("data", "backups") },
    },
    logging: { mode: "file", logDir: join("logs") },
    server,
    auth: buildPhibotAuth(input.exposure),
    telemetry: { enabled: false },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: join("data", "storage") },
      s3: { bucket: "paperclip", region: "us-east-1", prefix: "", forcePathStyle: false },
    },
    secrets: { provider: "local_encrypted", strictMode: false, localEncrypted: { keyFilePath: join("secrets", "master.key") } },
  };
}

/** Annex A, ".env" part, without the two secrets written by the upstream helpers. */
export function buildPhibotEnvEntries(input: { publicUrl: string; adaptersPath: string; betterAuthSecret: string }): Record<string, string> {
  return {
    BETTER_AUTH_SECRET: input.betterAuthSecret,
    PAPERCLIP_PUBLIC_URL: input.publicUrl,
    PAPERCLIP_API_URL: PHIBOT_LOCAL_URL,
    PAPERCLIP_ADAPTERS_FILE: input.adaptersPath,
    PAPERCLIP_HIDDEN_SETTINGS: PHIBOT_HIDDEN_SETTINGS,
    PAPERCLIP_ONBOARDING_SEED_ADAPTER_TYPE: "phi_local",
    PAPERCLIP_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE: "phi_local",
    PAPERCLIP_TELEMETRY_DISABLED: "1",
    PAPERCLIP_ANNOUNCEMENTS_ENABLED: "false",
    PAPERCLIP_FEEDBACK_EXPORT_BACKEND_URL: "http://127.0.0.1:9",
    PAPERCLIP_SETTING_DEFAULTS: '{"feedbackDataSharingPreference":"not_allowed"}',
    PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
    PAPERCLIP_UPDATE_CHECK: "0",
    PAPERCLIP_DISABLE_CWD_ENV_FILE: "true",
    PHIBOT_SINGLE_COMPANY: "true",
    PHIBOT_INVITE_ONLY_SIGNUP: "true",
    PHIBOT_DISABLE_BROWSER_CLAIM: "true",
  };
}

/**
 * Appends `KEY=value` lines (unquoted, so dotenv keeps the JSON value intact) for keys that
 * are not assigned yet; existing assignments are never changed.
 */
export function appendMissingEnvEntries(existing: string, entries: Record<string, string>): { contents: string; added: string[] } {
  const present = new Set<string>();
  for (const line of existing.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) present.add(match[1]);
  }
  const added = Object.keys(entries).filter((key) => !present.has(key));
  for (const key of added) {
    if (/[\r\n#]/.test(entries[key]) || entries[key] !== entries[key].trim()) {
      throw new Error(`Valeur non représentable sans guillemets dans .env : ${key}`);
    }
  }
  const base = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  return { contents: base + added.map((key) => `${key}=${entries[key]}\n`).join(""), added };
}

export interface InstanceFilesResult {
  /** Files created or rewritten by this call. */
  touchedFiles: string[];
  /** Directories created by this call. */
  createdDirs: string[];
  envKeysAdded: string[];
}

function readIfExists(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

/** Step 6: creates the missing instance files and keeps every existing file and secret. */
export function writeInstanceFiles(input: { instanceRoot: string; exposure: PhibotExposure; now: Date }): InstanceFilesResult {
  const join = joinFor(input.instanceRoot);
  const result: InstanceFilesResult = { touchedFiles: [], createdDirs: [], envKeysAdded: [] };
  if (!fs.existsSync(input.instanceRoot)) {
    fs.mkdirSync(input.instanceRoot, { recursive: true, mode: 0o700 });
    result.createdDirs.push(input.instanceRoot);
  }
  const configPath = join("config.json");
  const envPath = join(".env");
  const adaptersPath = join("adapters.json");

  if (!fs.existsSync(configPath)) {
    writeConfig(buildPhibotConfig(input), configPath);
    result.touchedFiles.push(configPath);
  }
  const config = readConfig(configPath);
  if (!config) throw new Error(`Configuration illisible : ${configPath}`);

  // A secret already present in this process environment (for example from another
  // instance) must not stop the upstream helpers from writing this instance's .env.
  const envBefore = readIfExists(envPath);
  const fileEntries = readPaperclipEnvEntries(envPath);
  for (const key of ["PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET"]) {
    if (!fileEntries[key]) delete process.env[key];
  }
  ensureAgentJwtSecret(configPath);
  ensureToolActionSigningSecret(configPath);
  const previous = fs.readFileSync(envPath, "utf8");
  const next = appendMissingEnvEntries(
    previous,
    buildPhibotEnvEntries({ publicUrl: input.exposure.publicUrl, adaptersPath, betterAuthSecret: randomBytes(32).toString("hex") }),
  );
  writeEnvFileAtomicallyIfChanged(envPath, previous, next.contents);
  result.envKeysAdded = next.added;
  if (envBefore !== next.contents) result.touchedFiles.push(envPath);

  if (!fs.existsSync(adaptersPath)) {
    fs.writeFileSync(adaptersPath, PHIBOT_ADAPTERS_JSON, { mode: 0o600 });
    result.touchedFiles.push(adaptersPath);
  }

  const secretsDir = join("secrets");
  const secretsDirExisted = fs.existsSync(secretsDir);
  const key = ensureLocalSecretsKeyFile(config, configPath);
  if (key.status === "created") {
    if (!secretsDirExisted) result.createdDirs.push(secretsDir);
    result.touchedFiles.push(key.path);
  }
  return result;
}

/**
 * `setup --reconfigure` and `--restore`: new public URL and host names, everything else kept.
 * The JSON is rewritten in place (temporary file then rename) and validated by the upstream schema.
 * Returns the rewritten files.
 */
export function applyExposureToInstance(input: { instanceRoot: string; exposure: PhibotExposure }): string[] {
  const join = joinFor(input.instanceRoot);
  const configPath = join("config.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown> & { server?: Record<string, unknown> };
  const next = { ...raw, server: { ...raw.server, allowedHostnames: input.exposure.allowedHostnames }, auth: buildPhibotAuth(input.exposure) };
  paperclipConfigSchema.parse(next);
  const touched: string[] = [];
  const serialized = `${JSON.stringify(next, null, 2)}
`;
  if (serialized !== fs.readFileSync(configPath, "utf8")) {
    const temporary = `${configPath}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, serialized, { mode: 0o600 });
    fs.renameSync(temporary, configPath);
    touched.push(configPath);
  }
  const envPath = join(".env");
  const previous = fs.readFileSync(envPath, "utf8");
  const nextEnv = updateEnvFileContents(previous, { PAPERCLIP_PUBLIC_URL: input.exposure.publicUrl }, { valueEncoding: "minimal" });
  if (writeEnvFileAtomicallyIfChanged(envPath, previous, nextEnv)) touched.push(envPath);
  return touched;
}
