import path from "node:path";
import { compareVersions } from "../commands/update.js";
import { backupTimestamp } from "./backup.js";
import { PHIBOT_BACKUP_DIR, PHIBOT_HEALTH_TIMEOUT_MS, PHIBOT_PACKAGE_NAME, PHIBOT_UNIT_NAME, PHIBOT_UNIT_PATH } from "./constants.js";
import {
  type AliasFunction,
  ensureEmbeddedPostgresAliases,
  installPathsFor,
  npmCommand,
  npmInstallGlobal,
  npmRootGlobal,
  readInstalledVersion,
  resolveNpmRegistry,
} from "./global-install.js";
import { waitForServiceHealthy } from "./health.js";
import { buildPhibotCommand, execAsPhibot, readUnitPaths } from "./relaunch.js";
import {
  type PhibotLogger,
  type PhibotPrompter,
  type PhibotSystem,
  PhibotStepError,
  createClackLogger,
  createClackPrompter,
  createNodeSystem,
  execOrThrow,
} from "./system.js";

const STEP = "Mise à jour";
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface PhibotUpdateOptions {
  version?: string;
  yes?: boolean;
  check?: boolean;
  dryRun?: boolean;
  canary?: boolean;
  rollback?: boolean;
  backup?: boolean;
}

export interface PhibotUpdateDeps {
  sys: PhibotSystem;
  logger: PhibotLogger;
  prompter: PhibotPrompter;
  loadAliasFunction?: (packageDir: string) => Promise<AliasFunction>;
}

/** A server installed by `phibot setup`: its update is the one of spec 13.1. */
export function isPhibotServer(sys: PhibotSystem): boolean {
  return sys.platform === "linux" && sys.exists(PHIBOT_UNIT_PATH);
}

export async function resolveTargetVersion(sys: PhibotSystem, registry: string, requested?: string): Promise<string> {
  if (requested) {
    const version = requested.trim();
    if (!EXACT_VERSION.test(version)) throw new PhibotStepError(STEP, `version invalide : « ${requested} ».`, "Indiquez une version exacte, par exemple --version 1.2.0.");
    return version;
  }
  const result = await execOrThrow(sys, npmCommand(sys), ["view", `${PHIBOT_PACKAGE_NAME}@latest`, "version", `--registry=${registry}`], {
    step: STEP,
    fix: `Vérifiez l'accès au registre ${registry} puis relancez la commande.`,
  });
  return result.stdout.trim();
}

function refuseUnsupported(options: PhibotUpdateOptions): void {
  if (options.canary) throw new PhibotStepError(STEP, "Phi Bot n'a pas de canal canary.", "Utilisez --version <version> pour une préversion publiée sous le dist-tag next.");
  if (options.rollback) throw new PhibotStepError(STEP, "--rollback concerne l'installation gérée de Paperclip.", "Pour revenir en arrière : sudo phibot update --version <version précédente> --yes.");
  if (options.backup === false) throw new PhibotStepError(STEP, "la sauvegarde préalable est obligatoire.", "Relancez sans --no-backup.");
}

/** Success criterion (review B2): unit active, health ok, installed version = expected. */
async function serviceRunsVersion(sys: PhibotSystem, npmRoot: string, version: string): Promise<boolean> {
  const health = await waitForServiceHealthy(sys, PHIBOT_HEALTH_TIMEOUT_MS);
  return health.healthy && readInstalledVersion(sys, npmRoot) === version;
}

/** npm install -g of a version, aliases (B1), then `setup --repair --yes` of that version (review M3). */
async function installAndRepair(sys: PhibotSystem, deps: PhibotUpdateDeps, npmRoot: string, version: string): Promise<boolean> {
  await npmInstallGlobal(sys, deps.logger, version, resolveNpmRegistry(sys.env));
  const paths = installPathsFor(sys.realpath(sys.execPath), npmRoot);
  await ensureEmbeddedPostgresAliases(sys, paths.packageDir, deps.loadAliasFunction);
  const repair = await sys.exec(paths.nodePath, [paths.phibotJsPath, "setup", "--repair", "--yes"], { inherit: true });
  return repair.code === 0 && (await serviceRunsVersion(sys, npmRoot, version));
}

