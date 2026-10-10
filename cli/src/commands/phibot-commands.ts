import path from "node:path";
import { type Command, Option } from "commander";
import type { CheckResult } from "../checks/index.js";
import { readPaperclipEnvEntries } from "../config/env.js";
import { readConfig, resolveConfigPath } from "../config/store.js";
import { type BackupContext, runFullBackup } from "../phibot/backup.js";
import { PHIBOT_ENV_PATH, PHIBOT_HOME_DIR, PHIBOT_INSTANCE_ID, PHIBOT_SETUP_MARKER_PATH, PHIBOT_UNIT_PATH } from "../phibot/constants.js";
import { openPhibotDatabase } from "../phibot/database.js";
import { phibotServerChecks, runDoctorRootPart } from "../phibot/doctor.js";
import { collectOwnerInfo, createOwnerHttp, ensureOwnerAndCompany, type OwnerOptions, resolveAuthOrigin } from "../phibot/owner.js";
import { loadServerPasswordHasher } from "../phibot/password-hash.js";
import { runPhiPrepare } from "../phibot/phi-prepare.js";
import { readUnitPaths, relaunchAsPhibotIfNeeded } from "../phibot/relaunch.js";
import { runResetPassword } from "../phibot/reset-password.js";
import { assertServerStopped, classifyRestoreSource, runDbRestore, runInternalDbRestore } from "../phibot/restore.js";
import { runContainerSetup } from "../phibot/setup-container.js";
import { runRestoreSetup } from "../phibot/setup-restore.js";
import { runSetup, type SetupOptions } from "../phibot/setup.js";
import {
  type PhibotLogger,
  type PhibotPrompter,
  type PhibotSystem,
  PhibotStepError,
  createClackLogger,
  createClackPrompter,
  createNodeSystem,
} from "../phibot/system.js";
import { runPhibotUninstall, type UninstallOptions } from "../phibot/uninstall.js";
import { cliVersion } from "../version.js";
import { dbBackupCommand } from "./db-backup.js";
import { runCommand } from "./run.js";

/** Name of the top-level command of an action (`user` for `phibot user reset-password`). */
export function topLevelCommandName(command: Command): string {
  let current = command;
  while (current.parent?.parent) current = current.parent;
  return current.name();
}

/** First thing of every action (spec 6.8): root commands of a Phi Bot server run again as phibot. */
export async function relaunchUnderPhibotIfNeeded(actionCommand: Command): Promise<void> {
  await relaunchAsPhibotIfNeeded({ sys: createNodeSystem(), topCommand: topLevelCommandName(actionCommand), argv: process.argv, exit: (code) => process.exit(code) });
}

/** Commands that need the instance of /var/lib/phibot: never root without the Phi Bot service. */
function assertServiceAccount(sys: PhibotSystem, command: string): void {
  if (sys.uid === 0) {
    throw new PhibotStepError(command, "Phi Bot n'est pas installé sur ce serveur (pas de service phibot).", `Lancez d'abord sudo phibot setup ; dans Docker, docker compose exec -it phibot phibot ${command}.`);
  }
}

