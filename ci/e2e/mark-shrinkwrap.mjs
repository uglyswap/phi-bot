#!/usr/bin/env node
// The npm registry sets `_hasShrinkwrap: true` on a version whose archive holds an
// npm-shrinkwrap.json, and npm only reads the shrinkwrap of a dependency when that field is
// true. Verdaccio does not compute it: this script sets it in Verdaccio's storage so that the
// end-to-end test installs the archive exactly as npm will install it from registry.npmjs.org.
// Usage: node ci/e2e/mark-shrinkwrap.mjs <verdaccio storage> <package name> <version>
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [storage, name, version] = process.argv.slice(2);
if (!storage || !name || !version) {
  console.error("usage: node ci/e2e/mark-shrinkwrap.mjs <verdaccio storage> <package name> <version>");
  process.exit(2);
}
const file = path.join(storage, ...name.split("/"), "package.json");
const packument = JSON.parse(readFileSync(file, "utf8"));
const entry = packument.versions?.[version];
if (!entry) {
  console.error(`mark-shrinkwrap: ${name}@${version} is not in ${file}`);
  process.exit(1);
}
entry._hasShrinkwrap = true;
writeFileSync(file, `${JSON.stringify(packument, null, 2)}\n`);
console.log(`mark-shrinkwrap: ${name}@${version} _hasShrinkwrap=true`);
