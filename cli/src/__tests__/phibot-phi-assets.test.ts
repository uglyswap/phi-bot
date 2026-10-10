import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installPathsFor } from "../phibot/global-install.js";
import {
  CAMOUFOX_LAUNCH_SCRIPT,
  findCamoufoxLauncher,
  missingCamoufoxLibraries,
  phibotNodeCommand,
  preparePhiAssets,
} from "../phibot/phi-assets.js";
import { loadPreparePhiForCompany, runPhiPrepare } from "../phibot/phi-prepare.js";
import { FakeSystem, MemoryLogger } from "./helpers/phibot-fake-system.js";

const PATHS = installPathsFor("/usr/bin/node", "/usr/lib/node_modules");
const CACHE = "/var/lib/phibot/.cache/phi-code/camoufox";
const BIN_DIR = `${CACHE}/v1.0.0/linux-x64/camoufox-bin`;
const LAUNCHER = `${BIN_DIR}/camoufox-bin`;
const CAMOUFOX_JS = "/usr/lib/node_modules/@phi-code-admin/phi-bot/node_modules/@phi-code-admin/camoufox-js";
const COMPANY = "de2d48f1-0b2b-4eab-bc37-b60741cff92f";
const CLEAN_ENV =
  "runuser -u phibot -- env -i HOME=/var/lib/phibot PAPERCLIP_HOME=/var/lib/phibot/.paperclip PAPERCLIP_INSTANCE_ID=default PATH=/usr/bin:/usr/bin:/bin";

function readyHost(): FakeSystem {
  return new FakeSystem()
    .addDir("/var/lib/phibot/.phi/memory/notes")
    .addFile(LAUNCHER, "")
    .addFile(`${BIN_DIR}/libxul.so`, "")
    .addFile(`${BIN_DIR}/libmozgtk.so`, "")
    .addFile(`${BIN_DIR}/version.json`, "{}")
    .onExec("ldd", { code: 0, stdout: "\tlinux-vdso.so.1 (0x00007ffd)\n\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f)\n", stderr: "" })
    .onExec(`${CLEAN_ENV} /usr/bin/node --input-type=module`, { code: 0, stdout: "camoufox-ok\n", stderr: "" });
}

describe("Camoufox files", () => {
  it("finds the newest release that has its launcher", () => {
    const sys = new FakeSystem().addFile(`${CACHE}/v1.0.0/linux-x64/camoufox-bin/camoufox-bin`, "").addFile(`${CACHE}/v2.0.0/linux-x64/camoufox-bin/version.json`, "{}");
    expect(findCamoufoxLauncher(sys)).toBe(`${CACHE}/v1.0.0/linux-x64/camoufox-bin/camoufox-bin`);
    expect(findCamoufoxLauncher(new FakeSystem())).toBeNull();
  });

  it("runs ldd on the launcher and on every .so of its folder, with the folder on LD_LIBRARY_PATH", async () => {
    const sys = readyHost().onExec(`ldd ${BIN_DIR}/libxul.so`, { code: 0, stdout: "\tlibgtk-3.so.0 => not found\n\tlibasound.so.2 => not found\n", stderr: "" });
    expect(await missingCamoufoxLibraries(sys, LAUNCHER)).toEqual(["libasound.so.2", "libgtk-3.so.0"]);
    expect(sys.lines()).toEqual([`ldd ${LAUNCHER}`, `ldd ${BIN_DIR}/libmozgtk.so`, `ldd ${BIN_DIR}/libxul.so`]);
    expect(sys.calls.every((call) => call.options?.env?.LD_LIBRARY_PATH === BIN_DIR)).toBe(true);
  });
});

