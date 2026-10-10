import {
  CADDY_BINARY_PATH,
  CADDYFILE_PATH,
  CADDY_MANAGED_HEADER,
  PHIBOT_DB_PORT,
  PHIBOT_GUARD_NFT_PATH,
  PHIBOT_INSTANCE_ID,
} from "./constants.js";

export interface PhibotUnitPaths {
  /** Absolute, resolved path of the node binary. */
  nodePath: string;
  /** `$(npm root -g)/@phi-code-admin/phi-bot/dist/index.js`. */
  phibotJsPath: string;
}

const SAFE_UNIT_PATH = /^\/[A-Za-z0-9._/@+-]+$/;

/** systemd values are written unquoted: refuse anything that would need escaping. */
export function assertSafeUnitPath(value: string, label: string): void {
  if (!SAFE_UNIT_PATH.test(value)) {
    throw new Error(`Chemin refusé pour l'unité systemd (${label}) : ${value}`);
  }
}

function posixDirname(value: string): string {
  const index = value.lastIndexOf("/");
  return index <= 0 ? "/" : value.slice(0, index);
}

/** Spec 6.3, character for character. */
export function renderPhibotUnit(paths: PhibotUnitPaths): string {
  assertSafeUnitPath(paths.nodePath, "node");
  assertSafeUnitPath(paths.phibotJsPath, "phibot");
  return `[Unit]
Description=Phi Bot
After=network-online.target phibot-guard.service
Wants=network-online.target phibot-guard.service
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=notify
NotifyAccess=all
User=phibot
Group=phibot
WorkingDirectory=/var/lib/phibot
Environment=HOME=/var/lib/phibot
Environment=PAPERCLIP_HOME=/var/lib/phibot/.paperclip
Environment=PAPERCLIP_INSTANCE_ID=${PHIBOT_INSTANCE_ID}
Environment=PAPERCLIP_SERVICE_MANAGED=1
Environment=PAPERCLIP_DISABLE_CWD_ENV_FILE=true
Environment=TRUST_PROXY=loopback
Environment=DO_NOT_TRACK=1
Environment=PATH=${posixDirname(paths.nodePath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=${paths.nodePath} ${paths.phibotJsPath} run --instance ${PHIBOT_INSTANCE_ID}
Restart=always
RestartSec=5
TimeoutStartSec=300
TimeoutStopSec=120
KillMode=mixed
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
UMask=0077

[Install]
WantedBy=multi-user.target
`;
}

/** Reads node and phibot paths back from an installed unit; null when the unit was not written by Phi Bot. */
export function parsePhibotUnitExecStart(unit: string): PhibotUnitPaths | null {
  const match = /^ExecStart=(\/\S+) (\/\S+) run --instance default$/m.exec(unit);
  return match ? { nodePath: match[1], phibotJsPath: match[2] } : null;
}

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const EMAIL_PATTERN = /^[^\s@"<>{}]+@[^\s@"<>{}]+\.[^\s@"<>{}]+$/;

export function normalizeDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_PATTERN.test(domain)) {
    throw new Error(`Nom de domaine invalide : « ${value} » (attendu : un nom complet comme bot.exemple.fr).`);
  }
  return domain;
}

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

export interface CaddyfileInput {
  domain: string;
  acmeEmail?: string;
  /** Test only (spec 15.2 point 4): certificate from Caddy's internal CA. */
  tlsInternal?: boolean;
}

/** Spec 6.5 point 4; the global block is omitted without an ACME e-mail. */
export function renderCaddyfile(input: CaddyfileInput): string {
  const domain = normalizeDomain(input.domain);
  const lines = [CADDY_MANAGED_HEADER];
  if (input.acmeEmail) {
    if (!isValidEmail(input.acmeEmail)) throw new Error(`Adresse e-mail ACME invalide : « ${input.acmeEmail} ».`);
    lines.push("{", `\temail ${input.acmeEmail.trim()}`, "}");
  }
  lines.push("", `${domain} {`);
  if (input.tlsInternal) lines.push("\ttls internal");
  lines.push('\theader Strict-Transport-Security "max-age=31536000"', "\treverse_proxy 127.0.0.1:3100", "}", "");
  return lines.join("\n");
}

/** Official caddy.service (caddyserver/dist, init/caddy.service) with the binary in /usr/local/bin. */
export function renderCaddyUnit(): string {
  return `[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=${CADDY_BINARY_PATH} run --environ --config ${CADDYFILE_PATH}
ExecReload=${CADDY_BINARY_PATH} reload --config ${CADDYFILE_PATH} --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
`;
}

/** Domain served by a Phi Bot managed Caddyfile, or null. */
export function parseManagedCaddyDomain(caddyfile: string): string | null {
  if (!caddyfile.startsWith(`${CADDY_MANAGED_HEADER}\n`)) return null;
  const match = /^([a-z0-9.-]+) \{$/m.exec(caddyfile);
  return match ? match[1] : null;
}

/**
 * nftables rule set of the local database guard (review M10): only root and the phibot account
 * may open a TCP connection to the embedded Postgres port on the loopback interface, and only root
 * may reach the Caddy admin API (port 2019, used by `caddy reload` from systemd as root).
 * The first two lines make the file idempotent: create the table if missing, then replace it.
 */
export function renderGuardNft(phibotUid: number): string {
  if (!Number.isInteger(phibotUid) || phibotUid <= 0) throw new Error(`uid du compte phibot invalide : ${phibotUid}`);
  return `table inet phibot_guard
delete table inet phibot_guard
table inet phibot_guard {
	chain output {
		type filter hook output priority 0; policy accept;
		oifname "lo" tcp dport ${PHIBOT_DB_PORT} meta skuid != { 0, ${phibotUid} } reject with tcp reset
		oifname "lo" tcp dport 2019 meta skuid != 0 reject with tcp reset
	}
}
`;
}

/** Oneshot unit that loads the guard before phibot.service (wanted, not required, by it). */
export function renderGuardUnit(): string {
  return `[Unit]
Description=Phi Bot local database guard
Before=phibot.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f ${PHIBOT_GUARD_NFT_PATH}
ExecStop=/usr/sbin/nft delete table inet phibot_guard

[Install]
WantedBy=multi-user.target
`;
}
