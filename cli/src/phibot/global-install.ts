import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PHIBOT_DEFAULT_NPM_REGISTRY,
  PHIBOT_NPM_ALLOW_SCRIPTS,
  PHIBOT_NPM_INSTALL_ENV,
  PHIBOT_PACKAGE_NAME,
  PHIBOT_PACKAGE_SCOPE,
} from "./constants.js";
import { type PhibotLogger, type PhibotSystem, PhibotStepError, execOrThrow } from "./system.js";

export interface InstallPaths {
  /** Resolved node binary (`realpath` of the running node). */
  nodePath: string;
  /** `npm root -g`. */
  npmRoot: string;
  /** `$ROOT/@phi-code-admin/phi-bot`. */
  packageDir: string;
  /** `$ROOT/@phi-code-admin/phi-bot/dist/index.js`. */
  phibotJsPath: string;
  /** phi installed as a dependency of Phi Bot. */
  phiDir: string;
}

/** Library folder of embedded Postgres whose aliases must exist before the service starts (review B1). */
export const EMBEDDED_POSTGRES_LIB_SUBPATH = "node_modules/@embedded-postgres/linux-x64/native/lib";

export function installPathsFor(nodePath: string, npmRoot: string): InstallPaths {
  const packageDir = path.posix.join(npmRoot, PHIBOT_PACKAGE_NAME);
  return {
    nodePath,
    npmRoot,
    packageDir,
    phibotJsPath: path.posix.join(packageDir, "dist", "index.js"),
    phiDir: path.posix.join(packageDir, "node_modules", "@phi-code-admin", "phi-code"),
  };
}

/** The npm next to the running node (same installation), otherwise the one on PATH. */
export function npmCommand(sys: PhibotSystem): string {
  const sibling = path.posix.join(path.posix.dirname(sys.execPath), "npm");
  return sys.exists(sibling) ? sibling : "npm";
}

export async function npmRootGlobal(sys: PhibotSystem): Promise<string> {
  const result = await execOrThrow(sys, npmCommand(sys), ["root", "-g"], {
    step: "Installation durable",
    fix: "Vérifiez que npm fonctionne (npm root -g) puis relancez la commande.",
  });
  return result.stdout.trim();
}

/** PHIBOT_NPM_REGISTRY (spec 5.4), used by the e2e test with a local registry. */
export function resolveNpmRegistry(env: NodeJS.ProcessEnv): string {
  const raw = env.PHIBOT_NPM_REGISTRY?.trim() || PHIBOT_DEFAULT_NPM_REGISTRY;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PHIBOT_NPM_REGISTRY invalide : « ${raw} ».`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`PHIBOT_NPM_REGISTRY invalide : « ${raw} ».`);
  return raw.replace(/\/+$/, "");
}

export function buildGlobalInstallArgs(version: string, registry: string): string[] {
  return [
    "install",
    "-g",
    `${PHIBOT_PACKAGE_NAME}@${version}`,
    `--registry=${registry}`,
    `--${PHIBOT_PACKAGE_SCOPE}:registry=${registry}`,
    "--no-audit",
    "--no-fund",
    `--allow-scripts=${PHIBOT_NPM_ALLOW_SCRIPTS.join(",")}`,
  ];
}

export function buildGlobalInstallEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, ...PHIBOT_NPM_INSTALL_ENV };
}

export function readInstalledVersion(sys: PhibotSystem, npmRoot: string): string | null {
  const manifest = path.posix.join(npmRoot, PHIBOT_PACKAGE_NAME, "package.json");
  if (!sys.exists(manifest)) return null;
  const parsed = JSON.parse(sys.readFile(manifest)) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : null;
}

export async function npmInstallGlobal(sys: PhibotSystem, logger: PhibotLogger, version: string, registry: string): Promise<void> {
  logger.step(`Installation de ${PHIBOT_PACKAGE_NAME}@${version} (npm install -g, plusieurs minutes)...`);
  await execOrThrow(sys, npmCommand(sys), buildGlobalInstallArgs(version, registry), {
    step: "Installation durable",
    fix: "Corrigez l'erreur de npm affichée ci-dessus (réseau, registre, espace disque) puis relancez la commande.",
  }, { env: buildGlobalInstallEnv(sys.env), inherit: true });
}

export type AliasFunction = (libDir: string) => Promise<string[]>;

/** `ensureLinuxSharedLibraryAliases` of the installed `@paperclipai/db` (review B1). */
export async function loadInstalledAliasFunction(packageDir: string): Promise<AliasFunction> {
  const file = path.posix.join(packageDir, "node_modules", "@paperclipai", "db", "dist", "embedded-postgres-native.js");
  const loaded: unknown = await import(pathToFileURL(file).href);
  const candidate = (loaded as { ensureLinuxSharedLibraryAliases?: unknown }).ensureLinuxSharedLibraryAliases;
  if (typeof candidate !== "function") throw new Error(`ensureLinuxSharedLibraryAliases introuvable dans ${file}.`);
  return candidate as AliasFunction;
}

/**
 * Creates, as root, the libssl.so.1 / libcrypto.so.1 style aliases that the server would
 * otherwise try to create at each start in a folder it cannot write (review B1).
 */
export async function ensureEmbeddedPostgresAliases(
  sys: PhibotSystem,
  packageDir: string,
  loadAliasFunction: (packageDir: string) => Promise<AliasFunction> = loadInstalledAliasFunction,
): Promise<string[]> {
  const libDir = path.posix.join(packageDir, EMBEDDED_POSTGRES_LIB_SUBPATH);
  if (!sys.exists(libDir)) {
    throw new PhibotStepError("Installation durable", `bibliothèques de Postgres embarqué introuvables : ${libDir}.`, "Réinstallez Phi Bot : sudo phibot setup --repair.");
  }
  const ensureAliases = await loadAliasFunction(packageDir);
  return ensureAliases(libDir);
}

/** Aliases expected next to each `lib<name>.so.<major>.<minor>` file: used by `doctor`. */
export function missingEmbeddedPostgresAliases(sys: PhibotSystem, libDir: string): string[] {
  const names = sys.listDir(libDir);
  const missing: string[] = [];
  for (const name of names) {
    const match = /^(lib.+\.so\.\d+)\.\d+(?:\.\d+)?$/.exec(name);
    if (match && !names.includes(match[1])) missing.push(match[1]);
  }
  return missing;
}

/** Step 5 of `setup`: exact CLI version installed globally, absolute paths resolved, aliases created. */
export async function ensureGlobalInstall(
  sys: PhibotSystem,
  logger: PhibotLogger,
  input: { cliVersion: string; loadAliasFunction?: (packageDir: string) => Promise<AliasFunction> },
): Promise<InstallPaths> {
  const npmRoot = await npmRootGlobal(sys);
  const installed = readInstalledVersion(sys, npmRoot);
  if (installed !== input.cliVersion) {
    await npmInstallGlobal(sys, logger, input.cliVersion, resolveNpmRegistry(sys.env));
  } else {
    logger.info(`${PHIBOT_PACKAGE_NAME}@${installed} est déjà installé.`);
  }
  const paths = installPathsFor(sys.realpath(sys.execPath), npmRoot);
  if (!sys.exists(paths.phibotJsPath)) {
    throw new PhibotStepError("Installation durable", `fichier introuvable après l'installation : ${paths.phibotJsPath}.`, "Relancez sudo phibot setup --repair.");
  }
  await ensureEmbeddedPostgresAliases(sys, paths.packageDir, input.loadAliasFunction);
  return paths;
}
