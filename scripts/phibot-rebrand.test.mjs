import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BRAND_FILES, sha256Hex } from "./phibot-rebrand-lib.mjs";
import { runRebrand } from "./phibot-rebrand.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "phibot-rebrand.mjs");
const USAGE = "usage: node scripts/phibot-rebrand.mjs --check | --apply [--root <repo>]";
const LOGO = "ui/src/components/Logo.tsx";
const UPSTREAM_LOGO = "export const Logo = () => <svg aria-label=\"Paperclip\" />;\n";
const PHI_LOGO = "export const Logo = () => <svg aria-label=\"Phi Bot\" />;\n";
const OVERRIDES = [{ path: LOGO, upstreamSha256: sha256Hex(Buffer.from(UPSTREAM_LOGO)) }];

function baseFiles() {
  const files = {
    "ui/src/App.tsx": "export const App = () => <h1 title=\"Paperclip\">Welcome to Paperclip</h1>;\n",
    "ui/src/App.test.tsx": "expect(screen.getByText(\"Welcome to Paperclip\")).toBeTruthy();\n",
    "ui/src/lib/notice.ts": "export const NOTICE = \"Paperclip needs a disposition.\";\n",
    [LOGO]: UPSTREAM_LOGO,
    [`phibot/branding/overrides/${LOGO}`]: PHI_LOGO,
    "packages/shared/src/app-definitions/demo.json": "{\n  \"key\": \"paperclip-demo\",\n  \"description\": \"Use Paperclip with Demo.\"\n}\n",
    "ui/index.html": [
      "<!doctype html>",
      "<meta name=\"apple-mobile-web-app-title\" content=\"Paperclip\" />",
      "<title>Paperclip</title>",
      "<h1>Paperclip couldn\u2019t start</h1>",
      "",
    ].join("\n"),
    "ui/public/site.webmanifest": "{\n  \"name\": \"Paperclip\",\n  \"short_name\": \"Paperclip\"\n}\n",
    "ui/public/sw.js": "const page = `<title>Paperclip is offline</title>`;\n",
    "phibot/branding/rebrand-allowlist.txt": "# Server data compared with ===.\nui/src/lib/notice.ts | Paperclip needs a disposition.\n",
  };
  for (const name of BRAND_FILES) {
    files[`ui/public/${name}`] = `old ${name}`;
    files[`phibot/branding/${name}`] = `new ${name}`;
  }
  return files;
}

function makeRepo(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "phibot-rebrand-"));
  for (const [relPath, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relPath)), { recursive: true });
    writeFileSync(path.join(root, relPath), content);
  }
  return root;
}

function run(root, mode) {
  const lines = [];
  const code = runRebrand({ mode, root, overrides: OVERRIDES }, (line) => lines.push(line));
  return { code, lines };
}

function read(root, relPath) {
  return readFileSync(path.join(root, relPath), "utf8");
}

