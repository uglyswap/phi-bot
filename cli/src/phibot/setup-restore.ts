import path from "node:path";
import { backupTimestamp } from "./backup.js";
import { PHIBOT_BACKUP_DIR, PHIBOT_HOME_DIR, PHIBOT_INSTANCE_ROOT, PHIBOT_SYSTEM_USER } from "./constants.js";
import { applyExposureToInstance } from "./instance-config.js";
import { preparePhiAssets } from "./phi-assets.js";
import { buildCleanPhibotCommand, execAsPhibot } from "./relaunch.js";
import { extractArchiveDump, readArchiveManifest, restoreArchiveFiles } from "./restore.js";
import {
  applyInstanceRights,
  commonSystemSteps,
  exposeStep,
  installServiceStep,
  ownerAndPhiStep,
  preflight,
  printSummary,
  resolveAccess,
  type SetupDeps,
  type SetupOptions,
  writeMarker,
} from "./setup.js";
import { PhibotStepError, execOrThrow } from "./system.js";

const STEP = "Restauration sur un serveur neuf";

/**
 * `phibot setup --restore <full-*.tar.gz>` (spec 13.7): steps 1, 3, 4 and 5, then the files of the
 * archive (root), the access of --access/--domain, the database (phibot), steps 7, 8, 9b and 10.
 * No owner is created: the owner signs in with the former password.
 */
export async function runRestoreSetup(options: SetupOptions, deps: SetupDeps): Promise<void> {
  const { sys, logger } = deps;
  const archive = path.posix.resolve(options.restore ?? "");
  if (!archive.endsWith(".tar.gz") || !sys.exists(archive)) {
    throw new PhibotStepError(STEP, `archive introuvable ou non reconnue : ${archive}.`, "Indiquez une archive .tar.gz produite par phibot backup --full.");
  }
  const target = { ...resolveAccess(options), acmeEmail: options.acmeEmail, tlsInternal: options.tlsInternal };
  const exposure = await preflight(deps, target);
  const manifest = await readArchiveManifest(sys, archive);
  const paths = await commonSystemSteps(deps);
  const fix = { step: STEP, fix: "Vérifiez l'archive et l'espace disque, puis relancez la commande." };
  logger.step("Restauration des fichiers de l'instance et des données de phi...");
  sys.makeDir(PHIBOT_BACKUP_DIR, 0o700);
  await restoreArchiveFiles(sys, archive, manifest);
  await execOrThrow(sys, "chown", ["-R", `${PHIBOT_SYSTEM_USER}:${PHIBOT_SYSTEM_USER}`, PHIBOT_HOME_DIR], fix);
  (deps.applyExposure ?? applyExposureToInstance)({ instanceRoot: PHIBOT_INSTANCE_ROOT, exposure });
  await applyInstanceRights(sys, false);
  const workDir = `/var/tmp/phibot-restore-${backupTimestamp(sys.now())}`;
  const dump = path.posix.join(PHIBOT_BACKUP_DIR, `restore-input-${path.posix.basename(manifest.dump)}`);
  try {
    const extracted = await extractArchiveDump(sys, archive, manifest, workDir);
    await execOrThrow(sys, "install", ["-o", PHIBOT_SYSTEM_USER, "-g", PHIBOT_SYSTEM_USER, "-m", "600", extracted, dump], fix);
  } finally {
    sys.remove(workDir);
  }
  logger.step("Restauration de la base (compte phibot)...");
  const result = await execAsPhibot(sys, buildCleanPhibotCommand(paths.nodePath, [paths.phibotJsPath, "internal:db-restore", dump], sys.env), { inherit: true });
  sys.remove(dump);
  if (result.code !== 0) throw new PhibotStepError(STEP, `la restauration de la base a échoué (code ${result.code}).`, "Consultez les messages ci-dessus puis relancez la commande.");
  await preparePhiAssets(sys, logger, paths, deps.resolveCamoufoxJsDir);
  await installServiceStep(deps, paths);
  await ownerAndPhiStep(deps, paths, null);
  await exposeStep(deps, target);
  await writeMarker(sys, { version: deps.cliVersion, ...target, completedAt: sys.now().toISOString() });
  printSummary(deps, exposure, null);
}
