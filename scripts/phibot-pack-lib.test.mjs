import assert from "node:assert/strict";
import test from "node:test";

import {
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
  satisfies,
  setInternalVersion,
  shrinkwrapFromConsumerLock,
  tarballName,
} from "./phibot-pack-lib.mjs";

const CLI = {
  name: "@phi-code-admin/phi-bot",
  version: "0.3.1",
  description: "Phi Bot",
  keywords: ["ai"],
  repository: { type: "git", url: "https://github.com/uglyswap/phi-bot", directory: "cli" },
  homepage: "https://github.com/uglyswap/phi-bot",
  bugs: { url: "https://github.com/uglyswap/phi-bot/issues" },
  dependencies: { "@paperclipai/server": "0.3.1", commander: "^15.0.0", "drizzle-orm": "0.45.2" },
  optionalDependencies: { "@embedded-postgres/linux-x64": "18.1.0-beta.16" },
};

test("versions: SemVer accepted, other forms refused, archive name", () => {
  assert.equal(isSemver("1.0.0"), true);
  assert.equal(isSemver("1.1.0-rc.1"), true);
  assert.equal(isSemver("2026.1005.0"), true);
  assert.equal(isSemver("1.0"), false);
  assert.equal(isSemver("v1.0.0"), false);
  assert.equal(tarballName("1.0.0"), "phi-code-admin-phi-bot-1.0.0.tgz");
});

test("satisfies: exact, caret, tilde and lower bound", () => {
  assert.equal(satisfies("0.45.2", "^0.45.2"), true);
  assert.equal(satisfies("0.46.0", "^0.45.2"), false);
  assert.equal(satisfies("1.9.0", "^1.2.0"), true);
  assert.equal(satisfies("1.3.1", "~1.3.0"), true);
  assert.equal(satisfies("1.4.0", "~1.3.0"), false);
  assert.equal(satisfies("3.0.0", ">=2.0.0"), true);
  assert.equal(satisfies("1.0.0-beta.1", "^1.0.0"), false);
});

test("mergeRange keeps the most restrictive specifier and refuses conflicts", () => {
  assert.equal(mergeRange("drizzle-orm", "0.45.2", "^0.45.2"), "0.45.2");
  assert.equal(mergeRange("drizzle-orm", "^0.45.2", "0.45.2"), "0.45.2");
  assert.equal(mergeRange("x", "^1.2.0", "^1.3.0"), "^1.3.0");
  assert.equal(mergeRange("x", ">=1.0.0", "^1.2.0"), "^1.2.0");
  assert.equal(mergeRange("x", undefined, "^1.0.0"), "^1.0.0");
  assert.throws(() => mergeRange("x", "1.0.0", "2.0.0"), /conflicting exact versions of x/);
  assert.throws(() => mergeRange("x", "2.0.0", "^1.0.0"), /does not satisfy/);
  assert.throws(() => mergeRange("x", "~1.2.0", "^1.3.0"), /conflicting ranges of x/);
  assert.throws(() => mergeRange("x", "1.x", "^1.0.0"), /unsupported specifiers/);
});

test("computeClosure follows internal dependencies, before and after set-version, peers included", () => {
  const workspace = new Map([
    ["@paperclipai/server", { name: "@paperclipai/server", dependencies: { "@paperclipai/db": "1.0.0", express: "^5.0.0" } }],
    ["@paperclipai/db", { name: "@paperclipai/db", peerDependencies: { "@paperclipai/shared": "workspace:*" } }],
    ["@paperclipai/shared", { name: "@paperclipai/shared" }],
    ["@paperclipai/unused", { name: "@paperclipai/unused" }],
  ]);
  const root = { dependencies: { "@paperclipai/server": "workspace:*", commander: "^15.0.0" } };
  assert.deepEqual(computeClosure(root, workspace), ["@paperclipai/db", "@paperclipai/server", "@paperclipai/shared"]);
  assert.throws(() => computeClosure({ dependencies: { "@paperclipai/missing": "workspace:*" } }, workspace), /workspace package not found/);
});

