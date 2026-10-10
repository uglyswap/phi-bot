import path from "node:path";
import { isSupportedNodeVersion, MINIMUM_NODE_VERSION } from "@paperclipai/shared/node-version";
import {
  CADDYFILE_PATH,
  CADDY_MANAGED_HEADER,
  PHIBOT_MIN_FREE_DISK_BYTES,
  PHIBOT_MIN_TOTAL_MEMORY_BYTES,
  PHIBOT_RECOMMENDED_MEMORY_BYTES,
} from "./constants.js";
import { npmRootGlobal } from "./global-install.js";
import type { PhibotAccess } from "./instance-config.js";
import { type PhibotSystem, PhibotStepError } from "./system.js";
import { readTailscaleStatus } from "./tailscale.js";

export interface PreflightInput {
  access: PhibotAccess;
  domain?: string;
  /** phibot.service is already installed: ports 3100 and 54329 may be its own. */
  unitExists: boolean;
}

export interface PreflightResult {
  warnings: string[];
  tailnetName: string | null;
}

const STEP = "Contrôles";
const GIB = 1024 ** 3;
const NODESOURCE_HINT = "Installez Node.js 24 au niveau système (NodeSource : https://deb.nodesource.com/setup_24.x, puis sudo apt-get install -y nodejs) et relancez la commande.";

function fail(problem: string, fix: string): never {
  throw new PhibotStepError(STEP, problem, fix);
}

function isUnderPrivateHome(target: string): boolean {
  const normalized = path.posix.normalize(target);
  return ["/home", "/root"].some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function checkHost(sys: PhibotSystem): void {
  if (sys.platform !== "linux") fail(`système ${sys.platform} non pris en charge.`, "Installez Phi Bot sur un serveur Linux (Ubuntu 22.04 ou 24.04, Debian 12) ou sous WSL2 avec systemd.");
  if (sys.arch !== "x64") fail(`architecture ${sys.arch} non prise en charge.`, "Utilisez un serveur x86_64.");
  if (sys.uid !== 0) fail("droits administrateur requis.", "Relancez la commande avec sudo.");
  if (!isSupportedNodeVersion(sys.nodeVersion)) fail(`Node.js ${sys.nodeVersion} trop ancien (minimum ${MINIMUM_NODE_VERSION}).`, NODESOURCE_HINT);
  const node = sys.realpath(sys.execPath);
  if (isUnderPrivateHome(node)) fail(`Node.js est installé sous ${node} (nvm ?), illisible par le compte phibot.`, NODESOURCE_HINT);
  if (!sys.exists("/run/systemd/system")) fail("systemd n'est pas actif.", "Utilisez un serveur démarré par systemd (sous WSL2 : [boot] systemd=true dans /etc/wsl.conf).");
  if (!sys.exists("/usr/bin/apt-get")) fail("apt-get introuvable.", "Utilisez Ubuntu ou Debian.");
}

function checkResources(sys: PhibotSystem, warnings: string[]): void {
  const memory = sys.totalMemoryBytes();
  if (memory < PHIBOT_MIN_TOTAL_MEMORY_BYTES) fail(`mémoire insuffisante (${(memory / GIB).toFixed(1)} Gio, minimum 3 Gio).`, "Utilisez un serveur avec au moins 4 Go de RAM.");
  if (memory < PHIBOT_RECOMMENDED_MEMORY_BYTES) warnings.push(`Mémoire de ${(memory / GIB).toFixed(1)} Gio : 8 Go sont recommandés pour les agents qui naviguent.`);
  const free = sys.freeDiskBytes("/var/lib");
  if (free < PHIBOT_MIN_FREE_DISK_BYTES) fail(`espace disque insuffisant sur /var/lib (${(free / GIB).toFixed(1)} Gio libres, minimum 10 Gio).`, "Libérez de l'espace disque puis relancez la commande.");
}

async function listeners(sys: PhibotSystem, ports: number[]): Promise<string> {
  const filter = `( ${ports.map((port) => `sport = :${port}`).join(" or ")} )`;
  const result = await sys.exec("ss", ["-ltnH", filter]);
  return result.stdout.trim();
}

async function checkDomain(sys: PhibotSystem, domain: string, warnings: string[]): Promise<void> {
  const managed = sys.exists(CADDYFILE_PATH) && sys.readFile(CADDYFILE_PATH).startsWith(`${CADDY_MANAGED_HEADER}\n`);
  if (sys.exists(CADDYFILE_PATH) && !managed) fail(`${CADDYFILE_PATH} existe et n'a pas été écrit par Phi Bot.`, "Utilisez --access ssh ou --access tailscale, ou retirez le Caddy existant.");
  if (!managed) {
    const busy = await listeners(sys, [80, 443]);
    if (busy) fail(`un autre serveur écoute déjà sur le port 80 ou 443 :\n${busy}`, "Arrêtez ce serveur web ou utilisez --access ssh ou --access tailscale.");
  }
  const resolved = await sys.exec("getent", ["ahosts", domain]);
  if (resolved.code !== 0 || !resolved.stdout.trim()) {
    warnings.push(`Le nom ${domain} ne résout pas encore : le certificat HTTPS sera émis dès que le DNS pointera sur ce serveur.`);
  }
}

/** Guard of the modes that only change an installed server (`--repair`, `--reconfigure`). */
export function requireRoot(sys: PhibotSystem): void {
  if (sys.platform !== "linux") fail(`système ${sys.platform} non pris en charge.`, "Lancez la commande sur le serveur Linux de Phi Bot.");
  if (sys.uid !== 0) fail("droits administrateur requis.", "Relancez la commande avec sudo.");
}

/** Checks of the chosen access (end of step 1), also run by `setup --reconfigure` (spec 13.8). */
export async function checkAccess(sys: PhibotSystem, input: { access: PhibotAccess; domain?: string }): Promise<PreflightResult> {
  const warnings: string[] = [];
  let tailnetName: string | null = null;
  if (input.access === "domain" && input.domain) await checkDomain(sys, input.domain, warnings);
  if (input.access === "tailscale") {
    const status = await readTailscaleStatus(sys);
    if (status.backendState !== "Running" || !status.dnsName) {
      fail(`Tailscale n'est pas connecté (état ${status.backendState || "inconnu"}).`, "Connectez ce serveur au tailnet (sudo tailscale up) puis relancez la commande.");
    }
    if (!status.certificatesEnabled) warnings.push("Les certificats HTTPS ne semblent pas activés pour ce tailnet : activez « HTTPS Certificates » dans la console Tailscale (page DNS).");
    tailnetName = status.dnsName;
  }
  return { warnings, tailnetName };
}

/** Step 1 of `phibot setup` (spec 6.2, review m10). Throws on the first blocking problem. */
export async function runPreflightChecks(sys: PhibotSystem, input: PreflightInput): Promise<PreflightResult> {
  const warnings: string[] = [];
  checkHost(sys);
  const npmRoot = sys.realpath(await npmRootGlobal(sys));
  if (isUnderPrivateHome(npmRoot)) fail(`le préfixe global de npm est sous ${npmRoot}, illisible par le compte phibot.`, NODESOURCE_HINT);
  checkResources(sys, warnings);
  if (!input.unitExists) {
    const busy = await listeners(sys, [3100, 54329]);
    if (busy) fail(`les ports 3100 ou 54329 sont déjà utilisés :\n${busy}`, "Arrêtez le programme qui les utilise (par exemple un Paperclip existant) puis relancez la commande.");
  }
  const access = await checkAccess(sys, input);
  return { warnings: [...warnings, ...access.warnings], tailnetName: access.tailnetName };
}
