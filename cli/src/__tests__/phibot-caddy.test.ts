import { describe, expect, it } from "vitest";
import { configureCaddy, installCaddyBinary, removeManagedCaddy, sha512Hex } from "../phibot/caddy.js";
import { installLocalGuard } from "../phibot/guard.js";
import { renderCaddyUnit, renderCaddyfile, renderGuardNft, renderGuardUnit } from "../phibot/units.js";
import { FakeSystem, MemoryLogger } from "./helpers/phibot-fake-system.js";

const ARCHIVE = new TextEncoder().encode("fake caddy archive");
const ARCHIVE_SHA512 = sha512Hex(ARCHIVE);

/** Caddy absent until `install` copies it, then `caddy version` answers v2.11.7. */
function caddyHost(): FakeSystem {
  const sys = new FakeSystem();
  let installed = false;
  sys.fetchHandler = async () => new Response(ARCHIVE, { status: 200 });
  sys.onExec("install -m 0755", () => {
    installed = true;
    sys.addFile("/usr/local/bin/caddy", "");
    return { code: 0, stdout: "", stderr: "" };
  });
  sys.onExec("/usr/local/bin/caddy version", () => ({ code: installed ? 0 : 127, stdout: installed ? "v2.11.7 h1:abc=\n" : "", stderr: "" }));
  sys.onExec("getent group caddy", { code: 2, stdout: "", stderr: "" });
  sys.onExec("getent passwd caddy", { code: 2, stdout: "", stderr: "" });
  sys.onExec("curl -fsS", { code: 0, stdout: '{"status":"ok"}', stderr: "" });
  sys.onExec("ufw status", { code: 0, stdout: "Status: active\n", stderr: "" });
  return sys;
}

describe("Caddy binary (spec 6.5 point 2)", () => {
  it("computes SHA-512", () => {
    expect(sha512Hex(new TextEncoder().encode("abc"))).toBe(
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    );
  });

  it("refuses an archive whose SHA-512 differs from the pinned value", async () => {
    const sys = caddyHost();
    await expect(installCaddyBinary(sys, new MemoryLogger())).rejects.toThrow("empreinte SHA-512 inattendue");
    expect(sys.lines().some((line) => line.startsWith("tar "))).toBe(false);
  });

  it("extracts only caddy and installs it as root 0755", async () => {
    const sys = caddyHost();
    await installCaddyBinary(sys, new MemoryLogger(), ARCHIVE_SHA512);
    const lines = sys.lines();
    expect(lines.find((line) => line.startsWith("tar "))).toMatch(/^tar -xzf \/var\/tmp\/phibot-caddy-\d+\/caddy\.tar\.gz -C \/var\/tmp\/phibot-caddy-\d+ caddy$/);
    expect(lines.find((line) => line.startsWith("install "))).toMatch(/^install -m 0755 -o root -g root \/var\/tmp\/phibot-caddy-\d+\/caddy \/usr\/local\/bin\/caddy$/);
    expect([...sys.dirs].some((dir) => dir.startsWith("/var/tmp/phibot-caddy-"))).toBe(false);
  });
});