async function rollBack(sys: PhibotSystem, deps: PhibotUpdateDeps, npmRoot: string, previous: string, archive: string): Promise<never> {
  deps.logger.warn(`Échec de la mise à jour : retour à la version ${previous}...`);
  await sys.exec("systemctl", ["stop", PHIBOT_UNIT_NAME]);
  let restored = false;
  try {
    restored = await installAndRepair(sys, deps, npmRoot, previous);
  } catch (error) {
    deps.logger.error(error instanceof Error ? error.message : String(error));
  }
  if (!restored) {
    deps.logger.warn("La version précédente ne démarre pas sur la base migrée : restauration de la sauvegarde préalable.");
    const paths = installPathsFor(sys.realpath(sys.execPath), npmRoot);
    await sys.exec(paths.nodePath, [paths.phibotJsPath, "db:restore", archive, "--yes"], { inherit: true });
    restored = await serviceRunsVersion(sys, npmRoot, previous);
  }
  throw new PhibotStepError(
    STEP,
    restored ? `la nouvelle version n'a pas démarré ; Phi Bot ${previous} est de nouveau en service.` : `ni la nouvelle version ni la version ${previous} ne démarrent.`,
    restored
      ? `Les migrations de base ne sont pas annulées sans restauration ; sauvegarde préalable : ${archive}. Consultez sudo phibot service logs.`
      : `Restaurez à la main : sudo phibot db:restore ${archive} --yes, puis sudo phibot service logs.`,
  );
}

/** `sudo phibot update [--version <v>] [--yes]` on a Phi Bot server (spec 13.1, reviews B2 and M3). */
export async function runPhibotUpdate(options: PhibotUpdateOptions, deps: PhibotUpdateDeps): Promise<void> {
  const { sys, logger } = deps;
  refuseUnsupported(options);
  if (sys.uid !== 0) throw new PhibotStepError(STEP, "droits administrateur requis.", "Relancez avec sudo.");
  const unitPaths = readUnitPaths(sys);
  if (!unitPaths) throw new PhibotStepError(STEP, `${PHIBOT_UNIT_PATH} illisible.`, "Relancez sudo phibot setup --repair.");
  const npmRoot = await npmRootGlobal(sys);
  const current = readInstalledVersion(sys, npmRoot);
  if (!current) throw new PhibotStepError(STEP, `${PHIBOT_PACKAGE_NAME} n'est pas installé globalement.`, "Relancez sudo phibot setup --repair.");
  const target = await resolveTargetVersion(sys, resolveNpmRegistry(sys.env), options.version);
  const comparison = compareVersions(target, current);
  if (options.check) {
    logger.info(comparison > 0 ? `Mise à jour disponible : ${current} vers ${target}.` : `Phi Bot ${current} est à jour (dernière version : ${target}).`);
    if (comparison > 0) process.exitCode = 10;
    return;
  }
  if (comparison === 0) return logger.info(`Phi Bot ${current} est déjà installé.`);
  if (comparison < 0 && !options.yes) throw new PhibotStepError(STEP, `${target} est plus ancienne que ${current}.`, "Ajoutez --yes pour confirmer le retour à une version précédente.");
  const archive = path.posix.join(PHIBOT_BACKUP_DIR, `pre-update-${current}-${target}-${backupTimestamp(sys.now())}.tar.gz`);
  if (options.dryRun) return logger.info(`Simulation : sauvegarde ${archive}, arrêt du service, npm install -g ${PHIBOT_PACKAGE_NAME}@${target}, setup --repair, contrôle de santé.`);
  logger.step(`Sauvegarde préalable : ${archive}`);
  const backup = await execAsPhibot(sys, buildPhibotCommand(unitPaths, ["backup", "--full", "--output", archive]), { inherit: true });
  if (backup.code !== 0) throw new PhibotStepError(STEP, "la sauvegarde préalable a échoué, rien n'a été modifié.", "Vérifiez que le service tourne (sudo phibot service status) et l'espace disque.");
  await execOrThrow(sys, "systemctl", ["stop", PHIBOT_UNIT_NAME], { step: STEP, fix: "Consultez sudo phibot service logs." });
  let updated = false;
  try {
    updated = await installAndRepair(sys, deps, npmRoot, target);
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
  }
  if (!updated) await rollBack(sys, deps, npmRoot, current, archive);
  logger.success(`Phi Bot mis à jour : ${current} vers ${target}. Sauvegarde préalable : ${archive}`);
}

/** Hook of `phibot update` (cli/src/commands/update.ts): true when this server was handled here. */
export async function runPhibotUpdateIfServer(options: PhibotUpdateOptions, sys: PhibotSystem = createNodeSystem()): Promise<boolean> {
  if (!isPhibotServer(sys)) return false;
  await runPhibotUpdate(options, { sys, logger: createClackLogger(), prompter: createClackPrompter() });
  return true;
}
