import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ALIAS_MODULE_SUBPATH, LIB_SUBPATHS, missingAliases } from "./ensure-postgres-aliases.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "ensure-postgres-aliases.mjs");
const realSource = path.join(here, "..", "..", "packages", "db", "src", "embedded-postgres-native.ts");

/** Fake installed package: the real alias function of @paperclipai/db, fake library files. */
function makePackage(libSubpaths) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phibot-aliases-"));
  const moduleFile = path.join(root, ALIAS_MODULE_SUBPATH);
  fs.mkdirSync(path.dirname(moduleFile), { recursive: true });
  fs.writeFileSync(moduleFile, stripTypeScriptTypes(fs.readFileSync(realSource, "utf8")));
  for (const sub of libSubpaths) {
    const libDir = path.join(root, sub);
    fs.mkdirSync(libDir, { recursive: true });
    for (const name of ["libssl.so.1.1", "libicuuc.so.60.2", "libpq.so.5", "README"]) fs.writeFileSync(path.join(libDir, name), "");
  }
  return root;
}

function run(packageDir) {
  return spawnSync(process.execPath, [script, packageDir], { encoding: "utf8" });
}

test("creates the aliases of the main library folder, then does nothing more", () => {
  const root = makePackage([LIB_SUBPATHS[0]]);
  const libDir = path.join(root, LIB_SUBPATHS[0]);
  const first = run(root);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, `postgres-aliases-ok ${libDir} (2 alias créés)\n`);
  assert.equal(fs.readlinkSync(path.join(libDir, "libssl.so.1")), "libssl.so.1.1");
  assert.equal(fs.readlinkSync(path.join(libDir, "libicuuc.so.60")), "libicuuc.so.60.2");
  assert.deepEqual(missingAliases(libDir), []);
  const second = run(root);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, `postgres-aliases-ok ${libDir} (0 alias créés)\n`);
  fs.rmSync(root, { recursive: true, force: true });
});

test("also handles the folder nested under @paperclipai/db when it exists", () => {
  const root = makePackage(LIB_SUBPATHS);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split("\n").filter((line) => line.startsWith("postgres-aliases-ok ")).length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("fails with a clear message when the main library folder is missing", () => {
  const root = makePackage([]);
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^ensure-postgres-aliases : dossier introuvable : /);
  fs.rmSync(root, { recursive: true, force: true });
});

test("fails with the usage line without argument", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^usage : node ensure-postgres-aliases\.mjs /);
});
