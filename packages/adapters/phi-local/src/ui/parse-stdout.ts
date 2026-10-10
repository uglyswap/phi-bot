import type { TranscriptEntry } from "@paperclipai/adapter-utils";

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

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function extractContent(content: unknown): { text: string; thinking: string } {
  if (typeof content === "string") return { text: content, thinking: "" };
  if (!Array.isArray(content)) return { text: "", thinking: "" };
  let text = "";
  let thinking = "";
  for (const raw of content) {
    const part = asRecord(raw);
    if (!part) continue;
    if (part.type === "text" && typeof part.text === "string") text += part.text;
    if (part.type === "thinking" && typeof part.thinking === "string") thinking += part.thinking;
  }
  return { text, thinking };
}

function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  const record = asRecord(result);
  const content = record ? record.content : result;
  const { text } = extractContent(content);
  return text || JSON.stringify(result);
}

function assistantFailure(message: Record<string, unknown>): string | null {
  const stopReason = asString(message.stopReason);
  if (stopReason !== "error" && stopReason !== "aborted") return null;
  return asString(message.errorMessage).trim() || (stopReason === "aborted" ? "Request aborted." : "Provider request failed.");
}

export interface PhiStdoutParser {
  parseLine: (line: string, ts: string) => TranscriptEntry[];
  reset: () => void;
}

/**
 * Transcript parser for `phi --mode json`.
 *
 * phi streams each assistant message as text/thinking deltas, then repeats the
 * full text in `text_end`, `message_end`, `turn_end` and `agent_end`. Only the
 * deltas are shown (the full text is used when nothing was streamed), so a
 * reply appears once. User and tool-result `message_*` events are ignored:
 * they echo the whole Paperclip prompt. Unknown JSON events (`session`,
 * `agent_settled`, `queue_update`, `entry_appended`, ...) produce nothing.
 */
export function createPhiStdoutParser(): PhiStdoutParser {
  const pendingToolNames = new Map<string, string>();
  let streamedText = false;
  let streamedThinking = false;

  const parseLine = (line: string, ts: string): TranscriptEntry[] => {
    const parsed = asRecord(safeJsonParse(line));
    if (!parsed) {
      const trimmed = line.trim();
      return trimmed ? [{ kind: "stdout", ts, text: trimmed }] : [];
    }

    switch (asString(parsed.type)) {
      case "message_start": {
        if (asRecord(parsed.message)?.role === "assistant") {
          streamedText = false;
          streamedThinking = false;
        }
        return [];
      }
      case "message_update": {
        const event = asRecord(parsed.assistantMessageEvent);
        const delta = asString(event?.delta);
        if (!delta) return [];
        if (event?.type === "text_delta") {
          streamedText = true;
          return [{ kind: "assistant", ts, text: delta, delta: true }];
        }
        if (event?.type === "thinking_delta") {
          streamedThinking = true;
          return [{ kind: "thinking", ts, text: delta, delta: true }];
        }
        return [];
      }
      case "message_end": {
        const message = asRecord(parsed.message);
        if (message?.role !== "assistant") return [];
        const entries: TranscriptEntry[] = [];
        const { text, thinking } = extractContent(message.content);
        if (thinking && !streamedThinking) entries.push({ kind: "thinking", ts, text: thinking });
        if (text && !streamedText) entries.push({ kind: "assistant", ts, text });
        const failure = assistantFailure(message);
        if (failure) entries.push({ kind: "stderr", ts, text: failure });
        streamedText = false;
        streamedThinking = false;
        return entries;
      }
      case "tool_execution_start": {
        const toolUseId = asString(parsed.toolCallId) || `tool-${ts}`;
        const name = asString(parsed.toolName) || "tool";
        pendingToolNames.set(toolUseId, name);
        return [{ kind: "tool_call", ts, name, input: parsed.args, toolUseId }];
      }
      case "tool_execution_end": {
        const toolUseId = asString(parsed.toolCallId) || `tool-${ts}`;
        const toolName = asString(parsed.toolName) || pendingToolNames.get(toolUseId) || "tool";
        pendingToolNames.delete(toolUseId);
        return [
          {
            kind: "tool_result",
            ts,
            toolUseId,
            toolName,
            content: toolResultText(parsed.result),
            isError: parsed.isError === true,
          },
        ];
      }
      case "auto_retry_start": {
        const attempt = asNumber(parsed.attempt);
        const maxAttempts = asNumber(parsed.maxAttempts);
        const seconds = Math.round(asNumber(parsed.delayMs) / 1000);
        return [
          {
            kind: "system",
            ts,
            text: `Provider error, retry ${attempt}/${maxAttempts} in ${seconds}s: ${asString(parsed.errorMessage)}`.trim(),
          },
        ];
      }
      case "auto_retry_end": {
        if (parsed.success === true) return [];
        return [{ kind: "stderr", ts, text: asString(parsed.finalError) || "Automatic retries exhausted." }];
      }
      case "compaction_start":
        return [{ kind: "system", ts, text: "Compacting the conversation context." }];
      case "compaction_end": {
        const error = asString(parsed.errorMessage).trim();
        return error ? [{ kind: "stderr", ts, text: `Context compaction failed: ${error}` }] : [];
      }
      case "error": {
        const message = asString(parsed.message).trim();
        return message ? [{ kind: "stderr", ts, text: message }] : [];
      }
      case "agent_end": {
        if (parsed.willRetry === true) return [];
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        let inputTokens = 0;
        let outputTokens = 0;
        let cachedTokens = 0;
        let costUsd = 0;
        let lastFailure: string | null = null;
        for (const raw of messages) {
          const message = asRecord(raw);
          if (message?.role !== "assistant") continue;
          const usage = asRecord(message.usage);
          inputTokens += asNumber(usage?.input);
          outputTokens += asNumber(usage?.output);
          cachedTokens += asNumber(usage?.cacheRead);
          costUsd += asNumber(asRecord(usage?.cost)?.total);
          lastFailure = assistantFailure(message);
        }
        return [
          {
            kind: "result",
            ts,
            text: lastFailure ? "Run failed" : "Run completed",
            inputTokens,
            outputTokens,
            cachedTokens,
            costUsd,
            subtype: "end",
            isError: lastFailure !== null,
            errors: lastFailure ? [lastFailure] : [],
          },
        ];
      }
      default:
        return [];
    }
  };

  const reset = () => {
    pendingToolNames.clear();
    streamedText = false;
    streamedThinking = false;
  };

  return { parseLine, reset };
}

const sharedParser = createPhiStdoutParser();

/** Stateless entry point (shared state); prefer `createPhiStdoutParser` per transcript. */
export function parsePhiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return sharedParser.parseLine(line, ts);
}

export function resetParserState(): void {
  sharedParser.reset();
}
