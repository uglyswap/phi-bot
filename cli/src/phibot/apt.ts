import { type PhibotLogger, type PhibotSystem, PhibotStepError, execOrThrow } from "./system.js";

export interface AptPackageSpec {
  key: string;
  candidates: string[];
  required: boolean;
  purpose: string;
}

/** Spec 6.9: each logical package installs its first candidate with an APT candidate version. */
export const PHIBOT_APT_PACKAGES: readonly AptPackageSpec[] = [
  { key: "certificats", candidates: ["ca-certificates"], required: true, purpose: "HTTPS" },
  { key: "curl", candidates: ["curl"], required: true, purpose: "téléchargements, contrôles" },
  { key: "tar", candidates: ["tar"], required: true, purpose: "archives" },
  { key: "unzip", candidates: ["unzip"], required: true, purpose: "archives" },
  { key: "git", candidates: ["git"], required: true, purpose: "agents" },
  { key: "ripgrep", candidates: ["ripgrep"], required: true, purpose: "outils de recherche de phi" },
  { key: "fd", candidates: ["fd-find"], required: false, purpose: "outil find de phi" },
  { key: "python3", candidates: ["python3"], required: false, purpose: "scripts des agents" },
  { key: "jq", candidates: ["jq"], required: false, purpose: "scripts" },
  { key: "ssh", candidates: ["openssh-client"], required: false, purpose: "dépôts git par SSH" },
  { key: "xvfb", candidates: ["xvfb"], required: true, purpose: "écran virtuel de Camoufox" },
  { key: "gtk3", candidates: ["libgtk-3-0t64", "libgtk-3-0"], required: true, purpose: "Firefox" },
  { key: "dbus-glib", candidates: ["libdbus-glib-1-2"], required: true, purpose: "Firefox (Camoufox)" },
  { key: "xt", candidates: ["libxt6t64", "libxt6"], required: true, purpose: "Firefox" },
  { key: "alsa", candidates: ["libasound2t64", "libasound2"], required: true, purpose: "Firefox" },
  { key: "x11-xcb", candidates: ["libx11-xcb1"], required: true, purpose: "Firefox" },
  { key: "xcomposite", candidates: ["libxcomposite1"], required: true, purpose: "Firefox" },
  { key: "xcursor", candidates: ["libxcursor1"], required: true, purpose: "Firefox" },
  { key: "xdamage", candidates: ["libxdamage1"], required: true, purpose: "Firefox" },
  { key: "xfixes", candidates: ["libxfixes3"], required: true, purpose: "Firefox" },
  { key: "xi", candidates: ["libxi6"], required: true, purpose: "Firefox" },
  { key: "xrandr", candidates: ["libxrandr2"], required: true, purpose: "Firefox" },
  { key: "xrender", candidates: ["libxrender1"], required: true, purpose: "Firefox" },
  { key: "xss", candidates: ["libxss1"], required: false, purpose: "Firefox" },
  { key: "xtst", candidates: ["libxtst6"], required: true, purpose: "Firefox" },
  { key: "egl", candidates: ["libegl1", "libegl1-mesa"], required: true, purpose: "WebGL logiciel" },
  { key: "gl-dri", candidates: ["libgl1-mesa-dri"], required: true, purpose: "WebGL logiciel" },
  { key: "gbm", candidates: ["libgbm1"], required: true, purpose: "WebGL logiciel" },
  { key: "polices liberation", candidates: ["fonts-liberation"], required: true, purpose: "rendu des pages" },
  { key: "polices emoji", candidates: ["fonts-noto-color-emoji"], required: false, purpose: "rendu des pages" },
  { key: "polices cjk", candidates: ["fonts-wqy-zenhei"], required: false, purpose: "rendu des pages" },
  { key: "fontconfig", candidates: ["fontconfig"], required: true, purpose: "rendu des pages" },
  { key: "nftables", candidates: ["nftables"], required: true, purpose: "garde réseau locale de la base embarquée" },
];

/**
 * Locale-independent APT output (the "Candidate:" label is translated otherwise), no dialog,
 * and needrestart restarts services automatically instead of asking.
 */
