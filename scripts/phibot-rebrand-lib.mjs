// Phi Bot build-time UI rebranding: the functions behind scripts/phibot-rebrand.mjs
// (PHIBOT-SOLO-SPEC.md section 10.2). TypeScript and JavaScript sources are parsed
// with the TypeScript 7 compiler API (typescript/unstable/sync, which drives the
// native tsgo parser) and rewritten by position: only the replaced words change.
// The app catalog JSON files are rewritten by position too, in display keys only,
// and a short explicit list of brand components is replaced by Phi Bot versions.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { SyntaxKind } from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";

export const BRAND_WORD = "Paperclip";
export const BRAND_NAME = "Phi Bot";
export const EXCLUDED_MARKERS = ["@paperclipai", "PAPERCLIP_", "X-Paperclip", "paperclip.", "paperclip-"];
export const HTML_INPUT = "ui/index.html";
export const MANIFEST_INPUT = "ui/public/site.webmanifest";
export const EXTRA_SCRIPT_INPUTS = ["ui/public/sw.js"];
export const ALLOWLIST_PATH = "phibot/branding/rebrand-allowlist.txt";
export const BRAND_SOURCE_DIR = "phibot/branding";
export const BRAND_TARGET_DIR = "ui/public";
export const BRAND_FILES = [
  "favicon-16x16.png",
  "favicon-32x32.png",
  "favicon.ico",
  "favicon.svg",
  "apple-touch-icon.png",
  "android-chrome-192x192.png",
  "android-chrome-512x512.png",
];
// App catalog shown by the connection screens (served by the server and bundled
// in the UI): only the string values of these keys are user-facing text.
export const APP_DEFINITIONS_DIR = "packages/shared/src/app-definitions";
export const APP_DEFINITION_DISPLAY_KEYS = new Set([
  "description",
  "guidanceMd",
  "helperMd",
  "label",
  "steps",
  "warnings",
  "whenToUse",
]);
// Upstream files replaced at build time by phibot/branding/overrides/<path>.
// upstreamSha256 is the upstream content each replacement was written for: when
// upstream changes the file, the run stops so the change can be reviewed.
export const OVERRIDE_SOURCE_DIR = "phibot/branding/overrides";
export const BRAND_OVERRIDES = [
  {
    path: "ui/public/paperclip-thinking.svg",
    upstreamSha256: "426c34b3c05b62bd09a852489e18fa1198a7e4712d088c6897a4b24b54d44f6f",
  },
  {
    path: "ui/src/components/AnimatedPaperclipIcon.tsx",
    upstreamSha256: "5008bd61c2da0f8cba811b34e59f62827a6cbb77b19ac549b6d606ebe0183bc1",
  },
  {
    path: "ui/src/components/PaperclipLockup.tsx",
    upstreamSha256: "a3df1aa61ae61e7a81339f5edc0fed59f5ed508b9d681376c27243bd6acaa985",
  },
];

const WORD_PATTERN = /\bPaperclip\b/g;
const BOM = "\uFEFF";
const VIRTUAL_ROOT = "/phibot-rebrand";
const VIRTUAL_TSCONFIG = `${VIRTUAL_ROOT}/tsconfig.json`;
const PARSE_OPTIONS = { noLib: true, noResolve: true, types: [], jsx: "preserve", allowJs: true, noEmit: true };
const LITERAL_KINDS = new Set([
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateHead,
  SyntaxKind.TemplateMiddle,
  SyntaxKind.TemplateTail,
]);
const NAMED_MEMBER_KINDS = new Set([
  SyntaxKind.PropertyAssignment,
  SyntaxKind.PropertySignature,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.MethodSignature,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.EnumMember,
]);
const HTML_RULES = [
  /(<title>)([^<]*)(<\/title>)/g,
  /(<meta\s+name="apple-mobile-web-app-title"\s+content=")([^"]*)(")/g,
  /()(Paperclip couldn\u2019t start)()/g,
  /()(Paperclip is taking longer to load)()/g,
];
const MANIFEST_RULE = /("(?:name|short_name)"\s*:\s*")((?:[^"\\]|\\.)*)(")/g;

// Offsets of the brand word, skipping header names such as X-Paperclip-Run-Id.
export function findBrandWords(text) {
  const offsets = [];
  for (const match of text.matchAll(WORD_PATTERN)) {
    if (text.slice(Math.max(0, match.index - 2), match.index) !== "X-") offsets.push(match.index);
  }
  return offsets;
}

export function replaceAt(text, offsets) {
  let output = "";
  let last = 0;
  for (const offset of [...offsets].sort((a, b) => a - b)) {
    output += text.slice(last, offset) + BRAND_NAME;
    last = offset + BRAND_WORD.length;
  }
  return output + text.slice(last);
}

export function replaceBrandWords(text) {
  const offsets = findBrandWords(text);
  return { text: replaceAt(text, offsets), count: offsets.length };
}

// ui/src/**/*.{ts,tsx} without tests, specs, stories, __tests__/ and storybook/.
export function isUiSourceInput(relPath) {
  const parts = relPath.split("/");
  const name = parts[parts.length - 1];
  return parts[0] === "ui" && parts[1] === "src" && /\.tsx?$/.test(name)
    && !/\.(test|spec|stories)\./.test(name)
    && !parts.includes("__tests__") && !parts.includes("storybook");
}

export function listUiSourceInputs(repoRoot) {
  const found = [];
  const walk = (relDir) => {
    for (const entry of readdirSync(join(repoRoot, relDir), { withFileTypes: true })) {
      const relPath = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) walk(relPath);
      else if (entry.isFile() && isUiSourceInput(relPath)) found.push(relPath);
    }
  };
  walk("ui/src");
  return found.sort();
}

