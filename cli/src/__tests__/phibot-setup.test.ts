import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PhibotDatabase } from "../phibot/database.js";
import type { OwnerHttp } from "../phibot/owner.js";
import { runContainerSetup } from "../phibot/setup-container.js";
import { runRestoreSetup } from "../phibot/setup-restore.js";
import { resolveAccess, resolveSetupMode, runSetup, type SetupDeps, type SetupMarker } from "../phibot/setup.js";
import { renderPhibotUnit } from "../phibot/units.js";
import { FakeSystem, MemoryLogger, ScriptedPrompter } from "./helpers/phibot-fake-system.js";
import { goodHost } from "./helpers/phibot-hosts.js";

const PACKAGE = "/usr/lib/node_modules/@phi-code-admin/phi-bot";
const LIB = `${PACKAGE}/node_modules/@embedded-postgres/linux-x64/native/lib`;
const LAUNCHER = "/var/lib/phibot/.cache/phi-code/camoufox/v1.0.0/linux-x64/camoufox-bin/camoufox-bin";
const INSTANCE = "/var/lib/phibot/.paperclip/instances/default";
const MARKER = `${INSTANCE}/.phibot-setup-complete`;
const COMPANY = "de2d48f1-0b2b-4eab-bc37-b60741cff92f";
const NOBLE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "apt-cache-policy-noble.txt"), "utf8");
const PASSWORD = "correct-horse-battery";
const CLEAN_ENV =
  "runuser -u phibot -- env -i HOME=/var/lib/phibot PAPERCLIP_HOME=/var/lib/phibot/.paperclip PAPERCLIP_INSTANCE_ID=default PATH=/usr/bin:/usr/bin:/bin";
const FILES = `${INSTANCE}/config.json ${INSTANCE}/.env ${INSTANCE}/adapters.json ${INSTANCE}/secrets/master.key`;
const RIGHTS = [`chown phibot:phibot ${INSTANCE}/secrets ${FILES}`, `chmod 0700 ${INSTANCE}/secrets`, `chmod 0600 ${FILES}`];

/** A fresh Ubuntu 24.04 server on which every command succeeds as on a real install. */
function installableHost(): FakeSystem {
  const sys = goodHost();
  let accountExists = false;
  sys.onExec("apt-cache policy", { code: 0, stdout: NOBLE, stderr: "" });
  sys.onExec("getent passwd phibot", () => ({ code: accountExists ? 0 : 2, stdout: "", stderr: "" }));
  sys.onExec("useradd --system --create-home", () => {
    accountExists = true;
    return { code: 0, stdout: "", stderr: "" };
  });
  sys.onExec("/usr/bin/npm install -g", () => {
    sys.addFile(`${PACKAGE}/package.json`, JSON.stringify({ version: "1.0.0" })).addFile(`${PACKAGE}/dist/index.js`, "").addDir(LIB);
    return { code: 0, stdout: "", stderr: "" };
  });
  sys.onExec("runuser -u phibot -- env -i", (call) => {
    const script = call.args.at(-1) ?? "";
    if (script.endsWith("postinstall.cjs")) sys.addDir("/var/lib/phibot/.phi/memory/notes");
    if (script.endsWith("postinstall.mjs")) sys.addFile(LAUNCHER, "");
    return { code: 0, stdout: script.endsWith("package.json") ? "camoufox-ok\n" : "", stderr: "" };
  });
  sys.onExec("ldd", { code: 0, stdout: "\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6\n", stderr: "" });
  sys.onExec("id -u phibot", { code: 0, stdout: "998\n", stderr: "" });
  sys.onExec("systemctl is-active phibot.service", { code: 0, stdout: "active\n", stderr: "" });
  sys.fetchHandler = async () => new Response(JSON.stringify({ status: "ok", bootstrapStatus: "ready" }), { status: 200 });
  sys.addFile("/root/pw", `${PASSWORD}\n`, 0o600);
  return sys;
}

