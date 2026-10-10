import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, ensurePostgresDatabase, applyPendingMigrations } from "@paperclipai/db";
import { dumpDatabase } from "../phibot/backup.js";
import {
  classifyRestoreSource,
  readArchiveManifest,
  realDatabaseRestoreDeps,
  restoreDatabaseFromDump,
  runDbRestore,
  runInternalDbRestore,
  type DatabaseRestoreDeps,
} from "../phibot/restore.js";
import { FakeSystem, MemoryLogger, ScriptedPrompter } from "./helpers/phibot-fake-system.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

const UNIT_PATHS = { nodePath: "/usr/bin/node", phibotJsPath: "/usr/lib/node_modules/@phi-code-admin/phi-bot/dist/index.js" };
const BACKUPS = "/var/lib/phibot/.paperclip/instances/default/data/backups";
const MANIFEST = JSON.stringify({
  format: 1,
  createdAt: "x",
  version: "1.0.0",
  companyId: null,
  access: "ssh",
  publicUrl: "http://localhost:3100",
  dump: "db/paperclip-1.sql.gz",
  entries: ["var/lib/phibot/.paperclip/instances/default/config.json", "var/lib/phibot/.phi/memory"],
});

function recordingDeps(calls: string[]): DatabaseRestoreDeps {
  return {
    startPostgres: async (dataDir, port) => {
      calls.push(`start ${dataDir} ${port}`);
      return { port: 54329, stop: async () => { calls.push("stop"); } };
    },
    resetDatabase: async (url) => { calls.push(`reset ${url}`); },
    restoreDump: async (url, file) => { calls.push(`restore ${url} ${file}`); },
    migrate: async (url) => { calls.push(`migrate ${url}`); },
  };
}

describe("db:restore sources (spec 13.3, review m4)", () => {
  it("accepts dumps and archives of backup --full, including pre-update", () => {
    expect(classifyRestoreSource("/b/paperclip-20261008-120000.sql.gz")).toBe("dump");
    expect(classifyRestoreSource("/b/full-20261008-120000.tar.gz")).toBe("archive");
    expect(classifyRestoreSource("/b/pre-update-1.0.0-1.0.1-20261008-120000.tar.gz")).toBe("archive");
    expect(() => classifyRestoreSource("/b/notes.txt")).toThrow("format non reconnu");
  });

  it("restores in the upstream order and always stops Postgres", async () => {
    const calls: string[] = [];
    await restoreDatabaseFromDump(recordingDeps(calls), { dumpFile: "/d.sql.gz", dataDir: "/db", port: 54329 });
    expect(calls).toEqual([
      "start /db 54329",
      "reset postgres://paperclip:paperclip@127.0.0.1:54329/postgres",
      "restore postgres://paperclip:paperclip@127.0.0.1:54329/paperclip /d.sql.gz",
      "migrate postgres://paperclip:paperclip@127.0.0.1:54329/paperclip",
      "stop",
    ]);
  });

  it("reads the manifest, extracts only the dump, puts the files back and restores (phibot part)", async () => {
    const sys = new FakeSystem().onExec("tar -xzOf /b/full.tar.gz phibot-backup.json", { code: 0, stdout: MANIFEST, stderr: "" });
    sys.uid = 998;
    const workDir = `${BACKUPS}/.restore-20261008-120000`;
    const calls: string[] = [];
    await runInternalDbRestore(sys, new MemoryLogger(), { file: "/b/full.tar.gz", withFiles: true, dataDir: "/db", port: 54329, deps: recordingDeps(calls) });
    expect(sys.lines()).toEqual([
      "tar -xzOf /b/full.tar.gz phibot-backup.json",
      `tar -xzf /b/full.tar.gz -C ${workDir} db/paperclip-1.sql.gz`,
      "tar -xzf /b/full.tar.gz -C / var/lib/phibot/.paperclip/instances/default/config.json var/lib/phibot/.phi/memory",
    ]);
    expect(calls[2]).toBe(`restore postgres://paperclip:paperclip@127.0.0.1:54329/paperclip ${workDir}/db/paperclip-1.sql.gz`);
    expect(sys.exists(workDir)).toBe(false);
  });

  it("refuses a manifest with paths outside the data folder", async () => {
    const evil = (manifest: object) =>
      new FakeSystem().onExec("tar -xzOf", { code: 0, stdout: JSON.stringify({ format: 1, createdAt: "x", dump: "db/x.sql.gz", entries: [], ...manifest }), stderr: "" });
    await expect(readArchiveManifest(evil({ entries: ["../etc/passwd"] }), "/b/evil.tar.gz")).rejects.toThrow("manifeste de sauvegarde invalide");
    await expect(readArchiveManifest(evil({ dump: "../../etc/shadow" }), "/b/evil.tar.gz")).rejects.toThrow("manifeste de sauvegarde invalide");
    await expect(readArchiveManifest(new FakeSystem().onExec("tar", { code: 2, stdout: "", stderr: "not in archive" }), "/b/x.tar.gz")).rejects.toThrow("phibot-backup.json illisible");
  });
});