test("setInternalVersion pins internal dependencies and drops devDependencies", () => {
  const manifest = setInternalVersion(
    { name: "@paperclipai/server", version: "0.3.1", dependencies: { "@paperclipai/db": "0.3.1", express: "^5.0.0" }, devDependencies: { vitest: "5" } },
    "1.0.0",
  );
  assert.deepEqual(manifest, { name: "@paperclipai/server", version: "1.0.0", dependencies: { "@paperclipai/db": "1.0.0", express: "^5.0.0" } });
});

test("flattenInternalManifest (R2) keeps internal and bundled dependencies and internal peers only", () => {
  const result = flattenInternalManifest({
    name: "@paperclipai/db",
    dependencies: { "@paperclipai/shared": "1.0.0", "embedded-postgres": "^18.1.0-beta.16", postgres: "^3.4.5" },
    optionalDependencies: { "@embedded-postgres/linux-x64": "18.1.0-beta.16" },
    peerDependencies: { "@paperclipai/plugin-sdk": "1.0.0", "@phi-code-admin/phi-code": ">=0.99.3", react: "^19.0.0" },
    peerDependenciesMeta: { "@phi-code-admin/phi-code": { optional: true } },
    bundleDependencies: ["embedded-postgres"],
  });
  assert.deepEqual(result.manifest.dependencies, { "@paperclipai/shared": "1.0.0", "embedded-postgres": "^18.1.0-beta.16" });
  assert.equal(result.manifest.optionalDependencies, undefined);
  assert.deepEqual(result.manifest.peerDependencies, { "@paperclipai/plugin-sdk": "1.0.0" });
  assert.equal(result.manifest.peerDependenciesMeta, undefined);
  assert.deepEqual(result.hoisted, { postgres: "^3.4.5" });
  assert.deepEqual(result.hoistedOptional, { "@embedded-postgres/linux-x64": "18.1.0-beta.16" });
  assert.deepEqual(result.droppedPeers, {
    "@phi-code-admin/phi-code": { spec: ">=0.99.3", optional: true },
    react: { spec: "^19.0.0", optional: false },
  });
  const leaf = flattenInternalManifest({ name: "@paperclipai/shared", dependencies: { zod: "^4.0.0" } });
  assert.equal(leaf.manifest.dependencies, undefined);
});

test("isPackageRootManifest recognises package roots only", () => {
  assert.equal(isPackageRootManifest("node_modules/@paperclipai/server/node_modules/esbuild/package.json"), true);
  assert.equal(isPackageRootManifest("node_modules/@paperclipai/server/node_modules/@chat-adapter/slack/package.json"), true);
  assert.equal(isPackageRootManifest("node_modules/@paperclipai/server/node_modules/esbuild/lib/package.json"), false);
  assert.equal(isPackageRootManifest("node_modules/@paperclipai/server/node_modules/x/dist/esm/package.json"), false);
  assert.equal(isPackageRootManifest("node_modules/@paperclipai/server/node_modules/.bin/package.json"), false);
});

test("pruneBundledManifest (R3) moves missing optional dependencies and refuses missing required ones", () => {
  const present = new Set(["@esbuild/linux-x64"]);
  const result = pruneBundledManifest(
    {
      name: "esbuild",
      optionalDependencies: { "@esbuild/linux-x64": "0.28.2", "@esbuild/darwin-arm64": "0.28.2" },
      peerDependencies: { zod: "^4.0.0" },
      peerDependenciesMeta: { zod: { optional: true } },
    },
    (name) => present.has(name),
    "node_modules/@paperclipai/server/node_modules/esbuild",
  );
  assert.deepEqual(result.manifest.optionalDependencies, { "@esbuild/linux-x64": "0.28.2" });
  assert.deepEqual(result.movedOptional, { "@esbuild/darwin-arm64": "0.28.2" });
  assert.deepEqual(result.removed, ["@esbuild/darwin-arm64", "zod"]);
  assert.deepEqual(result.manifest.peerDependencies, {});
  assert.deepEqual(result.manifest.peerDependenciesMeta, {});
  assert.throws(
    () => pruneBundledManifest({ name: "x", dependencies: { lost: "^1.0.0" } }, () => false, "node_modules/@paperclipai/server/node_modules/x"),
    /required dependency lost of node_modules\/@paperclipai\/server\/node_modules\/x is missing from the bundle/,
  );
});