function readSetupMarkerJson(sys: PhibotSystem, logger: PhibotLogger): Record<string, unknown> | null {
  if (!sys.exists(PHIBOT_SETUP_MARKER_PATH)) return null;
  try {
    const parsed: unknown = JSON.parse(sys.readFile(PHIBOT_SETUP_MARKER_PATH));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch (error) {
    logger.warn(`${PHIBOT_SETUP_MARKER_PATH} illisible (${error instanceof Error ? error.message : String(error)}) : l'accès manquera au manifeste.`);
    return null;
  }
}

/** Manifest fields of spec 13.2: version, company, access and public URL of this instance. */
async function readBackupContext(sys: PhibotSystem, logger: PhibotLogger): Promise<BackupContext> {
  const marker = readSetupMarkerJson(sys, logger);
  const env = readPaperclipEnvEntries(PHIBOT_ENV_PATH);
  let companyId: string | null = null;
  const db = openPhibotDatabase();
  try {
    const ids = await db.companyIds();
    companyId = ids.length === 1 ? ids[0] : null;
  } catch (error) {
    logger.warn(`Entreprise non lue en base (${error instanceof Error ? error.message : String(error)}) : le manifeste ne la nommera pas.`);
  } finally {
    await db.close();
  }
  const access = typeof marker?.access === "string" ? marker.access : marker?.container === true ? "container" : null;
  return { version: cliVersion, companyId, access, publicUrl: env.PAPERCLIP_PUBLIC_URL ?? sys.env.PAPERCLIP_PUBLIC_URL ?? null };
}

async function setupAction(options: SetupOptions & { container?: boolean }): Promise<void> {
  const sys = createNodeSystem();
  const logger = createClackLogger();
  if (options.container) {
    await runContainerSetup({ sys, logger, cliVersion, runServer: () => runCommand({ instance: PHIBOT_INSTANCE_ID, repair: true }) });
    return;
  }
  await runSetup(options, { sys, logger, prompter: createClackPrompter(), cliVersion }, runRestoreSetup);
}

/** `phibot owner create` (spec 6.8): step 9 with its resume rule, then 9b, as the service account. */
async function ownerCreateAction(options: OwnerOptions): Promise<void> {
  const sys = createNodeSystem();
  assertServiceAccount(sys, "owner create");
  const logger = createClackLogger();
  const db = openPhibotDatabase();
  try {
    if ((await db.instanceAdminCount()) > 0 && (await db.companyIds()).length === 1) {
      logger.info("Le propriétaire et l'entreprise existent déjà.");
    } else {
      const info = await collectOwnerInfo(options, { sys, prompter: createClackPrompter() });
      const config = readConfig(resolveConfigPath());
      if (!config) throw new PhibotStepError("owner create", `configuration introuvable : ${resolveConfigPath()}.`, "Lancez d'abord sudo phibot setup (ou démarrez le conteneur).");
      const http = createOwnerHttp((url, init) => sys.fetch(url, init), { authOrigin: resolveAuthOrigin(config.auth) });
      await ensureOwnerAndCompany({ http, db, logger }, info);
    }
    const [companyId] = await db.companyIds();
    await runPhiPrepare(companyId, { logger });
  } finally {
    await db.close();
  }
}

async function backupAction(options: { full?: boolean; output?: string }): Promise<void> {
  if (!options.full) {
    if (options.output) throw new PhibotStepError("Sauvegarde", "--output s'utilise avec --full.", "Ajoutez --full, ou utilisez phibot db:backup --dir <dossier>.");
    await dbBackupCommand({});
    return;
  }
  const sys = createNodeSystem();
  assertServiceAccount(sys, "backup --full");
  const logger = createClackLogger();
  await runFullBackup(sys, logger, { output: options.output ? path.resolve(options.output) : undefined, context: await readBackupContext(sys, logger) });
}

function embeddedDatabase(): { dataDir: string; port: number } {
  const config = readConfig(resolveConfigPath());
  if (!config) throw new PhibotStepError("Restauration", `configuration introuvable : ${resolveConfigPath()}.`, "Lancez la commande sur l'instance Phi Bot.");
  return { dataDir: config.database.embeddedPostgresDataDir, port: config.database.embeddedPostgresPort };
}

async function confirmRestore(prompter: PhibotPrompter, file: string, yes: boolean | undefined): Promise<void> {
  if (yes) return;
  if (!prompter.interactive) throw new PhibotStepError("Restauration", "confirmation requise.", "Relancez avec --yes pour confirmer.");
  if (!(await prompter.confirm({ message: `Remplacer les données de Phi Bot par le contenu de ${file} ?` }))) {
    throw new PhibotStepError("Restauration", "restauration annulée.", "Aucune modification n'a été faite.");
  }
}

/** `phibot db:restore` (spec 13.3): root and phibot parts on a server, phibot part only elsewhere (Docker). */
async function dbRestoreAction(file: string, options: { yes?: boolean }): Promise<void> {
  const sys = createNodeSystem();
  const logger = createClackLogger();
  const prompter = createClackPrompter();
  const unitPaths = readUnitPaths(sys);
  if (sys.uid === 0) {
    if (!unitPaths) throw new PhibotStepError("Restauration", "Phi Bot n'est pas installé sur ce serveur.", "Pour reconstruire un serveur à partir d'une archive : sudo phibot setup --restore <archive>.");
    await runDbRestore(sys, { logger, prompter, unitPaths }, { file, yes: options.yes });
    return;
  }
  const absolute = path.resolve(file);
  const kind = classifyRestoreSource(absolute);
  await confirmRestore(prompter, absolute, options.yes);
  await assertServerStopped(sys);
  await runInternalDbRestore(sys, logger, { file: absolute, withFiles: kind === "archive", ...embeddedDatabase() });
}

async function internalDbRestoreAction(file: string, options: { withFiles?: boolean }): Promise<void> {
  const sys = createNodeSystem();
  if (sys.uid === 0) throw new PhibotStepError("Restauration", "internal:db-restore ne tourne jamais en root (Postgres embarqué le refuse).", "Utilisez sudo phibot db:restore <fichier>.");
  await runInternalDbRestore(sys, createClackLogger(), { file: path.resolve(file), withFiles: options.withFiles === true, ...embeddedDatabase() });
}

async function resetPasswordAction(options: { email: string }): Promise<void> {
  const db = openPhibotDatabase();
  try {
    await runResetPassword({ email: options.email }, { db, hasher: await loadServerPasswordHasher(), logger: createClackLogger() });
  } finally {
    await db.close();
  }
}

/**
 * `phibot doctor` (spec 13.5): on a Phi Bot server, root runs the repair then relaunches the
 * checks as phibot (null returned); otherwise the Phi Bot checks of this machine, maybe none.
 */
export async function phibotDoctorChecksOrRelaunch(options: { repair?: boolean }): Promise<Array<() => Promise<CheckResult>> | null> {
  const sys = createNodeSystem();
  const code = await runDoctorRootPart(sys, createClackLogger(), options);
  if (code === null) return phibotServerChecks(sys);
  process.exitCode = code;
  return null;
}

/** `phibot uninstall` on a Phi Bot server (spec 13.6); false elsewhere (upstream managed CLI). */
export async function runPhibotUninstallIfServer(options: UninstallOptions): Promise<boolean> {
  const sys = createNodeSystem();
  if (sys.platform !== "linux" || sys.uid !== 0 || !(sys.exists(PHIBOT_UNIT_PATH) || sys.exists(PHIBOT_HOME_DIR))) return false;
  await runPhibotUninstall(options, { sys, logger: createClackLogger(), prompter: createClackPrompter() });
  return true;
}

function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Installer ou réparer Phi Bot sur ce serveur (root)")
    .option("--domain <fqdn>", "Nom de domaine de Phi Bot (accès domain, HTTPS par Caddy)")
    .option("--acme-email <e-mail>", "E-mail du compte ACME (Let's Encrypt)")
    .option("--access <mode>", "Accès : domain, ssh ou tailscale (ssh par défaut sans --domain)")
    .option("--company <nom>", "Nom de l'entreprise")
    .option("--owner-name <nom>", "Nom du propriétaire")
    .option("--owner-email <e-mail>", "E-mail du propriétaire")
    .option("--owner-password-file <fichier>", "Fichier (0600, une ligne) contenant le mot de passe du propriétaire")
    .option("-y, --yes", "Ne poser aucune question")
    .option("--repair", "Rejouer l'installation sans toucher à la configuration ni aux comptes")
    .option("--restore <archive>", "Installer sur un serveur neuf à partir d'une archive de phibot backup --full")
    .option("--reconfigure", "Changer l'accès (avec --access et --domain)")
    .addOption(new Option("--container", "Mode de l'image Docker").hideHelp())
    .addOption(new Option("--tls-internal", "Certificat interne de Caddy (test de bout en bout)").hideHelp())
    .action(setupAction);
}