export const APT_ENV_OVERRIDES = { LC_ALL: "C", LANG: "C", DEBIAN_FRONTEND: "noninteractive", NEEDRESTART_MODE: "a" } as const;
/** Waits up to 10 minutes for another APT run (for example unattended-upgrades) to release its lock. */
export const APT_LOCK_OPTIONS = ["-o", "DPkg::Lock::Timeout=600"] as const;

/**
 * Parses `apt-cache policy <names...>`: package name -> candidate version, or null when
 * APT prints "Candidate: (none)" (virtual package). Unknown names have no section at all.
 */
export function parseAptCachePolicy(stdout: string): Map<string, string | null> {
  const candidates = new Map<string, string | null>();
  let current: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const header = /^([^\s:][^\s]*?)(?::[a-z0-9]+)?:$/.exec(line);
    if (header) {
      current = header[1];
      candidates.set(current, null);
      continue;
    }
    const candidate = /^\s+Candidate:\s+(.+)$/.exec(line);
    if (candidate && current) {
      const value = candidate[1].trim();
      candidates.set(current, value === "(none)" ? null : value);
    }
  }
  return candidates;
}

export interface AptSelection {
  install: string[];
  missingRequired: AptPackageSpec[];
  missingOptional: AptPackageSpec[];
}

export function selectAptPackages(
  policy: Map<string, string | null>,
  specs: readonly AptPackageSpec[] = PHIBOT_APT_PACKAGES,
): AptSelection {
  const selection: AptSelection = { install: [], missingRequired: [], missingOptional: [] };
  for (const spec of specs) {
    const chosen = spec.candidates.find((name) => Boolean(policy.get(name)));
    if (chosen) selection.install.push(chosen);
    else if (spec.required) selection.missingRequired.push(spec);
    else selection.missingOptional.push(spec);
  }
  return selection;
}

export function allAptCandidateNames(specs: readonly AptPackageSpec[] = PHIBOT_APT_PACKAGES): string[] {
  return specs.flatMap((spec) => spec.candidates);
}

const STEP = "Paquets système";

/** Step 3 of `phibot setup`: apt-get update, candidate selection, apt-get install. */
export async function installSystemPackages(sys: PhibotSystem, logger: PhibotLogger): Promise<AptSelection> {
  const env = { ...sys.env, ...APT_ENV_OVERRIDES };
  logger.step("Installation des paquets système (apt-get). Si une autre installation est en cours (mises à jour automatiques), Phi Bot attend jusqu'à 10 minutes qu'elle se termine.");
  await execOrThrow(sys, "apt-get", [...APT_LOCK_OPTIONS, "update"], { step: STEP, fix: "Vérifiez l'accès réseau aux dépôts APT puis relancez la commande." }, { env });
  const policy = await execOrThrow(sys, "apt-cache", ["policy", ...allAptCandidateNames()], {
    step: STEP,
    fix: "Vérifiez que apt-cache fonctionne (sudo apt-cache policy curl) puis relancez la commande.",
  }, { env });
  const selection = selectAptPackages(parseAptCachePolicy(policy.stdout));
  for (const spec of selection.missingOptional) {
    logger.warn(`Paquet facultatif indisponible (${spec.key} : ${spec.candidates.join(" ou ")}), ${spec.purpose} limité.`);
  }
  if (selection.missingRequired.length > 0) {
    const names = selection.missingRequired.map((spec) => `${spec.key} (${spec.candidates.join(" ou ")})`).join(", ");
    throw new PhibotStepError(
      STEP,
      `paquets obligatoires introuvables dans les dépôts APT : ${names}.`,
      "Activez les dépôts main et universe (Ubuntu) ou main (Debian), lancez sudo apt-get update, puis relancez la commande.",
    );
  }
  await execOrThrow(sys, "apt-get", [...APT_LOCK_OPTIONS, "install", "-y", "--no-install-recommends", ...selection.install], {
    step: STEP,
    fix: "Corrigez l'erreur d'APT affichée ci-dessus (sudo apt-get -f install) puis relancez la commande.",
  }, { env });
  logger.success(`${selection.install.length} paquets système installés ou déjà présents.`);
  return selection;
}