class FakeDb implements PhibotDatabase {
  constructor(public admins = 0, public companies: string[] = []) {}
  async instanceAdminCount() { return this.admins; }
  async companyIds() { return this.companies; }
  async findUserIdByEmail() { return null; }
  async createBootstrapInvite() { return "pcp_bootstrap_1"; }
  async setCredentialPassword() { return 1; }
  async deleteSessions() { return 0; }
  async llmProviderValue() { return null; }
  async close() {}
}

function depsFor(sys: FakeSystem, db = new FakeDb(), calls: string[] = []): SetupDeps & { logger: MemoryLogger } {
  const http: OwnerHttp = {
    async signUp(input) { calls.push(`signUp ${input.email}`); return "cookie"; },
    async signIn() { calls.push("signIn"); return "cookie"; },
    async acceptBootstrapInvite() { calls.push("accept"); db.admins = 1; },
    async createCompany(_cookie, name) { calls.push(`createCompany ${name}`); db.companies = [COMPANY]; return COMPANY; },
    async listCompanies() { return db.companies.map((id) => ({ id, name: "Acme" })); },
  };
  return {
    sys,
    logger: new MemoryLogger(),
    prompter: new ScriptedPrompter([]),
    cliVersion: "1.0.0",
    openDatabase: () => db,
    ownerHttp: (origin) => {
      calls.push(`origin ${origin}`);
      return http;
    },
    writeInstance: (input) => {
      calls.push(`writeInstance ${input.exposure.publicUrl}`);
      const existed = sys.exists(input.instanceRoot);
      sys.addFile(`${input.instanceRoot}/config.json`, "{}", 0o600);
      return existed
        ? { touchedFiles: [`${input.instanceRoot}/adapters.json`], createdDirs: [], envKeysAdded: [] }
        : { touchedFiles: [`${input.instanceRoot}/config.json`], createdDirs: [input.instanceRoot], envKeysAdded: [] };
    },
    applyExposure: (input) => {
      calls.push(`applyExposure ${input.exposure.publicUrl}`);
      return [`${INSTANCE}/config.json`, `${INSTANCE}/.env`];
    },
    readInstanceAuth: () => ({ baseUrlMode: "auto", disableSignUp: false }),
    loadAliasFunction: async () => async () => [],
    resolveCamoufoxJsDir: () => `${PACKAGE}/node_modules/@phi-code-admin/camoufox-js`,
    caddySha512: "unused",
  };
}

const YES = { yes: true, ownerEmail: "owner@exemple.fr", ownerPasswordFile: "/root/pw", company: "Acme" };

function milestones(sys: FakeSystem): string[] {
  return sys.lines().filter((line) => !line.startsWith("ldd ") && line !== "systemctl is-active phibot.service" && !line.startsWith("getent ahosts") && !line.startsWith("ss "));
}

describe("setup options (spec 6.2 rules)", () => {
  it("derives the access and the mode", () => {
    expect(resolveAccess({})).toEqual({ access: "ssh" });
    expect(resolveAccess({ domain: "bot.exemple.fr" })).toEqual({ access: "domain", domain: "bot.exemple.fr" });
    expect(() => resolveAccess({ access: "domain" })).toThrow("l'accès domain exige --domain");
    expect(() => resolveAccess({ access: "ssh", domain: "x.fr" })).toThrow("--domain n'a pas de sens avec --access ssh");
    expect(() => resolveAccess({ access: "vpn" })).toThrow("--access vpn inconnu");
    const marker: SetupMarker = { version: "1.0.0", access: "ssh", completedAt: "x" };
    expect(resolveSetupMode({}, null)).toBe("install");
    expect(resolveSetupMode({}, marker)).toBe("already-installed");
    expect(resolveSetupMode({ repair: true }, marker)).toBe("repair");
    expect(resolveSetupMode({ reconfigure: true }, marker)).toBe("reconfigure");
    expect(resolveSetupMode({ restore: "/root/full.tar.gz" }, null)).toBe("restore");
    expect(() => resolveSetupMode({ repair: true }, null)).toThrow("Phi Bot n'est pas encore installé");
    expect(() => resolveSetupMode({ restore: "/x.tar.gz" }, marker)).toThrow("--restore s'utilise sur un serveur neuf");
    expect(() => resolveSetupMode({ repair: true, reconfigure: true }, marker)).toThrow("s'excluent");
  });
});

