import path from "node:path";
import { openPhibotDatabase } from "./database.js";
import { type PhibotCheck, phibotDoctorChecks } from "./doctor-checks.js";
import { type InstallPaths, installPathsFor } from "./global-install.js";
import { buildPhibotCommand, execAsPhibot, readUnitPaths } from "./relaunch.js";
import { readSetupMarker } from "./setup.js";
import type { PhibotLogger, PhibotSystem } from "./system.js";
import type { PhibotUnitPaths } from "./units.js";

/** Paths of the installed service, from its unit: ROOT is four levels above PHIBOT_JS. */
export function installPathsFromUnit(unit: PhibotUnitPaths): InstallPaths {
  const packageDir = path.posix.dirname(path.posix.dirname(unit.phibotJsPath));
  return installPathsFor(unit.nodePath, path.posix.dirname(path.posix.dirname(packageDir)));
}

/**
 * Root part of `phibot doctor` on a Phi Bot server (spec 6.8, 13.5): `--repair` runs
 * `setup --repair --yes` of the installed version, then the checks run as phibot.
 * Returns their exit code, or null when this process runs the checks itself.
 */
export async function runDoctorRootPart(sys: PhibotSystem, logger: PhibotLogger, options: { repair?: boolean }): Promise<number | null> {
  if (sys.platform !== "linux" || sys.uid !== 0) return null;
  const unit = readUnitPaths(sys);
  if (!unit) return null;
  if (options.repair) {
    logger.step("Réparation : setup --repair --yes...");
    const repair = await sys.exec(unit.nodePath, [unit.phibotJsPath, "setup", "--repair", "--yes"], { inherit: true });
    if (repair.code !== 0) logger.error(`La réparation a échoué (code ${repair.code}) ; les contrôles suivent.`);
  }
  const checks = await execAsPhibot(sys, buildPhibotCommand(unit, ["doctor"]), { inherit: true });
  return checks.code;
}

/** Checks of spec 13.5 when this machine is a Phi Bot server, none otherwise. */
export function phibotServerChecks(sys: PhibotSystem): PhibotCheck[] {
  if (sys.platform !== "linux") return [];
  const unit = readUnitPaths(sys);
  if (!unit) return [];
  return phibotDoctorChecks({ sys, paths: installPathsFromUnit(unit), marker: readSetupMarker(sys), openDatabase: () => openPhibotDatabase() });
}
