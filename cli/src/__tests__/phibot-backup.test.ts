import { describe, expect, it } from "vitest";
import {
  backupTimestamp,
  buildFullBackupTarArgs,
  fullBackupEntries,
  pruneFullBackups,
  runFullBackup,
} from "../phibot/backup.js";
import { FakeSystem, MemoryLogger } from "./helpers/phibot-fake-system.js";

const INSTANCE = "/var/lib/phibot/.paperclip/instances/default";
const BACKUPS = `${INSTANCE}/data/backups`;
const COMPANY = "de2d48f1-0b2b-4eab-bc37-b60741cff92f";
const CONTEXT = { version: "1.0.0", companyId: COMPANY, access: "domain", publicUrl: "https://bot.exemple.fr" };

function instanceHost(): FakeSystem {
  return new FakeSystem()
    .addFile(`${INSTANCE}/config.json`, "{}")
    .addFile(`${INSTANCE}/.env`, "")
    .addFile(`${INSTANCE}/adapters.json`, "[]")
    .addFile(`${INSTANCE}/secrets/master.key`, "k")
    .addDir(`${INSTANCE}/data/storage`)
    .addDir(`${INSTANCE}/workspaces`)
    .addDir("/var/lib/phibot/.phi/memory")
    .addDir(`/var/lib/phibot/.phi/phibot/companies/${COMPANY}/agent`)
    .addDir(`/var/lib/phibot/.phi/phibot/companies/${COMPANY}/sessions`);
}

describe("full backup content (spec 13.2)", () => {
  it("formats the timestamp in UTC", () => {
    expect(backupTimestamp(new Date("2026-10-08T12:34:56.789Z"))).toBe("20261008-123456");
  });

  it("lists the existing paths relative to /", () => {
    expect(fullBackupEntries(instanceHost())).toEqual([
      "var/lib/phibot/.paperclip/instances/default/config.json",
      "var/lib/phibot/.paperclip/instances/default/.env",
      "var/lib/phibot/.paperclip/instances/default/adapters.json",
      "var/lib/phibot/.paperclip/instances/default/secrets",
      "var/lib/phibot/.paperclip/instances/default/data/storage",
      "var/lib/phibot/.paperclip/instances/default/workspaces",
      "var/lib/phibot/.phi/memory",
      `var/lib/phibot/.phi/phibot/companies/${COMPANY}/agent`,
      `var/lib/phibot/.phi/phibot/companies/${COMPANY}/sessions`,
    ]);
  });

  it("builds the tar command without the model caches", () => {
    expect(buildFullBackupTarArgs({ archivePath: "/b/full.tar.gz", stagingDir: "/b/.s", entries: ["var/lib/phibot/.phi/memory"] })).toEqual([
      "-czf", "/b/full.tar.gz", "--exclude=var/lib/phibot/.phi/phibot/companies/*/agent/cache", "-C", "/b/.s", "phibot-backup.json", "db", "-C", "/", "var/lib/phibot/.phi/memory",
    ]);
  });

  it("keeps the 3 newest full-* and pre-update-* archives (review m13)", () => {
    const sys = new FakeSystem();
    for (let day = 1; day <= 5; day += 1) sys.addFile(`${BACKUPS}/full-2026100${day}-000000.tar.gz`, "", 0o600, day * 1000);
    for (let day = 1; day <= 4; day += 1) sys.addFile(`${BACKUPS}/pre-update-1.0.${day}-1.0.${day + 1}-2026100${day}-000000.tar.gz`, "", 0o600, day * 1000);
    sys.addFile(`${BACKUPS}/paperclip-20261001-000000.sql.gz`, "", 0o600, 1);
    expect(pruneFullBackups(sys)).toEqual([
      `${BACKUPS}/full-20261002-000000.tar.gz`,
      `${BACKUPS}/full-20261001-000000.tar.gz`,
      `${BACKUPS}/pre-update-1.0.1-1.0.2-20261001-000000.tar.gz`,
    ]);
    expect(sys.exists(`${BACKUPS}/paperclip-20261001-000000.sql.gz`)).toBe(true);
  });
});

describe("runFullBackup", () => {
  it("dumps the database, writes the manifest, archives with tar and protects the archive", async () => {
    const sys = instanceHost();
    const staging = `${BACKUPS}/.full-staging-20261008-120000`;
    let manifest = "";
    sys.onExec("tar", () => {
      manifest = sys.readFile(`${staging}/phibot-backup.json`);
      return { code: 0, stdout: "", stderr: "" };
    });
    const dumps: string[] = [];
    const archive = await runFullBackup(sys, new MemoryLogger(), {
      context: CONTEXT,
      dump: async (dir) => {
        dumps.push(dir);
        return `${dir}/paperclip-20261008-120000.sql.gz`;
      },
    });
    expect(archive).toBe(`${BACKUPS}/full-20261008-120000.tar.gz`);
    expect(JSON.parse(manifest)).toEqual({
      format: 1,
      createdAt: "2026-10-08T12:00:00.000Z",
      version: "1.0.0",
      companyId: COMPANY,
      access: "domain",
      publicUrl: "https://bot.exemple.fr",
      dump: "db/paperclip-20261008-120000.sql.gz",
      entries: fullBackupEntries(instanceHost()),
    });
    expect(dumps).toEqual([`${staging}/db`]);
    const tar = sys.calls.find((call) => call.command === "tar");
    expect(tar?.args.slice(0, 8)).toEqual(["-czf", archive, "--exclude=var/lib/phibot/.phi/phibot/companies/*/agent/cache", "-C", staging, "phibot-backup.json", "db", "-C"]);
    expect(sys.lines()).toContain(`chmod 600 ${archive}`);
    expect(sys.exists(staging)).toBe(false);
  });

  it("writes to --output when given", async () => {
    const sys = instanceHost();
    const archive = await runFullBackup(sys, new MemoryLogger(), {
      context: CONTEXT,
      output: `${BACKUPS}/pre-update-1.0.0-1.0.1-20261008-120000.tar.gz`,
      dump: async (dir) => `${dir}/paperclip-x.sql.gz`,
    });
    expect(archive).toBe(`${BACKUPS}/pre-update-1.0.0-1.0.1-20261008-120000.tar.gz`);
    const written = sys.calls.find((call) => call.command === "tar");
    expect(written?.args[1]).toBe(archive);
  });
});
