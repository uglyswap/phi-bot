import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckResult } from "../checks/index.js";
import { doctor } from "../commands/doctor.js";
import { writeConfig } from "../config/store.js";
import type { PaperclipConfig } from "../config/schema.js";
import type { PhibotDatabase } from "../phibot/database.js";
import { phibotDoctorChecks, type PhibotDoctorDeps } from "../phibot/doctor-checks.js";
import { installPathsFromUnit, phibotServerChecks, runDoctorRootPart } from "../phibot/doctor.js";
import type { SetupMarker } from "../phibot/setup.js";
import { renderPhibotUnit } from "../phibot/units.js";
import { FakeSystem, MemoryLogger } from "./helpers/phibot-fake-system.js";

const PACKAGE = "/usr/lib/node_modules/@phi-code-admin/phi-bot";
const UNIT = { nodePath: "/usr/bin/node", phibotJsPath: `${PACKAGE}/dist/index.js` };
const PHI = `${PACKAGE}/node_modules/@phi-code-admin/phi-code`;
const LIB = `${PACKAGE}/node_modules/@embedded-postgres/linux-x64/native/lib`;
const COMPANY = "de2d48f1-0b2b-4eab-bc37-b60741cff92f";
const AGENT = `/var/lib/phibot/.phi/phibot/companies/${COMPANY}/agent`;
const INSTANCE = "/var/lib/phibot/.paperclip/instances/default";
const LAUNCHER = "/var/lib/phibot/.cache/phi-code/camoufox/v1.0.0/linux-x64/camoufox-bin/camoufox-bin";
const ORIGINAL_ENV = { ...process.env };

class ProviderDb implements PhibotDatabase {
  constructor(private readonly provider: string | null) {}
  async instanceAdminCount() { return 1; }
  async companyIds() { return [COMPANY]; }
  async findUserIdByEmail() { return null; }
  async createBootstrapInvite() { return "unused"; }
  async setCredentialPassword() { return 0; }
  async deleteSessions() { return 0; }
  async llmProviderValue() { return this.provider; }
  async close() {}
}