describe("phibot setup", () => {
  it("installs everything in the order of spec 6.2 (ssh, --yes)", async () => {
    const sys = installableHost();
    const calls: string[] = [];
    const deps = depsFor(sys, new FakeDb(), calls);
    expect(await runSetup(YES, deps)).toBe("install");
    expect(milestones(sys)).toEqual([
      "/usr/bin/npm root -g",
      "apt-get -o DPkg::Lock::Timeout=600 update",
      expect.stringMatching(/^apt-cache policy ca-certificates /),
      expect.stringMatching(/^apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends ca-certificates /),
      "getent passwd phibot",
      "useradd --system --create-home --home-dir /var/lib/phibot --shell /usr/sbin/nologin phibot",
      "chmod 0700 /var/lib/phibot",
      "/usr/bin/npm root -g",
      expect.stringMatching(/^\/usr\/bin\/npm install -g @phi-code-admin\/phi-bot@1\.0\.0 /),
      "chown -R phibot:phibot /var/lib/phibot/.paperclip",
      ...RIGHTS,
      expect.stringMatching(/^runuser -u phibot -- env -i .* \/usr\/bin\/node .*\/phi-code\/scripts\/postinstall\.cjs$/),
      expect.stringMatching(/^runuser -u phibot -- env -i .* \/usr\/bin\/node .*\/camoufox-js\/scripts\/postinstall\.mjs$/),
      expect.stringMatching(/^runuser -u phibot -- env -i .* --input-type=module -e /),
      "id -u phibot",
      "systemctl daemon-reload",
      "systemctl enable phibot-guard.service",
      "systemctl restart phibot-guard.service",
      "systemctl daemon-reload",
      "systemctl enable phibot.service",
      "systemctl restart phibot.service",
      `${CLEAN_ENV} /usr/bin/node ${PACKAGE}/dist/index.js phi:prepare --company ${COMPANY}`,
      `chown phibot:phibot ${MARKER}`,
    ]);
    expect(calls).toEqual(["writeInstance http://localhost:3100", "origin http://127.0.0.1:3100", "signUp owner@exemple.fr", "accept", "createCompany Acme"]);
    expect(sys.readFile("/etc/systemd/system/phibot.service")).toBe(renderPhibotUnit({ nodePath: "/usr/bin/node", phibotJsPath: `${PACKAGE}/dist/index.js` }));
    expect(JSON.parse(sys.readFile(MARKER))).toEqual({ version: "1.0.0", access: "ssh", completedAt: "2026-10-08T12:00:00.000Z" });
    expect(deps.logger.text()).toContain("ssh -N -L 3100:127.0.0.1:3100 <utilisateur>@<serveur>");
    expect(deps.logger.text()).toContain("Les liens d'invitation de coéquipiers pointeront sur http://localhost:3100");
    expect(sys.lines().some((line) => line.startsWith("chmod -R"))).toBe(false);
  });

  it("stops at the first failing step with its correction", async () => {
    const sys = installableHost().onExec("apt-get -o DPkg::Lock::Timeout=600 update", { code: 100, stdout: "", stderr: "E: Could not get lock" });
    await expect(runSetup(YES, depsFor(sys))).rejects.toThrow("Étape « Paquets système »");
    expect(sys.lines().some((line) => line.startsWith("useradd"))).toBe(false);
  });

  it("only reports when Phi Bot is already installed", async () => {
    const sys = installableHost().addFile(MARKER, JSON.stringify({ version: "1.0.0", access: "ssh", completedAt: "x" }));
    const deps = depsFor(sys);
    expect(await runSetup({}, deps)).toBe("already-installed");
    expect(sys.lines()).toEqual(["systemctl is-active phibot.service"]);
    expect(deps.logger.text()).toContain("Phi Bot est déjà installé (version 1.0.0, accès ssh). Service : active.");
  });

  it("repairs without touching the configuration contents nor asking for the owner (--repair)", async () => {
    const sys = installableHost()
      .addFile(MARKER, JSON.stringify({ version: "0.9.0", access: "ssh", completedAt: "x" }))
      .addFile("/etc/systemd/system/phibot.service", "old")
      .onExec("getent passwd phibot", { code: 0, stdout: "phibot:x:998:998::/var/lib/phibot:/usr/sbin/nologin\n", stderr: "" });
    sys.freeDisk = 2 * 1024 ** 3;
    const calls: string[] = [];
    const deps = depsFor(sys, new FakeDb(1, [COMPANY]), calls);
    expect(await runSetup({ repair: true }, deps)).toBe("repair");
    expect(calls).toEqual([]);
    const lines = milestones(sys);
    expect(lines.slice(lines.indexOf("chmod 0700 /var/lib/phibot") + 3, lines.indexOf("chmod 0700 /var/lib/phibot") + 6)).toEqual(RIGHTS);
    expect(lines).not.toContain("chown -R phibot:phibot /var/lib/phibot/.paperclip");
    expect(lines.some((line) => line.startsWith("useradd"))).toBe(false);
    expect(lines).toContain(`${CLEAN_ENV} /usr/bin/node ${PACKAGE}/dist/index.js phi:prepare --company ${COMPANY}`);
    expect(sys.readFile("/etc/systemd/system/phibot.service")).toBe(renderPhibotUnit({ nodePath: "/usr/bin/node", phibotJsPath: `${PACKAGE}/dist/index.js` }));
    expect(JSON.parse(sys.readFile(MARKER)).version).toBe("1.0.0");
    expect(deps.logger.text()).toContain("Phi Bot 1.0.0 réparé.");
  });

  it("switches from ssh to a domain (--reconfigure)", async () => {
    const sys = installableHost()
      .addFile(MARKER, JSON.stringify({ version: "1.0.0", access: "ssh", completedAt: "x" }))
      .addFile("/etc/systemd/system/phibot.service", "unit")
      .onExec("/usr/local/bin/caddy version", { code: 0, stdout: "v2.11.7 h1:x=\n", stderr: "" })
      .addFile("/usr/local/bin/caddy", "")
      .onExec("getent group caddy", { code: 0, stdout: "caddy:x:997:\n", stderr: "" })
      .onExec("getent passwd caddy", { code: 0, stdout: "caddy:x:997:997::/var/lib/caddy:/usr/sbin/nologin\n", stderr: "" })
      .onExec("curl -fsS", { code: 0, stdout: '{"status":"ok"}', stderr: "" })
      .onExec("ufw status", { code: 1, stdout: "", stderr: "" });
    const calls: string[] = [];
    expect(await runSetup({ reconfigure: true, domain: "bot.exemple.fr" }, depsFor(sys, new FakeDb(1, [COMPANY]), calls))).toBe("reconfigure");
    expect(calls).toEqual(["applyExposure https://bot.exemple.fr"]);
    const lines = milestones(sys);
    expect(lines.slice(0, 5)).toEqual([...RIGHTS, "systemctl restart phibot.service", "/usr/local/bin/caddy version"]);
    expect(lines).toContain("systemctl restart caddy.service");
    expect(JSON.parse(sys.readFile(MARKER))).toMatchObject({ access: "domain", domain: "bot.exemple.fr" });
  });

  it("removes the Caddy of Phi Bot when leaving the domain access (--reconfigure)", async () => {
    const sys = installableHost()
      .addFile(MARKER, JSON.stringify({ version: "1.0.0", access: "domain", domain: "bot.exemple.fr", completedAt: "x" }))
      .addFile("/etc/systemd/system/phibot.service", "unit")
      .addFile("/etc/caddy/.phibot-installed", "")
      .addFile("/etc/caddy/Caddyfile", "# managed-by: phibot\n\nbot.exemple.fr {\n}\n")
      .addFile("/etc/systemd/system/caddy.service", "unit");
    expect(await runSetup({ reconfigure: true, access: "ssh" }, depsFor(sys, new FakeDb(1, [COMPANY])))).toBe("reconfigure");
    expect(milestones(sys)).toContain("systemctl disable --now caddy.service");
    expect(sys.exists("/etc/caddy/Caddyfile")).toBe(false);
    expect(JSON.parse(sys.readFile(MARKER))).toMatchObject({ access: "ssh" });
  });
});

