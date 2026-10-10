import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BRAND_OVERRIDES,
  findBrandWords,
  forEachJsonString,
  isUiSourceInput,
  parseAllowlist,
  planBrandOverrides,
  rebrandAppDefinition,
  rebrandHtml,
  rebrandManifest,
  rebrandSources,
  sha256Hex,
} from "./phibot-rebrand-lib.mjs";

function rebrand(relPath, text, allowlist = []) {
  return rebrandSources([{ relPath, text }], allowlist)[0];
}

function reasons(result) {
  return result.remaining.map((item) => item.reason);
}

test("JSX text is rebranded", () => {
  const result = rebrand("ui/src/a.tsx", "export const A = () => <p>Welcome to Paperclip, the Paperclip board</p>;\n");
  assert.equal(result.text, "export const A = () => <p>Welcome to Phi Bot, the Phi Bot board</p>;\n");
  assert.equal(result.count, 2);
  assert.deepEqual(result.remaining, []);
});

test("JSX attribute strings are rebranded", () => {
  const result = rebrand("ui/src/a.tsx", "export const A = () => <img alt=\"Paperclip logo\" title='Paperclip' />;\n");
  assert.equal(result.text, "export const A = () => <img alt=\"Phi Bot logo\" title='Phi Bot' />;\n");
  assert.equal(result.count, 2);
});

test("string literals are rebranded", () => {
  const result = rebrand("ui/src/a.ts", "const a = \"Paperclip is ready\";\nconst b = 'Paperclip\\'s board';\n");
  assert.equal(result.text, "const a = \"Phi Bot is ready\";\nconst b = 'Phi Bot\\'s board';\n");
  assert.equal(result.count, 2);
});

test("template literals are rebranded in every part, never in substitutions", () => {
  const source = "const a = `Paperclip`;\nconst b = `Hi ${Paperclip}, Paperclip ${x} and Paperclip ${y} end Paperclip`;\n";
  const result = rebrand("ui/src/a.ts", source);
  assert.equal(result.text, "const a = `Phi Bot`;\nconst b = `Hi ${Paperclip}, Phi Bot ${x} and Phi Bot ${y} end Phi Bot`;\n");
  assert.equal(result.count, 4);
});

test("module specifiers are never rewritten", () => {
  const source = [
    "import { Paperclip } from \"lucide-react\";",
    "import x from \"./Paperclip\";",
    "export * from \"./Paperclip\";",
    "const m = import(\"./Paperclip\");",
    "const r = require(\"./Paperclip\");",
    "",
  ].join("\n");
  const result = rebrand("ui/src/a.ts", source);
  assert.equal(result.text, source);
  assert.equal(result.count, 0);
  assert.deepEqual(reasons(result), Array(4).fill("module specifier"));
});

test("property names and type keys are never rewritten", () => {
  const source = [
    "const m = { \"Paperclip\": 1, [\"Paperclip\"]: 2 };",
    "m[\"Paperclip\"];",
    "interface I { \"Paperclip\": string }",
    "type T = \"Paperclip\" | \"Other\";",
    "",
  ].join("\n");
  const result = rebrand("ui/src/a.ts", source);
  assert.equal(result.text, source);
  assert.deepEqual(reasons(result), ["property name", "property name", "property name", "property name", "type"]);
});

test("literals with PAPERCLIP_, @paperclipai, paperclip. or paperclip- stay as they are", () => {
  const source = [
    "const a = \"Set PAPERCLIP_HOME before starting Paperclip\";",
    "const b = \"Install @paperclipai/ui to get Paperclip\";",
    "const c = \"See Paperclip at paperclip.ing\";",
    "const d = \"Paperclip uses paperclip-runner\";",
    "",
  ].join("\n");
  const result = rebrand("ui/src/a.ts", source);
  assert.equal(result.text, source);
  assert.deepEqual(reasons(result), [
    "contains PAPERCLIP_",
    "contains @paperclipai",
    "contains paperclip.",
    "contains paperclip-",
  ]);
  assert.deepEqual(result.remaining[0], {
    path: "ui/src/a.ts",
    line: 1,
    column: 47,
    reason: "contains PAPERCLIP_",
    excerpt: "\"Set PAPERCLIP_HOME before starting Paperclip\"",
  });
});

