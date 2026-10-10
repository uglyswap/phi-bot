import { PHIBOT_LOCAL_URL } from "./constants.js";
import { type PhibotSystem, PhibotStepError, execOrThrow } from "./system.js";

export interface TailscaleStatus {
  backendState: string;
  /** `Self.DNSName` without its final dot, or null. */
  dnsName: string | null;
  /** HTTPS certificates enabled in the tailnet console for this name. */
  certificatesEnabled: boolean;
}

/** `tailscale status --json` (ipn/ipnstate: BackendState, Self.DNSName ending with a dot, CertDomains). */
export function parseTailscaleStatus(json: string): TailscaleStatus {
  const parsed = JSON.parse(json) as { BackendState?: unknown; Self?: { DNSName?: unknown }; CertDomains?: unknown };
  const raw = typeof parsed.Self?.DNSName === "string" ? parsed.Self.DNSName.trim() : "";
  const dnsName = raw ? raw.replace(/\.$/, "").toLowerCase() : null;
  const certDomains = Array.isArray(parsed.CertDomains) ? parsed.CertDomains.filter((value): value is string => typeof value === "string") : [];
  return {
    backendState: typeof parsed.BackendState === "string" ? parsed.BackendState : "",
    dnsName,
    certificatesEnabled: dnsName !== null && certDomains.map((value) => value.toLowerCase()).includes(dnsName),
  };
}

export async function readTailscaleStatus(sys: PhibotSystem): Promise<TailscaleStatus> {
  const result = await sys.exec("tailscale", ["status", "--json"]);
  if (result.code !== 0) {
    throw new PhibotStepError("Contrôles", "tailscale status --json a échoué.", "Installez Tailscale et connectez ce serveur (sudo tailscale up), puis relancez la commande.");
  }
  return parseTailscaleStatus(result.stdout);
}

/** Spec 6.7: tailnet only, never Funnel. */
export async function enableTailscaleServe(sys: PhibotSystem): Promise<void> {
  await execOrThrow(sys, "tailscale", ["serve", "--bg", "--https=443", PHIBOT_LOCAL_URL], {
    step: "Exposition",
    fix: "Activez les certificats HTTPS dans la console du tailnet puis relancez sudo phibot setup --repair.",
  });
}

export async function disableTailscaleServe(sys: PhibotSystem): Promise<void> {
  await sys.exec("tailscale", ["serve", "--https=443", "off"]);
}
