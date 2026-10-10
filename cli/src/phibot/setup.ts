import path from "node:path";
import { readConfig } from "../config/store.js";
import type { AuthConfig } from "../config/schema.js";
import { installSystemPackages } from "./apt.js";
import { configureCaddy, removeManagedCaddy } from "./caddy.js";
import {
  CADDY_ARCHIVE_SHA512,
  PHIBOT_ADAPTERS_PATH,
  PHIBOT_CONFIG_PATH,
  PHIBOT_ENV_PATH,
  PHIBOT_HEALTH_TIMEOUT_MS,
  PHIBOT_HOME_DIR,
  PHIBOT_INSTANCE_ROOT,
  PHIBOT_MASTER_KEY_PATH,
  PHIBOT_PAPERCLIP_HOME,
  PHIBOT_SETUP_MARKER_PATH,
  PHIBOT_SYSTEM_USER,
  PHIBOT_UNIT_NAME,
  PHIBOT_UNIT_PATH,
} from "./constants.js";
import { openPhibotDatabase, type PhibotDatabase } from "./database.js";
import { type AliasFunction, ensureGlobalInstall, type InstallPaths } from "./global-install.js";
import { installLocalGuard } from "./guard.js";
import { serviceJournalTail, waitForServiceHealthy } from "./health.js";
import {
  applyExposureToInstance,
  type InstanceFilesResult,
  type PhibotAccess,
  type PhibotExposure,
  resolveExposure,
  writeInstanceFiles,
} from "./instance-config.js";
import { collectOwnerInfo, createOwnerHttp, ensureOwnerAndCompany, type OwnerHttp, type OwnerInfo, resolveAuthOrigin } from "./owner.js";
import { preparePhiAssets } from "./phi-assets.js";
import { checkAccess, requireRoot, runPreflightChecks } from "./preflight.js";
import { buildCleanPhibotCommand, execAsPhibot } from "./relaunch.js";
import { type PhibotLogger, type PhibotPrompter, type PhibotSystem, PhibotStepError, execOrThrow } from "./system.js";
import { disableTailscaleServe, enableTailscaleServe } from "./tailscale.js";
import { renderPhibotUnit } from "./units.js";

export interface SetupOptions {
  domain?: string;
  acmeEmail?: string;
  access?: string;
  company?: string;
  ownerName?: string;
  ownerEmail?: string;
  ownerPasswordFile?: string;
  yes?: boolean;
  repair?: boolean;
  reconfigure?: boolean;
  restore?: string;
  tlsInternal?: boolean;
}

/** Content of `.phibot-setup-complete`: what `--repair`, `--reconfigure` and `uninstall` replay. */
export interface SetupMarker {
  version: string;
  access: PhibotAccess;
  domain?: string;
  acmeEmail?: string;
  tlsInternal?: boolean;
  completedAt: string;
}

export interface SetupDeps {
  sys: PhibotSystem;
  logger: PhibotLogger;
  prompter: PhibotPrompter;
  cliVersion: string;
  openDatabase?: () => PhibotDatabase;
  ownerHttp?: (authOrigin: string) => OwnerHttp;
  writeInstance?: (input: { instanceRoot: string; exposure: PhibotExposure; now: Date }) => InstanceFilesResult;
  applyExposure?: (input: { instanceRoot: string; exposure: PhibotExposure }) => string[];
  readInstanceAuth?: () => AuthConfig;
  loadAliasFunction?: (packageDir: string) => Promise<AliasFunction>;
  resolveCamoufoxJsDir?: (phiDir: string) => string;
  caddySha512?: string;
}

export type SetupMode = "install" | "already-installed" | "repair" | "reconfigure" | "restore";

const ACCESS_VALUES: readonly PhibotAccess[] = ["domain", "ssh", "tailscale"];

