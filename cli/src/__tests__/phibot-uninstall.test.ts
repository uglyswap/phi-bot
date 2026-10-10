import { describe, expect, it } from "vitest";
import { runPhibotUninstall } from "../phibot/uninstall.js";
import { FakeSystem, MemoryLogger, ScriptedPrompter } from "./helpers/phibot-fake-system.js";

const MARKER = "/var/lib/phibot/.paperclip/instances/default/.phibot-setup-complete";

function installedServer(access: "ssh" | "domain" | "tailscale"): FakeSystem {
  const sys = new FakeSystem()
    .addFile("/etc/systemd/system/phibot.service", "unit")
    .addFile("/etc/systemd/system/phibot-guard.service", "guard")
    .addFile("/etc/phibot/guard.nft", "rules")
    .addFile(MARKER, JSON.stringify({ version: "1.0.0", access, completedAt: "x" }))
    .addFile("/var/lib/phibot/.paperclip/instances/default/config.json", "{}");
  if (access === "domain") {
    sys
      .addFile("/etc/caddy/.phibot-installed", "")
      .addFile("/etc/caddy/Caddyfile", "# managed-by: phibot\n\nbot.exemple.fr {\n}\n")
      .addFile("/etc/systemd/system/caddy.service", "unit");
  }
  return sys;
}

describe("phibot uninstall (spec 13.6)", () => {
  it("removes the service and the guard, stops its Caddy, keeps the data", async () => {
    const sys = installedServer("domain");
    const logger = new MemoryLogger();
    await runPhibotUninstall({ yes: true }, { sys, logger, prompter: new ScriptedPrompter([]) });
    expect(sys.lines()).toEqual([
      "systemctl disable --now phibot.service",
      "systemctl disable --now phibot-guard.service",
      "systemctl daemon-reload",
      "systemctl reset-failed phibot.service",
      "systemctl disable --now caddy.service",
      "systemctl daemon-reload",
    ]);
    expect(sys.exists("/etc/systemd/system/phibot.service")).toBe(false);
    expect(sys.exists("/etc/phibot/guard.nft")).toBe(false);
    expect(sys.exists("/etc/caddy/Caddyfile")).toBe(false);
    expect(sys.exists("/etc/systemd/system/caddy.service")).toBe(false);
    expect(sys.exists("/etc/caddy/.phibot-installed")).toBe(false);
    expect(sys.exists("/var/lib/phibot/.paperclip/instances/default/config.json")).toBe(true);
    expect(logger.text()).toContain("Pour retirer le programme : sudo npm uninstall -g @phi-code-admin/phi-bot");
  });

  it("turns tailscale serve off for a tailscale install", async () => {
    const sys = installedServer("tailscale");
    await runPhibotUninstall({ yes: true }, { sys, logger: new MemoryLogger(), prompter: new ScriptedPrompter([]) });
    expect(sys.lines()).toContain("tailscale serve --https=443 off");
  });

  it("asks before uninstalling and erases the data only after typing SUPPRIMER", async () => {
    const kept = installedServer("ssh");
    await runPhibotUninstall({ purge: true }, { sys: kept, logger: new MemoryLogger(), prompter: new ScriptedPrompter([true, "non"]) });
    expect(kept.exists("/var/lib/phibot/.paperclip/instances/default/config.json")).toBe(true);
    const purged = installedServer("ssh");
    await runPhibotUninstall({ purge: true }, { sys: purged, logger: new MemoryLogger(), prompter: new ScriptedPrompter([true, "SUPPRIMER"]) });
    expect(purged.exists("/var/lib/phibot")).toBe(false);
    expect(purged.lines()).toContain("userdel phibot");
  });

  it("refuses without confirmation, --purge without a terminal, and a non-root user", async () => {
    const sys = installedServer("ssh");
    await expect(runPhibotUninstall({}, { sys, logger: new MemoryLogger(), prompter: new ScriptedPrompter([false]) })).rejects.toThrow("désinstallation annulée");
    await expect(runPhibotUninstall({ purge: true, yes: true }, { sys, logger: new MemoryLogger(), prompter: new ScriptedPrompter([], false) })).rejects.toThrow("--purge exige une confirmation tapée au clavier");
    sys.uid = 1000;
    await expect(runPhibotUninstall({ yes: true }, { sys, logger: new MemoryLogger(), prompter: new ScriptedPrompter([]) })).rejects.toThrow("droits administrateur requis");
    expect(sys.calls).toEqual([]);
  });
});
