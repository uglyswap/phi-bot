import { describe, expect, it } from "vitest";
import {
  buildGlobalInstallArgs,
  buildGlobalInstallEnv,
  ensureGlobalInstall,
  installPathsFor,
  missingEmbeddedPostgresAliases,
  readInstalledVersion,
  resolveNpmRegistry,
} from "../phibot/global-install.js";
import { probeHealth, waitForServiceHealthy } from "../phibot/health.js";
import { FakeSystem, MemoryLogger } from "./helpers/phibot-fake-system.js";

const ROOT = "/usr/lib/node_modules";
const PACKAGE = "/usr/lib/node_modules/@phi-code-admin/phi-bot";
const LIB = `${PACKAGE}/node_modules/@embedded-postgres/linux-x64/native/lib`;

function installedSystem(version: string | null): FakeSystem {
  const sys = new FakeSystem()
    .addFile("/usr/bin/npm", "")
    .onExec("/usr/bin/npm root -g", { code: 0, stdout: `${ROOT}\n`, stderr: "" })
    .addDir(LIB);
  if (version) sys.addFile(`${PACKAGE}/package.json`, JSON.stringify({ version })).addFile(`${PACKAGE}/dist/index.js`, "");
  return sys;
}

describe("npm install -g of Phi Bot (spec 5.4, 6.2 step 5)", () => {
  it("builds the exact command and environment", () => {
    expect(buildGlobalInstallArgs("1.2.3", "https://registry.npmjs.org")).toEqual([
      "install",
      "-g",
      "@phi-code-admin/phi-bot@1.2.3",
      "--registry=https://registry.npmjs.org",
      "--@phi-code-admin:registry=https://registry.npmjs.org",
      "--no-audit",
      "--no-fund",
      "--allow-scripts=better-sqlite3,@embedded-postgres/linux-x64",
    ]);
    expect(buildGlobalInstallEnv({ PATH: "/usr/bin" })).toEqual({
      PATH: "/usr/bin",
      CAMOUFOX_SKIP_DOWNLOAD: "1",
      ONNXRUNTIME_NODE_INSTALL_CUDA: "skip",
      PHI_SKIP_POSTINSTALL: "1",
    });
  });

  it("reads PHIBOT_NPM_REGISTRY", () => {
    expect(resolveNpmRegistry({})).toBe("https://registry.npmjs.org");
    expect(resolveNpmRegistry({ PHIBOT_NPM_REGISTRY: "http://127.0.0.1:4873/" })).toBe("http://127.0.0.1:4873");
    expect(() => resolveNpmRegistry({ PHIBOT_NPM_REGISTRY: "file:///tmp" })).toThrow("PHIBOT_NPM_REGISTRY invalide");
  });

  it("resolves the absolute paths of a NodeSource install", () => {
    expect(installPathsFor("/usr/bin/node", ROOT)).toEqual({
      nodePath: "/usr/bin/node",
      npmRoot: ROOT,
      packageDir: PACKAGE,
      phibotJsPath: `${PACKAGE}/dist/index.js`,
      phiDir: `${PACKAGE}/node_modules/@phi-code-admin/phi-code`,
    });
    expect(readInstalledVersion(installedSystem("1.0.0"), ROOT)).toBe("1.0.0");
    expect(readInstalledVersion(installedSystem(null), ROOT)).toBeNull();
  });

  it("installs the running CLI version when another version is installed, then creates the aliases", async () => {
    const sys = installedSystem("0.9.0");
    sys.env = { PHIBOT_NPM_REGISTRY: "http://127.0.0.1:4873" };
    const aliasCalls: string[] = [];
    const paths = await ensureGlobalInstall(sys, new MemoryLogger(), {
      cliVersion: "1.0.0",
      loadAliasFunction: async () => async (libDir) => {
        aliasCalls.push(libDir);
        return [`${libDir}/libssl.so.1`];
      },
    });
    const install = sys.calls.find((call) => call.args[0] === "install");
    expect(install?.line).toBe(
      "/usr/bin/npm install -g @phi-code-admin/phi-bot@1.0.0 --registry=http://127.0.0.1:4873 --@phi-code-admin:registry=http://127.0.0.1:4873 --no-audit --no-fund --allow-scripts=better-sqlite3,@embedded-postgres/linux-x64",
    );
    expect(install?.options?.env?.PHI_SKIP_POSTINSTALL).toBe("1");
    expect(install?.options?.inherit).toBe(true);
    expect(paths.phibotJsPath).toBe(`${PACKAGE}/dist/index.js`);
    expect(aliasCalls).toEqual([LIB]);
  });

  it("does not reinstall the same version but still creates the aliases", async () => {
    const sys = installedSystem("1.0.0");
    let aliases = 0;
    await ensureGlobalInstall(sys, new MemoryLogger(), { cliVersion: "1.0.0", loadAliasFunction: async () => async () => { aliases += 1; return []; } });
    expect(sys.calls.some((call) => call.args[0] === "install")).toBe(false);
    expect(aliases).toBe(1);
  });

  it("lists the embedded Postgres aliases that are missing", () => {
    const sys = new FakeSystem().addFile(`${LIB}/libssl.so.1.1`, "").addFile(`${LIB}/libcrypto.so.1.1`, "").addFile(`${LIB}/libcrypto.so.1`, "").addFile(`${LIB}/libpq.so`, "");
    expect(missingEmbeddedPostgresAliases(sys, LIB)).toEqual(["libssl.so.1"]);
  });
});

describe("health of the service (review B2)", () => {
  it("reads status and bootstrapStatus of the anonymous answer", async () => {
    const sys = new FakeSystem();
    sys.fetchHandler = async () => new Response(JSON.stringify({ status: "ok", bootstrapStatus: "ready" }), { status: 200 });
    expect(await probeHealth(sys)).toEqual({ ok: true, bootstrapStatus: "ready", error: null });
    sys.fetchHandler = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3100");
    };
    expect(await probeHealth(sys)).toEqual({ ok: false, bootstrapStatus: null, error: "connect ECONNREFUSED 127.0.0.1:3100" });
  });

  it("requires systemctl is-active = active and status ok, polling every 2 s", async () => {
    const sys = new FakeSystem();
    let answers = 0;
    sys.fetchHandler = async () => {
      answers += 1;
      return new Response(JSON.stringify({ status: answers >= 3 ? "ok" : "starting" }), { status: 200 });
    };
    sys.onExec("systemctl is-active phibot.service", { code: 0, stdout: "active\n", stderr: "" });
    const result = await waitForServiceHealthy(sys, 300_000);
    expect(result.healthy).toBe(true);
    expect(sys.sleeps).toEqual([2000, 2000]);
  });

  it("gives up after the delay", async () => {
    const sys = new FakeSystem();
    sys.fetchHandler = async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    sys.onExec("systemctl is-active phibot.service", { code: 3, stdout: "activating\n", stderr: "" });
    const result = await waitForServiceHealthy(sys, 10_000);
    expect(result.healthy).toBe(false);
    expect(sys.sleeps.length).toBe(6);
  });
});
