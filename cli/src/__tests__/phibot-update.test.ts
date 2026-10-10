import { afterEach, describe, expect, it } from "vitest";
import { isPhibotServer, runPhibotUpdate, runPhibotUpdateIfServer } from "../phibot/update.js";
import { renderPhibotUnit } from "../phibot/units.js";
import { FakeSystem, MemoryLogger, ScriptedPrompter } from "./helpers/phibot-fake-system.js";

const PACKAGE = "/usr/lib/node_modules/@phi-code-admin/phi-bot";
const JS = `${PACKAGE}/dist/index.js`;
const BACKUP = "/var/lib/phibot/.paperclip/instances/default/data/backups/pre-update-1.0.0-1.0.1-20261008-120000.tar.gz";

/** A Phi Bot 1.0.0 server; `npm install -g` really switches the installed version. */
function serverHost(options: { repairFails?: string[]; healthy?: boolean } = {}): FakeSystem {
  const sys = new FakeSystem()
    .addFile("/etc/systemd/system/phibot.service", renderPhibotUnit({ nodePath: "/usr/bin/node", phibotJsPath: JS }))
    .addFile("/usr/bin/npm", "")
    .addFile(`${PACKAGE}/package.json`, JSON.stringify({ version: "1.0.0" }))
    .addDir(`${PACKAGE}/node_modules/@embedded-postgres/linux-x64/native/lib`)
    .onExec("/usr/bin/npm root -g", { code: 0, stdout: "/usr/lib/node_modules\n", stderr: "" })
    .onExec("/usr/bin/npm view @phi-code-admin/phi-bot@latest version", { code: 0, stdout: "1.0.1\n", stderr: "" })
    .onExec("systemctl is-active phibot.service", { code: 0, stdout: "active\n", stderr: "" });
  let installed = "1.0.0";
  sys.onExec("/usr/bin/npm install -g", (call) => {
    installed = (call.args[2] ?? "").split("@").at(-1) ?? "";
    sys.addFile(`${PACKAGE}/package.json`, JSON.stringify({ version: installed }));
    return { code: 0, stdout: "", stderr: "" };
  });
  sys.onExec(`/usr/bin/node ${JS} setup --repair --yes`, () => ({ code: options.repairFails?.includes(installed) ? 1 : 0, stdout: "", stderr: "" }));
  sys.fetchHandler = async () => new Response(JSON.stringify({ status: options.healthy === false ? "starting" : "ok" }), { status: 200 });
  return sys;
}

function deps(sys: FakeSystem) {
  return { sys, logger: new MemoryLogger(), prompter: new ScriptedPrompter([]), loadAliasFunction: async () => async () => [] };
}

function steps(sys: FakeSystem): string[] {
  return sys.lines().filter((line) => line !== "systemctl is-active phibot.service" && line !== "/usr/bin/npm root -g");
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("phibot update (spec 13.1, reviews B2 and M3)", () => {
  it("backs up, stops, installs, runs setup --repair of the new version and checks the result", async () => {
    const sys = serverHost();
    const context = deps(sys);
    await runPhibotUpdate({}, context);
    expect(steps(sys)).toEqual([
      "/usr/bin/npm view @phi-code-admin/phi-bot@latest version --registry=https://registry.npmjs.org",
      `runuser -u phibot -- env HOME=/var/lib/phibot PAPERCLIP_HOME=/var/lib/phibot/.paperclip PAPERCLIP_INSTANCE_ID=default /usr/bin/node ${JS} backup --full --output ${BACKUP}`,
      "systemctl stop phibot.service",
      "/usr/bin/npm install -g @phi-code-admin/phi-bot@1.0.1 --registry=https://registry.npmjs.org --@phi-code-admin:registry=https://registry.npmjs.org --no-audit --no-fund --allow-scripts=@embedded-postgres/linux-x64,@google/genai,@phi-code-admin/camoufox-js,@phi-code-admin/phi-code,better-sqlite3,cpu-features,onnxruntime-node,protobufjs,sharp,ssh2",
      `/usr/bin/node ${JS} setup --repair --yes`,
    ]);
    expect(context.logger.text()).toContain(`Phi Bot mis à jour : 1.0.0 vers 1.0.1. Sauvegarde préalable : ${BACKUP}`);
  });

  it("rolls back to the previous version when the new one does not start", async () => {
    const sys = serverHost({ repairFails: ["1.0.1"] });
    await expect(runPhibotUpdate({}, deps(sys))).rejects.toThrow("la nouvelle version n'a pas démarré ; Phi Bot 1.0.0 est de nouveau en service.");
    const lines = steps(sys);
    expect(lines.slice(4)).toEqual([
      `/usr/bin/node ${JS} setup --repair --yes`,
      "systemctl stop phibot.service",
      expect.stringMatching(/^\/usr\/bin\/npm install -g @phi-code-admin\/phi-bot@1\.0\.0 /),
      `/usr/bin/node ${JS} setup --repair --yes`,
    ]);
  });

  it("restores the pre-update backup when the previous version does not start on the migrated database", async () => {
    const sys = serverHost({ repairFails: ["1.0.1", "1.0.0"] });
    await expect(runPhibotUpdate({}, deps(sys))).rejects.toThrow("Phi Bot 1.0.0 est de nouveau en service.");
    expect(sys.lines()).toContain(`/usr/bin/node ${JS} db:restore ${BACKUP} --yes`);
  });

  it("says so when nothing starts any more", async () => {
    const sys = serverHost({ healthy: false });
    await expect(runPhibotUpdate({}, deps(sys))).rejects.toThrow("ni la nouvelle version ni la version 1.0.0 ne démarrent.");
    expect(sys.lines()).toContain(`/usr/bin/node ${JS} db:restore ${BACKUP} --yes`);
  });

  it("does nothing on the same version, refuses a downgrade without --yes, reports with --check", async () => {
    const same = serverHost();
    await runPhibotUpdate({ version: "1.0.0" }, deps(same));
    expect(same.lines().some((line) => line.includes("install -g"))).toBe(false);
    await expect(runPhibotUpdate({ version: "0.9.0" }, deps(serverHost()))).rejects.toThrow("0.9.0 est plus ancienne que 1.0.0");
    const check = serverHost();
    await runPhibotUpdate({ check: true }, deps(check));
    expect(process.exitCode).toBe(10);
    expect(check.lines().some((line) => line.startsWith("runuser"))).toBe(false);
  });

  it("refuses the options of the upstream managed install and needs root", async () => {
    await expect(runPhibotUpdate({ canary: true }, deps(serverHost()))).rejects.toThrow("Phi Bot n'a pas de canal canary");
    await expect(runPhibotUpdate({ rollback: true }, deps(serverHost()))).rejects.toThrow("--rollback concerne l'installation gérée");
    await expect(runPhibotUpdate({ backup: false }, deps(serverHost()))).rejects.toThrow("la sauvegarde préalable est obligatoire");
    const user = serverHost();
    user.uid = 1000;
    await expect(runPhibotUpdate({}, deps(user))).rejects.toThrow("droits administrateur requis");
  });

  it("only takes over on a Phi Bot server", async () => {
    expect(isPhibotServer(serverHost())).toBe(true);
    const laptop = new FakeSystem();
    expect(isPhibotServer(laptop)).toBe(false);
    expect(await runPhibotUpdateIfServer({}, laptop)).toBe(false);
  });
});
