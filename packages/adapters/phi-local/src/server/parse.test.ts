import { describe, expect, it } from "vitest";
import { isPhiSessionUnavailableError, parsePhiJsonl, PHI_SETTLED_EVENT_RE } from "./parse.js";

const usage = (input: number, output: number, cacheRead = 0, total = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: text ? [{ type: "text", text }] : [],
  provider: "anthropic",
  model: "claude-test",
  usage: usage(100, 7, 20, 0.01),
  stopReason: "stop",
  ...extra,
});

const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");

// Shape captured from `phi --mode json` 0.99.5 against a local OpenAI-compatible mock.
const successfulRun = lines(
  { type: "session", version: 3, id: "01a11ba2-2cc7", timestamp: "2026-10-08T13:09:35.559Z", cwd: "/work/repo" },
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", message: { role: "user", content: [{ type: "text", text: "Phi Bot task:\nDo it" }] } },
  { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Phi Bot task:\nDo it" }] } },
  { type: "message_start", message: assistant("", { stopReason: "pending", usage: usage(0, 0) }) },
  { type: "message_update", usage: usage(100, 7), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel" } },
  { type: "message_update", usage: usage(100, 7), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } },
  { type: "message_end", message: assistant("hello") },
  { type: "turn_end", message: assistant("hello"), toolResults: [] },
  { type: "agent_end", messages: [{ role: "user", content: "Do it" }, assistant("hello")], willRetry: false },
  { type: "agent_settled" },
);

describe("parsePhiJsonl", () => {
  it("reads the session header, the final text, usage once per LLM call and the settled marker", () => {
    const parsed = parsePhiJsonl(successfulRun);
    expect(parsed.sessionId).toBe("01a11ba2-2cc7");
    expect(parsed.sessionCwd).toBe("/work/repo");
    expect(parsed.finalMessage).toBe("hello");
    expect(parsed.messages).toEqual(["hello"]);
    expect(parsed.usage).toEqual({ inputTokens: 100, outputTokens: 7, cachedInputTokens: 20, costUsd: 0.01 });
    expect(parsed.errors).toEqual([]);
    expect(parsed.settled).toBe(true);
    expect(parsed.reportedModel).toBe("anthropic/claude-test");
  });

  it("does not fail a run whose provider error was retried successfully (agent_end willRetry)", () => {
    const failed = assistant("", { stopReason: "error", errorMessage: "529 overloaded", usage: usage(0, 0) });
    const parsed = parsePhiJsonl(
      lines(
        { type: "message_end", message: failed },
        { type: "turn_end", message: failed, toolResults: [] },
        { type: "agent_end", messages: [failed], willRetry: true },
        { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529 overloaded" },
        { type: "message_end", message: assistant("done") },
        { type: "auto_retry_end", success: true, attempt: 1 },
        { type: "turn_end", message: assistant("done"), toolResults: [] },
        { type: "agent_end", messages: [assistant("done")], willRetry: false },
        { type: "agent_settled" },
      ),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.finalMessage).toBe("done");
  });

  it("fails when the last assistant message failed or was aborted", () => {
    const failed = assistant("", { stopReason: "error", errorMessage: "401 invalid x-api-key" });
    expect(parsePhiJsonl(lines({ type: "message_end", message: failed }, { type: "agent_end", messages: [failed], willRetry: false })).errors)
      .toEqual(["401 invalid x-api-key"]);
    const aborted = assistant("", { stopReason: "aborted" });
    expect(parsePhiJsonl(lines({ type: "message_end", message: aborted })).errors).toEqual(["phi request was aborted."]);
  });

  it("reports exhausted retries and standalone errors once", () => {
    const parsed = parsePhiJsonl(
      lines(
        { type: "auto_retry_end", success: false, attempt: 3, finalError: "429 rate limit" },
        { type: "error", message: "Connection lost" },
        { type: "error", message: "Connection lost" },
      ),
    );
    expect(parsed.errors).toEqual(["429 rate limit", "Connection lost"]);
  });

  it("tracks tool calls and ignores phi bookkeeping events", () => {
    const parsed = parsePhiJsonl(
      lines(
        { type: "queue_update", steering: [], followUp: [] },
        { type: "compaction_start", reason: "threshold" },
        { type: "entry_appended", entry: { type: "custom" } },
        { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
        { type: "tool_execution_update", toolCallId: "t1", toolName: "bash", partialResult: "a" },
        { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "a\nb", isError: false },
        { type: "turn_end", message: assistant("listed"), toolResults: [{ toolCallId: "t1", content: [{ type: "text", text: "a\nb" }], isError: false }] },
      ),
    );
    expect(parsed.toolCalls).toEqual([{ toolCallId: "t1", toolName: "bash", args: { command: "ls" }, result: "a\nb", isError: false }]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.usage.inputTokens).toBe(100);
  });
});

describe("isPhiSessionUnavailableError", () => {
  it("matches phi's session errors", () => {
    expect(isPhiSessionUnavailableError("", "Session file is not a valid phi session: /x.jsonl")).toBe(true);
    expect(isPhiSessionUnavailableError("", "Stored session working directory does not exist: /old")).toBe(true);
    expect(isPhiSessionUnavailableError("all good", "")).toBe(false);
  });
});

describe("PHI_SETTLED_EVENT_RE", () => {
  it("matches the JSON line phi prints when the run is over", () => {
    expect(PHI_SETTLED_EVENT_RE.test(JSON.stringify({ type: "agent_settled" }))).toBe(true);
    expect(PHI_SETTLED_EVENT_RE.test(JSON.stringify({ type: "agent_end" }))).toBe(false);
  });
});