function withRepo(files, body) {
  const root = makeRepo(files);
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("--check lists the pending work and writes nothing", () => {
  const files = baseFiles();
  withRepo(files, (root) => {
    const result = run(root, "check");
    assert.equal(result.code, 1);
    assert.deepEqual(result.lines, [
      "phibot-rebrand: check (nothing is written)",
      "  packages/shared/src/app-definitions/demo.json: 1",
      "  ui/index.html: 3",
      "  ui/public/site.webmanifest: 2",
      "  ui/public/sw.js: 1",
      "  ui/src/App.tsx: 2",
      "override: ui/src/components/Logo.tsx",
      "files with replacements: 5",
      "replacements: 9",
      "brand files to copy: 7",
      "brand overrides to copy: 1",
      "remaining outside the allowlist: 0",
      "unused allowlist entries: 0",
      "syntax errors: 0",
      "override errors: 0",
    ]);
    assert.equal(read(root, "ui/src/App.tsx"), files["ui/src/App.tsx"]);
    assert.equal(read(root, LOGO), UPSTREAM_LOGO);
    assert.equal(read(root, "ui/public/favicon.ico"), "old favicon.ico");
  });
});

test("--apply rebrands texts, copies brand files and overrides, then --check passes", () => {
  const files = baseFiles();
  withRepo(files, (root) => {
    const applied = run(root, "apply");
    assert.equal(applied.code, 0);
    assert.equal(applied.lines[0], "phibot-rebrand: apply (never commit these changes)");
    assert.ok(applied.lines.includes("brand files copied: 7"));
    assert.ok(applied.lines.includes("brand overrides copied: 1"));
    assert.equal(read(root, "ui/src/App.tsx"), "export const App = () => <h1 title=\"Phi Bot\">Welcome to Phi Bot</h1>;\n");
    assert.equal(read(root, "ui/src/App.test.tsx"), files["ui/src/App.test.tsx"]);
    assert.equal(read(root, "ui/src/lib/notice.ts"), files["ui/src/lib/notice.ts"]);
    assert.equal(read(root, LOGO), PHI_LOGO);
    assert.equal(read(root, "packages/shared/src/app-definitions/demo.json"), "{\n  \"key\": \"paperclip-demo\",\n  \"description\": \"Use Phi Bot with Demo.\"\n}\n");
    assert.match(read(root, "ui/index.html"), /<title>Phi Bot<\/title>/);
    assert.match(read(root, "ui/index.html"), /content="Phi Bot"/);
    assert.match(read(root, "ui/index.html"), /<h1>Phi Bot couldn\u2019t start<\/h1>/);
    assert.equal(read(root, "ui/public/site.webmanifest"), "{\n  \"name\": \"Phi Bot\",\n  \"short_name\": \"Phi Bot\"\n}\n");
    assert.equal(read(root, "ui/public/sw.js"), "const page = `<title>Phi Bot is offline</title>`;\n");
    for (const name of BRAND_FILES) assert.equal(read(root, `ui/public/${name}`), `new ${name}`);
    const checked = run(root, "check");
    assert.equal(checked.code, 0);
    assert.ok(checked.lines.includes("replacements: 0"));
    assert.ok(checked.lines.includes("brand files to copy: 0"));
    assert.ok(checked.lines.includes("brand overrides to copy: 0"));
  });
});

test("an overridden upstream file that no longer exists stops the run before any write", () => {
  const files = baseFiles();
  delete files[LOGO];
  withRepo(files, (root) => {
    const result = run(root, "apply");
    assert.equal(result.code, 1);
    assert.ok(result.lines.includes(`override error: upstream file ${LOGO} no longer exists; find where upstream moved it, then update BRAND_OVERRIDES`));
    assert.ok(result.lines.includes("override errors: 1"));
    assert.equal(read(root, "ui/src/App.tsx"), files["ui/src/App.tsx"]);
    assert.equal(read(root, "ui/public/favicon.ico"), "old favicon.ico");
  });
});

test("an upstream change to an overridden file stops the run", () => {
  const files = baseFiles();
  files[LOGO] = UPSTREAM_LOGO.replace("<svg", "<svg role=\"img\"");
  withRepo(files, (root) => {
    const result = run(root, "check");
    assert.equal(result.code, 1);
    const digest = sha256Hex(Buffer.from(files[LOGO]));
    assert.ok(result.lines.includes(`override error: upstream file ${LOGO} changed (sha256 ${digest}); port the change into phibot/branding/overrides/${LOGO}, then update upstreamSha256 in BRAND_OVERRIDES`));
  });
});

test("--apply exits 1 when an occurrence remains outside the allowlist", () => {
  const files = baseFiles();
  files["ui/src/Docs.tsx"] = "export const DOCS = \"Read the Paperclip docs at paperclip.ing\";\n";
  withRepo(files, (root) => {
    const result = run(root, "apply");
    assert.equal(result.code, 1);
    assert.ok(result.lines.includes("remaining: ui/src/Docs.tsx:1:31 [contains paperclip.] \"Read the Paperclip docs at paperclip.ing\""));
    assert.ok(result.lines.includes("remaining outside the allowlist: 1"));
  });
});

test("an allowlist entry that matches nothing fails the run", () => {
  const files = baseFiles();
  files["phibot/branding/rebrand-allowlist.txt"] += "ui/src/App.tsx | text that does not exist\n";
  withRepo(files, (root) => {
    const result = run(root, "apply");
    assert.equal(result.code, 1);
    assert.ok(result.lines.includes("unused allowlist entry: phibot/branding/rebrand-allowlist.txt:3 ui/src/App.tsx | text that does not exist"));
    assert.ok(result.lines.includes("unused allowlist entries: 1"));
  });
});

test("a syntax error blocks --apply before anything is written", () => {
  const files = baseFiles();
  files["ui/src/Broken.tsx"] = "export const B = \"Paperclip;\n";
  withRepo(files, (root) => {
    const result = run(root, "apply");
    assert.equal(result.code, 1);
    assert.ok(result.lines.includes("syntax error: ui/src/Broken.tsx: Unterminated string literal."));
    assert.equal(read(root, "ui/src/App.tsx"), files["ui/src/App.tsx"]);
    assert.equal(read(root, LOGO), UPSTREAM_LOGO);
  });
});

test("a missing brand file is an explicit error", () => {
  withRepo(baseFiles(), (root) => {
    unlinkSync(path.join(root, "phibot/branding/favicon.ico"));
    assert.throws(() => run(root, "check"), /missing file: phibot\/branding\/favicon\.ico/);
  });
});

test("the command reports a missing allowlist on stderr with exit code 1", () => {
  const files = baseFiles();
  delete files["phibot/branding/rebrand-allowlist.txt"];
  withRepo(files, (root) => {
    const result = spawnSync(process.execPath, [CLI, "--check", "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "phibot-rebrand: error: missing file: phibot/branding/rebrand-allowlist.txt\n");
  });
});

test("usage errors exit 2", () => {
  for (const args of [[], ["--check", "--apply"], ["--apply", "--fast"], ["--check", "--root"]]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stderr, `${USAGE}\n`);
  }
});
