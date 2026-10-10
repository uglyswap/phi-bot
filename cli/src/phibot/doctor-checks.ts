import path from "node:path";
import { isSupportedNodeVersion, MINIMUM_NODE_VERSION } from "@paperclipai/shared/node-version";
import type { CheckResult } from "../checks/index.js";
import {
  PHIBOT_BACKUP_DIR,
  PHIBOT_BACKUP_MAX_AGE_MS,
  PHIBOT_COMPANIES_DIR,
  PHIBOT_DOCTOR_MIN_FREE_DISK_BYTES,
  PHIBOT_GUARD_UNIT_NAME,
  PHIBOT_HOME_DIR,
  PHIBOT_MASTER_KEY_PATH,
} from "./constants.js";
import type { PhibotDatabase } from "./database.js";
import { EMBEDDED_POSTGRES_LIB_SUBPATH, type InstallPaths, missingEmbeddedPostgresAliases, readInstalledVersion } from "./global-install.js";
import { isServiceActive, probeHealth } from "./health.js";
import { findCamoufoxLauncher, missingCamoufoxLibraries } from "./phi-assets.js";
import type { SetupMarker } from "./setup.js";
import type { PhibotSystem } from "./system.js";

export type PhibotCheck = () => Promise<CheckResult>;

export interface PhibotDoctorDeps {
  sys: PhibotSystem;
  /** NODE, ROOT and PHIBOT_JS of the installed unit. */
  paths: InstallPaths;
  marker: SetupMarker | null;
  openDatabase: () => PhibotDatabase;
}

/** Tools enabled by `defaultTools` in the agent settings (spec 8.3). */
export const PHIBOT_DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const REPAIR = "sudo phibot doctor --repair";
const EMBEDDING_MODEL = path.posix.join("cache", "models", "Xenova", "all-MiniLM-L6-v2");

const pass = (name: string, message: string): CheckResult => ({ name, status: "pass", message });
const fail = (name: string, message: string, repairHint: string): CheckResult => ({ name, status: "fail", message, repairHint });
const warn = (name: string, message: string, repairHint: string): CheckResult => ({ name, status: "warn", message, repairHint });

