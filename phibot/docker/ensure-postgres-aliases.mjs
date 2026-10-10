// Phi Bot Docker image (spec 14, 4.3 and 5.4): creates, as root at build time, the embedded
// Postgres library aliases (libssl.so.1 style) that the server would otherwise try to create
// at each start in a folder the phibot account cannot write.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** First entry: the folder used by `phibot setup` (plan D, EMBEDDED_POSTGRES_LIB_SUBPATH). */
export const LIB_SUBPATHS = [
  "node_modules/@embedded-postgres/linux-x64/native/lib",
  "node_modules/@paperclipai/db/node_modules/@embedded-postgres/linux-x64/native/lib",
];
export const ALIAS_MODULE_SUBPATH = "node_modules/@paperclipai/db/dist/embedded-postgres-native.js";
const VERSIONED_LIBRARY = /^(lib.+\.so\.\d+)\.\d+(?:\.\d+)?$/;

/** Same rule as `missingEmbeddedPostgresAliases` of plan D. */
export function missingAliases(libDir) {
  const names = fs.readdirSync(libDir);
  const missing = [];
  for (const name of names) {
    const match = VERSIONED_LIBRARY.exec(name);
    if (match && !names.includes(match[1])) missing.push(match[1]);
  }
  return missing;
}

export async function ensureAliases(packageDir) {
  const primary = path.join(packageDir, LIB_SUBPATHS[0]);
  if (!fs.existsSync(primary)) throw new Error(`dossier introuvable : ${primary}`);
  const moduleFile = path.join(packageDir, ALIAS_MODULE_SUBPATH);
  if (!fs.existsSync(moduleFile)) throw new Error(`fichier introuvable : ${moduleFile}`);
  const loaded = await import(pathToFileURL(moduleFile).href);
  if (typeof loaded.ensureLinuxSharedLibraryAliases !== "function") {
    throw new Error(`ensureLinuxSharedLibraryAliases absente de ${moduleFile}`);
  }
  const lines = [];
  for (const libDir of LIB_SUBPATHS.map((sub) => path.join(packageDir, sub)).filter((dir) => fs.existsSync(dir))) {
    const created = await loaded.ensureLinuxSharedLibraryAliases(libDir);
    const missing = missingAliases(libDir);
    if (missing.length > 0) throw new Error(`alias manquants dans ${libDir} : ${missing.join(", ")}`);
    lines.push(`postgres-aliases-ok ${libDir} (${created.length} alias créés)`);
  }
  return lines;
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const packageDir = process.argv[2];
  if (!packageDir) {
    console.error("usage : node ensure-postgres-aliases.mjs <dossier du paquet @phi-code-admin/phi-bot>");
    process.exit(2);
  }
  try {
    for (const line of await ensureAliases(path.resolve(packageDir))) console.log(line);
  } catch (error) {
    console.error(`ensure-postgres-aliases : ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
