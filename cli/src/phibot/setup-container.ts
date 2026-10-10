import path from "node:path";
import { isSupportedNodeVersion, MINIMUM_NODE_VERSION } from "@paperclipai/shared/node-version";
import { PHIBOT_INSTANCE_ID, PHIBOT_INSTANCE_ROOT, PHIBOT_PAPERCLIP_HOME, PHIBOT_SETUP_MARKER_PATH } from "./constants.js";
import { EMBEDDED_POSTGRES_LIB_SUBPATH, installPathsFor, missingEmbeddedPostgresAliases, npmRootGlobal } from "./global-install.js";
import { type InstanceFilesResult, type PhibotExposure, resolveContainerExposure, writeInstanceFiles } from "./instance-config.js";
import { readConfig, resolveConfigPath } from "../config/store.js";
import { openPhibotDatabase } from "./database.js";
import { preparePhiAssets } from "./phi-assets.js";
import { runPhiPrepare } from "./phi-prepare.js";
import { realDatabaseRestoreDeps } from "./restore.js";
import { type PhibotLogger, type PhibotSystem, PhibotStepError } from "./system.js";

const STEP = "Démarrage du conteneur";

export interface ContainerDeps {
  sys: PhibotSystem;
  logger: PhibotLogger;
  cliVersion: string;
  runServer: () => Promise<void>;
  writeInstance?: (input: { instanceRoot: string; exposure: PhibotExposure; now: Date }) => InstanceFilesResult;
  resolveCamoufoxJsDir?: (phiDir: string) => string;
  /** Companies of the existing instance, read before the server starts. */
  readCompanyIds?: () => Promise<string[]>;
  preparePhi?: (companyId: string) => Promise<unknown>;
}

/** Embedded Postgres started only for the query, then stopped: the server is not running yet. */
export async function readCompanyIdsWithTemporaryPostgres(): Promise<string[]> {
  const config = readConfig(resolveConfigPath());
  if (!config) throw new PhibotStepError(STEP, `configuration introuvable : ${resolveConfigPath()}.`, "Vérifiez le volume /var/lib/phibot du conteneur.");
  const handle = await realDatabaseRestoreDeps.startPostgres(config.database.embeddedPostgresDataDir, config.database.embeddedPostgresPort);
  const db = openPhibotDatabase(`postgres://paperclip:paperclip@127.0.0.1:${handle.port}/paperclip`);
  try {
    return await db.companyIds();
  } finally {
    await db.close();
    await handle.stop();
  }
}

/**
 * Restart of an existing instance (marker present, image maybe updated): step 9b for the company
 * read in the database; none yet means the owner will run `owner create`.
 */
async function prepareExistingCompany(deps: ContainerDeps): Promise<void> {
  const ids = await (deps.readCompanyIds ?? readCompanyIdsWithTemporaryPostgres)();
  if (ids.length > 1) throw new PhibotStepError(STEP, `${ids.length} entreprises en base (une seule attendue).`, "Contactez le support Phi Bot.");
  if (ids.length === 0) {
    deps.logger.info("Aucune entreprise en base : créez le propriétaire avec docker compose exec -it phibot phibot owner create.");
    return;
  }
  await (deps.preparePhi ?? ((id: string) => runPhiPrepare(id, { logger: deps.logger })))(ids[0]);
}

/**
 * `phibot setup --container` (spec 14): no apt, no account, no systemd, no Caddy. Writes the
 * configuration (bind 0.0.0.0, PAPERCLIP_PUBLIC_URL and PAPERCLIP_ALLOWED_HOSTNAMES from the
 * environment), prepares phi (step 7 at every start, step 9b when a company exists), then runs
 * the server in the foreground.
 */
export async function runContainerSetup(deps: ContainerDeps): Promise<void> {
  const { sys, logger } = deps;
  if (sys.uid === 0) throw new PhibotStepError(STEP, "le conteneur tourne en root.", "Lancez l'image sous son compte phibot (USER phibot) : Postgres embarqué refuse root.");
  if (!isSupportedNodeVersion(sys.nodeVersion)) throw new PhibotStepError(STEP, `Node.js ${sys.nodeVersion} trop ancien (minimum ${MINIMUM_NODE_VERSION}).`, "Reconstruisez l'image sur node:24.");
  sys.env.PAPERCLIP_HOME = PHIBOT_PAPERCLIP_HOME;
  sys.env.PAPERCLIP_INSTANCE_ID = PHIBOT_INSTANCE_ID;
  const exposure = resolveContainerExposure(sys.env);
  (deps.writeInstance ?? writeInstanceFiles)({ instanceRoot: PHIBOT_INSTANCE_ROOT, exposure, now: sys.now() });
  const paths = installPathsFor(sys.realpath(sys.execPath), await npmRootGlobal(sys));
  const missing = missingEmbeddedPostgresAliases(sys, path.posix.join(paths.packageDir, EMBEDDED_POSTGRES_LIB_SUBPATH));
  if (missing.length > 0) {
    throw new PhibotStepError(STEP, `alias de bibliothèques de Postgres embarqué absents : ${missing.join(", ")}.`, "Créez-les à la construction de l'image, en root (plan F).");
  }
  // Every start replays step 7 (idempotent); an existing instance also gets step 9b.
  const existing = sys.exists(PHIBOT_SETUP_MARKER_PATH);
  await preparePhiAssets(sys, logger, paths, deps.resolveCamoufoxJsDir);
  if (existing) await prepareExistingCompany(deps);
  sys.writeFile(PHIBOT_SETUP_MARKER_PATH, `${JSON.stringify({ version: deps.cliVersion, container: true, completedAt: sys.now().toISOString() }, null, 2)}\n`, 0o600);
  sys.env.PAPERCLIP_SERVICE_MANAGED = "1";
  sys.env.PAPERCLIP_DISABLE_CWD_ENV_FILE = "true";
  sys.env.DO_NOT_TRACK = sys.env.DO_NOT_TRACK ?? "1";
  logger.info(`Phi Bot démarre dans le conteneur : ${exposure.publicUrl}. Créez ensuite le propriétaire : docker compose exec -it phibot phibot owner create`);
  await deps.runServer();
}
