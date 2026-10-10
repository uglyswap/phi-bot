import { createHash } from "node:crypto";
import {
  CADDY_ARCHIVE_SHA512,
  CADDY_ARCHIVE_URL,
  CADDY_BINARY_PATH,
  CADDY_CONFIG_DIR,
  CADDY_HEALTH_TIMEOUT_MS,
  CADDY_INSTALL_MARKER_PATH,
  CADDY_MANAGED_HEADER,
  CADDY_UNIT_PATH,
  CADDY_VERSION,
  CADDYFILE_PATH,
} from "./constants.js";
import { type PhibotLogger, type PhibotSystem, PhibotStepError, execOrThrow } from "./system.js";
import { type CaddyfileInput, normalizeDomain, renderCaddyUnit, renderCaddyfile } from "./units.js";

const STEP = "Exposition (Caddy)";

export function sha512Hex(data: Uint8Array): string {
  return createHash("sha512").update(data).digest("hex");
}

async function installedCaddyIsPinned(sys: PhibotSystem): Promise<boolean> {
  if (!sys.exists(CADDY_BINARY_PATH)) return false;
  const version = await sys.exec(CADDY_BINARY_PATH, ["version"]);
  return version.code === 0 && version.stdout.trim().split(/\s+/)[0] === `v${CADDY_VERSION}`;
}

/** Spec 6.5 point 2: pinned archive, SHA-512 compared with the constant, only `caddy` extracted. */
export async function installCaddyBinary(sys: PhibotSystem, logger: PhibotLogger, expectedSha512: string = CADDY_ARCHIVE_SHA512): Promise<void> {
  if (await installedCaddyIsPinned(sys)) {
    logger.info(`Caddy ${CADDY_VERSION} est déjà installé.`);
    return;
  }
  logger.step(`Téléchargement de Caddy ${CADDY_VERSION}...`);
  const response = await sys.fetch(CADDY_ARCHIVE_URL);
  if (!response.ok) throw new PhibotStepError(STEP, `téléchargement de Caddy impossible (HTTP ${response.status}).`, "Vérifiez l'accès à github.com puis relancez sudo phibot setup --repair.");
  const archive = new Uint8Array(await response.arrayBuffer());
  const digest = sha512Hex(archive);
  if (digest !== expectedSha512) {
    throw new PhibotStepError(STEP, `empreinte SHA-512 inattendue pour l'archive de Caddy (${digest.slice(0, 16)}...).`, "Ne continuez pas : signalez-le à l'équipe Phi Bot.");
  }
  const workDir = `/var/tmp/phibot-caddy-${sys.now().getTime()}`;
  sys.makeDir(workDir, 0o700);
  try {
    sys.writeFile(`${workDir}/caddy.tar.gz`, archive, 0o600);
    const fix = { step: STEP, fix: "Relancez sudo phibot setup --repair." };
    await execOrThrow(sys, "tar", ["-xzf", `${workDir}/caddy.tar.gz`, "-C", workDir, "caddy"], fix);
    await execOrThrow(sys, "install", ["-m", "0755", "-o", "root", "-g", "root", `${workDir}/caddy`, CADDY_BINARY_PATH], fix);
  } finally {
    sys.remove(workDir);
  }
  if (!(await installedCaddyIsPinned(sys))) throw new PhibotStepError(STEP, `${CADDY_BINARY_PATH} ne répond pas v${CADDY_VERSION}.`, "Relancez sudo phibot setup --repair.");
}

/** Spec 6.5 point 3, as in the official documentation. */
export async function ensureCaddyAccount(sys: PhibotSystem): Promise<void> {
  const fix = { step: STEP, fix: "Créez le compte caddy à la main puis relancez sudo phibot setup --repair." };
  if ((await sys.exec("getent", ["group", "caddy"])).code !== 0) await execOrThrow(sys, "groupadd", ["--system", "caddy"], fix);
  if ((await sys.exec("getent", ["passwd", "caddy"])).code !== 0) {
    await execOrThrow(sys, "useradd", ["--system", "--gid", "caddy", "--create-home", "--home-dir", "/var/lib/caddy", "--shell", "/usr/sbin/nologin", "--comment", "Caddy web server", "caddy"], fix);
  }
}

