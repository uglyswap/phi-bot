import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { createProviderStoppedBoundary } from "@paperclipai/adapter-utils/provider-stopped-boundary";
import {
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  hydrateFreshSessionHandoff,
  isPaperclipRecoveryWakePayload,
  joinPromptSections,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  refreshPaperclipWorkspaceEnvForExecution,
  renderTemplate,
  resolveCommandForLogs,
  runChildProcess,
  selectInitialCommunicationGuidance,
  selectPaperclipPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import { findPhiBotProvider, PHIBOT_LLM_SECRET_KEYS } from "../providers.js";
import { ensurePhiAgentDirReady } from "./agent-dir.js";
import { buildPhiChildEnv } from "./child-env.js";
import { phiSupportsMcpConfigFile, PHI_MCP_CONFIG_ENV, writePhiMcpConfig } from "./mcp-config.js";
import { isPhiSessionUnavailableError, parsePhiJsonl, PHI_SETTLED_EVENT_RE } from "./parse.js";
import { isPathInside, resolvePhiAgentSessionsDir, resolvePhiCompanyPaths, resolvePhiRunDir } from "./paths.js";
import { readPhiCliVersion, resolvePhiCli } from "./phi-binary.js";
import { PHI_EXCLUDE_TOOLS_ARG, PHIBOT_PLATFORM_PROMPT_LINE } from "./phi-cli-args.js";
import {
  readPhiBotValue,
  resolvePhiProviderSelection,
  writeManagedModelsJson,
  type PhiProviderSelection,
} from "./runtime-config.js";
import { resolvePhiRunSkills } from "./skills.js";

/**
 * First line of the prompt sent on stdin. phi treats a prompt starting with
 * "/" as an extension command, a skill call or a prompt template
 * (`phi-release/packages/coding-agent/src/core/agent-session.ts:1214-1256`);
 * a fixed first line keeps Paperclip's text a plain message.
 */
export const PHI_PROMPT_PREFIX = "Phi Bot task:";

/** phi accepts these levels (`phi-release/packages/coding-agent/src/cli/args.ts:60`). */
const PHI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const QUOTA_RE = /\b429\b|rate[\s_-]?limit|insufficient_quota|quota|RESOURCE_EXHAUSTED/i;
const TRANSIENT_RE = /\b(500|502|503|504|529)\b|overloaded|temporarily unavailable|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i;

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

type PhiFailureFamily = NonNullable<AdapterExecutionResult["errorFamily"]>;

export function classifyPhiFailure(text: string): PhiFailureFamily | null {
  if (QUOTA_RE.test(text)) return "provider_quota";
  if (TRANSIENT_RE.test(text)) return "transient_upstream";
  return null;
}

function configurationFailure(code: string, message: string): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: message,
    errorCode: code,
    errorFamily: "configuration",
  };
}

function resolvePhiBiller(selection: PhiProviderSelection, env: Record<string, string>): string {
  if (!findPhiBotProvider(selection.phibotProvider)?.needsBaseUrl) return selection.phibotProvider;
  const baseUrl = readPhiBotValue(env, PHIBOT_LLM_SECRET_KEYS.baseUrl) ?? "";
  return /openrouter\.ai/i.test(baseUrl) ? "openrouter" : "custom";
}

async function readSessionHeaderCwd(sessionFile: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(sessionFile, "utf8");
    const headerLine = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (!headerLine) return null;
    const parsed = JSON.parse(headerLine) as Record<string, unknown>;
    if (parsed.type !== "session") return null;
    const cwd = typeof parsed.cwd === "string" ? parsed.cwd.trim() : "";
    return cwd.length > 0 ? cwd : null;
  } catch {
    return null;
  }
}

