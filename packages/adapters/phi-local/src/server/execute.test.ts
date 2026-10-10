import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { PHIBOT_PLATFORM_PROMPT_LINE } from "./phi-cli-args.js";

// Stand-in for phi: dumps what it received, prints a phi-like JSON stream.
const FAKE_PHI = String.raw`
import fs from "node:fs";
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const sessionFile = at("--session");
  if (sessionFile && !fs.existsSync(sessionFile)) {
    fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: "fake", cwd: process.cwd() }) + "\n");
  }
  const systemPromptFile = at("--append-system-prompt");
  const systemPrompt = systemPromptFile && fs.existsSync(systemPromptFile) ? fs.readFileSync(systemPromptFile, "utf8") : null;
  const settingsFile = process.env.PHI_CODING_AGENT_DIR + "/settings.json";
  const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : null;
  fs.appendFileSync(process.env.FAKE_PHI_DUMP, JSON.stringify({ args, stdin, env: process.env, cwd: process.cwd(), systemPrompt, settings }) + "\n");
  const mode = process.env.FAKE_PHI_MODE || "ok";
  const out = (event) => process.stdout.write(JSON.stringify(event) + "\n");
  const message = mode === "auth"
    ? { role: "assistant", content: [], stopReason: "error", errorMessage: "401 invalid x-api-key", usage: { input: 0, output: 0, cacheRead: 0, cost: { total: 0 } } }
    : { role: "assistant", content: [{ type: "text", text: "hello from fake phi" }], stopReason: "stop", provider: "anthropic", model: "claude-test", usage: { input: 10, output: 2, cacheRead: 0, cost: { total: 0.001 } } };
  out({ type: "session", version: 3, id: "fake", cwd: process.cwd() });
  out({ type: "agent_start" });
  out({ type: "message_end", message });
  out({ type: "turn_end", message, toolResults: [] });
  out({ type: "agent_end", messages: [message], willRetry: false });
  out({ type: "agent_settled" });
  if (mode === "hang") setInterval(() => {}, 1000);
});
`;

let root = "";
let workspace = "";
let dumpFile = "";
const savedEnv = { ...process.env };
const companyId = randomUUID();
const agentId = randomUUID();

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "phi-exec-"));
  workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const fake = path.join(root, "fake-phi.mjs");
  await fs.writeFile(fake, FAKE_PHI);
  dumpFile = path.join(root, "dump.jsonl");
  process.env.PHIBOT_PHI_CLI = fake;
  process.env.PHIBOT_HOME = path.join(root, "phibot");
  process.env.DATABASE_URL = "postgres://paperclip:secret@localhost:54329/paperclip";
  process.env.BETTER_AUTH_SECRET = "server-secret";
  process.env.ANTHROPIC_API_KEY = "operator-key";
});

afterAll(async () => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await fs.rm(root, { recursive: true, force: true });
});

function makeCtx(overrides: Partial<AdapterExecutionContext> = {}, envOverrides: Record<string, string> = {}): AdapterExecutionContext {
  return {
    runId: randomUUID(),
    agent: { id: agentId, companyId, name: "CEO", adapterType: "phi_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      cwd: workspace,
      terminalResultCleanupGraceMs: 200,
      env: {
        PHIBOT_LLM_PROVIDER: "anthropic",
        PHIBOT_LLM_API_KEY: "sk-company",
        PHIBOT_LLM_BASE_URL: "unset",
        PHIBOT_DEFAULT_MODEL: "anthropic/claude-test",
        FAKE_PHI_DUMP: dumpFile,
        ...envOverrides,
      },
    },
    context: {},
    onLog: async () => {},
    authToken: "run-jwt",
    ...overrides,
  };
}

async function lastDump(): Promise<{
  args: string[];
  stdin: string;
  env: Record<string, string>;
  systemPrompt: string | null;
  settings: { defaultTools?: string[] } | null;
}> {
  const lines = (await fs.readFile(dumpFile, "utf8")).trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!);
}

