import { createRequire } from "node:module";
import path from "node:path";
import { PHIBOT_CAMOUFOX_CACHE_DIR, PHIBOT_PHI_DIR } from "./constants.js";
import type { InstallPaths } from "./global-install.js";
import { buildCleanPhibotCommand, type CommandLine, execAsPhibot } from "./relaunch.js";
import { type ExecOptions, type PhibotLogger, type PhibotSystem, PhibotStepError, tailLines } from "./system.js";

const STEP = "Préparation de phi pour le compte phibot";
const LAUNCH_TIMEOUT_MS = 120_000;
/** Variables that would silently disable phi's install scripts (spec 8.4, R4 §1.5). */
const BLOCKED_ENV = ["CI", "PHI_SKIP_POSTINSTALL", "CAMOUFOX_SKIP_DOWNLOAD"];

/**
 * Real headless launch (review M6): resolves camoufox-js from phi's package.json, opens
 * about:blank and closes. The first launch also downloads uBlock Origin next to the binary.
 */
export const CAMOUFOX_LAUNCH_SCRIPT = [
  'import { createRequire } from "node:module";',
  'import { pathToFileURL } from "node:url";',
  "const entry = createRequire(process.argv[1]).resolve(\"@phi-code-admin/camoufox-js\");",
  "const { Camoufox } = await import(pathToFileURL(entry).href);",
  "const browser = await Camoufox({ headless: true });",
  "const page = await browser.newPage();",
  'await page.goto("about:blank");',
  "await browser.close();",
  'console.log("camoufox-ok");',
].join("\n");

/** Directory of the camoufox-js package that phi itself would load. */
export function resolveCamoufoxJsDirFromPhi(phiDir: string): string {
  const require = createRequire(path.posix.join(phiDir, "package.json"));
  return path.dirname(require.resolve("@phi-code-admin/camoufox-js/package.json"));
}

/**
 * Runs `node <args>` as phibot without CI or PHI_SKIP_POSTINSTALL: through `runuser ... env -i`
 * when called by root (setup), directly when already the service account (container, spec 14).
 */
export function phibotNodeCommand(sys: PhibotSystem, nodePath: string, args: string[]): { line: CommandLine; options: ExecOptions } {
  if (sys.uid === 0) return { line: buildCleanPhibotCommand(nodePath, args, sys.env), options: {} };
  const env = { ...sys.env };
  for (const key of BLOCKED_ENV) delete env[key];
  return { line: { command: nodePath, args }, options: { env } };
}

/** `<cache>/<release>/linux-x64/camoufox-bin/camoufox-bin`, newest release first. */
export function findCamoufoxLauncher(sys: PhibotSystem, cacheDir: string = PHIBOT_CAMOUFOX_CACHE_DIR): string | null {
  for (const release of sys.listDir(cacheDir).sort().reverse()) {
    const candidate = path.posix.join(cacheDir, release, "linux-x64", "camoufox-bin", "camoufox-bin");
    if (sys.exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Libraries reported "not found" by ldd for the launcher and every *.so of its folder, libxul.so
 * included (spec 6.2 step 7.3). As Playwright does, the folder is on LD_LIBRARY_PATH: Firefox's
 * own libraries are loaded by the launcher from its folder, not found through a run path.
 */
export async function missingCamoufoxLibraries(sys: PhibotSystem, launcher: string): Promise<string[]> {
  const dir = path.posix.dirname(launcher);
  const targets = [launcher, ...sys.listDir(dir).filter((name) => name.endsWith(".so")).map((name) => path.posix.join(dir, name))];
  const env = { ...sys.env, LD_LIBRARY_PATH: [dir, sys.env.LD_LIBRARY_PATH].filter(Boolean).join(":") };
  const missing = new Set<string>();
  for (const target of targets) {
    const result = await sys.exec("ldd", [target], { env });
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^\s*(\S+)\s+=>\s+not found/.exec(line);
      if (match) missing.add(match[1]);
    }
  }
  return [...missing].sort();
}

async function runNodeAsPhibot(sys: PhibotSystem, paths: InstallPaths, args: string[], extra: ExecOptions, what: string): Promise<string> {
  const { line, options } = phibotNodeCommand(sys, paths.nodePath, args);
  const result = await execAsPhibot(sys, line, { ...options, ...extra });
  if (result.code !== 0) {
    const output = tailLines([result.stdout, result.stderr].filter((text) => text.trim()).join("\n"), 20);
    throw new PhibotStepError(STEP, `${what} a échoué (code ${result.code}).${output ? `\n${output}` : ""}`, "Vérifiez l'accès réseau vers github.com et addons.mozilla.org, puis relancez sudo phibot setup --repair.");
  }
  return result.stdout;
}

/**
 * Step 7 (spec 6.2, review M6 and M12): phi's postinstall, Camoufox download by camoufox-js
 * (as phibot, in its own cache), library check, then a real headless launch. Blocking.
 */
export async function preparePhiAssets(
  sys: PhibotSystem,
  logger: PhibotLogger,
  paths: InstallPaths,
  resolveCamoufoxJsDir: (phiDir: string) => string = resolveCamoufoxJsDirFromPhi,
): Promise<{ launcher: string }> {
  logger.step("Préparation de phi (extensions, mémoire) pour le compte phibot...");
  await runNodeAsPhibot(sys, paths, [path.posix.join(paths.phiDir, "scripts", "postinstall.cjs")], {}, "Le postinstall de phi");
  if (!sys.exists(path.posix.join(PHIBOT_PHI_DIR, "memory", "notes"))) {
    throw new PhibotStepError(STEP, `${PHIBOT_PHI_DIR}/memory/notes absent après le postinstall de phi.`, "Relancez sudo phibot setup --repair.");
  }
  logger.step("Téléchargement de Camoufox pour le compte phibot (environ 680 Mio, une seule fois)...");
  const camoufoxJs = resolveCamoufoxJsDir(paths.phiDir);
  await runNodeAsPhibot(sys, paths, [path.posix.join(camoufoxJs, "scripts", "postinstall.mjs")], { inherit: true }, "Le téléchargement de Camoufox");
  const launcher = findCamoufoxLauncher(sys);
  if (!launcher) {
    throw new PhibotStepError(STEP, `lanceur Camoufox introuvable sous ${PHIBOT_CAMOUFOX_CACHE_DIR}.`, "Vérifiez l'accès à github.com (release binaries-v1.0.0 de uglyswap/phi-code) puis relancez sudo phibot setup --repair.");
  }
  const missing = await missingCamoufoxLibraries(sys, launcher);
  if (missing.length > 0) {
    throw new PhibotStepError(STEP, `bibliothèques manquantes pour Camoufox : ${missing.join(", ")}.`, "Relancez sudo phibot setup --repair (étape des paquets système).");
  }
  logger.step("Premier lancement de Camoufox (vérification, téléchargement de uBlock Origin)...");
  const output = await runNodeAsPhibot(
    sys,
    paths,
    ["--input-type=module", "-e", CAMOUFOX_LAUNCH_SCRIPT, path.posix.join(paths.phiDir, "package.json")],
    { timeoutMs: LAUNCH_TIMEOUT_MS },
    "Le lancement de Camoufox",
  );
  if (!output.includes("camoufox-ok")) throw new PhibotStepError(STEP, "Camoufox n'a pas confirmé son lancement.", "Consultez les messages ci-dessus puis relancez sudo phibot setup --repair.");
  logger.success(`Camoufox prêt : ${launcher}`);
  return { launcher };
}