/** Spec 6.2 rules: --domain implies domain, ssh by default; repair and reconfigure need an install. */
export function resolveSetupMode(options: SetupOptions, marker: SetupMarker | null): SetupMode {
  const chosen = [options.repair, options.reconfigure, options.restore !== undefined].filter(Boolean).length;
  if (chosen > 1) throw new PhibotStepError("Options", "--repair, --reconfigure et --restore s'excluent.", "Choisissez une seule de ces options.");
  if (options.restore !== undefined) {
    if (marker) throw new PhibotStepError("Options", "--restore s'utilise sur un serveur neuf, Phi Bot est déjà installé ici.", "Utilisez sudo phibot db:restore <archive>.");
    return "restore";
  }
  if (!marker) {
    if (options.repair || options.reconfigure) throw new PhibotStepError("Options", "Phi Bot n'est pas encore installé sur ce serveur.", "Lancez d'abord sudo phibot setup.");
    return "install";
  }
  if (options.repair) return "repair";
  if (options.reconfigure) return "reconfigure";
  return "already-installed";
}

export function resolveAccess(options: SetupOptions): { access: PhibotAccess; domain?: string } {
  const access = options.access ?? (options.domain ? "domain" : "ssh");
  if (!ACCESS_VALUES.includes(access as PhibotAccess)) throw new PhibotStepError("Options", `--access ${access} inconnu.`, "Utilisez --access domain, ssh ou tailscale.");
  if (access === "domain" && !options.domain) throw new PhibotStepError("Options", "l'accès domain exige --domain <fqdn>.", "Ajoutez --domain bot.exemple.fr.");
  if (access !== "domain" && options.domain) throw new PhibotStepError("Options", `--domain n'a pas de sens avec --access ${access}.`, "Retirez --domain ou utilisez --access domain.");
  return access === "domain" ? { access, domain: options.domain } : { access: access as PhibotAccess };
}

export function readSetupMarker(sys: PhibotSystem): SetupMarker | null {
  if (!sys.exists(PHIBOT_SETUP_MARKER_PATH)) return null;
  try {
    const parsed = JSON.parse(sys.readFile(PHIBOT_SETUP_MARKER_PATH)) as Partial<SetupMarker>;
    if (parsed.access && ACCESS_VALUES.includes(parsed.access)) return parsed as SetupMarker;
  } catch {
    // An unreadable marker (older format, manual edit) still means "installed": ssh is the safe default.
  }
  return { version: "inconnue", access: "ssh", completedAt: "" };
}

export async function writeMarker(sys: PhibotSystem, marker: SetupMarker): Promise<void> {
  sys.writeFile(PHIBOT_SETUP_MARKER_PATH, `${JSON.stringify(marker, null, 2)}\n`, 0o600);
  await execOrThrow(sys, "chown", [`${PHIBOT_SYSTEM_USER}:${PHIBOT_SYSTEM_USER}`, PHIBOT_SETUP_MARKER_PATH], { step: "Fin", fix: `Lancez chown phibot:phibot ${PHIBOT_SETUP_MARKER_PATH}.` });
}

/** Step 4. */
export async function ensureSystemAccount(sys: PhibotSystem, logger: PhibotLogger): Promise<void> {
  const fix = { step: "Compte système", fix: "Créez le compte à la main (useradd --system --create-home --home-dir /var/lib/phibot --shell /usr/sbin/nologin phibot) puis relancez la commande." };
  if ((await sys.exec("getent", ["passwd", PHIBOT_SYSTEM_USER])).code !== 0) {
    await execOrThrow(sys, "useradd", ["--system", "--create-home", "--home-dir", PHIBOT_HOME_DIR, "--shell", "/usr/sbin/nologin", PHIBOT_SYSTEM_USER], fix);
    logger.success("Compte système phibot créé.");
  }
  await execOrThrow(sys, "chmod", ["0700", PHIBOT_HOME_DIR], fix);
}

/** The files of step 6 (spec 4.2): owned by phibot, 0600, in a 0700 secrets folder. */
export const INSTANCE_FILES = [PHIBOT_CONFIG_PATH, PHIBOT_ENV_PATH, PHIBOT_ADAPTERS_PATH, PHIBOT_MASTER_KEY_PATH] as const;
const SECRETS_DIR = path.posix.dirname(PHIBOT_MASTER_KEY_PATH);

/**
 * Rights of step 6 (spec 6.2, review M8): `chown -R` only when the instance folder was just created,
 * then only the files of the step. Never a recursive chmod: it would strip the execute bit from the
 * agents' repositories.
 */
