// Pure functions of the Phi Bot single npm package (PHIBOT-SOLO-SPEC.md section 5).
// scripts/phibot-pack.mjs does the file system and process work around them.
//
// Flattening rules (research R1 section 1.4):
//   R1  each internal package is packed exactly like upstream, then extracted
//       into staging/node_modules/<name>; npm install never runs in staging.
//   R2  an internal manifest keeps in "dependencies" only @paperclipai/* and its
//       own bundled dependencies; the other dependencies and every optional
//       dependency move to the root manifest; its peer dependencies outside
//       @paperclipai/* are removed (a required one must be a root dependency).
//   R3  a third-party manifest bundled inside an internal package loses every
//       dependency and peer dependency that is not physically present; a missing
//       optional dependency moves to the root optional dependencies, a missing
//       peer is dropped, a missing required dependency is an error.
//   Why the peers: npm treats a root-level package that a bundled package depends
//   on, peer edges included, as part of the bundle and never fetches it (empty
//   folder, research R1 section 1.2); phi itself was lost through the optional
//   peer of @paperclipai/adapter-phi-local.
//   R4  the root manifest declares the third-party dependencies, phi at an
//       exact version and the internal packages at the exact release version,
//       bundled.

export const PACKAGE_NAME = "@phi-code-admin/phi-bot";
export const INTERNAL_SCOPE = "@paperclipai/";
export const PHI_PACKAGE = "@phi-code-admin/phi-code";
export const DEFAULT_PHI_VERSION = "0.100.0";
export const NODE_ENGINE = ">=24.11.0";
export const TARGET_PLATFORM = { os: "linux", cpu: "x64", libc: "glibc" };
export const REQUIRED_ALLOW_SCRIPTS = ["better-sqlite3", "@embedded-postgres/linux-x64"];
export const DEPENDENCY_SECTIONS = ["dependencies", "optionalDependencies", "peerDependencies"];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Strict SemVer (spec 5.3): "1.0.0", "1.1.0-rc.1". Calendar versions such as "2026.1005.0" are valid SemVer too. */
export function isSemver(version) {
  return typeof version === "string" && SEMVER.test(version);
}

export function tarballName(version) {
  return `phi-code-admin-phi-bot-${version}.tgz`;
}

function parseVersion(version) {
  const match = SEMVER.exec(version);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? "" };
}

