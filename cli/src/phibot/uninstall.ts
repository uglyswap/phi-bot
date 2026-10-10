import { removeManagedCaddy } from "./caddy.js";
import {
  PHIBOT_GUARD_DIR,
  PHIBOT_GUARD_UNIT_NAME,
  PHIBOT_GUARD_UNIT_PATH,
  PHIBOT_HOME_DIR,
  PHIBOT_PACKAGE_NAME,
  PHIBOT_SYSTEM_USER,
  PHIBOT_UNIT_NAME,
  PHIBOT_UNIT_PATH,
} from "./constants.js";
import { readSetupMarker } from "./setup.js";
import { type PhibotLogger, type PhibotPrompter, type PhibotSystem, PhibotStepError } from "./system.js";
import { disableTailscaleServe } from "./tailscale.js";

const STEP = "Désinstallation";
const PURGE_WORD = "SUPPRIMER";

export interface UninstallOptions {
  purge?: boolean;
  yes?: boolean;
}

async function confirm(options: UninstallOptions, prompter: PhibotPrompter): Promise<void> {
  if (options.purge && !prompter.interactive) {
    throw new PhibotStepError(STEP, "--purge exige une confirmation tapée au clavier.", "Lancez la commande dans un terminal interactif.");
  }
  if (options.yes) return;
  if (!prompter.interactive) throw new PhibotStepError(STEP, "confirmation requise.", "Relancez avec --yes.");
  const accepted = await prompter.confirm({ message: `Désinstaller le service Phi Bot ? Les données de ${PHIBOT_HOME_DIR} sont conservées${options.purge ? " (sauf confirmation de --purge ensuite)" : ""}.` });
  if (!accepted) throw new PhibotStepError(STEP, "désinstallation annulée.", "Aucune modification n'a été faite.");
}

async function removeUnit(sys: PhibotSystem, unit: string, unitPath: string): Promise<void> {
  await sys.exec("systemctl", ["disable", "--now", unit]);
  sys.remove(unitPath);
}

async function purge(sys: PhibotSystem, logger: PhibotLogger, prompter: PhibotPrompter): Promise<void> {
  const answer = await prompter.text({ message: `Tapez ${PURGE_WORD} pour effacer définitivement ${PHIBOT_HOME_DIR} (base, fichiers, mémoire, clé maîtresse) et le compte phibot` });
  if (answer.trim() !== PURGE_WORD) {
    logger.warn(`Effacement annulé : ${PHIBOT_HOME_DIR} est conservé.`);
    return;
  }
  sys.remove(PHIBOT_HOME_DIR);
  await sys.exec("userdel", [PHIBOT_SYSTEM_USER]);
  logger.success(`${PHIBOT_HOME_DIR} et le compte phibot sont supprimés.`);
}

/** `sudo phibot uninstall [--purge] [--yes]` (spec 13.6). */
export async function runPhibotUninstall(options: UninstallOptions, deps: { sys: PhibotSystem; logger: PhibotLogger; prompter: PhibotPrompter }): Promise<void> {
  const { sys, logger, prompter } = deps;
  if (sys.uid !== 0) throw new PhibotStepError(STEP, "droits administrateur requis.", "Relancez avec sudo.");
  await confirm(options, prompter);
  const marker = readSetupMarker(sys);
  await removeUnit(sys, PHIBOT_UNIT_NAME, PHIBOT_UNIT_PATH);
  await removeUnit(sys, PHIBOT_GUARD_UNIT_NAME, PHIBOT_GUARD_UNIT_PATH);
  sys.remove(PHIBOT_GUARD_DIR);
  await sys.exec("systemctl", ["daemon-reload"]);
  await sys.exec("systemctl", ["reset-failed", PHIBOT_UNIT_NAME]);
  logger.success("Service phibot arrêté, désactivé et supprimé.");
  if (await removeManagedCaddy(sys)) {
    logger.info("Caddy arrêté et désactivé, son unité et le Caddyfile de Phi Bot supprimés (binaire /usr/local/bin/caddy et compte caddy conservés).");
  }
  if (marker?.access === "tailscale") await disableTailscaleServe(sys);
  if (options.purge) await purge(sys, logger, prompter);
  else logger.info(`Données conservées dans ${PHIBOT_HOME_DIR}.`);
  logger.info(`Pour retirer le programme : sudo npm uninstall -g ${PHIBOT_PACKAGE_NAME}`);
}
