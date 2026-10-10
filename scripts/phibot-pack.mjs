#!/usr/bin/env node
// Builds the single npm package @phi-code-admin/phi-bot (PHIBOT-SOLO-SPEC.md section 5)
// from a built workspace: closure of the internal packages, flattening (rules R1 to R4 of
// scripts/phibot-pack-lib.mjs), published manifest, npm-shrinkwrap.json, archive and
// archive check. Run it last, after scripts/build-npm.sh (spec 10.2).
//
// Usage:
//   node scripts/phibot-pack.mjs --version <semver> --out <dir> [--phi-version <v>]
//       writes <dir>/staging, <dir>/work and <dir>/phi-code-admin-phi-bot-<v>.tgz
//   node scripts/phibot-pack.mjs --check-archive <tgz> --version <semver> [--phi-version <v>]
//   node scripts/phibot-pack.mjs --verify-install <installed package folder>
//       checks that an installation follows the package's npm-shrinkwrap.json
//   node scripts/phibot-pack.mjs --audit-signatures <tgz>
//       npm audit signatures on every registry package of the archive's npm-shrinkwrap.json
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PHI_VERSION,
  INTERNAL_SCOPE,
  PACKAGE_NAME,
  REQUIRED_ALLOW_SCRIPTS,
  TARGET_PLATFORM,
  buildRootManifest,
  checkArchive,
  compareInstalledTree,
  computeClosure,
  flattenInternalManifest,
  installScriptPackages,
  isPackageRootManifest,
  isSemver,
  mergeRange,
  parseAllowScriptsConstant,
  pruneBundledManifest,
  registryProjectFromShrinkwrap,
  setInternalVersion,
  shrinkwrapFromConsumerLock,
  tarballName,
} from "./phibot-pack-lib.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_ROOTS = ["packages", "server", "ui", "cli"];
const USAGE = [
  "usage: node scripts/phibot-pack.mjs --version <semver> --out <dir> [--phi-version <v>]",
  "       node scripts/phibot-pack.mjs --check-archive <tgz> --version <semver> [--phi-version <v>]",
  "       node scripts/phibot-pack.mjs --verify-install <installed package folder>",
  "       node scripts/phibot-pack.mjs --audit-signatures <tgz>",
].join("\n");

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--version", "--out", "--phi-version", "--check-archive", "--verify-install", "--audit-signatures"].includes(key)) return null;
    if (!value || value.startsWith("--")) return null;
    options[key.slice(2)] = value;
    index += 1;
  }
  options["phi-version"] ??= DEFAULT_PHI_VERSION;
  if (options["verify-install"]) return Object.keys(options).length === 2 ? { mode: "verify-install", ...options } : null;
  if (options["audit-signatures"]) return Object.keys(options).length === 2 ? { mode: "audit-signatures", ...options } : null;
  if (!options.version || !isSemver(options.version) || !isSemver(options["phi-version"])) return null;
  if (options["check-archive"]) return options.out ? null : { mode: "check-archive", ...options };
  return options.out ? { mode: "build", ...options } : null;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Runs a command; npm and pnpm are .cmd files on Windows, hence the shell there only. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === "win32" && ["npm", "pnpm"].includes(command),
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout}${result.stderr}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status}${detail}`);
  }
  return result.stdout ?? "";
}

function rel(from, to) {
  return path.relative(from, to).split(path.sep).join("/");
}

function discoverWorkspace() {
  const byName = new Map();
  const walk = (relDir) => {
    const dir = path.join(REPO_ROOT, relDir);
    if (!existsSync(dir)) return;
    const manifestPath = path.join(dir, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = readJson(manifestPath);
      byName.set(manifest.name, { dir, manifest });
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !["node_modules", "dist", ".git"].includes(entry.name)) walk(path.join(relDir, entry.name));
    }
  };
  for (const root of WORKSPACE_ROOTS) walk(root);
  return byName;
}

function singleTarball(dir) {
  const found = readdirSync(dir).filter((name) => name.endsWith(".tgz"));
  if (found.length !== 1) throw new Error(`expected one archive in ${dir}, found ${found.length}`);
  return path.join(dir, found[0]);
}

/** R1: pack like upstream (cli/src/commands/install.ts, installGitPayload), then extract. */
function packInternal(entry, work, staging) {
  const slug = entry.manifest.name.replace("@", "").replace("/", "-");
  const packDir = path.join(work, "tgz", slug);
  mkdirSync(packDir, { recursive: true });
  const bundled = entry.manifest.bundleDependencies ?? entry.manifest.bundledDependencies ?? [];
  if (bundled.length > 0) {
    const prepared = path.join(work, "bundled", slug);
    run(process.execPath, [path.join(REPO_ROOT, "scripts", "prepare-bundled-package.mjs"), entry.dir, prepared]);
    run("npm", ["pack", prepared, "--ignore-scripts", "--pack-destination", packDir], { capture: true });
  } else {
    run("pnpm", ["--dir", entry.dir, "pack", "--pack-destination", packDir], {
      capture: true,
      env: { PAPERCLIP_RELEASE_REUSE_UI_DIST: "1" },
    });
  }
  const target = path.join(staging, "node_modules", ...entry.manifest.name.split("/"));
  mkdirSync(target, { recursive: true });
  run("tar", ["-xzf", rel(work, singleTarball(packDir)), "--strip-components=1", "-C", rel(work, target)], { cwd: work });
  return target;
}

function listPackageManifests(dir, base, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listPackageManifests(full, base, found);
    else if (entry.name === "package.json" && isPackageRootManifest(rel(base, full))) found.push(full);
  }
  return found;
}

/** Does `name` resolve from `packageDir` by walking up node_modules folders, without leaving staging? */
function resolvesInBundle(packageDir, name, staging) {
  let dir = packageDir;
  for (;;) {
    if (existsSync(path.join(dir, "node_modules", ...name.split("/"), "package.json"))) return true;
    if (path.resolve(dir) === path.resolve(staging)) return false;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** R3 over every third-party manifest bundled inside the internal packages. */
function pruneBundles(staging, internalDirs) {
  const moved = {};
  const report = [];
  for (const internalDir of internalDirs) {
    const nested = path.join(internalDir, "node_modules");
    if (!existsSync(nested)) continue;
    for (const manifestPath of listPackageManifests(nested, staging)) {
      const manifest = readJson(manifestPath);
      const where = rel(staging, path.dirname(manifestPath));
      const result = pruneBundledManifest(manifest, (name) => resolvesInBundle(path.dirname(manifestPath), name, staging), where);
      if (result.removed.length === 0) continue;
      writeJson(manifestPath, result.manifest);
      for (const [name, spec] of Object.entries(result.movedOptional)) moved[name] = mergeRange(name, moved[name], spec);
      report.push(`${where}: ${result.removed.join(", ")}`);
    }
  }
  return { moved, report };
}

/**
 * npm-shrinkwrap.json (spec 5.5), computed as npm sees the archive when it installs it: a throwaway
 * project depends on a first archive (same content, no shrinkwrap yet), npm resolves it for
 * linux-x64 with the layout of `npm install -g` (shallow), and the package's subtree is kept.
 */
function writeShrinkwrap(staging, work, outDir, version, internalNames) {
  const firstDir = path.join(work, "first-pass");
  mkdirSync(firstDir, { recursive: true });
  run("npm", ["pack", staging, "--ignore-scripts", "--pack-destination", firstDir], { capture: true });
  const consumer = path.join(work, "consumer");
  rmSync(consumer, { recursive: true, force: true });
  mkdirSync(consumer, { recursive: true });
  const firstTarball = path.join(firstDir, tarballName(version));
  writeJson(path.join(consumer, "package.json"), {
    name: "phibot-shrinkwrap-consumer",
    private: true,
    dependencies: { [PACKAGE_NAME]: `file:${rel(consumer, firstTarball)}` },
  });
  run("npm", [
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--install-strategy=shallow",
    `--os=${TARGET_PLATFORM.os}`,
    `--cpu=${TARGET_PLATFORM.cpu}`,
    `--libc=${TARGET_PLATFORM.libc}`,
    // os/cpu of the package refuse any other host; only a build outside Linux needs this.
    ...(process.platform === TARGET_PLATFORM.os ? [] : ["--force"]),
  ], { cwd: consumer, capture: true });
  const lock = readJson(path.join(consumer, "package-lock.json"));
  if (lock.lockfileVersion !== 3) throw new Error(`unexpected lockfileVersion ${lock.lockfileVersion}`);
  const { shrinkwrap, problems } = shrinkwrapFromConsumerLock(lock, internalNames);
  writeJson(path.join(staging, "npm-shrinkwrap.json"), shrinkwrap);
  return { shrinkwrap, problems };
}

function readArchiveFile(tgz, member) {
  const dir = path.dirname(tgz);
  return run("tar", ["-xzOf", path.basename(tgz), member], { cwd: dir, capture: true });
}

export function checkArchiveFile(tgz, version, phiVersion) {
  const dir = path.dirname(path.resolve(tgz));
  const entries = run("tar", ["-tzf", path.basename(tgz)], { cwd: dir, capture: true }).split("\n").filter(Boolean);
  const manifest = JSON.parse(readArchiveFile(path.resolve(tgz), "package/package.json"));
  const internalNames = (manifest.bundleDependencies ?? []).filter((name) => name.startsWith(INTERNAL_SCOPE));
  const uiIndexHtml = readArchiveFile(path.resolve(tgz), "package/node_modules/@paperclipai/server/ui-dist/index.html");
  const problems = checkArchive({ entries, manifest, version, phiVersion, internalNames, uiIndexHtml });
  return { problems, entries: entries.length, internalNames };
}

function checkAllowScripts(lock) {
  const computed = installScriptPackages(lock);
  const declared = parseAllowScriptsConstant(readFileSync(path.join(REPO_ROOT, "cli/src/phibot/constants.ts"), "utf8"));
  const problems = [];
  for (const name of REQUIRED_ALLOW_SCRIPTS) if (!computed.includes(name)) problems.push(`required install script missing from the tree: ${name}`);
  if (JSON.stringify(computed) !== JSON.stringify([...declared].sort())) {
    problems.push(`PHIBOT_NPM_ALLOW_SCRIPTS (${declared.join(",")}) differs from the packages with install scripts (${computed.join(",")})`);
  }
  return { computed, problems };
}

function build({ version, out, "phi-version": phiVersion }) {
  const outDir = path.resolve(out);
  const staging = path.join(outDir, "staging");
  const work = path.join(outDir, "work");
  rmSync(staging, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  rmSync(path.join(outDir, tarballName(version)), { force: true });
  mkdirSync(path.join(staging, "node_modules"), { recursive: true });
  mkdirSync(work, { recursive: true });

  const devManifestPath = path.join(REPO_ROOT, "cli", "package.dev.json");
  if (!existsSync(devManifestPath)) throw new Error("cli/package.dev.json missing: run scripts/build-npm.sh first");
  const cliDev = readJson(devManifestPath);
  const cliPublished = readJson(path.join(REPO_ROOT, "cli", "package.json"));
  const workspace = discoverWorkspace();
  const manifests = new Map([...workspace].map(([name, entry]) => [name, entry.manifest]));
  const internalNames = computeClosure(cliDev, manifests);
  console.log(`closure: ${internalNames.length} internal packages`);

  let hoisted = {};
  let hoistedOptional = {};
  const droppedPeers = {};
  const internalDirs = [];
  for (const name of internalNames) {
    const target = packInternal(workspace.get(name), work, staging);
    const manifestPath = path.join(target, "package.json");
    const versioned = setInternalVersion(readJson(manifestPath), version);
    const scripts = Object.keys(versioned.scripts ?? {}).filter((key) => ["preinstall", "install", "postinstall"].includes(key));
    if (scripts.length > 0) throw new Error(`${name} has install scripts (${scripts.join(", ")}): not supported in a bundled package`);
    const flat = flattenInternalManifest(versioned);
    writeJson(manifestPath, flat.manifest);
    for (const [dep, spec] of Object.entries(flat.hoisted)) hoisted[dep] = mergeRange(dep, hoisted[dep], spec);
    for (const [dep, spec] of Object.entries(flat.hoistedOptional)) hoistedOptional[dep] = mergeRange(dep, hoistedOptional[dep], spec);
    for (const [dep, peer] of Object.entries(flat.droppedPeers)) droppedPeers[dep] = { ...peer, from: name };
    internalDirs.push(target);
    const peers = Object.keys(flat.droppedPeers);
    console.log(`  ${name}: ${Object.keys(flat.hoisted).length} dependencies and ${Object.keys(flat.hoistedOptional).length} optional dependencies hoisted${peers.length > 0 ? `, peers removed: ${peers.join(", ")}` : ""}`);
  }
  const pruned = pruneBundles(staging, internalDirs);
  for (const line of pruned.report) console.log(`  R3 ${line}`);
  for (const [dep, spec] of Object.entries(pruned.moved)) hoistedOptional[dep] = mergeRange(dep, hoistedOptional[dep], spec);

  cpSync(path.join(REPO_ROOT, "cli", "dist"), path.join(staging, "dist"), { recursive: true });
  for (const [from, to] of [["cli/README.md", "README.md"], ["LICENSE", "LICENSE"]]) {
    if (existsSync(path.join(REPO_ROOT, from))) cpSync(path.join(REPO_ROOT, from), path.join(staging, to));
  }
  const manifest = buildRootManifest({ cliManifest: cliPublished, version, phiVersion, internalNames, hoisted, hoistedOptional });
  for (const [dep, peer] of Object.entries(droppedPeers)) {
    if (!peer.optional && manifest.dependencies[dep] === undefined) throw new Error(`required peer ${dep} of ${peer.from} is not a dependency of the package`);
  }
  writeJson(path.join(staging, "package.json"), manifest);
  console.log(`manifest: ${Object.keys(manifest.dependencies).length} dependencies, ${Object.keys(manifest.optionalDependencies ?? {}).length} optional dependencies, ${manifest.bundleDependencies.length} bundled`);

  const sw = writeShrinkwrap(staging, work, outDir, version, internalNames);
  const shrinkwrap = sw.shrinkwrap;
  const bundled = Object.values(shrinkwrap.packages).filter((entry) => entry.inBundle).length;
  console.log(`npm-shrinkwrap.json: ${Object.keys(shrinkwrap.packages).length - 1} entries, ${bundled} inside the archive`);
  const allow = checkAllowScripts(shrinkwrap);
  console.log(`allow-scripts: ${allow.computed.join(",")}`);

  run("npm", ["pack", staging, "--ignore-scripts", "--pack-destination", outDir], { capture: true });
  const tgz = path.join(outDir, tarballName(version));
  const checked = checkArchiveFile(tgz, version, phiVersion);
  const problems = [...sw.problems, ...allow.problems, ...checked.problems];
  console.log(`archive: ${tgz} (${(statSync(tgz).size / 1024 / 1024).toFixed(1)} MiB, ${checked.entries} entries)`);
  return problems;
}

/** Package folders without package.json under node_modules: the npm defect of research R1 section 1.2. */
function emptyPackageFolders(modulesDir, found = []) {
  if (!existsSync(modulesDir)) return found;
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dirs = entry.name.startsWith("@")
      ? readdirSync(path.join(modulesDir, entry.name), { withFileTypes: true }).filter((child) => child.isDirectory()).map((child) => path.join(modulesDir, entry.name, child.name))
      : [path.join(modulesDir, entry.name)];
    for (const dir of dirs) {
      if (!existsSync(path.join(dir, "package.json"))) found.push(dir);
      emptyPackageFolders(path.join(dir, "node_modules"), found);
    }
  }
  return found;
}

function verifyInstall(packageDir) {
  const dir = path.resolve(packageDir);
  const shrinkwrap = readJson(path.join(dir, "npm-shrinkwrap.json"));
  const readVersion = (key) => {
    const file = path.join(dir, ...key.split("/"), "package.json");
    return existsSync(file) ? readJson(file).version ?? null : null;
  };
  const topLevel = [];
  const modules = path.join(dir, "node_modules");
  for (const entry of existsSync(modules) ? readdirSync(modules) : []) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) for (const child of readdirSync(path.join(modules, entry))) topLevel.push(`${entry}/${child}`);
    else topLevel.push(entry);
  }
  const result = compareInstalledTree(shrinkwrap, readVersion, topLevel);
  console.log(`shrinkwrap entries checked: ${result.checked}`);
  const empty = emptyPackageFolders(modules).map((folder) => `package folder without package.json: ${rel(dir, folder)}`);
  return [...result.problems, ...empty];
}

function auditSignatures(tgz) {
  const shrinkwrap = JSON.parse(readArchiveFile(path.resolve(tgz), "package/npm-shrinkwrap.json"));
  const { manifest, lock } = registryProjectFromShrinkwrap(shrinkwrap);
  const dir = mkdtempSync(path.join(os.tmpdir(), "phibot-signatures-"));
  try {
    writeJson(path.join(dir, "package.json"), manifest);
    writeJson(path.join(dir, "package-lock.json"), lock);
    // Same reason as in writeShrinkwrap: only a host other than Linux needs it.
    const force = process.platform === TARGET_PLATFORM.os ? [] : ["--force"];
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", ...force], { cwd: dir, capture: true });
    console.log(run("npm", ["audit", "signatures"], { cwd: dir, capture: true }).trim());
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function main(argv) {
  const args = parseArgs(argv);
  if (!args) {
    console.error(USAGE);
    return 2;
  }
  let problems;
  try {
    if (args.mode === "build") problems = build(args);
    else if (args.mode === "check-archive") problems = checkArchiveFile(args["check-archive"], args.version, args["phi-version"]).problems;
    else if (args.mode === "audit-signatures") problems = auditSignatures(args["audit-signatures"]);
    else problems = verifyInstall(args["verify-install"]);
  } catch (error) {
    console.error(`phibot-pack: error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  for (const problem of problems) console.error(`problem: ${problem}`);
  console.log(problems.length === 0 ? "phibot-pack: OK" : `phibot-pack: ${problems.length} problem(s)`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