function compareParsed(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return Math.sign(a[key] - b[key]);
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/** Parses "1.2.3", "^1.2.3", "~1.2.3" and ">=1.2.3"; any other form returns null. */
export function parseRange(spec) {
  const match = /^(\^|~|>=)?\s*(\S+)$/.exec(String(spec).trim());
  if (!match) return null;
  const version = parseVersion(match[2]);
  if (!version) return null;
  return { op: match[1] ?? "=", version, raw: String(spec).trim() };
}

export function satisfies(versionText, spec) {
  const version = parseVersion(versionText);
  const range = parseRange(spec);
  if (!version || !range) return false;
  const base = range.version;
  const cmp = compareParsed(version, base);
  if (range.op === "=") return cmp === 0;
  if (cmp < 0) return false;
  if (version.pre && (version.major !== base.major || version.minor !== base.minor || version.patch !== base.patch)) return false;
  if (range.op === ">=") return true;
  if (range.op === "~") return version.major === base.major && version.minor === base.minor;
  if (base.major > 0) return version.major === base.major;
  if (base.minor > 0) return version.major === 0 && version.minor === base.minor;
  return version.major === 0 && version.minor === 0 && version.patch === base.patch;
}

/**
 * Keeps the most restrictive of two specifiers of the same dependency (R2).
 * Throws when they cannot be ordered: the build must not guess.
 */
export function mergeRange(name, left, right) {
  if (left === undefined) return right;
  if (right === undefined || left === right) return left;
  const a = parseRange(left);
  const b = parseRange(right);
  if (!a || !b) throw new Error(`cannot merge ${name}: unsupported specifiers "${left}" and "${right}"`);
  if (a.op === "=" && b.op === "=") throw new Error(`conflicting exact versions of ${name}: ${left} and ${right}`);
  if (a.op === "=") {
    if (satisfies(left, right)) return left;
    throw new Error(`conflicting versions of ${name}: ${left} does not satisfy ${right}`);
  }
  if (b.op === "=") {
    if (satisfies(right, left)) return right;
    throw new Error(`conflicting versions of ${name}: ${right} does not satisfy ${left}`);
  }
  const strongest = compareParsed(a.version, b.version) >= 0 ? a : b;
  const weakest = strongest === a ? b : a;
  if (!satisfies(`${strongest.version.major}.${strongest.version.minor}.${strongest.version.patch}`, weakest.raw)) {
    throw new Error(`conflicting ranges of ${name}: ${left} and ${right}`);
  }
  if (strongest.op === ">=" && weakest.op !== ">=") throw new Error(`cannot merge ${name}: "${left}" and "${right}"`);
  return strongest.raw;
}

/**
 * Internal packages reachable from the CLI, sorted by name. `workspace` maps the name of every
 * workspace package to its manifest; a dependency is internal when its name is a workspace
 * package, whatever its specifier ("workspace:*" before set-version, the release version after).
 */
export function computeClosure(rootManifest, workspace) {
  const seen = new Set();
  const queue = [rootManifest];
  while (queue.length > 0) {
    const manifest = queue.shift();
    for (const section of DEPENDENCY_SECTIONS) {
      for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
        const workspaceSpec = typeof spec === "string" && spec.startsWith("workspace:");
        if (!workspaceSpec && !name.startsWith(INTERNAL_SCOPE)) continue;
        if (seen.has(name)) continue;
        const target = workspace.get(name);
        if (!target) throw new Error(`workspace package not found: ${name}`);
        seen.add(name);
        queue.push(target);
      }
    }
  }
  const names = [...seen].sort();
  const outside = names.filter((name) => !name.startsWith(INTERNAL_SCOPE));
  if (outside.length > 0) throw new Error(`internal packages outside ${INTERNAL_SCOPE}: ${outside.join(", ")}`);
  return names;
}

/** Sets the release version and pins every internal dependency to it (set-version, done in staging only). */
export function setInternalVersion(manifest, version) {
  const next = { ...manifest, version };
  for (const section of DEPENDENCY_SECTIONS) {
    if (!next[section]) continue;
    next[section] = Object.fromEntries(
      Object.entries(next[section]).map(([name, spec]) => [name, name.startsWith(INTERNAL_SCOPE) ? version : spec]),
    );
  }
  delete next.devDependencies;
  return next;
}

/** R2 on one extracted internal manifest. */
export function flattenInternalManifest(manifest) {
  const droppedPeers = {};
  const peers = {};
  const peerMeta = {};
  for (const [name, spec] of Object.entries(manifest.peerDependencies ?? {})) {
    if (name.startsWith(INTERNAL_SCOPE)) {
      peers[name] = spec;
      if (manifest.peerDependenciesMeta?.[name]) peerMeta[name] = manifest.peerDependenciesMeta[name];
    } else {
      droppedPeers[name] = { spec, optional: Boolean(manifest.peerDependenciesMeta?.[name]?.optional) };
    }
  }
  const bundled = new Set(manifest.bundleDependencies ?? manifest.bundledDependencies ?? []);
  const kept = {};
  const hoisted = {};
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (name.startsWith(INTERNAL_SCOPE) || bundled.has(name)) kept[name] = spec;
    else hoisted[name] = spec;
  }
  const hoistedOptional = { ...(manifest.optionalDependencies ?? {}) };
  const next = { ...manifest };
  if (Object.keys(kept).length > 0) next.dependencies = kept;
  else delete next.dependencies;
  delete next.optionalDependencies;
  if (Object.keys(peers).length > 0) next.peerDependencies = peers;
  else delete next.peerDependencies;
  if (Object.keys(peerMeta).length > 0) next.peerDependenciesMeta = peerMeta;
  else delete next.peerDependenciesMeta;
  return { manifest: next, hoisted, hoistedOptional, droppedPeers };
}

/** True for the package.json at the root of a package inside node_modules (never dist/esm/package.json). */
export function isPackageRootManifest(relPath) {
  const parts = relPath.split("/");
  if (parts.at(-1) !== "package.json") return false;
  const index = parts.lastIndexOf("node_modules");
  if (index === -1) return false;
  const rest = parts.slice(index + 1, -1);
  if (rest.length === 1) return !rest[0].startsWith("@") && !rest[0].startsWith(".");
  return rest.length === 2 && rest[0].startsWith("@");
}

