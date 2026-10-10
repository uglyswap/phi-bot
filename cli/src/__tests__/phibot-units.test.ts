import { describe, expect, it } from "vitest";
import {
  normalizeDomain,
  parseManagedCaddyDomain,
  parsePhibotUnitExecStart,
  renderCaddyUnit,
  renderCaddyfile,
  renderGuardNft,
  renderGuardUnit,
  renderPhibotUnit,
} from "../phibot/units.js";

const NODESOURCE = {
  nodePath: "/usr/bin/node",
  phibotJsPath: "/usr/lib/node_modules/@phi-code-admin/phi-bot/dist/index.js",
};

const EXPECTED_UNIT = `[Unit]
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
Environment=PAPERCLIP_INSTANCE_ID=default
Environment=PAPERCLIP_SERVICE_MANAGED=1
Environment=PAPERCLIP_DISABLE_CWD_ENV_FILE=true
Environment=TRUST_PROXY=loopback
Environment=DO_NOT_TRACK=1
Environment=PATH=/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/node /usr/lib/node_modules/@phi-code-admin/phi-bot/dist/index.js run --instance default
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

describe("renderPhibotUnit", () => {
  it("renders the unit of spec 6.3 exactly", () => {
    expect(renderPhibotUnit(NODESOURCE)).toBe(EXPECTED_UNIT);
  });

  it("puts the node directory first on PATH", () => {
    const unit = renderPhibotUnit({ nodePath: "/opt/node-v24/bin/node", phibotJsPath: "/opt/node-v24/lib/node_modules/@phi-code-admin/phi-bot/dist/index.js" });
    expect(unit).toContain("Environment=PATH=/opt/node-v24/bin:/usr/local/sbin:");
  });

  it("refuses paths that systemd would need to escape", () => {
    expect(() => renderPhibotUnit({ ...NODESOURCE, nodePath: "/usr/bin/no de" })).toThrow("Chemin refusé");
    expect(() => renderPhibotUnit({ ...NODESOURCE, phibotJsPath: "/x/%h/index.js" })).toThrow("Chemin refusé");
    expect(() => renderPhibotUnit({ ...NODESOURCE, nodePath: "node" })).toThrow("Chemin refusé");
  });

  it("reads the paths back from the installed unit", () => {
    expect(parsePhibotUnitExecStart(EXPECTED_UNIT)).toEqual(NODESOURCE);
    expect(parsePhibotUnitExecStart("[Service]\nExecStart=/bin/true\n")).toBeNull();
  });
});

describe("renderCaddyfile", () => {
  it("renders the global e-mail block when --acme-email is given", () => {
    expect(renderCaddyfile({ domain: "Bot.Exemple.fr", acmeEmail: "admin@exemple.fr" })).toBe(
      '# managed-by: phibot\n{\n\temail admin@exemple.fr\n}\n\nbot.exemple.fr {\n\theader Strict-Transport-Security "max-age=31536000"\n\treverse_proxy 127.0.0.1:3100\n}\n',
    );
  });

  it("omits the global block without e-mail and supports tls internal for tests", () => {
    expect(renderCaddyfile({ domain: "phibot.ci.test", tlsInternal: true })).toBe(
      '# managed-by: phibot\n\nphibot.ci.test {\n\ttls internal\n\theader Strict-Transport-Security "max-age=31536000"\n\treverse_proxy 127.0.0.1:3100\n}\n',
    );
  });

  it("validates the domain and the e-mail", () => {
    expect(() => renderCaddyfile({ domain: "localhost" })).toThrow("Nom de domaine invalide");
    expect(() => renderCaddyfile({ domain: "bot.exemple.fr", acmeEmail: "pas-une-adresse" })).toThrow("Adresse e-mail ACME invalide");
    expect(normalizeDomain("bot.exemple.fr.")).toBe("bot.exemple.fr");
  });

  it("finds the domain of a managed Caddyfile only", () => {
    expect(parseManagedCaddyDomain(renderCaddyfile({ domain: "bot.exemple.fr", acmeEmail: "a@b.fr" }))).toBe("bot.exemple.fr");
    expect(parseManagedCaddyDomain("example.com {\n\treverse_proxy 127.0.0.1:8080\n}\n")).toBeNull();
  });
});

describe("renderCaddyUnit", () => {
  it("is the official unit with /usr/local/bin/caddy", () => {
    expect(renderCaddyUnit()).toBe(`[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
`);
  });
});

describe("local database guard", () => {
  it("rejects loopback connections to 54329 from other accounts and to 2019 from non-root, idempotently", () => {
    expect(renderGuardNft(998)).toBe(`table inet phibot_guard
delete table inet phibot_guard
table inet phibot_guard {
	chain output {
		type filter hook output priority 0; policy accept;
		oifname "lo" tcp dport 54329 meta skuid != { 0, 998 } reject with tcp reset
		oifname "lo" tcp dport 2019 meta skuid != 0 reject with tcp reset
	}
}
`);
    expect(() => renderGuardNft(0)).toThrow("uid du compte phibot invalide");
  });

  it("loads the rule set before phibot.service", () => {
    expect(renderGuardUnit()).toBe(`[Unit]
Description=Phi Bot local database guard
Before=phibot.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/phibot/guard.nft
ExecStop=/usr/sbin/nft delete table inet phibot_guard

[Install]
WantedBy=multi-user.target
`);
  });
});