test("buildRootManifest (R4) writes the published manifest", () => {
  const manifest = buildRootManifest({
    cliManifest: CLI,
    version: "1.0.0",
    phiVersion: "0.100.0",
    internalNames: ["@paperclipai/db", "@paperclipai/server"],
    hoisted: { "drizzle-orm": "^0.45.2", postgres: "^3.4.5" },
    hoistedOptional: { "@esbuild/darwin-arm64": "0.28.2", postgres: "^3.4.5" },
  });
  assert.equal(manifest.name, "@phi-code-admin/phi-bot");
  assert.equal(manifest.version, "1.0.0");
  assert.deepEqual(manifest.bin, { phibot: "./dist/index.js" });
  assert.deepEqual(manifest.files, ["dist", "npm-shrinkwrap.json"]);
  assert.deepEqual(manifest.os, ["linux"]);
  assert.deepEqual(manifest.cpu, ["x64"]);
  assert.deepEqual(manifest.engines, { node: ">=24.11.0" });
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.publishConfig, { access: "public" });
  assert.equal(manifest.repository.url, "https://github.com/uglyswap/phi-bot");
  assert.deepEqual(manifest.dependencies, {
    "@paperclipai/db": "1.0.0",
    "@paperclipai/server": "1.0.0",
    "@phi-code-admin/phi-code": "0.100.0",
    commander: "^15.0.0",
    "drizzle-orm": "0.45.2",
    postgres: "^3.4.5",
  });
  assert.deepEqual(manifest.optionalDependencies, { "@embedded-postgres/linux-x64": "18.1.0-beta.16", "@esbuild/darwin-arm64": "0.28.2" });
  assert.deepEqual(manifest.bundleDependencies, ["@paperclipai/db", "@paperclipai/server"]);
  assert.throws(
    () => buildRootManifest({ cliManifest: { ...CLI, dependencies: { "@paperclipai/db": "workspace:*" } }, version: "1.0.0", phiVersion: "0.100.0", internalNames: [], hoisted: {}, hoistedOptional: {} }),
    /run scripts\/build-npm.sh first/,
  );
});

