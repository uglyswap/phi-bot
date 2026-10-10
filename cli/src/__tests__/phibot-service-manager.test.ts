import { describe, expect, it } from "vitest";
import { SystemdSystemServiceManager, type UnitFile } from "../phibot/system-service-manager.js";
import { renderPhibotUnit } from "../phibot/units.js";
import { detectServiceManager, type CommandRunner } from "../services/service-manager.js";

const PATHS = { nodePath: "/usr/bin/node", phibotJsPath: "/usr/lib/node_modules/@phi-code-admin/phi-bot/dist/index.js" };

function recorder(responses: Record<string, string> = {}) {
  const calls: string[] = [];
  const runner: CommandRunner = async (command, args, options) => {
    const line = [command, ...args].join(" ");
    calls.push(options?.inherit ? `${line} (terminal)` : line);
    if (line in responses) return { stdout: responses[line], stderr: "" };
    if (line.startsWith("systemctl --user")) throw new Error("no user manager");
    return { stdout: "", stderr: "" };
  };
  return { calls, runner };
}

function memoryUnit(initial: string | null): UnitFile & { contents: string | null } {
  return {
    contents: initial,
    read() { return this.contents; },
    write(value: string) { this.contents = value; },
    remove() { this.contents = null; },
  };
}

describe("SystemdSystemServiceManager (spec 13.4)", () => {
  it("is chosen first when /etc/systemd/system/phibot.service exists", async () => {
    const { runner } = recorder();
    const detection = await detectServiceManager({ platform: "linux", runner, systemUnitExists: () => true });
    expect(detection.supported && detection.manager instanceof SystemdSystemServiceManager).toBe(true);
    expect(detection.supported && detection.manager.serviceName).toBe("phibot.service");
    const fallback = await detectServiceManager({ platform: "linux", runner, systemUnitExists: () => false });
    expect(fallback.supported).toBe(false);
  });

  it("drives systemctl and journalctl on phibot.service", async () => {
    const { calls, runner } = recorder({
      "systemctl show phibot.service --property=LoadState,ActiveState,UnitFileState,MainPID": "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nMainPID=4242\n",
    });
    const manager = new SystemdSystemServiceManager(runner, memoryUnit(renderPhibotUnit(PATHS)));
    await manager.start();
    await manager.stop();
    await manager.restart();
    await manager.logs(true, 50);
    expect(await manager.status()).toEqual({ platform: "systemd", serviceName: "phibot.service", installed: true, active: true, enabled: true, pid: 4242, detail: "active", linger: null });
    expect(calls).toEqual([
      "systemctl start phibot.service",
      "systemctl stop phibot.service",
      "systemctl restart phibot.service",
      "journalctl --unit phibot.service --lines 50 --follow (terminal)",
      "systemctl show phibot.service --property=LoadState,ActiveState,UnitFileState,MainPID",
    ]);
  });

  it("renders the unit with its installed paths and rewrites a drifted unit", async () => {
    const unit = memoryUnit(renderPhibotUnit(PATHS).replace("TimeoutStopSec=120", "TimeoutStopSec=300"));
    const { calls, runner } = recorder();
    const manager = new SystemdSystemServiceManager(runner, unit);
    expect(manager.renderDefinition()).toBe(renderPhibotUnit(PATHS));
    expect(await manager.installedExecutablePath()).toBe(PATHS.phibotJsPath);
    expect(await manager.install({ startNow: true, startOnLogin: true })).toEqual({ changed: true });
    expect(unit.contents).toBe(renderPhibotUnit(PATHS));
    expect(calls).toEqual(["systemctl daemon-reload", "systemctl enable phibot.service", "systemctl start phibot.service"]);
  });

  it("uninstalls: disable --now, unit removed, daemon-reload", async () => {
    const unit = memoryUnit(renderPhibotUnit(PATHS));
    const { calls, runner } = recorder();
    await new SystemdSystemServiceManager(runner, unit).uninstall();
    expect(unit.contents).toBeNull();
    expect(calls).toEqual(["systemctl disable --now phibot.service", "systemctl daemon-reload", "systemctl reset-failed phibot.service"]);
  });
});
