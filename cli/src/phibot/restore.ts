import path from "node:path";
import { applyPendingMigrations, resetPostgresDatabase, runDatabaseRestore } from "@paperclipai/db";
import { ensureEmbeddedPostgres } from "../commands/worktree.js";
import { BACKUP_MANIFEST_NAME, type FullBackupManifest, backupTimestamp } from "./backup.js";
import { PHIBOT_BACKUP_DIR, PHIBOT_HEALTH_TIMEOUT_MS, PHIBOT_HOME_DIR, PHIBOT_SYSTEM_USER, PHIBOT_UNIT_NAME } from "./constants.js";
import { probeHealth, serviceJournalTail, waitForServiceHealthy } from "./health.js";
import { buildPhibotCommand, execAsPhibot } from "./relaunch.js";
import { type PhibotLogger, type PhibotPrompter, type PhibotSystem, PhibotStepError, execOrThrow } from "./system.js";
import type { PhibotUnitPaths } from "./units.js";

const STEP = "Restauration";

export type RestoreKind = "dump" | "archive";

/** Review m4: a dump (`*.sql.gz`, `*.sql`) or any archive of `backup --full` (`full-*`, `pre-update-*`). */
export function classifyRestoreSource(file: string): RestoreKind {
  if (file.endsWith(".sql.gz") || file.endsWith(".sql")) return "dump";
  if (file.endsWith(".tar.gz")) return "archive";
  throw new PhibotStepError(STEP, `format non reconnu : ${file}.`, "Indiquez un fichier .sql.gz (sauvegarde de la base) ou une archive .tar.gz de phibot backup --full.");
}

export interface DatabaseRestoreDeps {
  startPostgres(dataDir: string, port: number): Promise<{ port: number; stop(): Promise<void> }>;
  resetDatabase(adminConnectionString: string): Promise<void>;
  restoreDump(connectionString: string, dumpFile: string): Promise<void>;
  migrate(connectionString: string): Promise<void>;
}

/** Upstream sequence of cli/src/commands/worktree.ts:1708-1723 (spec 13.3). */
export const realDatabaseRestoreDeps: DatabaseRestoreDeps = {
  startPostgres: (dataDir, port) => ensureEmbeddedPostgres(dataDir, port, { allowExisting: false }),
  resetDatabase: async (adminConnectionString) => {
    await resetPostgresDatabase(adminConnectionString, "paperclip");
  },
  restoreDump: (connectionString, dumpFile) => runDatabaseRestore({ connectionString, backupFile: dumpFile }),
  migrate: (connectionString) => applyPendingMigrations(connectionString),
};