describe("configureCaddy (spec 6.5)", () => {
  it("writes the Caddyfile, the marker and the unit, starts Caddy, waits for HTTPS and opens ufw", async () => {
    const sys = caddyHost();
    const result = await configureCaddy(sys, new MemoryLogger(), { domain: "bot.exemple.fr", acmeEmail: "admin@exemple.fr" }, ARCHIVE_SHA512);
    expect(result).toEqual({ httpsReady: true });
    expect(sys.readFile("/etc/caddy/Caddyfile")).toBe(renderCaddyfile({ domain: "bot.exemple.fr", acmeEmail: "admin@exemple.fr" }));
    expect(sys.fileMode("/etc/caddy/Caddyfile")).toBe(0o644);
    expect(sys.readFile("/etc/caddy/.phibot-installed")).toBe("");
    expect(sys.readFile("/etc/systemd/system/caddy.service")).toBe(renderCaddyUnit());
    const lines = sys.lines().filter((line) => !line.startsWith("/usr/local/bin/caddy version") && !line.startsWith("tar ") && !line.startsWith("install "));
    expect(lines).toEqual([
      "getent group caddy",
      "groupadd --system caddy",
      "getent passwd caddy",
      "useradd --system --gid caddy --create-home --home-dir /var/lib/caddy --shell /usr/sbin/nologin --comment Caddy web server caddy",
      "/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile",
      "systemctl daemon-reload",
      "systemctl enable caddy.service",
      "systemctl restart caddy.service",
      "curl -fsS --max-time 5 --resolve bot.exemple.fr:443:127.0.0.1 https://bot.exemple.fr/api/health",
      "ufw status",
      "ufw allow 80/tcp",
      "ufw allow 443/tcp",
    ]);
  });

  it("only warns when HTTPS does not answer within 2 minutes, and accepts the internal CA in tests", async () => {
    const sys = caddyHost().onExec("curl -fsS", { code: 7, stdout: "", stderr: "Failed to connect" });
    const logger = new MemoryLogger();
    expect(await configureCaddy(sys, logger, { domain: "phibot.ci.test", tlsInternal: true }, ARCHIVE_SHA512)).toEqual({ httpsReady: false });
    expect(logger.text()).toContain("HTTPS ne répond pas encore pour phibot.ci.test");
    expect(sys.lines()).toContain("curl -fsS -k --max-time 5 --resolve phibot.ci.test:443:127.0.0.1 https://phibot.ci.test/api/health");
  });

  it("refuses a Caddyfile that Phi Bot did not write, and removes only its own Caddy", async () => {
    const sys = caddyHost().addFile("/etc/caddy/Caddyfile", "example.com {\n}\n");
    await expect(configureCaddy(sys, new MemoryLogger(), { domain: "bot.exemple.fr" }, ARCHIVE_SHA512)).rejects.toThrow("n'a pas été écrit par Phi Bot");
    expect(await removeManagedCaddy(sys)).toBe(false);
    expect(sys.exists("/etc/caddy/Caddyfile")).toBe(true);
    const managed = new FakeSystem()
      .addFile("/etc/caddy/.phibot-installed", "")
      .addFile("/etc/caddy/Caddyfile", "# managed-by: phibot\n\nbot.exemple.fr {\n}\n")
      .addFile("/etc/systemd/system/caddy.service", "unit")
      .addFile("/usr/local/bin/caddy", "");
    expect(await removeManagedCaddy(managed)).toBe(true);
    expect(managed.lines()).toEqual(["systemctl disable --now caddy.service", "systemctl daemon-reload"]);
    expect(["/etc/caddy/.phibot-installed", "/etc/caddy/Caddyfile", "/etc/systemd/system/caddy.service"].filter((file) => managed.exists(file))).toEqual([]);
    expect(managed.exists("/usr/local/bin/caddy")).toBe(true);
  });
});

describe("installLocalGuard (review M10)", () => {
  it("writes the rule set for the uid of phibot and enables phibot-guard.service", async () => {
    const sys = new FakeSystem().onExec("id -u phibot", { code: 0, stdout: "998\n", stderr: "" });
    expect(await installLocalGuard(sys, new MemoryLogger())).toBe(true);
    expect(sys.readFile("/etc/phibot/guard.nft")).toBe(renderGuardNft(998));
    expect(sys.readFile("/etc/systemd/system/phibot-guard.service")).toBe(renderGuardUnit());
    expect(sys.lines()).toEqual([
      "id -u phibot",
      "systemctl daemon-reload",
      "systemctl enable phibot-guard.service",
      "systemctl restart phibot-guard.service",
    ]);
  });

  it("only warns when nftables refuses the rules", async () => {
    const sys = new FakeSystem()
      .onExec("id -u phibot", { code: 0, stdout: "998\n", stderr: "" })
      .onExec("systemctl restart phibot-guard.service", { code: 1, stdout: "", stderr: "Job failed" });
    const logger = new MemoryLogger();
    expect(await installLocalGuard(sys, logger)).toBe(false);
    expect(logger.entries[0]).toEqual({
      level: "warn",
      message: "Garde réseau locale non active (systemctl restart phibot-guard.service : code 1). Phi Bot fonctionne, mais d'autres comptes locaux peuvent joindre la base sur 127.0.0.1:54329. Voir journalctl -u phibot-guard.service.",
    });
  });
});
