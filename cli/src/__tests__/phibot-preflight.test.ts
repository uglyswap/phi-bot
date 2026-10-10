import { describe, expect, it } from "vitest";
import { runPreflightChecks } from "../phibot/preflight.js";
import { parseTailscaleStatus } from "../phibot/tailscale.js";
import type { FakeSystem } from "./helpers/phibot-fake-system.js";
import { goodHost } from "./helpers/phibot-hosts.js";

const TAILSCALE_STATUS = JSON.stringify({
  Version: "1.90.0",
  BackendState: "Running",
  Self: { HostName: "srv", DNSName: "srv.tail1234.ts.net." },
  CertDomains: ["srv.tail1234.ts.net"],
});

describe("parseTailscaleStatus", () => {
  it("reads BackendState and Self.DNSName without the final dot", () => {
    expect(parseTailscaleStatus(TAILSCALE_STATUS)).toEqual({ backendState: "Running", dnsName: "srv.tail1234.ts.net", certificatesEnabled: true });
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin", Self: { DNSName: "" } }))).toEqual({ backendState: "NeedsLogin", dnsName: null, certificatesEnabled: false });
  });
});

describe("runPreflightChecks (spec 6.2 step 1)", () => {
  it("accepts a fresh Ubuntu server and warns under 7 GiB of RAM", async () => {
    const sys = goodHost();
    sys.memoryBytes = 4 * 1024 ** 3;
    const result = await runPreflightChecks(sys, { access: "ssh", unitExists: false });
    expect(result).toEqual({ warnings: ["Mémoire de 4.0 Gio : 8 Go sont recommandés pour les agents qui naviguent."], tailnetName: null });
    expect(sys.lines()).toContain("ss -ltnH ( sport = :3100 or sport = :54329 )");
  });

  it("refuses another system, a non-root user, an old or nvm Node, a missing systemd", async () => {
    const cases: Array<[(sys: FakeSystem) => void, string]> = [
      [(sys) => { sys.platform = "darwin"; }, "système darwin non pris en charge"],
      [(sys) => { sys.arch = "arm64"; }, "architecture arm64 non prise en charge"],
      [(sys) => { sys.uid = 1000; }, "droits administrateur requis"],
      [(sys) => { sys.nodeVersion = "22.19.0"; }, "Node.js 22.19.0 trop ancien"],
      [(sys) => { sys.execPath = "/root/.nvm/versions/node/v24.11.0/bin/node"; }, "illisible par le compte phibot"],
      [(sys) => { sys.dirs.delete("/run/systemd/system"); }, "systemd n'est pas actif"],
      [(sys) => { sys.files.delete("/usr/bin/apt-get"); }, "apt-get introuvable"],
      [(sys) => { sys.memoryBytes = 2 * 1024 ** 3; }, "mémoire insuffisante"],
      [(sys) => { sys.freeDisk = 5 * 1024 ** 3; }, "espace disque insuffisant"],
    ];
    for (const [mutate, message] of cases) {
      const sys = goodHost();
      mutate(sys);
      await expect(runPreflightChecks(sys, { access: "ssh", unitExists: false })).rejects.toThrow(message);
    }
  });

  it("refuses an npm global prefix under /home (review m10)", async () => {
    const sys = goodHost().onExec("/usr/bin/npm root -g", { code: 0, stdout: "/home/ubuntu/.npm-global/lib/node_modules\n", stderr: "" });
    await expect(runPreflightChecks(sys, { access: "ssh", unitExists: false })).rejects.toThrow("le préfixe global de npm est sous /home/ubuntu");
  });

  it("refuses busy ports 3100 or 54329 unless phibot.service exists", async () => {
    const busy = goodHost().onExec("ss -ltnH ( sport = :3100", { code: 0, stdout: "LISTEN 0 511 127.0.0.1:3100 0.0.0.0:*\n", stderr: "" });
    await expect(runPreflightChecks(busy, { access: "ssh", unitExists: false })).rejects.toThrow("les ports 3100 ou 54329 sont déjà utilisés");
    await expect(runPreflightChecks(busy, { access: "ssh", unitExists: true })).resolves.toEqual({ warnings: [], tailnetName: null });
  });

  it("checks ports 80 and 443, a foreign Caddyfile and the DNS for a domain", async () => {
    const web = goodHost().onExec("ss -ltnH ( sport = :80", { code: 0, stdout: "LISTEN 0 511 0.0.0.0:80 0.0.0.0:*\n", stderr: "" });
    await expect(runPreflightChecks(web, { access: "domain", domain: "bot.exemple.fr", unitExists: false })).rejects.toThrow("un autre serveur écoute déjà sur le port 80 ou 443");
    const managed = goodHost().onExec("ss -ltnH ( sport = :80", { code: 0, stdout: "LISTEN 0 511 *:443 *:*\n", stderr: "" }).addFile("/etc/caddy/Caddyfile", "# managed-by: phibot\n\nbot.exemple.fr {\n}\n");
    await expect(runPreflightChecks(managed, { access: "domain", domain: "bot.exemple.fr", unitExists: true })).resolves.toEqual({ warnings: [], tailnetName: null });
    const foreign = goodHost().addFile("/etc/caddy/Caddyfile", "example.com {\n}\n");
    await expect(runPreflightChecks(foreign, { access: "domain", domain: "bot.exemple.fr", unitExists: false })).rejects.toThrow("n'a pas été écrit par Phi Bot");
    const noDns = goodHost().onExec("getent ahosts", { code: 2, stdout: "", stderr: "" });
    const result = await runPreflightChecks(noDns, { access: "domain", domain: "bot.exemple.fr", unitExists: false });
    expect(result.warnings).toEqual(["Le nom bot.exemple.fr ne résout pas encore : le certificat HTTPS sera émis dès que le DNS pointera sur ce serveur."]);
  });

  it("reads the tailnet name and requires a running Tailscale", async () => {
    const sys = goodHost().onExec("tailscale status --json", { code: 0, stdout: TAILSCALE_STATUS, stderr: "" });
    expect(await runPreflightChecks(sys, { access: "tailscale", unitExists: false })).toEqual({ warnings: [], tailnetName: "srv.tail1234.ts.net" });
    const stopped = goodHost().onExec("tailscale status --json", { code: 0, stdout: JSON.stringify({ BackendState: "Stopped", Self: { DNSName: "srv.tail1234.ts.net." } }), stderr: "" });
    await expect(runPreflightChecks(stopped, { access: "tailscale", unitExists: false })).rejects.toThrow("Tailscale n'est pas connecté (état Stopped)");
  });
});