test("X-Paperclip header names are kept and never reported", () => {
  const source = "const h = \"X-Paperclip-Run-Id\";\nexport const C = () => <code>X-Paperclip-Run-Id keeps Paperclip in sync</code>;\n";
  const result = rebrand("ui/src/a.tsx", source);
  assert.equal(result.text, source.replace("keeps Paperclip", "keeps Phi Bot"));
  assert.equal(result.count, 1);
  assert.deepEqual(result.remaining, []);
});

test("the lucide Paperclip icon and other identifiers are untouched", () => {
  const source = "import { Paperclip } from \"lucide-react\";\nexport const I = () => <Paperclip className=\"size-4\" aria-hidden />;\nconst Paperclip2 = Paperclip;\n";
  const result = rebrand("ui/src/a.tsx", source);
  assert.equal(result.text, source);
  assert.equal(result.count, 0);
  assert.deepEqual(result.remaining, []);
});

test("comments are untouched", () => {
  const source = "// Paperclip\n/* Paperclip */\nexport const C = () => <div>{/* Paperclip */}</div>;\n";
  const result = rebrand("ui/src/a.tsx", source);
  assert.equal(result.text, source);
  assert.deepEqual(result.remaining, []);
});

test("only the whole word is replaced", () => {
  const source = "const a = \"PaperclipLockup paperclip Paperclips Paperclip's\";\n";
  const result = rebrand("ui/src/a.ts", source);
  assert.equal(result.text, "const a = \"PaperclipLockup paperclip Paperclips Phi Bot's\";\n");
  assert.deepEqual(findBrandWords("X-Paperclip Paperclip"), [12]);
});

test("positions stay exact after non-ASCII text and a byte order mark", () => {
  const source = "\uFEFFconst s = \"\u00e9\u2019\ud83d\ude00\";\nconst t = \"Paperclip\";\n";
  const result = rebrand("ui/src/a.ts", source);
  assert.equal(result.text, "\uFEFFconst s = \"\u00e9\u2019\ud83d\ude00\";\nconst t = \"Phi Bot\";\n");
});

test("an allowlisted literal is neither rewritten nor reported", () => {
  const allowlist = parseAllowlist("ui/src/a.ts | Paperclip needs a disposition\n");
  const source = "const a = \"Paperclip needs a disposition before this issue can continue.\";\nconst b = \"Paperclip\";\n";
  const result = rebrand("ui/src/a.ts", source, allowlist);
  assert.equal(result.text, source.replace("\"Paperclip\";", "\"Phi Bot\";"));
  assert.deepEqual(result.remaining, []);
  assert.equal(allowlist[0].used, true);
});

test("regular expressions are untouched", () => {
  const source = "const ok = /^Paperclip exhausted/i.test(text);\n";
  const result = rebrand("ui/src/a.ts", source);
  assert.equal(result.text, source);
  assert.deepEqual(result.remaining, []);
});

test("a file with a syntax error is reported and left unchanged", () => {
  const source = "const a = \"Paperclip;\n";
  const result = rebrand("ui/src/a.ts", source);
  assert.equal(result.text, source);
  assert.equal(result.error, "Unterminated string literal.");
});

test("the service worker template is rebranded, its cache name is not", () => {
  const source = "const page = `<title>Paperclip is offline</title><h1>Paperclip is offline</h1>`;\nconst CACHE_NAME = `paperclip-public-assets-${BUILD_ID}`;\n";
  const result = rebrand("ui/public/sw.js", source);
  assert.equal(result.text, source.replaceAll("Paperclip is offline", "Phi Bot is offline"));
  assert.equal(result.count, 2);
});