// Allowlist lines: "<path> | <text>"; "#" starts a comment line.
export function parseAllowlist(text) {
  const entries = [];
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return;
    const separator = line.indexOf(" | ");
    if (separator <= 0 || separator + 3 >= line.length) {
      throw new Error(`${ALLOWLIST_PATH}:${index + 1}: expected "<path> | <text>"`);
    }
    entries.push({ path: line.slice(0, separator), text: line.slice(separator + 3), line: index + 1, used: false });
  });
  return entries;
}

export function findAllowlistEntry(allowlist, relPath, text) {
  const entry = allowlist.find((candidate) => candidate.path === relPath && text.includes(candidate.text));
  if (entry) entry.used = true;
  return entry;
}

export function lineAndColumn(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - before.lastIndexOf("\n") };
}

function excerpt(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 100 ? `${flat.slice(0, 97)}...` : flat;
}

function literalExpressionOf(node) {
  if (node.kind === SyntaxKind.TemplateHead) return node.parent;
  if (node.kind === SyntaxKind.TemplateMiddle || node.kind === SyntaxKind.TemplateTail) return node.parent.parent;
  return node;
}

function isModuleSpecifier(literal, text) {
  const parent = literal.parent;
  switch (parent.kind) {
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.ExportDeclaration:
      return parent.moduleSpecifier === literal;
    case SyntaxKind.ExternalModuleReference:
    case SyntaxKind.ImportAttribute:
      return true;
    case SyntaxKind.ModuleDeclaration:
      return parent.name === literal;
    case SyntaxKind.CallExpression: {
      const callee = parent.expression;
      if (parent.arguments[0] !== literal) return false;
      if (callee.kind === SyntaxKind.ImportKeyword) return true;
      return callee.kind === SyntaxKind.Identifier && text.slice(callee.getStart(), callee.end) === "require";
    }
    default:
      return false;
  }
}

function isPropertyName(literal) {
  const parent = literal.parent;
  if (NAMED_MEMBER_KINDS.has(parent.kind)) return parent.name === literal;
  if (parent.kind === SyntaxKind.BindingElement) return parent.propertyName === literal;
  if (parent.kind === SyntaxKind.ElementAccessExpression) return parent.argumentExpression === literal;
  return parent.kind === SyntaxKind.ComputedPropertyName
    || parent.kind === SyntaxKind.ImportSpecifier
    || parent.kind === SyntaxKind.ExportSpecifier;
}

function isInTypePosition(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (current.kind >= SyntaxKind.FirstTypeNode && current.kind <= SyntaxKind.LastTypeNode) return true;
  }
  return false;
}

function literalSkipReason(node, unitText, text) {
  const literal = literalExpressionOf(node);
  if (isModuleSpecifier(literal, text)) return "module specifier";
  if (isPropertyName(literal)) return "property name";
  if (isInTypePosition(literal)) return "type";
  const marker = EXCLUDED_MARKERS.find((candidate) => unitText.includes(candidate));
  return marker ? `contains ${marker}` : null;
}