export async function applyInstanceRights(sys: PhibotSystem, created: boolean): Promise<void> {
  const fix = { step: "Configuration de l'instance", fix: `Vérifiez les droits de ${PHIBOT_PAPERCLIP_HOME} puis relancez sudo phibot setup --repair.` };
  const owner = `${PHIBOT_SYSTEM_USER}:${PHIBOT_SYSTEM_USER}`;
  if (created) await execOrThrow(sys, "chown", ["-R", owner, PHIBOT_PAPERCLIP_HOME], fix);
  await execOrThrow(sys, "chown", [owner, SECRETS_DIR, ...INSTANCE_FILES], fix);
  await execOrThrow(sys, "chmod", ["0700", SECRETS_DIR], fix);
  await execOrThrow(sys, "chmod", ["0600", ...INSTANCE_FILES], fix);
}

/** Step 6: missing files and secrets are created, existing ones kept, then the rights. */
export async function writeInstanceStep(deps: SetupDeps, exposure: PhibotExposure): Promise<void> {
  const created = !deps.sys.exists(PHIBOT_INSTANCE_ROOT);
  (deps.writeInstance ?? writeInstanceFiles)({ instanceRoot: PHIBOT_INSTANCE_ROOT, exposure, now: deps.sys.now() });
  await applyInstanceRights(deps.sys, created);
}

/** Step 8 (spec 6.3, review M10): guard, unit, enable and (re)start, then health (review B2). */
export async function installServiceStep(deps: SetupDeps, paths: InstallPaths): Promise<void> {
  const { sys, logger } = deps;
  await installLocalGuard(sys, logger);
  sys.writeFile(PHIBOT_UNIT_PATH, renderPhibotUnit({ nodePath: paths.nodePath, phibotJsPath: paths.phibotJsPath }), 0o644);
  const fix = { step: "Service", fix: "Consultez sudo phibot service logs puis relancez sudo phibot setup --repair." };
  await execOrThrow(sys, "systemctl", ["daemon-reload"], fix);
  await execOrThrow(sys, "systemctl", ["enable", PHIBOT_UNIT_NAME], fix);
  await execOrThrow(sys, "systemctl", ["restart", PHIBOT_UNIT_NAME], fix);
  logger.step("Démarrage du service phibot (5 minutes au plus au premier démarrage)...");
  const health = await waitForServiceHealthy(sys, PHIBOT_HEALTH_TIMEOUT_MS);
  if (!health.healthy) {
    logger.error(await serviceJournalTail(sys, 100));
    throw new PhibotStepError("Service", `le service ne répond pas (${health.last.error ?? "santé différente de ok"}).`, "Lisez les 100 lignes du journal ci-dessus, corrigez, puis relancez sudo phibot setup --repair.");
  }
  logger.success("Service phibot démarré.");
}

/** Step 9b (review M5): the company is always read in the database, then phi:prepare runs as phibot. */
export async function preparePhiForInstalledCompany(deps: SetupDeps, paths: InstallPaths, db: PhibotDatabase): Promise<string | null> {
  const ids = await db.companyIds();
  if (ids.length === 0) return null;
  if (ids.length > 1) throw new PhibotStepError("Préparation de phi pour l'entreprise", `${ids.length} entreprises en base (une seule attendue).`, "Contactez le support Phi Bot.");
  const command = buildCleanPhibotCommand(paths.nodePath, [paths.phibotJsPath, "phi:prepare", "--company", ids[0]], deps.sys.env);
  const result = await execAsPhibot(deps.sys, command, { inherit: true });
  if (result.code !== 0) {
    throw new PhibotStepError("Préparation de phi pour l'entreprise", `phi:prepare a échoué (code ${result.code}).`, "Vérifiez l'accès réseau (modèle d'embedding sur huggingface.co) puis relancez sudo phibot setup --repair.");
  }
  return ids[0];
}

/** Step 10. */
export async function exposeStep(deps: SetupDeps, target: { access: PhibotAccess; domain?: string; acmeEmail?: string; tlsInternal?: boolean }): Promise<void> {
  if (target.access === "domain" && target.domain) {
    await configureCaddy(deps.sys, deps.logger, { domain: target.domain, acmeEmail: target.acmeEmail, tlsInternal: target.tlsInternal }, deps.caddySha512 ?? CADDY_ARCHIVE_SHA512);
  } else if (target.access === "tailscale") {
    await enableTailscaleServe(deps.sys);
  }
}

