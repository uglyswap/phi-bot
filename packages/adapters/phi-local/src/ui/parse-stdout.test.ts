import { describe, expect, it } from "vitest";
import { createPhiStdoutParser } from "./parse-stdout.js";

const ts = "2026-10-08T00:00:00.000Z";
const usage = { input: 100, output: 7, cacheRead: 20, cacheWrite: 0, totalTokens: 107, cost: { total: 0.01 } };
const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: text ? [{ type: "text", text }] : [],
  usage,
  stopReason: "stop",
  ...extra,
});

function run(events: unknown[]) {
  const parser = createPhiStdoutParser();
  return events.flatMap((event) => parser.parseLine(JSON.stringify(event), ts));
}

describe("createPhiStdoutParser", () => {
  it("shows a streamed reply once and ignores the prompt echo and phi bookkeeping", () => {
    const entries = run([
      { type: "session", version: 3, id: "s", cwd: "/w" },
      { type: "agent_start" },
      { type: "message_start", message: { role: "user", content: [{ type: "text", text: "Phi Bot task:\nsecret prompt" }] } },
      { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Phi Bot task:\nsecret prompt" }] } },
      { type: "message_start", message: assistant("") },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hel" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } },
      { type: "message_update", assistantMessageEvent: { type: "text_end", content: "hello" } },
      { type: "message_end", message: assistant("hello") },
      { type: "turn_end", message: assistant("hello"), toolResults: [] },
      { type: "agent_end", messages: [assistant("hello")], willRetry: false },
      { type: "agent_settled" },
      { type: "queue_update", steering: [], followUp: [] },
    ]);
    expect(entries).toEqual([
      { kind: "assistant", ts, text: "hel", delta: true },
      { kind: "assistant", ts, text: "lo", delta: true },
      {
        kind: "result",
        ts,
        text: "Run completed",
        inputTokens: 100,
        outputTokens: 7,
        cachedTokens: 20,
        costUsd: 0.01,
        subtype: "end",
        isError: false,
        errors: [],
      },
    ]);
  });

  it("falls back to the full text when nothing was streamed and reports failures", () => {
    const failed = assistant("", { stopReason: "error", errorMessage: "401 invalid key" });
    const entries = run([
      { type: "message_start", message: assistant("") },
      { type: "message_end", message: assistant("done") },
      { type: "message_start", message: failed },
      { type: "message_end", message: failed },
      { type: "agent_end", messages: [failed], willRetry: true },
      { type: "auto_retry_end", success: false, finalError: "401 invalid key" },
    ]);
    expect(entries).toEqual([
      { kind: "assistant", ts, text: "done" },
      { kind: "stderr", ts, text: "401 invalid key" },
      { kind: "stderr", ts, text: "401 invalid key" },
    ]);
  });

  it("renders tool calls and results", () => {
    const entries = run([
      { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
      { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "a\nb" }] }, isError: false },
    ]);
    expect(entries).toEqual([
      { kind: "tool_call", ts, name: "bash", input: { command: "ls" }, toolUseId: "t1" },
      { kind: "tool_result", ts, toolUseId: "t1", toolName: "bash", content: "a\nb", isError: false },
    ]);
  });

  it("keeps non-JSON lines as raw stdout", () => {
    expect(run([]).length).toBe(0);
    const parser = createPhiStdoutParser();
    expect(parser.parseLine("plain text", ts)).toEqual([{ kind: "stdout", ts, text: "plain text" }]);
  });
});