test("rebranding twice changes nothing more", () => {
  const first = rebrand("ui/src/a.tsx", "export const A = () => <p title=\"Paperclip\">Paperclip</p>;\n");
  const second = rebrand("ui/src/a.tsx", first.text);
  assert.equal(second.text, first.text);
  assert.equal(second.count, 0);
});

test("inputs exclude tests, specs, stories, __tests__ and storybook", () => {
  assert.equal(isUiSourceInput("ui/src/App.tsx"), true);
  assert.equal(isUiSourceInput("ui/src/lib/utils.ts"), true);
  assert.equal(isUiSourceInput("ui/src/vite-env.d.ts"), true);
  assert.equal(isUiSourceInput("ui/src/App.test.tsx"), false);
  assert.equal(isUiSourceInput("ui/src/lib/a.spec.ts"), false);
  assert.equal(isUiSourceInput("ui/src/components/Button.stories.tsx"), false);
  assert.equal(isUiSourceInput("ui/src/__tests__/a.ts"), false);
  assert.equal(isUiSourceInput("ui/src/storybook/a.tsx"), false);
  assert.equal(isUiSourceInput("ui/src/index.css"), false);
  assert.equal(isUiSourceInput("server/src/app.ts"), false);
});

test("the allowlist parser keeps entries and rejects malformed lines", () => {
  const entries = parseAllowlist("# comment\n\nui/src/a.ts | Paperclip text\n");
  assert.deepEqual(entries, [{ path: "ui/src/a.ts", text: "Paperclip text", line: 3, used: false }]);
  assert.throws(() => parseAllowlist("ui/src/a.ts Paperclip text\n"), /rebrand-allowlist\.txt:1: expected/);
});

test("index.html: title, app title and startup texts are rebranded", () => {
  const html = [
    "<meta name=\"apple-mobile-web-app-title\" content=\"Paperclip\" />",
    "<title>Paperclip</title>",
    "<script>const key = \"paperclip.theme\";</script>",
    "<section id=\"paperclip-startup\"><h1>Paperclip couldn\u2019t start</h1></section>",
    "<script>title.textContent = \"Paperclip couldn\u2019t start\"; later = \"Paperclip is taking longer to load\";</script>",
    "",
  ].join("\n");
  const result = rebrandHtml(html, "ui/index.html", []);
  assert.equal(result.count, 5);
  assert.equal(result.text, html.replaceAll("Paperclip", "Phi Bot"));
  assert.deepEqual(result.remaining, []);
  const extra = rebrandHtml("<p>Paperclip docs</p>\n", "ui/index.html", []);
  assert.deepEqual(extra.remaining, [
    { path: "ui/index.html", line: 1, column: 4, reason: "html", excerpt: "<p>Paperclip docs</p>" },
  ]);
});

test("site.webmanifest: name and short_name are rebranded, other fields are reported", () => {
  const manifest = "{\n  \"name\": \"Paperclip\",\n  \"short_name\": \"Paperclip\",\n  \"description\": \"Paperclip board\"\n}\n";
  const result = rebrandManifest(manifest, "ui/public/site.webmanifest", []);
  assert.equal(result.count, 2);
  assert.equal(result.text, manifest.replace("\"name\": \"Paperclip\"", "\"name\": \"Phi Bot\"").replace("\"short_name\": \"Paperclip\"", "\"short_name\": \"Phi Bot\""));
  assert.deepEqual(result.remaining.map((item) => `${item.line}:${item.reason}`), ["4:manifest"]);
});

test("forEachJsonString gives each string value with the key that holds it", () => {
  const json = "{\"a\": \"x\", \"b\": [\"y\", {\"c\": \"q\\\"z\"}], \"d\": 1, \"e\": null}";
  const seen = [];
  forEachJsonString(json, (start, end, key) => seen.push(`${key}=${json.slice(start, end)}`));
  assert.deepEqual(seen, ["a=\"x\"", "b=\"y\"", "c=\"q\\\"z\""]);
});

