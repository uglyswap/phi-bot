import { describe, expect, it } from "vitest";
import {
  applyPhibotRootEnvironment,
  buildCleanPhibotCommand,
  buildPhibotCommand,
  relaunchAsPhibotIfNeeded,
  shouldRelaunchAsPhibot,
} from "../phibot/relaunch.js";
import { renderPhibotUnit } from "../phibot/units.js";
import { FakeSystem } from "./helpers/phibot-fake-system.js";

const PATHS = { nodePath: "/usr/bin/node", phibotJsPath: "/usr/lib/node_modules/@phi-code-admin/phi-bot/dist/index.js" };

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}
const exit = (code: number): never => {
  throw new ExitCalled(code);
};

describe("relaunch under the phibot account (spec 6.8)", () => {
  it("relaunches only root commands that read the instance, on a server with the unit", () => {
    const base = { platform: "linux" as const, uid: 0, unitExists: true };
    for (const command of ["run", "backup", "user", "owner", "phi:prepare", "db:backup", "auth", "allowed-hostname", "env"]) {
      expect(shouldRelaunchAsPhibot({ ...base, topCommand: command })).toBe(true);
    }
    for (const command of ["setup", "update", "upgrade", "service", "uninstall", "db:restore", "install", "doctor", "internal:db-restore"]) {
      expect(shouldRelaunchAsPhibot({ ...base, topCommand: command })).toBe(false);
    }
    expect(shouldRelaunchAsPhibot({ ...base, unitExists: false, topCommand: "backup" })).toBe(false);
    expect(shouldRelaunchAsPhibot({ ...base, uid: 998, topCommand: "backup" })).toBe(false);
    expect(shouldRelaunchAsPhibot({ ...base, platform: "win32", topCommand: "backup" })).toBe(false);
  });

  it("points root commands at /var/lib/phibot/.paperclip (review m11)", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyPhibotRootEnvironment({ platform: "linux", uid: 0, unitExists: false, topCommand: "setup", env })).toBe(true);
    expect(env).toEqual({ PAPERCLIP_HOME: "/var/lib/phibot/.paperclip", PAPERCLIP_INSTANCE_ID: "default" });
    const untouched: NodeJS.ProcessEnv = {};
    expect(applyPhibotRootEnvironment({ platform: "linux", uid: 0, unitExists: false, topCommand: "service", env: untouched })).toBe(false);
    expect(applyPhibotRootEnvironment({ platform: "linux", uid: 0, unitExists: true, topCommand: "backup", env: untouched })).toBe(false);
    expect(untouched).toEqual({});
  });

  it("builds the runuser command lines", () => {
    expect(buildPhibotCommand(PATHS, ["user", "reset-password", "--email", "a@b.fr"])).toEqual({
      command: "runuser",
      args: [
        "-u", "phibot", "--", "env", "HOME=/var/lib/phibot", "PAPERCLIP_HOME=/var/lib/phibot/.paperclip", "PAPERCLIP_INSTANCE_ID=default",
        "/usr/bin/node", "/usr/lib/node_modules/@phi-code-admin/phi-bot/dist/index.js", "user", "reset-password", "--email", "a@b.fr",
      ],
    });
    expect(buildCleanPhibotCommand("/usr/bin/node", ["/x/postinstall.cjs"], { CI: "1", PHI_SKIP_POSTINSTALL: "1", HTTPS_PROXY: "http://proxy:3128" })).toEqual({
      command: "runuser",
      args: [
        "-u", "phibot", "--", "env", "-i", "HOME=/var/lib/phibot", "PAPERCLIP_HOME=/var/lib/phibot/.paperclip", "PAPERCLIP_INSTANCE_ID=default",
        "PATH=/usr/bin:/usr/bin:/bin", "HTTPS_PROXY=http://proxy:3128", "/usr/bin/node", "/x/postinstall.cjs",
      ],
    });
  });

  it("re-runs the same arguments from /var/lib/phibot and exits with the child's code", async () => {
    const sys = new FakeSystem().addFile("/etc/systemd/system/phibot.service", renderPhibotUnit(PATHS)).onExec("runuser", { code: 4, stdout: "", stderr: "" });
    await expect(
      relaunchAsPhibotIfNeeded({ sys, topCommand: "backup", argv: ["/usr/bin/node", "/usr/bin/phibot", "backup", "--full"], exit }),
    ).rejects.toEqual(new ExitCalled(4));
    expect(sys.calls[0].line).toBe(
      "runuser -u phibot -- env HOME=/var/lib/phibot PAPERCLIP_HOME=/var/lib/phibot/.paperclip PAPERCLIP_INSTANCE_ID=default /usr/bin/node /usr/lib/node_modules/@phi-code-admin/phi-bot/dist/index.js backup --full",
    );
    expect(sys.calls[0].options).toEqual({ cwd: "/var/lib/phibot", inherit: true });
  });

  it("does nothing for a root command", async () => {
    const sys = new FakeSystem().addFile("/etc/systemd/system/phibot.service", renderPhibotUnit(PATHS));
    await relaunchAsPhibotIfNeeded({ sys, topCommand: "service", argv: ["/usr/bin/node", "/usr/bin/phibot", "service", "status"], exit });
    expect(sys.calls).toEqual([]);
    expect(sys.env.PAPERCLIP_HOME).toBe("/var/lib/phibot/.paperclip");
  });
});