describe("runDbRestore (root part, review M4)", () => {
  it("copies the file for phibot, stops the service, restores as phibot, chowns the restored paths, restarts and waits for health", async () => {
    const sys = new FakeSystem()
      .addFile("/root/full-20261001-000000.tar.gz", "archive")
      .addFile("/var/lib/phibot/.paperclip/instances/default/config.json", "{}")
      .addDir("/var/lib/phibot/.phi/memory")
      .onExec("tar -xzOf /root/full-20261001-000000.tar.gz phibot-backup.json", { code: 0, stdout: MANIFEST, stderr: "" })
      .onExec("systemctl is-active phibot.service", { code: 0, stdout: "active\n", stderr: "" });
    sys.fetchHandler = async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    await runDbRestore(sys, { logger: new MemoryLogger(), prompter: new ScriptedPrompter([true]), unitPaths: UNIT_PATHS }, { file: "/root/full-20261001-000000.tar.gz" });
    const staged = `${BACKUPS}/restore-input-20261008-120000-full-20261001-000000.tar.gz`;
    expect(sys.lines()).toEqual([
      `install -o phibot -g phibot -m 600 /root/full-20261001-000000.tar.gz ${staged}`,
      "systemctl stop phibot.service",
      `runuser -u phibot -- env HOME=/var/lib/phibot PAPERCLIP_HOME=/var/lib/phibot/.paperclip PAPERCLIP_INSTANCE_ID=default /usr/bin/node /usr/lib/node_modules/@phi-code-admin/phi-bot/dist/index.js internal:db-restore ${staged} --with-files`,
      "tar -xzOf /root/full-20261001-000000.tar.gz phibot-backup.json",
      "chown -R phibot:phibot /var/lib/phibot/.paperclip/instances/default/config.json /var/lib/phibot/.phi/memory",
      "systemctl start phibot.service",
      "systemctl is-active phibot.service",
    ]);
  });

  it("asks for confirmation unless --yes, and needs a terminal", async () => {
    const sys = new FakeSystem().addFile("/var/lib/phibot/x.sql.gz", "");
    await expect(runDbRestore(sys, { logger: new MemoryLogger(), prompter: new ScriptedPrompter([false]), unitPaths: UNIT_PATHS }, { file: "/var/lib/phibot/x.sql.gz" })).rejects.toThrow("restauration annulée");
    await expect(runDbRestore(sys, { logger: new MemoryLogger(), prompter: new ScriptedPrompter([], false), unitPaths: UNIT_PATHS }, { file: "/var/lib/phibot/x.sql.gz" })).rejects.toThrow("Relancez avec --yes");
    expect(sys.calls).toEqual([]);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("restoreDatabaseFromDump with the real upstream functions", () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phibot-restore-"));
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("brings the database back to the dump", async () => {
    const dataDir = path.join(root, "db");
    const first = await realDatabaseRestoreDeps.startPostgres(dataDir, 54400);
    const url = `postgres://paperclip:paperclip@127.0.0.1:${first.port}/paperclip`;
    try {
      await ensurePostgresDatabase(`postgres://paperclip:paperclip@127.0.0.1:${first.port}/postgres`, "paperclip");
      await applyPendingMigrations(url);
      const db = createDb(url);
      await db.insert(companies).values({ name: "Avant", issuePrefix: "AVA" });
      const dump = await dumpDatabase(path.join(root, "backups"), url);
      await db.insert(companies).values({ name: "Apres", issuePrefix: "APR" });
      await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
      await first.stop();
      await restoreDatabaseFromDump(realDatabaseRestoreDeps, { dumpFile: dump, dataDir, port: first.port });
    } finally {
      await first.stop().catch(() => undefined);
    }
    const second = await realDatabaseRestoreDeps.startPostgres(dataDir, first.port);
    try {
      const db = createDb(`postgres://paperclip:paperclip@127.0.0.1:${second.port}/paperclip`);
      const names = (await db.select({ name: companies.name }).from(companies)).map((row) => row.name);
      await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
      expect(names).toEqual(["Avant"]);
    } finally {
      await second.stop();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS * 2);
});
