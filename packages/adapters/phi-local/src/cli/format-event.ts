import pc from "picocolors";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => asRecord(part))
    .filter((part): part is Record<string, unknown> => part !== null && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

/**
 * Console rendering of `phi --mode json` events for the Paperclip CLI. Prints
 * each assistant reply once (at `message_end`), tools and errors; skips
 * deltas, the session header, user prompt echoes and phi-only bookkeeping events.
 */
export function printPhiStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    console.log(line);
    return;
  }
  switch (asString(parsed.type)) {
    case "agent_start":
      console.log(pc.blue("phi agent started"));
      return;
    case "agent_end":
      if (parsed.willRetry !== true) console.log(pc.blue("phi agent finished"));
      return;
    case "message_end": {
      const message = asRecord(parsed.message);
      if (message?.role !== "assistant") return;
      const text = extractText(message.content);
      if (text) console.log(pc.green(`assistant: ${text}`));
      const stopReason = asString(message.stopReason);
      if (stopReason === "error" || stopReason === "aborted") {
        console.log(pc.red(`error: ${asString(message.errorMessage, stopReason)}`));
      }
      return;
    }
    case "tool_execution_start": {
      console.log(pc.yellow(`tool_start: ${asString(parsed.toolName)}`));
      if (parsed.args !== undefined) {
        try {
          console.log(pc.gray(JSON.stringify(parsed.args, null, 2)));
        } catch {
          console.log(pc.gray(String(parsed.args)));
        }
      }
      return;
    }
    case "tool_execution_end": {
      const result = parsed.result;
      const output = typeof result === "string" ? result : JSON.stringify(result);
      if (output) console.log((parsed.isError === true ? pc.red : pc.gray)(output));
      return;
    }
    case "auto_retry_start":
      console.log(pc.yellow(`retrying after provider error: ${asString(parsed.errorMessage)}`));
      return;
    case "auto_retry_end":
      if (parsed.success !== true) console.log(pc.red(`retries exhausted: ${asString(parsed.finalError)}`));
      return;
    case "error":
      console.log(pc.red(`error: ${asString(parsed.message)}`));
      return;
    default:
      return;
  }
}