// One text unit (JSX text or literal): replace its words, or record them as remaining.
function handleUnit(state, start, end, getSkipReason) {
  const unitText = state.text.slice(start, end);
  const offsets = findBrandWords(unitText);
  if (offsets.length === 0 || findAllowlistEntry(state.allowlist, state.relPath, unitText)) return;
  const reason = getSkipReason(unitText);
  for (const offset of offsets) {
    if (!reason) {
      state.edits.push(start + offset);
      continue;
    }
    const { line, column } = lineAndColumn(state.text, start + offset);
    state.remaining.push({ path: state.relPath, line, column, reason, excerpt: excerpt(unitText) });
  }
}

export function rebrandParsedSource(sourceFile, text, relPath, allowlist) {
  const state = { text, relPath, allowlist, edits: [], remaining: [] };
  const visit = (node) => {
    if (node.kind === SyntaxKind.JsxText) {
      handleUnit(state, node.pos, node.end, () => null);
    } else if (LITERAL_KINDS.has(node.kind)) {
      handleUnit(state, node.getStart(), node.end, (unitText) => literalSkipReason(node, unitText, text));
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return { relPath, text: replaceAt(text, state.edits), count: state.edits.length, remaining: state.remaining };
}

function syntaxErrorsByPath(program) {
  const errors = new Map();
  for (const diagnostic of program.getSyntacticDiagnostics()) {
    const name = diagnostic.fileName ?? "";
    if (!name.startsWith(`${VIRTUAL_ROOT}/`)) continue;
    const relPath = name.slice(VIRTUAL_ROOT.length + 1);
    if (!errors.has(relPath)) errors.set(relPath, diagnostic.text);
  }
  return errors;
}

// sources: [{ relPath, text }] -> [{ relPath, text, count, remaining, error }]
export function rebrandSources(sources, allowlist) {
  if (sources.length === 0) return [];
  const bodies = sources.map((source) => (source.text.startsWith(BOM) ? source.text.slice(1) : source.text));
  const files = {
    [VIRTUAL_TSCONFIG]: JSON.stringify({
      compilerOptions: PARSE_OPTIONS,
      files: sources.map((source) => `${VIRTUAL_ROOT}/${source.relPath}`),
    }),
  };
  sources.forEach((source, index) => {
    files[`${VIRTUAL_ROOT}/${source.relPath}`] = bodies[index];
  });
  const api = new API({ cwd: VIRTUAL_ROOT, fs: createVirtualFileSystem(files) });
  try {
    const program = api.updateSnapshot({ openProjects: [VIRTUAL_TSCONFIG] }).getProject(VIRTUAL_TSCONFIG).program;
    const errors = syntaxErrorsByPath(program);
    return sources.map((source, index) => {
      if (errors.has(source.relPath)) {
        return { relPath: source.relPath, text: source.text, count: 0, remaining: [], error: errors.get(source.relPath) };
      }
      const sourceFile = program.getSourceFile(`${VIRTUAL_ROOT}/${source.relPath}`);
      const result = rebrandParsedSource(sourceFile, bodies[index], source.relPath, allowlist);
      const bom = source.text.startsWith(BOM) ? BOM : "";
      return { ...result, text: bom + result.text, error: null };
    });
  } finally {
    api.close();
  }
}

// Brand words still present in a non-TypeScript file, checked line by line.
export function leftoverWords(text, relPath, allowlist, reason) {
  const remaining = [];
  const lines = text.split("\n");
  lines.forEach((lineText, index) => {
    const offsets = findBrandWords(lineText);
    if (offsets.length === 0 || findAllowlistEntry(allowlist, relPath, lineText)) return;
    for (const offset of offsets) {
      remaining.push({ path: relPath, line: index + 1, column: offset + 1, reason, excerpt: excerpt(lineText) });
    }
  });
  return remaining;
}

function applyRules(text, rules) {
  let count = 0;
  let output = text;
  for (const rule of rules) {
    output = output.replace(rule, (match, before, value, after) => {
      const result = replaceBrandWords(value);
      count += result.count;
      return before + result.text + after;
    });
  }
  return { output, count };
}

// ui/index.html: <title>, apple-mobile-web-app-title and the startup notice texts.
export function rebrandHtml(text, relPath, allowlist) {
  const { output, count } = applyRules(text, HTML_RULES);
  return { relPath, text: output, count, remaining: leftoverWords(output, relPath, allowlist, "html"), error: null };
}

// ui/public/site.webmanifest: "name" and "short_name".
export function rebrandManifest(text, relPath, allowlist) {
  const { output, count } = applyRules(text, [MANIFEST_RULE]);
  return { relPath, text: output, count, remaining: leftoverWords(output, relPath, allowlist, "manifest"), error: null };
}

function skipWhitespace(text, index) {
  let at = index;
  while (at < text.length && " \t\r\n".includes(text[at])) at += 1;
  return at;
}

function jsonStringEnd(text, start) {
  let at = start + 1;
  while (text[at] !== "\"") at += text[at] === "\\" ? 2 : 1;
  return at + 1;
}

// Calls visit(start, end, key) for every string value of a valid JSON text, with
// the name of its property; the items of an array get the name of the array.
export function forEachJsonString(text, visit) {
  JSON.parse(text);
  const value = (at, key) => {
    const start = skipWhitespace(text, at);
    if (text[start] === "\"") {
      const end = jsonStringEnd(text, start);
      visit(start, end, key);
      return end;
    }
    if (text[start] === "{" || text[start] === "[") return container(start, key);
    let end = start;
    while (end < text.length && !",]} \t\r\n".includes(text[end])) end += 1;
    return end;
  };
  const container = (start, key) => {
    const close = text[start] === "{" ? "}" : "]";
    let at = skipWhitespace(text, start + 1);
    while (text[at] !== close) {
      let name = key;
      if (close === "}") {
        const keyEnd = jsonStringEnd(text, at);
        name = JSON.parse(text.slice(at, keyEnd));
        at = skipWhitespace(text, keyEnd) + 1;
      }
      at = skipWhitespace(text, value(at, name));
      if (text[at] === ",") at = skipWhitespace(text, at + 1);
    }
    return at + 1;
  };
  value(0, "");
}

// packages/shared/src/app-definitions/*.json: the word is replaced only in the
// string values of APP_DEFINITION_DISPLAY_KEYS; a word under another key is reported.
export function rebrandAppDefinition(text, relPath, allowlist) {
  const state = { text, relPath, allowlist, edits: [], remaining: [] };
  const skipReason = (key) => (unitText) => {
    if (!APP_DEFINITION_DISPLAY_KEYS.has(key)) return `json key ${key}`;
    const marker = EXCLUDED_MARKERS.find((candidate) => unitText.includes(candidate));
    return marker ? `contains ${marker}` : null;
  };
  try {
    forEachJsonString(text, (start, end, key) => handleUnit(state, start, end, skipReason(key)));
  } catch (error) {
    return { relPath, text, count: 0, remaining: [], error: error instanceof Error ? error.message : String(error) };
  }
  return { relPath, text: replaceAt(text, state.edits), count: state.edits.length, remaining: state.remaining, error: null };
}

export function listAppDefinitionInputs(repoRoot) {
  const dir = join(repoRoot, APP_DEFINITIONS_DIR);
  if (!existsSync(dir)) throw new Error(`missing directory: ${APP_DEFINITIONS_DIR}`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => `${APP_DEFINITIONS_DIR}/${entry.name}`)
    .sort();
}

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// Overrides still to copy, and the reasons an override cannot be applied.
export function planBrandOverrides(repoRoot, overrides) {
  const toCopy = [];
  const errors = [];
  for (const { path, upstreamSha256 } of overrides) {
    const sourcePath = `${OVERRIDE_SOURCE_DIR}/${path}`;
    if (!existsSync(join(repoRoot, sourcePath))) {
      errors.push(`missing override source ${sourcePath}`);
    } else if (!existsSync(join(repoRoot, path))) {
      errors.push(`upstream file ${path} no longer exists; find where upstream moved it, then update BRAND_OVERRIDES`);
    } else {
      const current = readFileSync(join(repoRoot, path));
      if (current.equals(readFileSync(join(repoRoot, sourcePath)))) continue;
      const digest = sha256Hex(current);
      if (digest === upstreamSha256) toCopy.push(path);
      else errors.push(`upstream file ${path} changed (sha256 ${digest}); port the change into ${sourcePath}, then update upstreamSha256 in BRAND_OVERRIDES`);
    }
  }
  return { toCopy, errors };
}