/**
 * R3 on one bundled third-party manifest. `isPresent(name)` tells whether the dependency
 * resolves physically from the manifest's folder inside the bundle.
 */
export function pruneBundledManifest(manifest, isPresent, where) {
  const next = { ...manifest };
  const movedOptional = {};
  const removed = [];
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!next[section]) continue;
    const kept = {};
    for (const [name, spec] of Object.entries(next[section])) {
      if (isPresent(name)) {
        kept[name] = spec;
        continue;
      }
      removed.push(name);
      if (section === "peerDependencies") {
        if (next.peerDependenciesMeta?.[name]) {
          next.peerDependenciesMeta = { ...next.peerDependenciesMeta };
          delete next.peerDependenciesMeta[name];
        }
        continue;
      }
      const optional = section === "optionalDependencies" || Boolean(manifest.optionalDependencies?.[name]);
      if (!optional) throw new Error(`required dependency ${name} of ${where} is missing from the bundle`);
      movedOptional[name] = spec;
    }
    next[section] = kept;
  }
  return { manifest: next, movedOptional, removed };
}

function sortObject(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

/** R4: the published manifest. `cliManifest` is cli/package.json as written by scripts/build-npm.sh. */
export function buildRootManifest({ cliManifest, version, phiVersion, internalNames, hoisted, hoistedOptional }) {
  if (cliManifest.name !== PACKAGE_NAME) throw new Error(`cli/package.json is ${cliManifest.name}, expected ${PACKAGE_NAME}`);
  const leftover = Object.entries(cliManifest.dependencies ?? {}).filter(([, spec]) => String(spec).startsWith("workspace:"));
  if (leftover.length > 0) throw new Error("cli/package.json still has workspace dependencies: run scripts/build-npm.sh first");
  let dependencies = {};
  for (const [name, spec] of Object.entries(cliManifest.dependencies ?? {})) {
    if (name.startsWith(INTERNAL_SCOPE)) continue;
    dependencies[name] = spec;
  }
  for (const [name, spec] of Object.entries(hoisted)) dependencies[name] = mergeRange(name, dependencies[name], spec);
  if (dependencies[PHI_PACKAGE] !== undefined && dependencies[PHI_PACKAGE] !== phiVersion) {
    throw new Error(`${PHI_PACKAGE} is declared as ${dependencies[PHI_PACKAGE]}, expected ${phiVersion}`);
  }
  dependencies[PHI_PACKAGE] = phiVersion;
  for (const name of internalNames) dependencies[name] = version;
  let optionalDependencies = {};
  for (const [name, spec] of Object.entries({ ...(cliManifest.optionalDependencies ?? {}) })) {
    optionalDependencies[name] = spec;
  }
  for (const [name, spec] of Object.entries(hoistedOptional)) {
    optionalDependencies[name] = mergeRange(name, optionalDependencies[name], spec);
  }
  for (const name of Object.keys(optionalDependencies)) {
    if (dependencies[name] !== undefined) delete optionalDependencies[name];
  }
  dependencies = sortObject(dependencies);
  optionalDependencies = sortObject(optionalDependencies);
  const manifest = {
    name: PACKAGE_NAME,
    version,
    description: cliManifest.description,
    type: "module",
    bin: { phibot: "./dist/index.js" },
    keywords: cliManifest.keywords,
    license: "MIT",
    repository: cliManifest.repository,
    homepage: cliManifest.homepage,
    bugs: cliManifest.bugs,
    files: ["dist", "npm-shrinkwrap.json"],
    engines: { node: NODE_ENGINE },
    os: [TARGET_PLATFORM.os],
    cpu: [TARGET_PLATFORM.cpu],
    publishConfig: { access: "public" },
    dependencies,
  };
  if (Object.keys(optionalDependencies).length > 0) manifest.optionalDependencies = optionalDependencies;
  manifest.bundleDependencies = [...internalNames];
  return manifest;
}

/**
 * npm-shrinkwrap.json (spec 5.5) from the lockfile of a throwaway project that depends on the
 * archive (`npm install --package-lock-only --install-strategy=shallow`, the layout of
 * `npm install -g`): the package's own subtree, rebased on the package root. Problems: a package
 * that npm would take for a bundled one although it is outside the archive (never fetched, empty
 * folder at install time, research R1 section 1.2), an entry without registry coordinates, an
 * entry placed outside the package.
 */
export function shrinkwrapFromConsumerLock(consumerLock, internalNames) {
  const prefix = `node_modules/${PACKAGE_NAME}`;
  const own = consumerLock.packages?.[prefix];
  if (!own) throw new Error(`${PACKAGE_NAME} is missing from the consumer lockfile`);
  const { resolved: _resolved, integrity: _integrity, ...rootEntry } = own;
  const packages = { "": { name: PACKAGE_NAME, ...rootEntry } };
  const problems = [];
  const inside = (key) => internalNames.some((name) => key === `node_modules/${name}` || key.startsWith(`node_modules/${name}/`));
  for (const [key, entry] of Object.entries(consumerLock.packages)) {
    if (key === "" || key === prefix) continue;
    if (!key.startsWith(`${prefix}/`)) {
      problems.push(`placed outside the package: ${key}`);
      continue;
    }
    const relKey = key.slice(prefix.length + 1);
    if (inside(relKey)) {
      packages[relKey] = entry.inBundle ? entry : { ...entry, inBundle: true };
      continue;
    }
    if (entry.inBundle) problems.push(`npm would take ${relKey} for a bundled package and never fetch it`);
    else if (!entry.resolved || !entry.integrity) problems.push(`no resolved/integrity: ${relKey}`);
    packages[relKey] = entry;
  }
  return {
    shrinkwrap: { name: PACKAGE_NAME, version: rootEntry.version, lockfileVersion: 3, requires: true, packages },
    problems,
  };
}

/**
 * Project made of the registry packages of a shrinkwrap only (spec 3, `npm audit signatures`):
 * npm refuses to audit a global package and looks up the bundled @paperclipai/* packages on the
 * registry, where they do not exist. The bundled entries live in the archive, published with
 * provenance; every other entry is checked by `npm ci` then `npm audit signatures` in this project.
 */
export function registryProjectFromShrinkwrap(shrinkwrap) {
  const root = shrinkwrap.packages?.[""] ?? {};
  const bundled = new Set(root.bundleDependencies ?? []);
  const keep = (deps) => Object.fromEntries(Object.entries(deps ?? {}).filter(([name]) => !bundled.has(name)));
  const manifest = { name: "phibot-signatures", version: "1.0.0", private: true, dependencies: keep(root.dependencies) };
  const optional = keep(root.optionalDependencies);
  if (Object.keys(optional).length > 0) manifest.optionalDependencies = optional;
  const packages = { "": manifest };
  for (const [key, entry] of Object.entries(shrinkwrap.packages ?? {})) {
    if (key !== "" && !entry.inBundle) packages[key] = entry;
  }
  return { manifest, lock: { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages } };
}

function lastPackageName(lockKey) {
  const index = lockKey.lastIndexOf("node_modules/");
  return index === -1 ? "" : lockKey.slice(index + "node_modules/".length);
}

function fitsTarget(entry) {
  if (Array.isArray(entry.os) && !entry.os.includes(TARGET_PLATFORM.os)) return false;
  if (Array.isArray(entry.cpu) && !entry.cpu.includes(TARGET_PLATFORM.cpu)) return false;
  if (Array.isArray(entry.libc) && !entry.libc.includes(TARGET_PLATFORM.libc)) return false;
  return true;
}

/**
 * Packages whose install scripts npm runs (or warns about) on linux-x64 (spec 5.4): every
 * shrinkwrap entry with an install script, outside the bundled packages, that fits the target.
 */
export function installScriptPackages(shrinkwrap) {
  const names = new Set();
  for (const [key, entry] of Object.entries(shrinkwrap.packages ?? {})) {
    if (key === "" || !entry.hasInstallScript || entry.inBundle) continue;
    if (!fitsTarget(entry)) continue;
    names.add(lastPackageName(key));
  }
  return [...names].sort();
}

/** Compares a computed list with PHIBOT_NPM_ALLOW_SCRIPTS of cli/src/phibot/constants.ts. */
export function parseAllowScriptsConstant(source) {
  const match = /PHIBOT_NPM_ALLOW_SCRIPTS\s*=\s*\[([^\]]*)\]/.exec(source);
  if (!match) throw new Error("PHIBOT_NPM_ALLOW_SCRIPTS not found in cli/src/phibot/constants.ts");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

/**
 * Problems of an archive, from its entry list (`tar -tzf`) and its package.json.
 * An empty list means the archive is the expected single package.
 */
export function checkArchive({ entries, manifest, version, phiVersion, internalNames, uiIndexHtml }) {
  const problems = [];
  const set = new Set(entries.map((entry) => entry.replace(/\/$/, "")));
  const required = [
    "package/package.json",
    "package/npm-shrinkwrap.json",
    "package/dist/index.js",
    "package/node_modules/@paperclipai/server/package.json",
    "package/node_modules/@paperclipai/server/ui-dist/index.html",
    "package/node_modules/@paperclipai/adapter-phi-local/package.json",
    "package/node_modules/@paperclipai/db/dist/embedded-postgres-native.js",
  ];
  for (const name of internalNames) required.push(`package/node_modules/${name}/package.json`);
  for (const entry of [...new Set(required)]) if (!set.has(entry)) problems.push(`missing entry: ${entry}`);
  const thirdParty = new Set();
  for (const entry of set) {
    const match = /^package\/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(entry);
    if (match && !match[1].startsWith(INTERNAL_SCOPE) && match[1] !== "@paperclipai") thirdParty.add(match[1]);
  }
  for (const name of [...thirdParty].sort()) problems.push(`third-party folder at the top of the bundle: node_modules/${name}`);
  const expect = (label, actual, wanted) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) problems.push(`${label}: ${JSON.stringify(actual)} instead of ${JSON.stringify(wanted)}`);
  };
  expect("name", manifest.name, PACKAGE_NAME);
  expect("version", manifest.version, version);
  expect("bin", manifest.bin, { phibot: "./dist/index.js" });
  expect("os", manifest.os, [TARGET_PLATFORM.os]);
  expect("cpu", manifest.cpu, [TARGET_PLATFORM.cpu]);
  expect("engines", manifest.engines, { node: NODE_ENGINE });
  expect(PHI_PACKAGE, manifest.dependencies?.[PHI_PACKAGE], phiVersion);
  expect("bundleDependencies", [...(manifest.bundleDependencies ?? [])].sort(), [...internalNames].sort());
  const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  if (!/github\.com\/uglyswap\/phi-bot(\.git)?$/.test(repository ?? "")) problems.push(`repository: ${JSON.stringify(repository)} is not uglyswap/phi-bot`);
  for (const name of internalNames) expect(`dependencies.${name}`, manifest.dependencies?.[name], version);
  if (uiIndexHtml !== undefined && !uiIndexHtml.includes("<title>Phi Bot</title>")) problems.push("ui-dist/index.html is not rebranded (<title>Phi Bot</title> missing)");
  return problems;
}

/**
 * Shrinkwrap respected by an installation: every entry of the package's npm-shrinkwrap.json
 * outside the bundle is installed at the recorded version. `readVersion(key)` returns the
 * installed version of <package>/<key>, or null when absent.
 */
export function compareInstalledTree(shrinkwrap, readVersion, installedTopLevel) {
  const problems = [];
  let checked = 0;
  for (const [key, entry] of Object.entries(shrinkwrap.packages ?? {})) {
    if (key === "" || entry.inBundle || entry.link) continue;
    const installed = readVersion(key);
    if (installed === null) {
      if (entry.optional || entry.devOptional || entry.peer) continue;
      problems.push(`not installed: ${key}@${entry.version}`);
      continue;
    }
    checked += 1;
    if (installed !== entry.version) problems.push(`${key}: installed ${installed}, shrinkwrap ${entry.version}`);
  }
  const recorded = new Set(Object.keys(shrinkwrap.packages ?? {}).map((key) => lastPackageName(key)));
  for (const name of installedTopLevel) {
    if (!recorded.has(name)) problems.push(`installed but absent from the shrinkwrap: node_modules/${name}`);
  }
  return { problems, checked };
}