test("shrinkwrapFromConsumerLock rebases the package subtree and reports what npm would never fetch", () => {
  const registry = (name) => ({ resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`, integrity: "sha512-x" });
  const consumerLock = {
    lockfileVersion: 3,
    packages: {
      "": { name: "phibot-shrinkwrap-consumer", dependencies: { "@phi-code-admin/phi-bot": "file:a.tgz" } },
      "node_modules/@phi-code-admin/phi-bot": { version: "1.0.0", resolved: "file:a.tgz", integrity: "sha512-a", bundleDependencies: ["@paperclipai/server"], dependencies: { express: "^5.1.0" } },
      "node_modules/@phi-code-admin/phi-bot/node_modules/@paperclipai/server": { version: "1.0.0", inBundle: true },
      "node_modules/@phi-code-admin/phi-bot/node_modules/@paperclipai/server/node_modules/acpx": { version: "0.13.1" },
      "node_modules/@phi-code-admin/phi-bot/node_modules/express": { version: "5.1.0", ...registry("express") },
    },
  };
  const good = shrinkwrapFromConsumerLock(consumerLock, ["@paperclipai/server"]);
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.shrinkwrap.packages[""], { name: "@phi-code-admin/phi-bot", version: "1.0.0", bundleDependencies: ["@paperclipai/server"], dependencies: { express: "^5.1.0" } });
  assert.equal(good.shrinkwrap.version, "1.0.0");
  assert.equal(good.shrinkwrap.lockfileVersion, 3);
  assert.equal(good.shrinkwrap.packages["node_modules/@paperclipai/server/node_modules/acpx"].inBundle, true);
  assert.deepEqual(good.shrinkwrap.packages["node_modules/express"], { version: "5.1.0", ...registry("express") });
  const bad = shrinkwrapFromConsumerLock(
    {
      packages: {
        ...consumerLock.packages,
        "node_modules/@phi-code-admin/phi-bot/node_modules/@phi-code-admin/phi-code": { version: "0.100.0", inBundle: true },
        "node_modules/@phi-code-admin/phi-bot/node_modules/lost": { version: "1.0.0" },
        "node_modules/hoisted": { version: "1.0.0", ...registry("hoisted") },
      },
    },
    ["@paperclipai/server"],
  );
  assert.deepEqual(bad.problems, [
    "npm would take node_modules/@phi-code-admin/phi-code for a bundled package and never fetch it",
    "no resolved/integrity: node_modules/lost",
    "placed outside the package: node_modules/hoisted",
  ]);
  assert.throws(() => shrinkwrapFromConsumerLock({ packages: {} }, []), /@phi-code-admin\/phi-bot is missing from the consumer lockfile/);
});

test("installScriptPackages lists the packages npm asks about on linux-x64", () => {
  const shrinkwrap = {
    packages: {
      "": { name: "@phi-code-admin/phi-bot", hasInstallScript: true },
      "node_modules/better-sqlite3": { version: "12.0.0", hasInstallScript: true },
      "node_modules/@embedded-postgres/linux-x64": { version: "18.1.0-beta.16", hasInstallScript: true, optional: true, os: ["linux"], cpu: ["x64"] },
      "node_modules/@embedded-postgres/darwin-arm64": { version: "18.1.0-beta.16", hasInstallScript: true, optional: true, os: ["darwin"], cpu: ["arm64"] },
      "node_modules/@paperclipai/server/node_modules/esbuild": { version: "0.28.2", hasInstallScript: true, inBundle: true },
      "node_modules/@phi-code-admin/phi-code/node_modules/onnxruntime-node": { version: "1.22.0", hasInstallScript: true },
      "node_modules/commander": { version: "15.0.0" },
    },
  };
  assert.deepEqual(installScriptPackages(shrinkwrap), ["@embedded-postgres/linux-x64", "better-sqlite3", "onnxruntime-node"]);
  assert.deepEqual(parseAllowScriptsConstant('export const PHIBOT_NPM_ALLOW_SCRIPTS = ["a", "@b/c"] as const;'), ["a", "@b/c"]);
  assert.throws(() => parseAllowScriptsConstant("nothing"), /PHIBOT_NPM_ALLOW_SCRIPTS not found/);
});

function archiveInput(overrides = {}) {
  const internalNames = ["@paperclipai/adapter-phi-local", "@paperclipai/db", "@paperclipai/server"];
  const entries = [
    "package/package.json",
    "package/npm-shrinkwrap.json",
    "package/dist/index.js",
    "package/node_modules/@paperclipai/server/package.json",
    "package/node_modules/@paperclipai/server/ui-dist/index.html",
    "package/node_modules/@paperclipai/server/node_modules/esbuild/package.json",
    "package/node_modules/@paperclipai/adapter-phi-local/package.json",
    "package/node_modules/@paperclipai/db/package.json",
    "package/node_modules/@paperclipai/db/dist/embedded-postgres-native.js",
  ];
  const manifest = {
    name: "@phi-code-admin/phi-bot",
    version: "1.0.0",
    bin: { phibot: "./dist/index.js" },
    os: ["linux"],
    cpu: ["x64"],
    engines: { node: ">=24.11.0" },
    repository: { type: "git", url: "https://github.com/uglyswap/phi-bot" },
    dependencies: Object.fromEntries([...internalNames.map((name) => [name, "1.0.0"]), ["@phi-code-admin/phi-code", "0.100.0"]]),
    bundleDependencies: internalNames,
  };
  return { entries, manifest, version: "1.0.0", phiVersion: "0.100.0", internalNames, uiIndexHtml: "<title>Phi Bot</title>", ...overrides };
}

test("checkArchive accepts the expected archive and reports each defect", () => {
  assert.deepEqual(checkArchive(archiveInput()), []);
  const input = archiveInput();
  const problems = checkArchive({
    ...input,
    entries: [...input.entries.filter((entry) => entry !== "package/npm-shrinkwrap.json"), "package/node_modules/is-number/package.json"],
    manifest: { ...input.manifest, os: undefined, repository: "https://github.com/paperclipai/paperclip" },
    uiIndexHtml: "<title>Paperclip</title>",
  });
  assert.deepEqual(problems, [
    "missing entry: package/npm-shrinkwrap.json",
    "third-party folder at the top of the bundle: node_modules/is-number",
    'os: undefined instead of ["linux"]',
    'repository: "https://github.com/paperclipai/paperclip" is not uglyswap/phi-bot',
    "ui-dist/index.html is not rebranded (<title>Phi Bot</title> missing)",
  ]);
});

test("compareInstalledTree checks versions, skips bundled and absent optional entries", () => {
  const shrinkwrap = {
    packages: {
      "": {},
      "node_modules/@paperclipai/server": { version: "1.0.0", inBundle: true },
      "node_modules/ms": { version: "2.1.2" },
      "node_modules/debug": { version: "4.4.0" },
      "node_modules/debug/node_modules/ms": { version: "2.1.3" },
      "node_modules/@esbuild/darwin-arm64": { version: "0.28.2", optional: true },
      "node_modules/lost": { version: "1.0.0" },
    },
  };
  const installed = { "node_modules/ms": "2.1.3", "node_modules/debug": "4.4.0", "node_modules/debug/node_modules/ms": "2.1.3" };
  const result = compareInstalledTree(shrinkwrap, (key) => installed[key] ?? null, ["@paperclipai/server", "debug", "ms", "extra"]);
  assert.equal(result.checked, 3);
  assert.deepEqual(result.problems, [
    "node_modules/ms: installed 2.1.3, shrinkwrap 2.1.2",
    "not installed: node_modules/lost@1.0.0",
    "installed but absent from the shrinkwrap: node_modules/extra",
  ]);
});

test("registryProjectFromShrinkwrap keeps the registry packages only", () => {
  const { manifest, lock } = registryProjectFromShrinkwrap({
    packages: {
      "": { name: "@phi-code-admin/phi-bot", dependencies: { "@paperclipai/server": "1.0.0", express: "^5.1.0" }, optionalDependencies: { "@esbuild/linux-x64": "0.28.2" }, bundleDependencies: ["@paperclipai/server"] },
      "node_modules/@paperclipai/server": { version: "1.0.0", inBundle: true },
      "node_modules/@paperclipai/server/node_modules/acpx": { version: "0.13.1", inBundle: true },
      "node_modules/express": { version: "5.1.0", resolved: "https://registry.npmjs.org/express/-/express-5.1.0.tgz", integrity: "sha512-x" },
    },
  });
  assert.deepEqual(manifest, { name: "phibot-signatures", version: "1.0.0", private: true, dependencies: { express: "^5.1.0" }, optionalDependencies: { "@esbuild/linux-x64": "0.28.2" } });
  assert.deepEqual(Object.keys(lock.packages), ["", "node_modules/express"]);
  assert.equal(lock.lockfileVersion, 3);
});