describe("preparePhiAssets (step 7)", () => {
  it("runs phi's postinstall, downloads Camoufox as phibot, checks the libraries and launches it", async () => {
    const sys = readyHost();
    const result = await preparePhiAssets(sys, new MemoryLogger(), PATHS, () => CAMOUFOX_JS);
    expect(result).toEqual({ launcher: LAUNCHER });
    const runuser = sys.calls.filter((call) => call.command === "runuser");
    expect(runuser.map((call) => call.args.slice(10))).toEqual([
      ["/usr/lib/node_modules/@phi-code-admin/phi-bot/node_modules/@phi-code-admin/phi-code/scripts/postinstall.cjs"],
      [`${CAMOUFOX_JS}/scripts/postinstall.mjs`],
      ["--input-type=module", "-e", CAMOUFOX_LAUNCH_SCRIPT, "/usr/lib/node_modules/@phi-code-admin/phi-bot/node_modules/@phi-code-admin/phi-code/package.json"],
    ]);
    expect(runuser.every((call) => call.line.startsWith(`${CLEAN_ENV} /usr/bin/node `))).toBe(true);
    expect(runuser.every((call) => call.options?.cwd === "/var/lib/phibot")).toBe(true);
    expect(runuser[1].options?.inherit).toBe(true);
    expect(runuser[2].options?.timeoutMs).toBe(120_000);
  });

  it("stops when the launcher is missing, a library is missing or the launch fails", async () => {
    const noLauncher = readyHost();
    noLauncher.remove(LAUNCHER);
    await expect(preparePhiAssets(noLauncher, new MemoryLogger(), PATHS, () => CAMOUFOX_JS)).rejects.toThrow("lanceur Camoufox introuvable");
    const noLib = readyHost().onExec(`ldd ${LAUNCHER}`, { code: 0, stdout: "\tlibdbus-glib-1.so.2 => not found\n", stderr: "" });
    await expect(preparePhiAssets(noLib, new MemoryLogger(), PATHS, () => CAMOUFOX_JS)).rejects.toThrow("bibliothèques manquantes pour Camoufox : libdbus-glib-1.so.2.");
    const crash = readyHost().onExec(`${CLEAN_ENV} /usr/bin/node --input-type=module`, { code: 1, stdout: "", stderr: "browserType.launch: Target page, context or browser has been closed" });
    await expect(preparePhiAssets(crash, new MemoryLogger(), PATHS, () => CAMOUFOX_JS)).rejects.toThrow("Le lancement de Camoufox a échoué (code 1).");
  });

  it("runs node directly, without CI, when already the service account (container)", () => {
    const sys = new FakeSystem();
    sys.uid = 998;
    sys.env = { HOME: "/var/lib/phibot", CI: "1", PHI_SKIP_POSTINSTALL: "1", PATH: "/usr/bin" };
    expect(phibotNodeCommand(sys, "/usr/bin/node", ["x.mjs"])).toEqual({
      line: { command: "/usr/bin/node", args: ["x.mjs"] },
      options: { env: { HOME: "/var/lib/phibot", PATH: "/usr/bin" } },
    });
  });
});

describe("phi:prepare (spec 12.1)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "phibot-prepare-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("calls preparePhiForCompany of the adapter loaded at run time", async () => {
    const adapter = path.join(dir, "adapter.mjs");
    fs.writeFileSync(adapter, "export async function preparePhiForCompany(id) { return { agentDir: `/a/${id}`, phiVersion: '0.100.0', embeddingModelDir: `/a/${id}/cache/models` }; }\n");
    const prepare = await loadPreparePhiForCompany(pathToFileURL(adapter).href);
    expect(await prepare(COMPANY)).toEqual({ agentDir: `/a/${COMPANY}`, phiVersion: "0.100.0", embeddingModelDir: `/a/${COMPANY}/cache/models` });
    const empty = path.join(dir, "empty.mjs");
    fs.writeFileSync(empty, "export const nothing = 1;\n");
    await expect(loadPreparePhiForCompany(pathToFileURL(empty).href)).rejects.toThrow("preparePhiForCompany introuvable");
  });

  it("validates the company id and reports the result", async () => {
    const logger = new MemoryLogger();
    const result = await runPhiPrepare(COMPANY, { logger, load: async () => async (id) => ({ agentDir: `/var/lib/phibot/.phi/phibot/companies/${id}/agent`, phiVersion: null, embeddingModelDir: "/m" }) });
    expect(result.agentDir).toBe(`/var/lib/phibot/.phi/phibot/companies/${COMPANY}/agent`);
    expect(logger.text()).toContain("Version de phi : inconnue");
    await expect(runPhiPrepare("../etc", { logger, load: async () => async () => result })).rejects.toThrow("Identifiant d'entreprise invalide");
  });
});