async function waitForHttps(sys: PhibotSystem, input: CaddyfileInput): Promise<boolean> {
  const domain = normalizeDomain(input.domain);
  const args = ["-fsS", ...(input.tlsInternal ? ["-k"] : []), "--max-time", "5", "--resolve", `${domain}:443:127.0.0.1`, `https://${domain}/api/health`];
  const deadline = sys.now().getTime() + CADDY_HEALTH_TIMEOUT_MS;
  while (sys.now().getTime() <= deadline) {
    const result = await sys.exec("curl", args);
    if (result.code === 0 && result.stdout.includes('"status":"ok"')) return true;
    await sys.sleep(5_000);
  }
  return false;
}

async function openFirewall(sys: PhibotSystem, logger: PhibotLogger): Promise<void> {
  const status = await sys.exec("ufw", ["status"]);
  if (status.code !== 0 || !/^Status: active/m.test(status.stdout)) return;
  for (const rule of ["80/tcp", "443/tcp"]) await sys.exec("ufw", ["allow", rule]);
  logger.info("Pare-feu ufw : ports 80 et 443 ouverts.");
}

/** Spec 6.5: binary, account, Caddyfile, unit, start, HTTPS check (warning only), firewall. */
export async function configureCaddy(
  sys: PhibotSystem,
  logger: PhibotLogger,
  input: CaddyfileInput,
  expectedSha512: string = CADDY_ARCHIVE_SHA512,
): Promise<{ httpsReady: boolean }> {
  if (sys.exists(CADDYFILE_PATH) && !sys.readFile(CADDYFILE_PATH).startsWith(`${CADDY_MANAGED_HEADER}\n`)) {
    throw new PhibotStepError(STEP, `${CADDYFILE_PATH} n'a pas été écrit par Phi Bot.`, "Retirez le Caddy existant ou utilisez --access ssh ou --access tailscale.");
  }
  await installCaddyBinary(sys, logger, expectedSha512);
  await ensureCaddyAccount(sys);
  sys.makeDir(CADDY_CONFIG_DIR, 0o755);
  sys.writeFile(CADDYFILE_PATH, renderCaddyfile(input), 0o644);
  sys.writeFile(CADDY_INSTALL_MARKER_PATH, "", 0o644);
  sys.writeFile(CADDY_UNIT_PATH, renderCaddyUnit(), 0o644);
  const fix = { step: STEP, fix: "Consultez journalctl -u caddy.service puis relancez sudo phibot setup --repair." };
  await execOrThrow(sys, CADDY_BINARY_PATH, ["validate", "--config", CADDYFILE_PATH], fix);
  await execOrThrow(sys, "systemctl", ["daemon-reload"], fix);
  await execOrThrow(sys, "systemctl", ["enable", "caddy.service"], fix);
  await execOrThrow(sys, "systemctl", ["restart", "caddy.service"], fix);
  logger.step(`Attente du certificat HTTPS de ${normalizeDomain(input.domain)} (2 minutes au plus)...`);
  const httpsReady = await waitForHttps(sys, input);
  if (!httpsReady) {
    logger.warn(`HTTPS ne répond pas encore pour ${input.domain} : vérifiez que le DNS pointe sur ce serveur et que les ports 80 et 443 sont ouverts ; Caddy réessaie seul.`);
  }
  await openFirewall(sys, logger);
  return { httpsReady };
}

/**
 * Spec 13.6, also used by `setup --reconfigure` (13.8): only when Phi Bot installed Caddy (marker),
 * stop and disable it, remove its unit, the managed Caddyfile and the marker. The binary
 * /usr/local/bin/caddy and the caddy account stay.
 */
export async function removeManagedCaddy(sys: PhibotSystem): Promise<boolean> {
  if (!sys.exists(CADDY_INSTALL_MARKER_PATH)) return false;
  await sys.exec("systemctl", ["disable", "--now", "caddy.service"]);
  sys.remove(CADDY_UNIT_PATH);
  if (sys.exists(CADDYFILE_PATH) && sys.readFile(CADDYFILE_PATH).startsWith(`${CADDY_MANAGED_HEADER}\n`)) sys.remove(CADDYFILE_PATH);
  sys.remove(CADDY_INSTALL_MARKER_PATH);
  await sys.exec("systemctl", ["daemon-reload"]);
  return true;
}