/** Embedded Postgres started on the instance data, database reset, dump restored, migrations applied. */
export async function restoreDatabaseFromDump(deps: DatabaseRestoreDeps, input: { dumpFile: string; dataDir: string; port: number }): Promise<void> {
  const handle = await deps.startPostgres(input.dataDir, input.port);
  try {
    await deps.resetDatabase(`postgres://paperclip:paperclip@127.0.0.1:${handle.port}/postgres`);
    const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${handle.port}/paperclip`;
    await deps.restoreDump(connectionString, input.dumpFile);
    await deps.migrate(connectionString);
  } finally {
    await handle.stop();
  }
}

const ARCHIVE_FIX = "Utilisez une archive produite par phibot backup --full.";
const SAFE_DUMP = /^db\/[A-Za-z0-9._-]+\.sql(?:\.gz)?$/;

/** Reads `phibot-backup.json` from an archive of `backup --full` without extracting the rest. */
export async function readArchiveManifest(sys: PhibotSystem, archivePath: string): Promise<FullBackupManifest> {
  const result = await sys.exec("tar", ["-xzOf", archivePath, BACKUP_MANIFEST_NAME]);
  if (result.code !== 0) throw new PhibotStepError(STEP, `${BACKUP_MANIFEST_NAME} illisible dans ${archivePath}.`, ARCHIVE_FIX);
  let manifest: FullBackupManifest;
  try {
    manifest = JSON.parse(result.stdout) as FullBackupManifest;
  } catch {
    throw new PhibotStepError(STEP, "manifeste de sauvegarde illisible.", ARCHIVE_FIX);
  }
  if (manifest.format !== 1 || typeof manifest.dump !== "string" || !Array.isArray(manifest.entries)) {
    throw new PhibotStepError(STEP, "manifeste de sauvegarde illisible.", ARCHIVE_FIX);
  }
  if (!SAFE_DUMP.test(manifest.dump) || manifest.entries.some((entry) => typeof entry !== "string" || entry.startsWith("/") || entry.split("/").includes(".."))) {
    throw new PhibotStepError(STEP, "manifeste de sauvegarde invalide (chemin hors de /var/lib/phibot).", ARCHIVE_FIX);
  }
  return manifest;
}

/** Extracts only the database dump of the archive into `targetDir`. */
export async function extractArchiveDump(sys: PhibotSystem, archivePath: string, manifest: FullBackupManifest, targetDir: string): Promise<string> {
  sys.makeDir(targetDir, 0o700);
  await execOrThrow(sys, "tar", ["-xzf", archivePath, "-C", targetDir, manifest.dump], { step: STEP, fix: "Vérifiez que l'archive est complète (tar -tzf <archive>)." });
  return path.posix.join(targetDir, manifest.dump);
}

/** Paths of the archive that are put back: only under /var/lib/phibot. */
export function restorableEntries(manifest: FullBackupManifest): string[] {
  return manifest.entries.filter((entry) => entry.startsWith("var/lib/phibot/"));
}

/** Puts back the files of spec 13.2 (instance files and phi data) at their place. */
export async function restoreArchiveFiles(sys: PhibotSystem, archivePath: string, manifest: FullBackupManifest): Promise<void> {
  const allowed = restorableEntries(manifest);
  if (allowed.length === 0) return;
  await execOrThrow(sys, "tar", ["-xzf", archivePath, "-C", "/", ...allowed], { step: STEP, fix: "Vérifiez l'espace disque libre puis relancez la restauration." });
}

/**
 * phibot part (`phibot internal:db-restore <file> [--with-files]`): the service is stopped by the
 * root part; embedded Postgres refuses root (review M4).
 */
export async function runInternalDbRestore(
  sys: PhibotSystem,
  logger: PhibotLogger,
  input: { file: string; withFiles: boolean; dataDir: string; port: number; deps?: DatabaseRestoreDeps },
): Promise<void> {
  const kind = classifyRestoreSource(input.file);
  let dumpFile = input.file;
  const workDir = path.posix.join(PHIBOT_BACKUP_DIR, `.restore-${backupTimestamp(sys.now())}`);
  try {
    if (kind === "archive") {
      const manifest = await readArchiveManifest(sys, input.file);
      dumpFile = await extractArchiveDump(sys, input.file, manifest, workDir);
      if (input.withFiles) {
        logger.step("Restauration des fichiers de l'instance et des données de phi...");
        await restoreArchiveFiles(sys, input.file, manifest);
      }
    }
    logger.step("Restauration de la base (Postgres embarqué, puis migrations)...");
    await restoreDatabaseFromDump(input.deps ?? realDatabaseRestoreDeps, { dumpFile, dataDir: input.dataDir, port: input.port });
  } finally {
    sys.remove(workDir);
  }
  logger.success("Base restaurée.");
}

/** Readable copy for phibot of a file that may sit in root's home. */
async function stageForPhibot(sys: PhibotSystem, file: string): Promise<{ staged: string; temporary: boolean }> {
  if (file.startsWith(`${PHIBOT_HOME_DIR}/`)) return { staged: file, temporary: false };
  const staged = path.posix.join(PHIBOT_BACKUP_DIR, `restore-input-${backupTimestamp(sys.now())}-${path.posix.basename(file)}`);
  await execOrThrow(sys, "install", ["-o", PHIBOT_SYSTEM_USER, "-g", PHIBOT_SYSTEM_USER, "-m", "600", file, staged], {
    step: STEP,
    fix: `Copiez le fichier dans ${PHIBOT_BACKUP_DIR} puis relancez la commande.`,
  });
  return { staged, temporary: true };
}

/** Root part after an archive (spec 13.3): `chown -R phibot:phibot` of the restored paths only. */
async function chownRestoredEntries(sys: PhibotSystem, archivePath: string): Promise<void> {
  const restored = restorableEntries(await readArchiveManifest(sys, archivePath))
    .map((entry) => `/${entry}`)
    .filter((entry) => sys.exists(entry));
  if (restored.length === 0) return;
  await execOrThrow(sys, "chown", ["-R", `${PHIBOT_SYSTEM_USER}:${PHIBOT_SYSTEM_USER}`, ...restored], {
    step: STEP,
    fix: "Lancez sudo chown -R phibot:phibot /var/lib/phibot puis sudo phibot service start.",
  });
}

/** Root part of `phibot db:restore <file> [--yes]` (spec 13.3, review M4): stop, restore as phibot, start, health. */
export async function runDbRestore(
  sys: PhibotSystem,
  deps: { logger: PhibotLogger; prompter: PhibotPrompter; unitPaths: PhibotUnitPaths },
  input: { file: string; yes?: boolean },
): Promise<void> {
  const file = path.posix.resolve(input.file);
  if (!sys.exists(file)) throw new PhibotStepError(STEP, `fichier introuvable : ${file}.`, "Indiquez le chemin d'une sauvegarde existante.");
  const kind = classifyRestoreSource(file);
  if (!input.yes) {
    if (!deps.prompter.interactive) throw new PhibotStepError(STEP, "confirmation requise.", "Relancez avec --yes pour confirmer.");
    const what = kind === "archive" ? "la base ET les fichiers de l'instance (configuration, .env, secrets, fichiers, mémoire de phi)" : "la base";
    if (!(await deps.prompter.confirm({ message: `Remplacer ${what} par le contenu de ${file} ? Le service sera arrêté pendant la restauration.` }))) {
      throw new PhibotStepError(STEP, "restauration annulée.", "Aucune modification n'a été faite.");
    }
  }
  const { staged, temporary } = await stageForPhibot(sys, file);
  const fix = { step: STEP, fix: "Consultez les messages ci-dessus, puis sudo phibot service start." };
  try {
    await execOrThrow(sys, "systemctl", ["stop", PHIBOT_UNIT_NAME], fix);
    const worker = buildPhibotCommand(deps.unitPaths, ["internal:db-restore", staged, ...(kind === "archive" ? ["--with-files"] : [])]);
    const result = await execAsPhibot(sys, worker, { inherit: true });
    if (result.code !== 0) throw new PhibotStepError(STEP, `la restauration a échoué (code ${result.code}).`, "Consultez les messages ci-dessus ; le service reste arrêté (sudo phibot service start pour le relancer).");
  } finally {
    if (temporary) sys.remove(staged);
  }
  if (kind === "archive") await chownRestoredEntries(sys, file);
  await execOrThrow(sys, "systemctl", ["start", PHIBOT_UNIT_NAME], fix);
  const health = await waitForServiceHealthy(sys, PHIBOT_HEALTH_TIMEOUT_MS);
  if (!health.healthy) {
    deps.logger.error(await serviceJournalTail(sys));
    throw new PhibotStepError(STEP, "le service ne répond pas après la restauration.", "Consultez sudo phibot service logs.");
  }
  deps.logger.success("Restauration terminée, service redémarré.");
}

/** Without systemd (Docker, development): refuses while a server answers on 127.0.0.1:3100. */
export async function assertServerStopped(sys: PhibotSystem): Promise<void> {
  if ((await probeHealth(sys)).ok) {
    throw new PhibotStepError(STEP, "un serveur Phi Bot répond sur 127.0.0.1:3100.", "Arrêtez-le d'abord (docker compose stop, ou Ctrl+C sur phibot run), puis relancez la restauration.");
  }
}
