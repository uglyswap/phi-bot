import path from "node:path";
import { runDatabaseBackup } from "@paperclipai/db";
import { PHIBOT_BACKUP_DIR, PHIBOT_COMPANIES_DIR, PHIBOT_DB_URL, PHIBOT_INSTANCE_ROOT, PHIBOT_PHI_DIR } from "./constants.js";
import { type PhibotLogger, type PhibotSystem, execOrThrow } from "./system.js";

export const BACKUP_MANIFEST_NAME = "phibot-backup.json";
export const FULL_BACKUP_KEEP = 3;

/** What the manifest records about the instance (spec 13.2). */
export interface BackupContext {
  /** Version of Phi Bot that wrote the archive. */
  version: string;
  companyId: string | null;
  access: string | null;
  publicUrl: string | null;
}

export interface FullBackupManifest extends BackupContext {
  format: 1;
  createdAt: string;
  /** Dump path inside the archive, for example "db/paperclip-20261008-120000.sql.gz". */
  dump: string;
  /** Saved paths, relative to "/" as stored in the archive. */
  entries: string[];
}

const INSTANCE_ENTRIES = ["config.json", ".env", "adapters.json", "secrets", "data/storage", "workspaces", "projects"];

/** `YYYYMMDD-HHMMSS` in UTC. */
export function backupTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

/** Spec 13.2: what a full backup contains, limited to the paths that exist. */
export function fullBackupEntries(sys: PhibotSystem, input: { instanceRoot?: string; phiDir?: string; companiesDir?: string } = {}): string[] {
  const instanceRoot = input.instanceRoot ?? PHIBOT_INSTANCE_ROOT;
  const phiDir = input.phiDir ?? PHIBOT_PHI_DIR;
  const companiesDir = input.companiesDir ?? PHIBOT_COMPANIES_DIR;
  const absolute = [
    ...INSTANCE_ENTRIES.map((entry) => path.posix.join(instanceRoot, entry)),
    path.posix.join(phiDir, "memory"),
    ...sys.listDir(companiesDir).flatMap((company) => [
      path.posix.join(companiesDir, company, "agent"),
      path.posix.join(companiesDir, company, "sessions"),
    ]),
  ];
  return absolute.filter((entry) => sys.exists(entry)).map((entry) => entry.replace(/^\/+/, ""));
}

/** GNU tar: manifest and dump from the staging folder, then the data from "/", without the model caches. */
export function buildFullBackupTarArgs(input: { archivePath: string; stagingDir: string; entries: string[]; companiesDir?: string }): string[] {
  const companies = (input.companiesDir ?? PHIBOT_COMPANIES_DIR).replace(/^\/+/, "");
  return ["-czf", input.archivePath, `--exclude=${companies}/*/agent/cache`, "-C", input.stagingDir, BACKUP_MANIFEST_NAME, "db", "-C", "/", ...input.entries];
}

/** Review m13: keeps the 3 newest `full-*` and the 3 newest `pre-update-*` archives. */
export function pruneFullBackups(sys: PhibotSystem, backupDir: string = PHIBOT_BACKUP_DIR, keep: number = FULL_BACKUP_KEEP): string[] {
  const removed: string[] = [];
  for (const prefix of ["full-", "pre-update-"]) {
    const archives = sys
      .listDir(backupDir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".tar.gz"))
      .map((name) => path.posix.join(backupDir, name))
      .sort((left, right) => (sys.modifiedAtMs(right) ?? 0) - (sys.modifiedAtMs(left) ?? 0));
    for (const archive of archives.slice(keep)) {
      sys.remove(archive);
      removed.push(archive);
    }
  }
  return removed;
}

/** Upstream engine of `db:backup` (pg_dump when compatible, otherwise the JavaScript engine). */
export async function dumpDatabase(backupDir: string, connectionString: string = PHIBOT_DB_URL): Promise<string> {
  const result = await runDatabaseBackup({
    connectionString,
    backupDir,
    retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
    filenamePrefix: "paperclip",
  });
  return result.backupFile;
}

/** `phibot backup --full [--output <path>]` (spec 13.2, review m4). Runs as phibot. */
export async function runFullBackup(
  sys: PhibotSystem,
  logger: PhibotLogger,
  input: { context: BackupContext; output?: string; dump?: (dir: string) => Promise<string>; backupDir?: string },
): Promise<string> {
  const backupDir = input.backupDir ?? PHIBOT_BACKUP_DIR;
  const stamp = backupTimestamp(sys.now());
  const archivePath = input.output ?? path.posix.join(backupDir, `full-${stamp}.tar.gz`);
  const stagingDir = path.posix.join(backupDir, `.full-staging-${stamp}`);
  sys.makeDir(path.posix.join(stagingDir, "db"), 0o700);
  try {
    logger.step("Sauvegarde de la base...");
    const dumpFile = await (input.dump ?? ((dir: string) => dumpDatabase(dir)))(path.posix.join(stagingDir, "db"));
    const entries = fullBackupEntries(sys);
    const manifest: FullBackupManifest = {
      format: 1,
      createdAt: sys.now().toISOString(),
      ...input.context,
      dump: `db/${path.posix.basename(dumpFile.replaceAll("\\", "/"))}`,
      entries,
    };
    sys.writeFile(path.posix.join(stagingDir, BACKUP_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    logger.step("Archivage des fichiers de l'instance et des données de phi...");
    const fix = { step: "Sauvegarde complète", fix: "Vérifiez l'espace disque libre puis relancez sudo phibot backup --full." };
    await execOrThrow(sys, "tar", buildFullBackupTarArgs({ archivePath, stagingDir, entries }), fix);
    await execOrThrow(sys, "chmod", ["600", archivePath], fix);
  } finally {
    sys.remove(stagingDir);
  }
  pruneFullBackups(sys, backupDir);
  logger.success(`Sauvegarde complète : ${archivePath}`);
  logger.warn("Copiez cette archive hors du serveur : elle contient la clé maîtresse et les secrets.");
  return archivePath;
}
