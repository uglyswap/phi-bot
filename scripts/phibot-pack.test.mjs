import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkArchiveFile, parseArgs } from "./phibot-pack.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "phibot-pack.mjs");
const INTERNAL = ["@paperclipai/adapter-phi-local", "@paperclipai/db", "@paperclipai/server"];

function writeFiles(root, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const file = path.join(root, ...relPath.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

/** A minimal archive with the layout of the real one, built with tar like npm pack. */
function fakeArchive(dir, { title = "Phi Bot", extra = {} } = {}) {
  const manifest = {
    name: "@phi-code-admin/phi-bot",
    version: "1.0.0",
    bin: { phibot: "./dist/index.js" },
    os: ["linux"],
    cpu: ["x64"],
    engines: { node: ">=24.11.0" },
    repository: { type: "git", url: "https://github.com/uglyswap/phi-bot", directory: "cli" },
    dependencies: Object.fromEntries([...INTERNAL.map((name) => [name, "1.0.0"]), ["@phi-code-admin/phi-code", "0.100.0"]]),
    bundleDependencies: INTERNAL,
  };
  writeFiles(path.join(dir, "src"), {
    "package/package.json": manifest,
    "package/npm-shrinkwrap.json": { lockfileVersion: 3, packages: {} },
    "package/dist/index.js": "#!/usr/bin/env node\n",
    "package/node_modules/@paperclipai/server/package.json": { name: "@paperclipai/server", version: "1.0.0" },
    "package/node_modules/@paperclipai/server/ui-dist/index.html": `<title>${title}</title>\n`,
    "package/node_modules/@paperclipai/db/package.json": { name: "@paperclipai/db", version: "1.0.0" },
    "package/node_modules/@paperclipai/db/dist/embedded-postgres-native.js": "export {};\n",
    "package/node_modules/@paperclipai/adapter-phi-local/package.json": { name: "@paperclipai/adapter-phi-local", version: "1.0.0" },
    ...extra,
  });
  const result = spawnSync("tar", ["-czf", "../a.tgz", "package"], { cwd: path.join(dir, "src"), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return path.join(dir, "a.tgz");
}

test("parseArgs accepts the three modes and refuses anything else", () => {
  assert.deepEqual(parseArgs(["--version", "1.0.0", "--out", "out"]), { mode: "build", version: "1.0.0", out: "out", "phi-version": "0.100.0" });
  assert.deepEqual(parseArgs(["--version", "1.0.0", "--out", "out", "--phi-version", "0.99.5"]), { mode: "build", version: "1.0.0", out: "out", "phi-version": "0.99.5" });
  assert.deepEqual(parseArgs(["--check-archive", "a.tgz", "--version", "1.0.0"]), { mode: "check-archive", "check-archive": "a.tgz", version: "1.0.0", "phi-version": "0.100.0" });
  assert.deepEqual(parseArgs(["--verify-install", "dir"]), { mode: "verify-install", "verify-install": "dir", "phi-version": "0.100.0" });
  assert.equal(parseArgs([]), null);
  assert.equal(parseArgs(["--version", "1.0", "--out", "out"]), null);
  assert.equal(parseArgs(["--version", "1.0.0"]), null);
  assert.equal(parseArgs(["--version", "1.0.0", "--out"]), null);
  assert.equal(parseArgs(["--check-archive", "a.tgz", "--version", "1.0.0", "--out", "x"]), null);
  assert.equal(parseArgs(["--verify-install", "dir", "--version", "1.0.0"]), null);
  assert.deepEqual(parseArgs(["--audit-signatures", "a.tgz"]), { mode: "audit-signatures", "audit-signatures": "a.tgz", "phi-version": "0.100.0" });
  assert.equal(parseArgs(["--audit-signatures", "a.tgz", "--out", "x"]), null);
  assert.equal(parseArgs(["--unknown", "x"]), null);
});

test("wrong arguments print the usage and exit with code 2", () => {
  const result = runCli(["--version", "one"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^usage: node scripts\/phibot-pack.mjs --version <semver> --out <dir>/);
});

test("--check-archive accepts a correct archive", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "phibot-pack-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tgz = fakeArchive(dir);
  assert.deepEqual(checkArchiveFile(tgz, "1.0.0", "0.100.0").problems, []);
  const result = runCli(["--check-archive", tgz, "--version", "1.0.0"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /phibot-pack: OK/);
});

test("--check-archive reports a third-party folder and a UI that is not rebranded", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "phibot-pack-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tgz = fakeArchive(dir, { title: "Paperclip", extra: { "package/node_modules/is-number/package.json": { name: "is-number" } } });
  const result = runCli(["--check-archive", tgz, "--version", "1.0.0"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /problem: third-party folder at the top of the bundle: node_modules\/is-number/);
  assert.match(result.stderr, /problem: ui-dist\/index.html is not rebranded/);
  assert.match(result.stdout, /phibot-pack: 2 problem\(s\)/);
});

test("--verify-install compares an installed tree with its shrinkwrap", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "phibot-pack-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFiles(dir, {
    "npm-shrinkwrap.json": {
      lockfileVersion: 3,
      packages: { "": {}, "node_modules/ms": { version: "2.1.2" }, "node_modules/@paperclipai/db": { version: "1.0.0", inBundle: true } },
    },
    "node_modules/ms/package.json": { name: "ms", version: "2.1.2" },
    "node_modules/@paperclipai/db/package.json": { name: "@paperclipai/db", version: "1.0.0" },
  });
  const good = runCli(["--verify-install", dir]);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /shrinkwrap entries checked: 1\n/);
  writeFiles(dir, { "node_modules/ms/package.json": { name: "ms", version: "2.1.3" } });
  const bad = runCli(["--verify-install", dir]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /problem: node_modules\/ms: installed 2.1.3, shrinkwrap 2.1.2/);
});
