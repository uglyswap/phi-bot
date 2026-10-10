import fs from "node:fs/promises";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { ensurePhiAgentDirReady } from "./agent-dir.js";
import { buildPhiChildEnv } from "./child-env.js";
import { parsePhiJsonl, PHI_SETTLED_EVENT_RE } from "./parse.js";
import { resolvePhiCompanyPaths } from "./paths.js";
import { readPhiCliVersion, resolvePhiCli } from "./phi-binary.js";
import { PHI_EXCLUDE_TOOLS_ARG } from "./phi-cli-args.js";
import { resolvePhiProviderSelection, writeManagedModelsJson } from "./runtime-config.js";

const PHI_AUTH_FAILURE_RE =
  /\b401\b|\b403\b|unauthori[sz]ed|invalid[\s_-]*(api[\s_-]*)?key|incorrect api key|authentication|permission denied|no api key/i;

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function clip(text: string, max = 240): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function stringEnv(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(parseObject(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const done = (): AdapterEnvironmentTestResult => ({
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  });
  const config = parseObject(ctx.config);

  if (ctx.executionTarget?.kind === "remote") {
    checks.push({
      code: "phi_remote_target_unsupported",
      level: "error",
      message: "phi_local runs only on the Phi Bot server itself.",
      hint: "Select the Local environment for this agent.",
    });
    return done();
  }

  const configuredCwd = asString(config.cwd, "").trim();
  const cwd = configuredCwd || process.cwd();
  if (configuredCwd) {
    try {
      await ensureAbsoluteDirectory(configuredCwd, { createIfMissing: false });
      checks.push({ code: "phi_cwd_valid", level: "info", message: `Working directory is valid: ${configuredCwd}` });
    } catch (err) {
      checks.push({
        code: "phi_cwd_invalid",
        level: "error",
        message: err instanceof Error ? err.message : "Invalid working directory",
        detail: configuredCwd,
      });
    }
  }

  const runEnv = stringEnv(config.env);
  const baseEnv = buildPhiChildEnv({ inherited: process.env, runEnv: {}, forced: {} });
  const cli = resolvePhiCli();
  let cliReady = true;
  if (cli.source === "path") {
    try {
      await ensureCommandResolvable(cli.command, cwd, baseEnv);
    } catch (err) {
      cliReady = false;
      checks.push({
        code: "phi_cli_missing",
        level: "error",
        message: err instanceof Error ? err.message : "phi is not installed.",
        hint: "Reinstall Phi Bot (it ships @phi-code-admin/phi-code), or set PHIBOT_PHI_CLI to phi's dist/cli.js.",
      });
    }
  }
  let phiVersion: string | null = null;
  if (cliReady) {
    phiVersion = await readPhiCliVersion(cli, { cwd, env: baseEnv });
    checks.push({
      code: "phi_cli_found",
      level: "info",
      message: `phi ${phiVersion ?? "(unknown version)"} found: ${cli.displayPath}`,
    });
  }

  const selectionResult = resolvePhiProviderSelection({ env: runEnv, agentModel: asString(config.model, "") });
  if (!selectionResult.ok) {
    checks.push({
      code: selectionResult.code,
      level: "error",
      message: selectionResult.message,
      hint: "Settings > AI provider. The test reads the variables of the environment selected for the test.",
    });
    return done();
  }
  const selection = selectionResult.selection;
  checks.push({
    code: "phibot_llm_configured",
    level: "info",
    message: `Provider ${selection.phibotProvider}, model ${selection.displayModel}${selection.usesCompanyDefaultModel ? " (company default)" : ""}.`,
  });
  if (!cliReady || checks.some((check) => check.code === "phi_cwd_invalid")) return done();

  const paths = resolvePhiCompanyPaths(ctx.companyId);
  await fs.mkdir(paths.agentDir, { recursive: true });
  await writeManagedModelsJson(paths.agentDir, selection.managedProviders);
  const env = buildPhiChildEnv({
    inherited: process.env,
    runEnv,
    forced: {
      ...selection.providerEnv,
      PHI_CODING_AGENT_DIR: paths.agentDir,
      PHI_OFFLINE: "1",
      PHI_TELEMETRY: "0",
    },
  });
  const args = [
    ...cli.prefixArgs,
    "--mode",
    "json",
    "--provider",
    selection.phiProvider,
    "--model",
    selection.modelId,
    "--no-session",
    "--no-approve",
    "--exclude-tools",
    PHI_EXCLUDE_TOOLS_ARG,
  ];
  try {
    // The first call copies phi's bundled extensions into the company agent dir (up to a minute).
    await ensurePhiAgentDirReady({ cli, version: phiVersion, agentDir: paths.agentDir, cwd, env });
    const probe = await runChildProcess(
      `phi-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      cli.command,
      args,
      {
        cwd,
        env,
        stdin: "Phi Bot connection test. Respond with the single word hello.",
        timeoutSec: 180,
        graceSec: 5,
        onLog: async () => {},
        inheritProcessEnv: false,
        terminalResultCleanup: { graceMs: 5_000, hasTerminalResult: ({ stdout }) => PHI_SETTLED_EVENT_RE.test(stdout) },
      },
    );
    const parsed = parsePhiJsonl(probe.stdout);
    const evidence = `${parsed.errors.join("\n")}\n${probe.stderr}`;
    const settledCleanly = parsed.settled && parsed.errors.length === 0;
    if (probe.timedOut && !parsed.settled) {
      checks.push({ code: "phi_hello_probe_timed_out", level: "warn", message: "The phi test did not finish within 3 minutes." });
    } else if (settledCleanly || ((probe.exitCode ?? 1) === 0 && parsed.errors.length === 0)) {
      const reply = (parsed.finalMessage ?? "").trim();
      const saidHello = /\bhello\b/i.test(reply);
      checks.push({
        code: saidHello ? "phi_hello_probe_passed" : "phi_hello_probe_unexpected_output",
        level: saidHello ? "info" : "warn",
        message: saidHello ? "phi answered through the configured provider." : "phi ran but did not answer hello.",
        ...(reply ? { detail: clip(reply) } : {}),
      });
    } else if (PHI_AUTH_FAILURE_RE.test(evidence)) {
      checks.push({
        code: "phi_hello_probe_auth_failed",
        level: "error",
        message: "The provider rejected the API key.",
        detail: clip(parsed.errors[0] ?? probe.stderr),
        hint: "Check the key in Settings > AI provider.",
      });
    } else {
      checks.push({
        code: "phi_hello_probe_failed",
        level: "error",
        message: "phi could not reach the model.",
        detail: clip(parsed.errors[0] ?? (probe.stderr || `exit code ${probe.exitCode ?? "unknown"}`)),
        hint: "Check the provider, the model and, for a custom provider, the base URL.",
      });
    }
  } catch (err) {
    checks.push({
      code: "phi_hello_probe_failed",
      level: "error",
      message: "phi could not be started.",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  return done();
}