export function printSummary(deps: SetupDeps, exposure: PhibotExposure, ownerEmail: string | null): void {
  const { logger, sys } = deps;
  logger.success(`Phi Bot est prêt : ${exposure.publicUrl}${ownerEmail ? ` (propriétaire : ${ownerEmail})` : ""}`);
  if (exposure.access === "ssh") {
    logger.info("Accès par tunnel SSH, depuis votre poste : ssh -N -L 3100:127.0.0.1:3100 <utilisateur>@<serveur> puis ouvrez http://localhost:3100");
    logger.warn(
      "Les liens d'invitation de coéquipiers pointeront sur http://localhost:3100 : chaque coéquipier aura besoin d'un tunnel SSH. Pour une équipe, préférez un domaine ou Tailscale : sudo phibot setup --reconfigure --access domain --domain <fqdn>.",
    );
  }
  logger.info("Commandes utiles : sudo phibot service status | sudo phibot service logs | sudo phibot update | sudo phibot backup --full");
  logger.warn(`Copiez hors du serveur ${PHIBOT_MASTER_KEY_PATH} : sans elle, la clé du fournisseur IA et les autres secrets sont perdus.`);
  const leftovers = ["/root/.cache/phi-code", "/root/.npm/_npx"].filter((dir) => sys.exists(dir));
  if (leftovers.length > 0) {
    logger.info(`Fichiers temporaires de l'installation (inutiles désormais) : vous pouvez lancer sudo rm -rf ${leftovers.join(" ")}`);
  }
}

function readAuth(deps: SetupDeps): AuthConfig {
  if (deps.readInstanceAuth) return deps.readInstanceAuth();
  const config = readConfig(PHIBOT_CONFIG_PATH);
  if (!config) throw new PhibotStepError("Propriétaire et entreprise", `configuration introuvable : ${PHIBOT_CONFIG_PATH}.`, "Relancez sudo phibot setup.");
  return config.auth;
}

/** Step 9 then 9b, with the database of the running service. */
export async function ownerAndPhiStep(deps: SetupDeps, paths: InstallPaths, owner: OwnerInfo | null): Promise<void> {
  const db = (deps.openDatabase ?? (() => openPhibotDatabase()))();
  try {
    if (owner) {
      const http = (deps.ownerHttp ?? ((origin: string) => createOwnerHttp((url, init) => deps.sys.fetch(url, init), { authOrigin: origin })))(resolveAuthOrigin(readAuth(deps)));
      const outcome = await ensureOwnerAndCompany({ http, db, logger: deps.logger }, owner);
      deps.logger.success(`Propriétaire et entreprise prêts (entreprise ${outcome.companyId}).`);
    }
    await preparePhiForInstalledCompany(deps, paths, db);
  } finally {
    await db.close();
  }
}

export async function commonSystemSteps(deps: SetupDeps): Promise<InstallPaths> {
  await installSystemPackages(deps.sys, deps.logger);
  await ensureSystemAccount(deps.sys, deps.logger);
  return ensureGlobalInstall(deps.sys, deps.logger, { cliVersion: deps.cliVersion, loadAliasFunction: deps.loadAliasFunction });
}

export async function preflight(deps: SetupDeps, target: { access: PhibotAccess; domain?: string }): Promise<PhibotExposure> {
  const result = await runPreflightChecks(deps.sys, { access: target.access, domain: target.domain, unitExists: deps.sys.exists(PHIBOT_UNIT_PATH) });
  for (const warning of result.warnings) deps.logger.warn(warning);
  return resolveExposure({ access: target.access, domain: target.domain, tailnetName: result.tailnetName ?? undefined });
}

/** Fresh install or resumed install (spec 6.2, steps 1 to 11). */
async function runInstall(options: SetupOptions, deps: SetupDeps): Promise<void> {
  const target = { ...resolveAccess(options), acmeEmail: options.acmeEmail, tlsInternal: options.tlsInternal };
  const exposure = await preflight(deps, target);
  const owner = await collectOwnerInfo(options, { sys: deps.sys, prompter: deps.prompter });
  const paths = await commonSystemSteps(deps);
  await writeInstanceStep(deps, exposure);
  await preparePhiAssets(deps.sys, deps.logger, paths, deps.resolveCamoufoxJsDir);
  await installServiceStep(deps, paths);
  await ownerAndPhiStep(deps, paths, owner);
  await exposeStep(deps, target);
  await writeMarker(deps.sys, { version: deps.cliVersion, ...target, completedAt: deps.sys.now().toISOString() });
  printSummary(deps, exposure, owner.email);
}

