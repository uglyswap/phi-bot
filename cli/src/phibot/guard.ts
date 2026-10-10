import { PHIBOT_GUARD_DIR, PHIBOT_GUARD_NFT_PATH, PHIBOT_GUARD_UNIT_NAME, PHIBOT_GUARD_UNIT_PATH, PHIBOT_SYSTEM_USER } from "./constants.js";
import type { PhibotLogger, PhibotSystem } from "./system.js";
import { renderGuardNft, renderGuardUnit } from "./units.js";

/**
 * Local database guard (review M10): loopback connections to 54329 are rejected unless they
 * come from root or phibot. Idempotent; a failure is only a warning (phibot.service only Wants it).
 */
export async function installLocalGuard(sys: PhibotSystem, logger: PhibotLogger): Promise<boolean> {
  const uid = await sys.exec("id", ["-u", PHIBOT_SYSTEM_USER]);
  const phibotUid = Number(uid.stdout.trim());
  if (uid.code !== 0 || !Number.isInteger(phibotUid) || phibotUid <= 0) {
    logger.warn("Garde réseau locale non installée : uid du compte phibot introuvable.");
    return false;
  }
  sys.makeDir(PHIBOT_GUARD_DIR, 0o755);
  sys.writeFile(PHIBOT_GUARD_NFT_PATH, renderGuardNft(phibotUid), 0o644);
  sys.writeFile(PHIBOT_GUARD_UNIT_PATH, renderGuardUnit(), 0o644);
  for (const args of [["daemon-reload"], ["enable", PHIBOT_GUARD_UNIT_NAME], ["restart", PHIBOT_GUARD_UNIT_NAME]]) {
    const result = await sys.exec("systemctl", args);
    if (result.code !== 0) {
      logger.warn(`Garde réseau locale non active (systemctl ${args.join(" ")} : code ${result.code}). Phi Bot fonctionne, mais d'autres comptes locaux peuvent joindre la base sur 127.0.0.1:54329. Voir journalctl -u ${PHIBOT_GUARD_UNIT_NAME}.`);
      return false;
    }
  }
  return true;
}