function registerOwnerCommands(program: Command): void {
  program
    .command("owner")
    .description("Propriétaire de Phi Bot")
    .command("create")
    .description("Créer le propriétaire et l'entreprise (Docker ou installation interrompue)")
    .option("--owner-name <nom>", "Nom du propriétaire")
    .option("--owner-email <e-mail>", "E-mail du propriétaire")
    .option("--owner-password-file <fichier>", "Fichier (0600, une ligne) contenant le mot de passe")
    .option("--company <nom>", "Nom de l'entreprise")
    .option("-y, --yes", "Ne poser aucune question")
    .action(ownerCreateAction);
  program
    .command("phi:prepare")
    .description("Préparer phi pour une entreprise (dossier agent, modèle d'embedding)")
    .requiredOption("--company <id>", "Identifiant de l'entreprise")
    .action(async (options: { company: string }) => {
      const sys = createNodeSystem();
      assertServiceAccount(sys, "phi:prepare");
      await runPhiPrepare(options.company, { logger: createClackLogger() });
    });
}

function registerDataCommands(program: Command): void {
  program
    .command("backup")
    .description("Sauvegarder la base, ou tout Phi Bot avec --full")
    .option("--full", "Archive complète : base, configuration, secrets, fichiers, mémoire de phi")
    .option("--output <chemin>", "Chemin de l'archive de --full")
    .action(backupAction);
  program
    .command("db:restore")
    .description("Restaurer une sauvegarde de la base (*.sql.gz) ou une archive de backup --full")
    .argument("<fichier>", "Sauvegarde à restaurer")
    .option("-y, --yes", "Ne pas demander de confirmation")
    .action(dbRestoreAction);
  program
    .command("internal:db-restore", { hidden: true })
    .argument("<fichier>")
    .option("--with-files")
    .action(internalDbRestoreAction);
  program
    .command("user")
    .description("Comptes des utilisateurs")
    .command("reset-password")
    .description("Donner un nouveau mot de passe aléatoire à un compte et fermer ses sessions")
    .requiredOption("--email <e-mail>", "E-mail du compte")
    .action(resetPasswordAction);
}

/** Commands added by Phi Bot (spec 6.8). */
export function registerPhibotCommands(program: Command): void {
  registerSetupCommand(program);
  registerOwnerCommands(program);
  registerDataCommands(program);
}
