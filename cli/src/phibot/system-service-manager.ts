import fs from "node:fs";
import type { CommandRunner, ServiceInstallOptions, ServiceManager, ServiceStatus } from "../services/service-manager.js";
import { PHIBOT_INSTANCE_ID, PHIBOT_UNIT_NAME, PHIBOT_UNIT_PATH } from "./constants.js";
import { parsePhibotUnitExecStart, renderPhibotUnit } from "./units.js";

/** Access to /etc/systemd/system/phibot.service (injectable for tests). */
export interface UnitFile {
  read(): string | null;
  write(contents: string): void;
  remove(): void;
}

export const systemUnitFile: UnitFile = {
  read: () => (fs.existsSync(PHIBOT_UNIT_PATH) ? fs.readFileSync(PHIBOT_UNIT_PATH, "utf8") : null),
  write: (contents) => fs.writeFileSync(PHIBOT_UNIT_PATH, contents, { mode: 0o644 }),
  remove: () => fs.rmSync(PHIBOT_UNIT_PATH, { force: true }),
};

export function phibotSystemUnitExists(): boolean {
  return fs.existsSync(PHIBOT_UNIT_PATH);
}

/**
 * Spec 13.4: same ServiceManager interface as upstream, but on the system unit phibot.service
 * (`systemctl <verb> phibot.service`, `journalctl --unit phibot.service`), run by root.
 */
export class SystemdSystemServiceManager implements ServiceManager {
  readonly platform = "systemd" as const;
  readonly instanceId = PHIBOT_INSTANCE_ID;
  readonly serviceName = PHIBOT_UNIT_NAME;
  readonly definitionPath = PHIBOT_UNIT_PATH;

  constructor(
    private readonly runner: CommandRunner,
    private readonly unitFile: UnitFile = systemUnitFile,
  ) {}

  /** The unit of spec 6.3 with the node and phibot paths of the installed unit ("" when unreadable). */
  renderDefinition(): string {
    const current = this.unitFile.read();
    const paths = current ? parsePhibotUnitExecStart(current) : null;
    return paths ? renderPhibotUnit(paths) : "";
  }

  async installedExecutablePath(): Promise<string | null> {
    const current = this.unitFile.read();
    return current ? (parsePhibotUnitExecStart(current)?.phibotJsPath ?? null) : null;
  }

  async install(options: ServiceInstallOptions): Promise<{ changed: boolean }> {
    const next = this.renderDefinition();
    if (!next) throw new Error("Unité phibot.service absente ou illisible : relancez sudo phibot setup --repair.");
    const changed = this.unitFile.read() !== next;
    if (changed) this.unitFile.write(next);
    await this.runner("systemctl", ["daemon-reload"]);
    await this.runner("systemctl", [options.startOnLogin ? "enable" : "disable", this.serviceName]);
    if (options.startNow) await this.start();
    return { changed };
  }

  async uninstall(): Promise<void> {
    await this.runner("systemctl", ["disable", "--now", this.serviceName]).catch(() => undefined);
    this.unitFile.remove();
    await this.runner("systemctl", ["daemon-reload"]);
    await this.runner("systemctl", ["reset-failed", this.serviceName]).catch(() => undefined);
  }

  async start(): Promise<void> {
    await this.runner("systemctl", ["start", this.serviceName]);
  }

  async stop(): Promise<void> {
    await this.runner("systemctl", ["stop", this.serviceName]);
  }

  async restart(): Promise<void> {
    await this.runner("systemctl", ["restart", this.serviceName]);
  }

  async status(): Promise<ServiceStatus> {
    let output: string;
    try {
      output = (await this.runner("systemctl", ["show", this.serviceName, "--property=LoadState,ActiveState,UnitFileState,MainPID"])).stdout;
    } catch {
      return { platform: this.platform, serviceName: this.serviceName, installed: false, active: false, enabled: false, pid: null, linger: null };
    }
    const values = Object.fromEntries(output.trim().split(/\r?\n/).map((line) => line.split(/=(.*)/s).slice(0, 2)));
    const pid = Number(values.MainPID);
    return {
      platform: this.platform,
      serviceName: this.serviceName,
      installed: values.LoadState === "loaded",
      active: values.ActiveState === "active",
      enabled: values.UnitFileState === "enabled",
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      detail: values.ActiveState,
      linger: null,
    };
  }

  async logs(follow: boolean, lines: number): Promise<void> {
    await this.runner("journalctl", ["--unit", this.serviceName, "--lines", String(lines), ...(follow ? ["--follow"] : [])], { inherit: true });
  }
}
