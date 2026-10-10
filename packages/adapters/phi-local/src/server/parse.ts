import { asNumber, asString, parseJson } from "@paperclipai/adapter-utils/server-utils";

/**
 * Parser of `phi --mode json` (stdout, one JSON event per line).
 *
 * Differences from pi_local's parser:
 * - the first line is the session header `{"type":"session","id",...,"cwd"}`;
 * - `agent_end` carries `willRetry`: an `agent_end` with `willRetry: true`
 *   is followed by an automatic retry, so its failed assistant message is not
 *   an error of the run; the run fails only if the LAST assistant message
 *   failed (stopReason "error" or "aborted") or retries were exhausted;
 * - `agent_settled` closes the run (phi then disposes and exits);
 * - phi-only events (`queue_update`, `compaction_*`, `entry_appended`,
 *   `session_info_changed`, `thinking_level_changed`, `model_changed`,
 *   `summarization_*`, `bash_execution_update`, `auto_retry_start`) carry no
 *   result and are ignored.
 * Usage is summed over assistant `turn_end` messages (one per LLM call), never
 * from `message_update.usage`, which is a running snapshot of one message.
 */
export interface ParsedPhiOutput {
  sessionId: string | null;
  sessionCwd: string | null;
  messages: string[];
  errors: string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    costUsd: number;
  };
  finalMessage: string | null;
  toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown; result: string | null; isError: boolean }>;
  /** True once `agent_settled` was seen. */
  settled: boolean;
  /** Model reported by the last assistant message (`<provider>/<model>`), if any. */
  reportedModel: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function extractPhiText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => asRecord(part))
    .filter((part): part is Record<string, unknown> => part !== null && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

function assistantFailure(message: Record<string, unknown>): string | null {
  const stopReason = asString(message.stopReason, "");
  if (stopReason !== "error" && stopReason !== "aborted") return null;
  const detail = asString(message.errorMessage, "").trim();
  if (detail) return detail;
  return stopReason === "aborted" ? "phi request was aborted." : "phi provider request failed.";
}

export function parsePhiJsonl(stdout: string): ParsedPhiOutput {
  const result: ParsedPhiOutput = {
    sessionId: null,
    sessionCwd: null,
    messages: [],
    errors: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
    finalMessage: null,
    toolCalls: [],
    settled: false,
    reportedModel: null,
  };
  const pushError = (error: string) => {
    if (error && !result.errors.includes(error)) result.errors.push(error);
  };
  let lastAssistantFailure: string | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;
    const type = asString(event.type, "");

    switch (type) {
      case "session": {
        result.sessionId = asString(event.id, "").trim() || null;
        result.sessionCwd = asString(event.cwd, "").trim() || null;
        break;
      }
      case "message_end": {
        const message = asRecord(event.message);
        if (message?.role !== "assistant") break;
        lastAssistantFailure = assistantFailure(message);
        const provider = asString(message.provider, "");
        const model = asString(message.model, "");
        if (provider && model) result.reportedModel = `${provider}/${model}`;
        break;
      }
      case "turn_end": {
        const message = asRecord(event.message);
        if (message?.role === "assistant") {
          const text = extractPhiText(message.content);
          if (text) {
            result.messages.push(text);
            result.finalMessage = text;
          }
          const usage = asRecord(message.usage);
          if (usage) {
            result.usage.inputTokens += asNumber(usage.input, 0);
            result.usage.outputTokens += asNumber(usage.output, 0);
            result.usage.cachedInputTokens += asNumber(usage.cacheRead, 0);
            result.usage.costUsd += asNumber(asRecord(usage.cost)?.total, 0);
          }
        }
        const toolResults = Array.isArray(event.toolResults) ? event.toolResults : [];
        for (const raw of toolResults) {
          const toolResult = asRecord(raw);
          if (!toolResult) continue;
          const existing = result.toolCalls.find((call) => call.toolCallId === asString(toolResult.toolCallId, ""));
          if (existing && existing.result === null) {
            existing.result = typeof toolResult.content === "string" ? toolResult.content : JSON.stringify(toolResult.content);
            existing.isError = toolResult.isError === true;
          }
        }
        break;
      }
      case "agent_end": {
        if (event.willRetry === true) break;
        const messages = Array.isArray(event.messages) ? event.messages : [];
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = asRecord(messages[index]);
          if (message?.role !== "assistant") continue;
          const text = extractPhiText(message.content);
          if (text) result.finalMessage = text;
          lastAssistantFailure = assistantFailure(message);
          break;
        }
        break;
      }
      case "agent_settled": {
        result.settled = true;
        break;
      }
      case "auto_retry_end": {
        if (event.success !== true) {
          pushError(asString(event.finalError, "").trim() || "phi exhausted automatic retries without a response.");
        }
        break;
      }
      case "error": {
        pushError(asString(event.message, "").trim());
        break;
      }
      case "tool_execution_start": {
        result.toolCalls.push({
          toolCallId: asString(event.toolCallId, ""),
          toolName: asString(event.toolName, ""),
          args: event.args,
          result: null,
          isError: false,
        });
        break;
      }
      case "tool_execution_end": {
        const existing = result.toolCalls.find((call) => call.toolCallId === asString(event.toolCallId, ""));
        if (existing) {
          existing.result = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
          existing.isError = event.isError === true;
        }
        break;
      }
      default:
        break;
    }
  }

  if (lastAssistantFailure) pushError(lastAssistantFailure);
  return result;
}

/** phi refused the saved session file (corrupt file, or its stored cwd no longer exists). */
export function isPhiSessionUnavailableError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`;
  return /Session file is not a valid \S+ session|Stored session working directory does not exist|unknown\s+session|session\s+not\s+found/i.test(
    haystack,
  );
}

/** Marker of a finished run in phi's JSON stream (used to stop a process that does not exit). */
export const PHI_SETTLED_EVENT_RE = /"type"\s*:\s*"agent_settled"/;