describe("phi_local execute (local process)", () => {
  it("runs phi with the company provider, a whitelisted environment and the prompt on stdin", async () => {
    const result = await execute(makeCtx());
    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toBe("hello from fake phi");
    expect(result.model).toBe("anthropic/claude-test");
    expect(result.provider).toBe("anthropic");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 });

    const dump = await lastDump();
    const flag = (name: string) => dump.args[dump.args.indexOf(name) + 1];
    expect(flag("--mode")).toBe("json");
    expect(flag("--provider")).toBe("anthropic");
    expect(flag("--model")).toBe("claude-test");
    expect(flag("--exclude-tools")).toBe("goal_complete,phase_result");
    expect(dump.args).toContain("--no-approve");
    expect(dump.args).not.toContain("--tools");
    expect(dump.args).not.toContain("-p");
    expect(dump.stdin.startsWith("Phi Bot task:\n")).toBe(true);
    expect(dump.systemPrompt).toContain(`You are agent ${agentId} (CEO).`);
    expect(dump.systemPrompt?.trimEnd().endsWith(PHIBOT_PLATFORM_PROMPT_LINE)).toBe(true);
    // phi reads defaultTools from the agent dir settings: grep, find and ls are active in the run.
    expect(dump.settings?.defaultTools).toEqual(expect.arrayContaining(["grep", "find", "ls"]));

    expect(dump.env.ANTHROPIC_API_KEY).toBe("sk-company");
    expect(dump.env.PAPERCLIP_API_KEY).toBe("run-jwt");
    expect(dump.env.PHI_OFFLINE).toBe("1");
    expect(dump.env.PHI_CODING_AGENT_DIR).toBe(path.join(root, "phibot", "companies", companyId, "agent"));
    expect(dump.env.DATABASE_URL).toBeUndefined();
    expect(dump.env.BETTER_AUTH_SECRET).toBeUndefined();

    const sessionFile = flag("--session");
    expect(path.dirname(sessionFile)).toBe(path.join(root, "phibot", "companies", companyId, "sessions", agentId));
    expect(result.sessionParams).toMatchObject({ sessionId: sessionFile, cwd: workspace });

    // The per-run directory (system prompt file) is removed after the run.
    await expect(fs.stat(path.dirname(flag("--append-system-prompt")))).rejects.toThrow();

    // Next run resumes the same session file.
    const resumed = await execute(
      makeCtx({ runtime: { sessionId: sessionFile, sessionParams: result.sessionParams ?? null, sessionDisplayId: sessionFile, taskKey: null } }),
    );
    expect(resumed.exitCode).toBe(0);
    const second = await lastDump();
    expect(second.args[second.args.indexOf("--session") + 1]).toBe(sessionFile);
  });

  it("starts a fresh session for a session file that is not this agent's", async () => {
    const foreign = path.join(root, "foreign.jsonl");
    await fs.writeFile(foreign, `${JSON.stringify({ type: "session", cwd: workspace })}\n`);
    await execute(makeCtx({ runtime: { sessionId: foreign, sessionParams: { sessionId: foreign, cwd: workspace }, sessionDisplayId: null, taskKey: null } }));
    const dump = await lastDump();
    expect(dump.args[dump.args.indexOf("--session") + 1]).not.toBe(foreign);
  });

  it("fails without spawning phi when the company provider is not configured", async () => {
    const before = (await fs.readFile(dumpFile, "utf8")).length;
    const result = await execute(makeCtx({}, { PHIBOT_LLM_PROVIDER: "unset" }));
    expect(result).toMatchObject({ exitCode: 1, errorCode: "phibot_llm_provider_missing", errorFamily: "configuration" });
    expect((await fs.readFile(dumpFile, "utf8")).length).toBe(before);
  });

  it("reports a provider failure from the JSON stream even when phi exits 0", async () => {
    const result = await execute(makeCtx({}, { FAKE_PHI_MODE: "auth" }));
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe("401 invalid x-api-key");
  });

  it("stops a phi process that does not exit after agent_settled and keeps the run successful", async () => {
    const result = await execute(makeCtx({}, { FAKE_PHI_MODE: "hang" }));
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.resultJson?.unmanagedBackgroundTask).toMatchObject({ stopped: true });
  });
});