describe("phibot setup --restore (spec 13.7)", () => {
  it("restores the files as root, the database as phibot, then starts without creating an owner", async () => {
    const ARCHIVE = "/root/full-20261001-000000.tar.gz";
    const sys = installableHost()
      .addFile(ARCHIVE, "archive")
      .onExec(`tar -xzOf ${ARCHIVE} phibot-backup.json`, {
        code: 0,
        stdout: JSON.stringify({ format: 1, createdAt: "x", version: "1.0.0", companyId: COMPANY, access: "domain", publicUrl: "https://old.exemple.fr", dump: "db/paperclip-1.sql.gz", entries: [`var/lib/phibot/.paperclip/instances/default/config.json`] }),
        stderr: "",
      });
    const calls: string[] = [];
    await runSetup({ restore: ARCHIVE, access: "ssh" }, depsFor(sys, new FakeDb(1, [COMPANY]), calls), runRestoreSetup);
    const lines = milestones(sys);
    const restored = lines.indexOf(`tar -xzf ${ARCHIVE} -C / var/lib/phibot/.paperclip/instances/default/config.json`);
    expect(lines.slice(restored, restored + 7)).toEqual([
      `tar -xzf ${ARCHIVE} -C / var/lib/phibot/.paperclip/instances/default/config.json`,
      "chown -R phibot:phibot /var/lib/phibot",
      ...RIGHTS,
      `tar -xzf ${ARCHIVE} -C /var/tmp/phibot-restore-20261008-120000 db/paperclip-1.sql.gz`,
      `install -o phibot -g phibot -m 600 /var/tmp/phibot-restore-20261008-120000/db/paperclip-1.sql.gz ${INSTANCE}/data/backups/restore-input-paperclip-1.sql.gz`,
    ]);
    expect(lines[restored + 7]).toBe(`${CLEAN_ENV} /usr/bin/node ${PACKAGE}/dist/index.js internal:db-restore ${INSTANCE}/data/backups/restore-input-paperclip-1.sql.gz`);
    expect(calls).toEqual(["applyExposure http://localhost:3100"]);
    expect(lines.indexOf("systemctl restart phibot.service")).toBeGreaterThan(restored + 7);
    expect(lines.some((line) => line.startsWith("useradd"))).toBe(true);
  });
});