/**
 * `--repair` (spec 6.2): steps 3, 4, 5, 6 (rights only, contents untouched), 7, 8, 9b and 10.
 * Step 1 is not replayed: a server that runs Phi Bot must not be refused for its free disk space.
 */
async function runRepair(marker: SetupMarker, deps: SetupDeps): Promise<void> {
  requireRoot(deps.sys);
  const paths = await commonSystemSteps(deps);
  await applyInstanceRights(deps.sys, false);
  await preparePhiAssets(deps.sys, deps.logger, paths, deps.resolveCamoufoxJsDir);
  await installServiceStep(deps, paths);
  await ownerAndPhiStep(deps, paths, null);
  await exposeStep(deps, marker);
  await writeMarker(deps.sys, { ...marker, version: deps.cliVersion, completedAt: deps.sys.now().toISOString() });
  deps.logger.success(`Phi Bot ${deps.cliVersion} réparé.`);
}

/** `--reconfigure` (spec 13.8): public URL, host names and auth, exposure swapped, restart and health. */
async function runReconfigure(options: SetupOptions, marker: SetupMarker, deps: SetupDeps): Promise<void> {
  requireRoot(deps.sys);
  const target = { ...resolveAccess(options), acmeEmail: options.acmeEmail, tlsInternal: options.tlsInternal };
  const checked = await checkAccess(deps.sys, target);
  for (const warning of checked.warnings) deps.logger.warn(warning);
  const exposure = resolveExposure({ access: target.access, domain: target.domain, tailnetName: checked.tailnetName ?? undefined });
  (deps.applyExposure ?? applyExposureToInstance)({ instanceRoot: PHIBOT_INSTANCE_ROOT, exposure });
  await applyInstanceRights(deps.sys, false);
  if (marker.access === "domain" && target.access !== "domain") await removeManagedCaddy(deps.sys);
  if (marker.access === "tailscale" && target.access !== "tailscale") await disableTailscaleServe(deps.sys);
  const fix = { step: "Service", fix: "Consultez sudo phibot service logs." };
  await execOrThrow(deps.sys, "systemctl", ["restart", PHIBOT_UNIT_NAME], fix);
  const health = await waitForServiceHealthy(deps.sys, PHIBOT_HEALTH_TIMEOUT_MS);
  if (!health.healthy) throw new PhibotStepError("Service", "le service ne répond pas après la reconfiguration.", "Consultez sudo phibot service logs.");
  await exposeStep(deps, target);
  await writeMarker(deps.sys, { ...marker, ...target, version: deps.cliVersion, completedAt: deps.sys.now().toISOString() });
  printSummary(deps, exposure, null);
}

async function showInstalled(marker: SetupMarker, deps: SetupDeps): Promise<void> {
  const active = await deps.sys.exec("systemctl", ["is-active", PHIBOT_UNIT_NAME]);
  deps.logger.info(`Phi Bot est déjà installé (version ${marker.version}, accès ${marker.access}). Service : ${active.stdout.trim() || "inconnu"}.`);
  deps.logger.info("Réparer : sudo phibot setup --repair. Changer d'accès : sudo phibot setup --reconfigure --access <domain|ssh|tailscale>.");
}

/** `phibot setup` (spec 6.2). `--restore` is handled by runRestoreSetup (setup-restore.ts). */
export async function runSetup(options: SetupOptions, deps: SetupDeps, restore?: (options: SetupOptions, deps: SetupDeps) => Promise<void>): Promise<SetupMode> {
  const marker = readSetupMarker(deps.sys);
  const mode = resolveSetupMode(options, marker);
  if (mode === "already-installed" && marker) await showInstalled(marker, deps);
  else if (mode === "repair" && marker) await runRepair(marker, deps);
  else if (mode === "reconfigure" && marker) await runReconfigure(options, marker, deps);
  else if (mode === "restore") {
    if (!restore) throw new Error("restore handler missing");
    await restore(options, deps);
  } else await runInstall(options, deps);
  return mode;
}
