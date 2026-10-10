#!/usr/bin/env node
// Phi Bot build-time UI rebranding (PHIBOT-SOLO-SPEC.md section 10.2).
// Replaces the word "Paperclip" with "Phi Bot" in the user-visible text of the UI
// and of the app catalog, copies the Phi Bot brand files into ui/public and puts
// the Phi Bot versions of a few brand components over the upstream ones. The
// build runs it after the unit tests and before any UI, shared or server build.
// Never commit its output: `git checkout -- ui packages/shared/src/app-definitions`
// restores the tree.
//
// Usage: node scripts/phibot-rebrand.mjs --check | --apply [--root <repo>]
//   --check  writes nothing; exit 1 while anything is left to rebrand or to fix
//   --apply  rewrites the working tree; exit 1 if occurrences remain outside
//            phibot/branding/rebrand-allowlist.txt or if an override is invalid
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ALLOWLIST_PATH,
  BRAND_FILES,
  BRAND_OVERRIDES,
  BRAND_SOURCE_DIR,
  BRAND_TARGET_DIR,
  EXTRA_SCRIPT_INPUTS,
  HTML_INPUT,
  MANIFEST_INPUT,
  OVERRIDE_SOURCE_DIR,
  listAppDefinitionInputs,
  listUiSourceInputs,
  parseAllowlist,
  planBrandOverrides,
  rebrandAppDefinition,
  rebrandHtml,
  rebrandManifest,
  rebrandSources,
} from "./phibot-rebrand-lib.mjs";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: node scripts/phibot-rebrand.mjs --check | --apply [--root <repo>]";

export function parseArgs(argv) {
  const rootIndex = argv.indexOf("--root");
  const rest = rootIndex === -1 ? argv : argv.filter((arg, index) => index !== rootIndex && index !== rootIndex + 1);
  if (rootIndex !== -1 && !argv[rootIndex + 1]) return null;
  if (rest.length !== 1 || (rest[0] !== "--check" && rest[0] !== "--apply")) return null;
  return { mode: rest[0].slice(2), root: rootIndex === -1 ? DEFAULT_ROOT : resolve(argv[rootIndex + 1]) };
}

function readRequired(root, relPath) {
  const file = join(root, relPath);
  if (!existsSync(file)) throw new Error(`missing file: ${relPath}`);
  return readFileSync(file);
}

// Text results of every input; the files replaced by an override are skipped.
function collectResults(root, allowlist, overrides) {
  const replaced = new Set(overrides.map((entry) => entry.path));
  const scriptPaths = [...listUiSourceInputs(root).filter((relPath) => !replaced.has(relPath)), ...EXTRA_SCRIPT_INPUTS];
  const sources = scriptPaths.map((relPath) => ({ relPath, text: readRequired(root, relPath).toString("utf8") }));
  const definitions = listAppDefinitionInputs(root).map((relPath) =>
    rebrandAppDefinition(readRequired(root, relPath).toString("utf8"), relPath, allowlist));
  return [
    ...rebrandSources(sources, allowlist),
    ...definitions,
    rebrandHtml(readRequired(root, HTML_INPUT).toString("utf8"), HTML_INPUT, allowlist),
    rebrandManifest(readRequired(root, MANIFEST_INPUT).toString("utf8"), MANIFEST_INPUT, allowlist),
  ];
}

function brandFilesToCopy(root) {
  return BRAND_FILES.filter((name) => {
    const source = readRequired(root, `${BRAND_SOURCE_DIR}/${name}`);
    const target = join(root, BRAND_TARGET_DIR, name);
    return !existsSync(target) || !source.equals(readFileSync(target));
  });
}

function writeChanges(root, summary) {
  for (const result of summary.changed) writeFileSync(join(root, result.relPath), result.text, "utf8");
  for (const name of summary.brandFiles) {
    copyFileSync(join(root, BRAND_SOURCE_DIR, name), join(root, BRAND_TARGET_DIR, name));
  }
  for (const relPath of summary.overrides) copyFileSync(join(root, OVERRIDE_SOURCE_DIR, relPath), join(root, relPath));
}

function report(log, summary) {
  const { mode, changed, brandFiles, overrides, remaining, unused, errors, overrideErrors } = summary;
  const verb = mode === "apply" ? "copied" : "to copy";
  log(mode === "apply" ? "phibot-rebrand: apply (never commit these changes)" : "phibot-rebrand: check (nothing is written)");
  for (const result of changed) log(`  ${result.relPath}: ${result.count}`);
  for (const relPath of overrides) log(`override: ${relPath}`);
  for (const item of remaining) log(`remaining: ${item.path}:${item.line}:${item.column} [${item.reason}] ${item.excerpt}`);
  for (const entry of unused) log(`unused allowlist entry: ${ALLOWLIST_PATH}:${entry.line} ${entry.path} | ${entry.text}`);
  for (const result of errors) log(`syntax error: ${result.relPath}: ${result.error}`);
  for (const message of overrideErrors) log(`override error: ${message}`);
  log(`files with replacements: ${changed.length}`);
  log(`replacements: ${changed.reduce((total, result) => total + result.count, 0)}`);
  log(`brand files ${verb}: ${brandFiles.length}`);
  log(`brand overrides ${verb}: ${overrides.length}`);
  log(`remaining outside the allowlist: ${remaining.length}`);
  log(`unused allowlist entries: ${unused.length}`);
  log(`syntax errors: ${errors.length}`);
  log(`override errors: ${overrideErrors.length}`);
}

// Returns the process exit code: 0 when the tree is (or becomes) fully rebranded.
export function runRebrand({ mode, root, overrides = BRAND_OVERRIDES }, log = console.log) {
  const allowlist = parseAllowlist(readRequired(root, ALLOWLIST_PATH).toString("utf8"));
  const results = collectResults(root, allowlist, overrides);
  const plan = planBrandOverrides(root, overrides);
  const byPath = (a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);
  const byPosition = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.column - b.column);
  const summary = {
    mode,
    changed: results.filter((result) => result.count > 0).sort(byPath),
    brandFiles: brandFilesToCopy(root),
    overrides: plan.toCopy,
    remaining: results.flatMap((result) => result.remaining).sort(byPosition),
    unused: allowlist.filter((entry) => !entry.used),
    errors: results.filter((result) => result.error).sort(byPath),
    overrideErrors: plan.errors,
  };
  const blocking = summary.errors.length + summary.overrideErrors.length;
  const problems = blocking + summary.remaining.length + summary.unused.length;
  if (mode === "apply" && blocking === 0) writeChanges(root, summary);
  report(log, summary);
  if (mode === "apply") return problems > 0 ? 1 : 0;
  return problems + summary.changed.length + summary.brandFiles.length + summary.overrides.length > 0 ? 1 : 0;
}

export function main(argv) {
  const options = parseArgs(argv);
  if (!options) {
    console.error(USAGE);
    return 2;
  }
  try {
    return runRebrand(options);
  } catch (error) {
    console.error(`phibot-rebrand: error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