/** A Phi Bot server where everything of spec 13.5 is in order, seen by the phibot account. */
function healthyServer(): FakeSystem {
  const sys = new FakeSystem()
    .addFile("/etc/systemd/system/phibot.service", renderPhibotUnit(UNIT))
    .addFile(`${PACKAGE}/package.json`, JSON.stringify({ version: "1.0.0" }))
    .addFile(`${PHI}/package.json`, JSON.stringify({ version: "0.100.0", bin: { phi: "dist/cli.js" } }))
    .addFile(`${PHI}/dist/cli.js`, "")
    .addFile(`${LIB}/libssl.so.1.1`, "")
    .addFile(`${LIB}/libssl.so.1`, "")
    .addFile(`${AGENT}/.bundled-assets-version`, "0.100.0\n")
    .addFile(`${AGENT}/extensions/node_modules/@phi-code-admin/sigma-memory/package.json`, "{}")
    .addFile(`${AGENT}/settings.json`, JSON.stringify({ theme: "dark", defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"] }))
    .addFile(`${AGENT}/cache/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx`, "")
    .addFile(LAUNCHER, "")
    .addFile("/usr/bin/Xvfb", "")
    .addFile(`${INSTANCE}/secrets/master.key`, "k", 0o600)
    .addFile(`${INSTANCE}/data/backups/paperclip-20261008-110000.sql.gz`, "", 0o600, Date.parse("2026-10-08T11:00:00.000Z"))
    .onExec("systemctl is-active", { code: 0, stdout: "active\n", stderr: "" })
    .onExec("/usr/bin/node --version", { code: 0, stdout: "v24.11.0\n", stderr: "" })
    .onExec("ldd", { code: 0, stdout: "\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6\n", stderr: "" })
    .onExec("curl -fsS", { code: 0, stdout: '{"status":"ok"}', stderr: "" });
  sys.uid = 998;
  sys.fetchHandler = async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  return sys;
}

async function runChecks(sys: FakeSystem, options: { marker?: SetupMarker; provider?: string | null } = {}): Promise<CheckResult[]> {
  const deps: PhibotDoctorDeps = {
    sys,
    paths: installPathsFromUnit(UNIT),
    marker: options.marker ?? { version: "1.0.0", access: "ssh", completedAt: "x" },
    openDatabase: () => new ProviderDb(options.provider === undefined ? "openai" : options.provider),
  };
  const results: CheckResult[] = [];
  for (const check of phibotDoctorChecks(deps)) results.push(await check());
  return results;
}

function byName(results: CheckResult[], name: string): CheckResult | undefined {
  return results.find((result) => result.name === name);
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("Phi Bot doctor checks (spec 13.5)", () => {
  it("passes every check on a healthy server, in the order of the spec", async () => {
    const results = await runChecks(healthyServer());
    expect(results.map((result) => `${result.status} ${result.name}`)).toEqual([
      "pass Service phibot",
      "pass Garde réseau locale",
      "pass Version de Phi Bot",
      "pass Binaire phi",
      "pass Node.js du service",
      "pass Alias de Postgres embarqué",
      "pass Dossier agent de l'entreprise",
      "pass Camoufox",
      "pass Xvfb",
      "pass Modèle d'embedding",
      "pass Clé maîtresse",
      "pass Dernière sauvegarde",
      "pass Espace disque",
      "pass Fournisseur IA",
    ]);
    expect(byName(results, "Binaire phi")?.message).toBe(`${PHI}/dist/cli.js (version 0.100.0)`);
    expect(byName(results, "Dernière sauvegarde")?.message).toBe("il y a 1 h");
  });

  it("adds the HTTPS check of the domain access", async () => {
    const sys = healthyServer().onExec("curl -fsS -k", { code: 7, stdout: "", stderr: "Failed to connect" });
    const results = await runChecks(sys, { marker: { version: "1.0.0", access: "domain", domain: "bot.exemple.fr", tlsInternal: true, completedAt: "x" } });
    expect(results.at(-1)).toEqual({
      name: "Accès HTTPS",
      status: "fail",
      message: "caddy.service actif, https://bot.exemple.fr injoignable",
      repairHint: "sudo phibot doctor --repair",
    });
  });

  it("reports each problem with its correction", async () => {
    const sys = healthyServer()
      .addFile(`${AGENT}/settings.json`, JSON.stringify({ defaultTools: ["read", "bash", "edit", "write"] }))
      .addFile(`${LIB}/libcrypto.so.1.1`, "")
      .addFile(`${INSTANCE}/secrets/master.key`, "k", 0o644)
      .addFile(`${INSTANCE}/data/backups/paperclip-20261008-110000.sql.gz`, "", 0o600, Date.parse("2026-10-06T11:00:00.000Z"))
      .onExec("systemctl is-active phibot-guard.service", { code: 3, stdout: "failed\n", stderr: "" });
    sys.freeDisk = 4 * 1024 ** 3;
    const results = await runChecks(sys, { provider: null });
    expect(results.filter((result) => result.status !== "pass")).toEqual([
      {
        name: "Garde réseau locale",
        status: "warn",
        message: "phibot-guard.service inactif : d'autres comptes du serveur peuvent joindre la base sur 127.0.0.1:54329",
        repairHint: "sudo phibot doctor --repair",
      },
      { name: "Alias de Postgres embarqué", status: "fail", message: "absents : libcrypto.so.1", repairHint: "sudo phibot doctor --repair" },
      { name: "Dossier agent de l'entreprise", status: "fail", message: `${COMPANY} : defaultTools sans grep, find, ls`, repairHint: "sudo phibot doctor --repair" },
      {
        name: "Clé maîtresse",
        status: "fail",
        message: "mode 644",
        repairHint: "sudo chmod 600 /var/lib/phibot/.paperclip/instances/default/secrets/master.key",
      },
      {
        name: "Dernière sauvegarde",
        status: "warn",
        message: "il y a 49 h",
        repairHint: "sudo phibot backup --full, et vérifiez que le service tourne (sauvegarde horaire)",
      },
      {
        name: "Espace disque",
        status: "fail",
        message: "4.0 Gio libres (plus de 5 Gio requis)",
        repairHint: "Libérez de l'espace (anciennes sauvegardes dans /var/lib/phibot/.paperclip/instances/default/data/backups)",
      },
      { name: "Fournisseur IA", status: "warn", message: "non configuré", repairHint: "Ouvrez Phi Bot et terminez l'assistant (fournisseur, clé API, modèle)" },
    ]);
  });

  it("detects a stale agent folder and an unresolved extension link", async () => {
    const stale = healthyServer().addFile(`${AGENT}/.bundled-assets-version`, "0.99.5\n");
    expect(byName(await runChecks(stale), "Dossier agent de l'entreprise")?.message).toBe(`${COMPANY} : tampon 0.99.5, phi 0.100.0`);
    const broken = healthyServer().addDir(`${AGENT}/extensions/node_modules/@phi-code-admin/browser`);
    expect(byName(await runChecks(broken), "Dossier agent de l'entreprise")?.message).toBe(`${COMPANY} : liens non résolus : @phi-code-admin/browser`);
  });

  it("only exists on a Phi Bot server", () => {
    expect(phibotServerChecks(healthyServer())).toHaveLength(14);
    expect(phibotServerChecks(new FakeSystem())).toEqual([]);
  });
});

describe("phibot doctor run by root (spec 6.8)", () => {
  it("runs setup --repair --yes of the installed version, then the checks as phibot", async () => {
    const sys = healthyServer().onExec("runuser", { code: 1, stdout: "", stderr: "" });
    sys.uid = 0;
    expect(await runDoctorRootPart(sys, new MemoryLogger(), { repair: true })).toBe(1);
    expect(sys.lines()).toEqual([
      `/usr/bin/node ${PACKAGE}/dist/index.js setup --repair --yes`,
      `runuser -u phibot -- env HOME=/var/lib/phibot PAPERCLIP_HOME=/var/lib/phibot/.paperclip PAPERCLIP_INSTANCE_ID=default /usr/bin/node ${PACKAGE}/dist/index.js doctor`,
    ]);
  });

  it("lets the phibot account, or a machine without the unit, run the checks itself", async () => {
    expect(await runDoctorRootPart(healthyServer(), new MemoryLogger(), { repair: true })).toBeNull();
    expect(await runDoctorRootPart(new FakeSystem(), new MemoryLogger(), {})).toBeNull();
  });
});

describe("doctor hook (review M2)", () => {
  it("counts the extra checks given by the doctor command", async () => {
    process.env.PAPERCLIP_UPDATE_CHECK = "0";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phibot-doctor-"));
    try {
      const configPath = path.join(root, "config.json");
      const config: PaperclipConfig = {
        $meta: { version: 1, updatedAt: "2026-10-08T00:00:00.000Z", source: "configure" },
        database: { mode: "embedded-postgres", embeddedPostgresDataDir: path.join(root, "db"), embeddedPostgresPort: 55433, backup: { enabled: true, intervalMinutes: 60, retentionDays: 30, dir: path.join(root, "backups") } },
        logging: { mode: "file", logDir: path.join(root, "logs") },
        server: { deploymentMode: "local_trusted", exposure: "private", host: "127.0.0.1", port: 3199, allowedHostnames: [], serveUi: true },
        auth: { baseUrlMode: "auto", disableSignUp: false },
        telemetry: { enabled: false },
        storage: { provider: "local_disk", localDisk: { baseDir: path.join(root, "storage") }, s3: { bucket: "paperclip", region: "us-east-1", prefix: "", forcePathStyle: false } },
        secrets: { provider: "local_encrypted", strictMode: false, localEncrypted: { keyFilePath: path.join(root, "secrets", "master.key") } },
      };
      writeConfig(config, configPath);
      const without = await doctor({ config: configPath });
      let called = 0;
      const extra = async (): Promise<CheckResult> => {
        called += 1;
        return { name: "Phi Bot", status: "fail", message: "test", repairHint: "sudo phibot doctor --repair" };
      };
      const withExtra = await doctor({ config: configPath, extraChecks: [extra] });
      expect(called).toBe(1);
      expect(withExtra.failed).toBe(without.failed + 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