describe("phibot setup --container (spec 14)", () => {
  it("replays step 7 at each start and step 9b only when the existing instance has a company", async () => {
    const sys = new FakeSystem();
    sys.uid = 10001;
    sys.execPath = "/usr/local/bin/node";
    sys.onExec("npm root -g", { code: 0, stdout: "/usr/local/lib/node_modules\n", stderr: "" });
    sys.onExec("/usr/local/bin/node", (call) => {
      const script = call.args.at(-1) ?? "";
      if (script.endsWith("postinstall.cjs")) sys.addDir("/var/lib/phibot/.phi/memory/notes");
      if (script.endsWith("postinstall.mjs")) sys.addFile(LAUNCHER, "");
      return { code: 0, stdout: script.endsWith("package.json") ? "camoufox-ok\n" : "", stderr: "" };
    });
    sys.onExec("ldd", { code: 0, stdout: "", stderr: "" });
    const events: string[] = [];
    let companies: string[] = [];
    const container = {
      sys,
      logger: new MemoryLogger(),
      cliVersion: "1.0.0",
      runServer: async () => { events.push("server"); },
      writeInstance: () => ({ touchedFiles: [], createdDirs: [], envKeysAdded: [] }),
      resolveCamoufoxJsDir: () => "/usr/local/lib/node_modules/@phi-code-admin/phi-bot/node_modules/@phi-code-admin/camoufox-js",
      readCompanyIds: async () => { events.push("read companies"); return companies; },
      preparePhi: async (id: string) => { events.push(`phi:prepare ${id}`); },
    };
    await runContainerSetup(container);
    await runContainerSetup(container);
    companies = [COMPANY];
    await runContainerSetup(container);
    expect(events).toEqual(["server", "read companies", "server", "read companies", `phi:prepare ${COMPANY}`, "server"]);
    expect(sys.lines().filter((line) => line.includes("postinstall.mjs"))).toHaveLength(3);
    expect(container.logger.text()).toContain("Aucune entreprise en base : créez le propriétaire avec docker compose exec -it phibot phibot owner create.");
    companies = [COMPANY, "x"];
    await expect(runContainerSetup(container)).rejects.toThrow("2 entreprises en base");
  });

  it("writes the configuration from the environment and runs the server", async () => {
    const sys = new FakeSystem();
    sys.uid = 10001;
    sys.env = { PAPERCLIP_PUBLIC_URL: "https://bot.exemple.fr" };
    sys.execPath = "/usr/local/bin/node";
    sys.onExec("npm root -g", { code: 0, stdout: "/usr/local/lib/node_modules\n", stderr: "" });
    sys.addFile("/usr/local/lib/node_modules/@phi-code-admin/phi-bot/node_modules/@embedded-postgres/linux-x64/native/lib/libssl.so.1.1", "");
    sys.addFile("/usr/local/lib/node_modules/@phi-code-admin/phi-bot/node_modules/@embedded-postgres/linux-x64/native/lib/libssl.so.1", "");
    sys.onExec("/usr/local/bin/node", (call) => {
      const script = call.args.at(-1) ?? "";
      if (script.endsWith("postinstall.cjs")) sys.addDir("/var/lib/phibot/.phi/memory/notes");
      if (script.endsWith("postinstall.mjs")) sys.addFile(LAUNCHER, "");
      return { code: 0, stdout: script.endsWith("package.json") ? "camoufox-ok\n" : "", stderr: "" };
    });
    sys.onExec("ldd", { code: 0, stdout: "", stderr: "" });
    const written: string[] = [];
    let served = 0;
    const container = {
      sys,
      logger: new MemoryLogger(),
      cliVersion: "1.0.0",
      runServer: async () => { served += 1; },
      writeInstance: (input: { exposure: { publicUrl: string; bindHost: string } }) => {
        written.push(`${input.exposure.publicUrl} ${input.exposure.bindHost}`);
        return { touchedFiles: [], createdDirs: [], envKeysAdded: [] };
      },
      resolveCamoufoxJsDir: () => "/usr/local/lib/node_modules/@phi-code-admin/phi-bot/node_modules/@phi-code-admin/camoufox-js",
      readCompanyIds: async () => [],
    };
    await runContainerSetup(container);
    await runContainerSetup(container);
    expect(written).toEqual(["https://bot.exemple.fr 0.0.0.0", "https://bot.exemple.fr 0.0.0.0"]);
    expect(served).toBe(2);
    expect(sys.env.PAPERCLIP_SERVICE_MANAGED).toBe("1");
    expect(sys.lines().some((line) => line.startsWith("runuser") || line.startsWith("apt-get") || line.startsWith("systemctl"))).toBe(false);
  });

  it("refuses root and an image without the Postgres aliases", async () => {
    const root = new FakeSystem();
    await expect(runContainerSetup({ sys: root, logger: new MemoryLogger(), cliVersion: "1.0.0", runServer: async () => {} })).rejects.toThrow("le conteneur tourne en root");
    const sys = new FakeSystem();
    sys.uid = 10001;
    sys.onExec("npm root -g", { code: 0, stdout: "/usr/local/lib/node_modules\n", stderr: "" });
    sys.addFile("/usr/local/lib/node_modules/@phi-code-admin/phi-bot/node_modules/@embedded-postgres/linux-x64/native/lib/libcrypto.so.1.1", "");
    await expect(
      runContainerSetup({ sys, logger: new MemoryLogger(), cliVersion: "1.0.0", runServer: async () => {}, writeInstance: () => ({ touchedFiles: [], createdDirs: [], envKeysAdded: [] }) }),
    ).rejects.toThrow("alias de bibliothèques de Postgres embarqué absents : libcrypto.so.1");
  });
});