function newSessionFile(sessionsDir: string, runId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(sessionsDir, `${stamp}-${runId}.jsonl`);
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const providerStop = createProviderStoppedBoundary(ctx.onProviderStopped);
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  if (ctx.executionTarget?.kind === "remote" || ctx.executionTransport?.remoteExecution) {
    return configurationFailure(
      "phi_remote_target_unsupported",
      "phi_local runs only on the Phi Bot server itself. Select the Local environment for this agent.",
    );
  }

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const hasCustomPromptTemplate = asString(config.promptTemplate, "").trim().length > 0;
  const thinking = asString(config.thinking, "").trim();

  // Workspace and working directory: same rules as pi_local.
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // Run environment built by Paperclip: same variables as pi_local.
  const envConfig = parseObject(config.env);
  const runEnv: Record<string, string> = {
    ...buildPaperclipEnv(agent, ctx.agentIdentity),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  runEnv.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0 ? context.wakeReason.trim() : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0 ? context.approvalId.trim() : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) runEnv.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) runEnv.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) runEnv.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) runEnv.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) runEnv.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) runEnv.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) runEnv.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  refreshPaperclipWorkspaceEnvForExecution({
    env: runEnv,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote: false,
    executionCwd: cwd,
  });
  if (authToken) runEnv.PAPERCLIP_API_KEY = authToken;

  // Company provider and model (PHIBOT_LLM_* from the environment's envVars).
  const selectionResult = resolvePhiProviderSelection({ env: runEnv, agentModel: asString(config.model, "") });
  if (!selectionResult.ok) {
    await onLog("stderr", `[phibot] ${selectionResult.message}\n`);
    return configurationFailure(selectionResult.code, selectionResult.message);
  }
  const selection = selectionResult.selection;

  const companyPaths = resolvePhiCompanyPaths(agent.companyId);
  const sessionsDir = resolvePhiAgentSessionsDir(agent.companyId, agent.id);
  const runDir = resolvePhiRunDir(agent.companyId, runId);
  await fs.mkdir(companyPaths.agentDir, { recursive: true });
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.rm(runDir, { recursive: true, force: true });
  await fs.mkdir(runDir, { recursive: true });

  try {
    const commandNotes: string[] = [];
    const modelsJson = await writeManagedModelsJson(companyPaths.agentDir, selection.managedProviders);
    if (Object.keys(selection.managedProviders).length > 0) {
      commandNotes.push(`Provider ${selection.phiProvider} declared in ${modelsJson.path}.`);
    }

    const runSkills = await resolvePhiRunSkills(config);
    for (const key of runSkills.missing) {
      await onLog("stderr", `[phibot] Skill "${key}" is enabled but its files are unavailable; it was not passed to phi.\n`);
    }

    const cli = resolvePhiCli();
    const forced: Record<string, string> = {
      ...selection.providerEnv,
      PHI_CODING_AGENT_DIR: companyPaths.agentDir,
      PHI_OFFLINE: "1",
      PHI_TELEMETRY: "0",
    };
    let childEnv = buildPhiChildEnv({ inherited: process.env, runEnv, forced, prependPath: runSkills.binDirs });
    if (cli.source === "path") {
      await ensureCommandResolvable(cli.command, cwd, childEnv);
    }
    const phiVersion = await readPhiCliVersion(cli, { cwd, env: childEnv });
    await ensurePhiAgentDirReady({ cli, version: phiVersion, agentDir: companyPaths.agentDir, cwd, env: childEnv });

    const runtimeMcpServers = ctx.runtimeMcp?.getServers() ?? [];
    if (runtimeMcpServers.length > 0) {
      if (phiSupportsMcpConfigFile(phiVersion)) {
        forced[PHI_MCP_CONFIG_ENV] = await writePhiMcpConfig(runDir, runtimeMcpServers);
        childEnv = buildPhiChildEnv({ inherited: process.env, runEnv, forced, prependPath: runSkills.binDirs });
        commandNotes.push(`Delivered ${runtimeMcpServers.length} Paperclip MCP server(s) through ${PHI_MCP_CONFIG_ENV}.`);
      } else {
        commandNotes.push(
          `phi ${phiVersion ?? "(unknown version)"} cannot read a per-run MCP config (needs >= 0.100.0): ` +
            `${runtimeMcpServers.length} Paperclip MCP server(s) not delivered; runtime tools stay reachable through PAPERCLIP_RUNTIME_TOOLS_* variables.`,
        );
      }
    }

    const resolvedCommand =
      cli.source === "path"
        ? await resolveCommandForLogs(cli.command, cwd, childEnv)
        : `${cli.command} ${cli.displayPath}`;
    const loggedEnv = buildInvocationEnvForLogs(
      { ...runEnv, ...forced },
      { runtimeEnv: childEnv, includeRuntimeKeys: ["HOME"], resolvedCommand },
    );

    const timeoutSec = Math.max(0, asNumber(config.timeoutSec, 0));
    const graceSec = asNumber(config.graceSec, 20);
    const terminalCleanupGraceMs = Math.max(0, asNumber(config.terminalResultCleanupGraceMs, 5_000));
    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();
    if (thinking && !PHI_THINKING_LEVELS.has(thinking)) {
      commandNotes.push(`Ignored unknown thinking level "${thinking}".`);
    }

    // Session: resume only a session file this adapter created for this agent, in this cwd.
    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const sessionInsideOwnDir = runtimeSessionId.length > 0 && isPathInside(sessionsDir, runtimeSessionId);
    const sessionParamsCwdMatches =
      runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd);
    const savedSessionCwd = sessionInsideOwnDir ? await readSessionHeaderCwd(runtimeSessionId) : null;
    const canResumeSession =
      sessionInsideOwnDir &&
      sessionParamsCwdMatches &&
      savedSessionCwd !== null &&
      path.resolve(savedSessionCwd) === path.resolve(cwd);
    const sessionPath = canResumeSession ? runtimeSessionId : newSessionFile(sessionsDir, runId);
    if (runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[phibot] Session "${runtimeSessionId}" cannot be resumed in "${cwd}" ` +
          `(${sessionInsideOwnDir ? "different working directory" : "not a phi_local session of this agent"}); starting a fresh session.\n`,
      );
    }

    // System prompt extension: agent instructions file, then the default Paperclip policy.
    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    const resolvedInstructionsFilePath = instructionsFilePath ? path.resolve(cwd, instructionsFilePath) : "";
    const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
    let systemPromptExtension = promptTemplate;
    let instructionsReadFailed = false;
    if (resolvedInstructionsFilePath) {
      try {
        const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
        systemPromptExtension =
          `${instructionsContents}\n\n` +
          `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
          `Resolve any relative file references from ${instructionsFileDir}.\n\n` +
          (context.conversationMode === true
            ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
            : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
        commandNotes.push(`Loaded agent instructions from ${resolvedInstructionsFilePath}`);
      } catch (err) {
        instructionsReadFailed = true;
        const reason = err instanceof Error ? err.message : String(err);
        await onLog(
          "stdout",
          `[phibot] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
        );
        commandNotes.push(
          `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
        );
      }
    }
    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    // Spec 8.5: agent instructions, path directive, Paperclip policy, then the Phi Bot line.
    const renderedSystemPromptExtension = `${renderTemplate(systemPromptExtension, templateData).trimEnd()}\n\n${PHIBOT_PLATFORM_PROMPT_LINE}\n`;
    // A file, not an argument: no MAX_ARG_STRLEN / Windows command-line limit, nothing in `ps`.
    const systemPromptFile = path.join(runDir, "system-prompt.md");
    await fs.writeFile(systemPromptFile, renderedSystemPromptExtension, { encoding: "utf8", mode: 0o600 });
    const systemOwnsDefaultPolicy =
      !hasCustomPromptTemplate || Boolean(resolvedInstructionsFilePath && !instructionsReadFailed);
    const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();

    const buildArgs = (sessionFile: string): string[] => [
      ...cli.prefixArgs,
      "--mode",
      "json",
      "--append-system-prompt",
      systemPromptFile,
      "--provider",
      selection.phiProvider,
      "--model",
      selection.modelId,
      ...(thinking && PHI_THINKING_LEVELS.has(thinking) ? ["--thinking", thinking] : []),
      "--session",
      sessionFile,
      "--no-approve",
      "--exclude-tools",
      PHI_EXCLUDE_TOOLS_ARG,
      ...runSkills.skillDirs.flatMap((dir) => ["--skill", dir]),
      ...extraArgs,
    ];

    const runAttempt = async (sessionFile: string) => {
      const attemptResumedSession = canResumeSession && sessionFile === sessionPath;
      await hydrateFreshSessionHandoff(ctx, { resumedSession: attemptResumedSession });
      const attemptSections = selectPaperclipPromptSections(context, {
        resumedSession: attemptResumedSession,
        includeCommunicationGuidance: false,
        includeExecutionContract: systemOwnsDefaultPolicy ? false : undefined,
      });
      const attemptBootstrapPrompt =
        !attemptResumedSession && bootstrapPromptTemplate.trim().length > 0
          ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
          : "";
      const attemptWakePrompt = attemptSections.wakePrompt;
      const attemptRenderedHeartbeatPrompt =
        (attemptResumedSession && attemptWakePrompt.length > 0) ||
        isPaperclipRecoveryWakePayload(context.paperclipWake) ||
        !hasCustomPromptTemplate
          ? ""
          : renderTemplate(promptTemplate, templateData);
      const userPrompt = joinPromptSections([
        selectInitialCommunicationGuidance(context, { resumedSession: attemptResumedSession }),
        attemptBootstrapPrompt,
        attemptWakePrompt,
        attemptSections.taskContextNote,
        sessionHandoffNote,
        attemptRenderedHeartbeatPrompt,
      ]);
      const stdinPrompt = `${PHI_PROMPT_PREFIX}\n${userPrompt}`;
      const args = buildArgs(sessionFile);
      if (onMeta) {
        await onMeta({
          adapterType: "phi_local",
          command: resolvedCommand,
          cwd,
          commandNotes,
          commandArgs: args,
          env: loggedEnv,
          prompt: stdinPrompt,
          promptMetrics: {
            systemPromptChars: renderedSystemPromptExtension.length,
            promptChars: stdinPrompt.length,
            bootstrapPromptChars: attemptBootstrapPrompt.length,
            wakePromptChars: attemptWakePrompt.length,
            taskContextChars: attemptSections.taskContextNote.length,
            sessionHandoffChars: sessionHandoffNote.length,
            heartbeatPromptChars: attemptRenderedHeartbeatPrompt.length,
          },
          context,
        });
      }

      // Emit stdout to Paperclip by complete lines (one JSON event per line).
      let stdoutBuffer = "";
      const bufferedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
        if (stream === "stderr") {
          await onLog(stream, chunk);
          return;
        }
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line) await onLog(stream, `${line}\n`);
        }
      };

      const markStopped = providerStop.beginInvocation();
      const proc = await runChildProcess(runId, cli.command, args, {
        cwd,
        env: childEnv,
        inheritProcessEnv: false,
        stdin: stdinPrompt,
        timeoutSec,
        graceSec,
        onSpawn,
        onLog: bufferedOnLog,
        // phi can stay alive after `agent_settled` while an extension finishes
        // background work; stop it once the result is in.
        terminalResultCleanup: {
          graceMs: terminalCleanupGraceMs,
          hasTerminalResult: ({ stdout }) => PHI_SETTLED_EVENT_RE.test(stdout),
        },
      });
      markStopped();
      if (stdoutBuffer) await onLog("stdout", stdoutBuffer);
      return { proc, parsed: parsePhiJsonl(proc.stdout) };
    };

    const toResult = (
      attempt: Awaited<ReturnType<typeof runAttempt>>,
      attemptSessionFile: string,
      clearSession: boolean,
    ): AdapterExecutionResult => {
      const { proc, parsed } = attempt;
      if (proc.timedOut && !parsed.settled) {
        return {
          exitCode: proc.exitCode,
          signal: proc.signal,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          clearSession,
        };
      }
      // Stopped by terminalResultCleanup after agent_settled: the run itself finished.
      const stoppedAfterSettle = parsed.settled && proc.terminalResultCleanup?.stopped === true;
      const parsedError = parsed.errors.find((error) => error.trim().length > 0) ?? "";
      const rawExitCode = stoppedAfterSettle ? 0 : proc.exitCode;
      const signal = stoppedAfterSettle ? null : proc.signal;
      const failed = (rawExitCode ?? 0) !== 0 || signal !== null || parsedError.length > 0;
      const errorMessage = failed
        ? parsedError || firstNonEmptyLine(proc.stderr) || `phi exited with code ${rawExitCode ?? -1}`
        : null;
      const errorFamily = failed && errorMessage ? classifyPhiFailure(`${errorMessage}\n${proc.stderr}`) : null;
      const sessionParams = clearSession
        ? null
        : {
            sessionId: attemptSessionFile,
            cwd,
            ...(workspaceId ? { workspaceId } : {}),
            ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
            ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
          };
      return {
        exitCode: failed && (rawExitCode ?? 0) === 0 ? 1 : rawExitCode,
        signal,
        timedOut: false,
        errorMessage,
        errorCode: proc.errorCode ?? null,
        errorFamily,
        usage: {
          inputTokens: parsed.usage.inputTokens,
          outputTokens: parsed.usage.outputTokens,
          cachedInputTokens: parsed.usage.cachedInputTokens,
        },
        usageBasis: "per_run",
        sessionId: clearSession ? null : attemptSessionFile,
        sessionParams,
        sessionDisplayId: clearSession ? null : attemptSessionFile,
        provider: selection.phibotProvider,
        biller: resolvePhiBiller(selection, runEnv),
        model: selection.displayModel,
        billingType: "api",
        costUsd: parsed.usage.costUsd,
        resultJson: {
          stdout: proc.stdout,
          stderr: proc.stderr,
          ...(errorFamily ? { errorFamily } : {}),
          ...(proc.terminalResultCleanup ? { unmanagedBackgroundTask: proc.terminalResultCleanup } : {}),
        },
        summary: parsed.finalMessage ?? parsed.messages.join("\n\n").trim(),
        clearSession,
      };
    };

    try {
      const initial = await runAttempt(sessionPath);
      const initialFailed =
        !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || initial.parsed.errors.length > 0);
      if (canResumeSession && initialFailed && isPhiSessionUnavailableError(initial.proc.stdout, initial.proc.stderr)) {
        await onLog("stdout", `[phibot] Session "${sessionPath}" is unavailable; retrying with a fresh session.\n`);
        const freshSession = newSessionFile(sessionsDir, `${runId}-retry`);
        const retry = await runAttempt(freshSession);
        return toResult(retry, freshSession, false);
      }
      return toResult(initial, sessionPath, false);
    } finally {
      await providerStop.collectBeforeRestore();
    }
  } finally {
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