function readJson(sys: PhibotSystem, file: string): Record<string, unknown> | null {
  if (!sys.exists(file)) return null;
  try {
    const parsed: unknown = JSON.parse(sys.readFile(file));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function companyIds(sys: PhibotSystem): string[] {
  return sys.listDir(PHIBOT_COMPANIES_DIR).sort();
}

async function serviceCheck(sys: PhibotSystem): Promise<CheckResult> {
  const active = await isServiceActive(sys);
  const health = await probeHealth(sys);
  if (active && health.ok) return pass("Service phibot", "actif, santé ok");
  return fail("Service phibot", `${active ? "actif" : "inactif"}, santé : ${health.ok ? "ok" : (health.error ?? "différente de ok")}`, "sudo phibot service start, puis sudo phibot service logs");
}

async function guardCheck(sys: PhibotSystem): Promise<CheckResult> {
  if (await isServiceActive(sys, PHIBOT_GUARD_UNIT_NAME)) return pass("Garde réseau locale", `${PHIBOT_GUARD_UNIT_NAME} actif`);
  return warn("Garde réseau locale", `${PHIBOT_GUARD_UNIT_NAME} inactif : d'autres comptes du serveur peuvent joindre la base sur 127.0.0.1:54329`, REPAIR);
}

function versionCheck(deps: PhibotDoctorDeps): CheckResult {
  const version = readInstalledVersion(deps.sys, deps.paths.npmRoot);
  return version ? pass("Version de Phi Bot", version) : fail("Version de Phi Bot", `${deps.paths.packageDir}/package.json illisible`, REPAIR);
}

function phiCheck(deps: PhibotDoctorDeps): CheckResult {
  const manifest = readJson(deps.sys, path.posix.join(deps.paths.phiDir, "package.json"));
  const bin = manifest?.bin;
  const relative = typeof bin === "string" ? bin : bin !== null && typeof bin === "object" ? (bin as Record<string, unknown>).phi : undefined;
  if (typeof relative !== "string" || !deps.sys.exists(path.posix.join(deps.paths.phiDir, relative))) {
    return fail("Binaire phi", `introuvable dans ${deps.paths.phiDir}`, REPAIR);
  }
  return pass("Binaire phi", `${path.posix.join(deps.paths.phiDir, relative)} (version ${typeof manifest?.version === "string" ? manifest.version : "inconnue"})`);
}

async function nodeCheck(deps: PhibotDoctorDeps): Promise<CheckResult> {
  const result = await deps.sys.exec(deps.paths.nodePath, ["--version"]);
  const version = result.stdout.trim().replace(/^v/, "");
  if (result.code === 0 && isSupportedNodeVersion(version)) return pass("Node.js du service", version);
  return fail("Node.js du service", `${version || "introuvable"} (minimum ${MINIMUM_NODE_VERSION})`, "Installez Node.js 24 (NodeSource), puis sudo phibot doctor --repair");
}

function aliasesCheck(deps: PhibotDoctorDeps): CheckResult {
  const missing = missingEmbeddedPostgresAliases(deps.sys, path.posix.join(deps.paths.packageDir, EMBEDDED_POSTGRES_LIB_SUBPATH));
  return missing.length === 0 ? pass("Alias de Postgres embarqué", "présents") : fail("Alias de Postgres embarqué", `absents : ${missing.join(", ")}`, REPAIR);
}

/** Problem of one company agent folder (spec 8.3), or null when it is ready. */
function agentDirProblem(sys: PhibotSystem, agentDir: string, phiVersion: string | null): string | null {
  const stampFile = path.posix.join(agentDir, ".bundled-assets-version");
  const stamp = sys.exists(stampFile) ? sys.readFile(stampFile).trim() : null;
  if (!phiVersion || stamp !== phiVersion) return `tampon ${stamp ?? "absent"}, phi ${phiVersion ?? "inconnu"}`;
  const modules = path.posix.join(agentDir, "extensions", "node_modules");
  const names = sys.listDir(modules).flatMap((name) => (name.startsWith("@") ? sys.listDir(path.posix.join(modules, name)).map((child) => `${name}/${child}`) : [name]));
  const broken = names.filter((name) => !sys.exists(path.posix.join(modules, name, "package.json")));
  if (broken.length > 0) return `liens non résolus : ${broken.join(", ")}`;
  const tools = readJson(sys, path.posix.join(agentDir, "settings.json"))?.defaultTools;
  const missing = PHIBOT_DEFAULT_TOOLS.filter((tool) => !Array.isArray(tools) || !tools.includes(tool));
  return missing.length > 0 ? `defaultTools sans ${missing.join(", ")}` : null;
}

function agentDirCheck(deps: PhibotDoctorDeps): CheckResult {
  const name = "Dossier agent de l'entreprise";
  const companies = companyIds(deps.sys);
  if (companies.length === 0) return fail(name, "aucune entreprise préparée", "sudo phibot owner create si aucune entreprise n'existe, sinon sudo phibot doctor --repair");
  const version = readJson(deps.sys, path.posix.join(deps.paths.phiDir, "package.json"))?.version;
  const phiVersion = typeof version === "string" ? version : null;
  for (const company of companies) {
    const problem = agentDirProblem(deps.sys, path.posix.join(PHIBOT_COMPANIES_DIR, company, "agent"), phiVersion);
    if (problem) return fail(name, `${company} : ${problem}`, REPAIR);
  }
  return pass(name, `prêt (phi ${phiVersion})`);
}

async function camoufoxCheck(deps: PhibotDoctorDeps): Promise<CheckResult> {
  const launcher = findCamoufoxLauncher(deps.sys);
  if (!launcher) return fail("Camoufox", "lanceur absent", REPAIR);
  const missing = await missingCamoufoxLibraries(deps.sys, launcher);
  return missing.length === 0 ? pass("Camoufox", launcher) : fail("Camoufox", `bibliothèques manquantes : ${missing.join(", ")}`, REPAIR);
}

function embeddingCheck(deps: PhibotDoctorDeps): CheckResult {
  const companies = companyIds(deps.sys);
  const missing = companies.filter((company) => deps.sys.listDir(path.posix.join(PHIBOT_COMPANIES_DIR, company, "agent", EMBEDDING_MODEL)).length === 0);
  if (companies.length === 0 || missing.length > 0) return fail("Modèle d'embedding", missing.length > 0 ? `absent pour ${missing.join(", ")}` : "absent", REPAIR);
  return pass("Modèle d'embedding", "présent");
}

function masterKeyCheck(deps: PhibotDoctorDeps): CheckResult {
  const mode = deps.sys.fileMode(PHIBOT_MASTER_KEY_PATH);
  if (mode === null) return fail("Clé maîtresse", `${PHIBOT_MASTER_KEY_PATH} absente`, "Remettez en place la copie gardée hors du serveur");
  return mode === 0o600 ? pass("Clé maîtresse", "présente (0600)") : fail("Clé maîtresse", `mode ${mode.toString(8)}`, `sudo chmod 600 ${PHIBOT_MASTER_KEY_PATH}`);
}

function backupCheck(deps: PhibotDoctorDeps): CheckResult {
  const dates = deps.sys
    .listDir(PHIBOT_BACKUP_DIR)
    .filter((name) => /\.(sql\.gz|tar\.gz)$/.test(name))
    .map((name) => deps.sys.modifiedAtMs(path.posix.join(PHIBOT_BACKUP_DIR, name)) ?? 0);
  const newest = Math.max(0, ...dates);
  const ageMs = deps.sys.now().getTime() - newest;
  if (newest > 0 && ageMs < PHIBOT_BACKUP_MAX_AGE_MS) return pass("Dernière sauvegarde", `il y a ${Math.floor(ageMs / 3_600_000)} h`);
  return warn("Dernière sauvegarde", newest > 0 ? `il y a ${Math.floor(ageMs / 3_600_000)} h` : "aucune", "sudo phibot backup --full, et vérifiez que le service tourne (sauvegarde horaire)");
}

function diskCheck(deps: PhibotDoctorDeps): CheckResult {
  const free = deps.sys.freeDiskBytes(PHIBOT_HOME_DIR);
  const gib = (free / 1024 ** 3).toFixed(1);
  if (free > PHIBOT_DOCTOR_MIN_FREE_DISK_BYTES) return pass("Espace disque", `${gib} Gio libres`);
  return fail("Espace disque", `${gib} Gio libres (plus de 5 Gio requis)`, `Libérez de l'espace (anciennes sauvegardes dans ${PHIBOT_BACKUP_DIR})`);
}

async function providerCheck(deps: PhibotDoctorDeps): Promise<CheckResult> {
  const db = deps.openDatabase();
  try {
    const provider = await db.llmProviderValue();
    return provider ? pass("Fournisseur IA", provider) : warn("Fournisseur IA", "non configuré", "Ouvrez Phi Bot et terminez l'assistant (fournisseur, clé API, modèle)");
  } catch (error) {
    return fail("Fournisseur IA", `base injoignable (${error instanceof Error ? error.message : String(error)})`, "sudo phibot service start");
  } finally {
    await db.close();
  }
}

async function httpsCheck(deps: PhibotDoctorDeps, domain: string): Promise<CheckResult> {
  const active = await isServiceActive(deps.sys, "caddy.service");
  const args = ["-fsS", ...(deps.marker?.tlsInternal ? ["-k"] : []), "--max-time", "5", "--resolve", `${domain}:443:127.0.0.1`, `https://${domain}/api/health`];
  const https = await deps.sys.exec("curl", args);
  if (active && https.code === 0 && https.stdout.includes('"status":"ok"')) return pass("Accès HTTPS", `https://${domain}`);
  return fail("Accès HTTPS", `caddy.service ${active ? "actif" : "inactif"}, https://${domain} ${https.code === 0 ? "sans santé ok" : "injoignable"}`, REPAIR);
}

/** Spec 13.5. Only the `phibot doctor` command runs them, never `phibot run` (review M2). */
export function phibotDoctorChecks(deps: PhibotDoctorDeps): PhibotCheck[] {
  const checks: PhibotCheck[] = [
    () => serviceCheck(deps.sys),
    () => guardCheck(deps.sys),
    async () => versionCheck(deps),
    async () => phiCheck(deps),
    () => nodeCheck(deps),
    async () => aliasesCheck(deps),
    async () => agentDirCheck(deps),
    () => camoufoxCheck(deps),
    async () => (deps.sys.exists("/usr/bin/Xvfb") ? pass("Xvfb", "présent") : fail("Xvfb", "absent", REPAIR)),
    async () => embeddingCheck(deps),
    async () => masterKeyCheck(deps),
    async () => backupCheck(deps),
    async () => diskCheck(deps),
    () => providerCheck(deps),
  ];
  const domain = deps.marker?.access === "domain" ? deps.marker.domain : undefined;
  if (domain) checks.push(() => httpsCheck(deps, domain));
  return checks;
}