test("app definitions: only display keys are rebranded and the formatting is kept", () => {
  const json = [
    "{",
    "  \"name\": \"Paperclip Demo\",",
    "  \"description\": \"Delegate tasks and watch them in Paperclip.\",",
    "  \"methods\": [",
    "    {",
    "      \"key\": \"paperclip-oauth\",",
    "      \"label\": \"Connect with Paperclip\",",
    "      \"warnings\": [\"Paperclip stores the token.\", \"Read paperclip.ing before Paperclip runs.\"],",
    "      \"credentialFields\": [{ \"key\": \"apiKey\", \"helperMd\": \"Paperclip keeps this key encrypted.\" }]",
    "    }",
    "  ]",
    "}",
    "",
  ].join("\n");
  const result = rebrandAppDefinition(json, "packages/shared/src/app-definitions/demo.json", []);
  assert.equal(result.count, 4);
  assert.equal(result.text, json
    .replace("watch them in Paperclip.", "watch them in Phi Bot.")
    .replace("Connect with Paperclip", "Connect with Phi Bot")
    .replace("\"Paperclip stores", "\"Phi Bot stores")
    .replace("Paperclip keeps", "Phi Bot keeps"));
  assert.deepEqual(result.remaining.map((item) => `${item.line}:${item.reason}`), ["2:json key name", "8:contains paperclip."]);
});

test("app definitions: invalid JSON is reported and left unchanged", () => {
  const json = "{\"label\": \"Paperclip\",}\n";
  const result = rebrandAppDefinition(json, "packages/shared/src/app-definitions/bad.json", []);
  assert.equal(result.text, json);
  assert.equal(result.count, 0);
  assert.match(result.error, /JSON/);
});

test("brand overrides: copy, already applied, missing upstream, changed upstream, missing source", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "phibot-overrides-"));
  const files = {
    "ui/a.txt": "upstream a",
    "phibot/branding/overrides/ui/a.txt": "phi a",
    "ui/b.txt": "phi b",
    "phibot/branding/overrides/ui/b.txt": "phi b",
    "phibot/branding/overrides/ui/c.txt": "phi c",
    "ui/d.txt": "upstream d, edited",
    "phibot/branding/overrides/ui/d.txt": "phi d",
    "ui/e.txt": "upstream e",
  };
  try {
    for (const [relPath, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, relPath)), { recursive: true });
      writeFileSync(path.join(root, relPath), content);
    }
    const hash = (text) => sha256Hex(Buffer.from(text));
    const plan = planBrandOverrides(root, ["a", "b", "c", "d", "e"].map((name) => ({
      path: `ui/${name}.txt`,
      upstreamSha256: hash(`upstream ${name}`),
    })));
    assert.deepEqual(plan.toCopy, ["ui/a.txt"]);
    assert.deepEqual(plan.errors, [
      "upstream file ui/c.txt no longer exists; find where upstream moved it, then update BRAND_OVERRIDES",
      `upstream file ui/d.txt changed (sha256 ${hash("upstream d, edited")}); port the change into phibot/branding/overrides/ui/d.txt, then update upstreamSha256 in BRAND_OVERRIDES`,
      "missing override source phibot/branding/overrides/ui/e.txt",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the override list names the three upstream brand files", () => {
  assert.deepEqual(BRAND_OVERRIDES.map((entry) => entry.path), [
    "ui/public/paperclip-thinking.svg",
    "ui/src/components/AnimatedPaperclipIcon.tsx",
    "ui/src/components/PaperclipLockup.tsx",
  ]);
  for (const entry of BRAND_OVERRIDES) assert.match(entry.upstreamSha256, /^[0-9a-f]{64}$/);
});
