#!/usr/bin/env node
// Scripted OpenAI-compatible provider of the Phi Bot end-to-end test (spec 15.2 point 3),
// built on the mock of research R2, appendix A (streaming SSE, one JSON line per request).
//
// A request with tools gets, according to the number of tool results already in the
// conversation: 0 -> a memory_write call, 1 -> a browser_navigate call to the local page,
// 2 -> a browser_snapshot call on the tab it opened (browser_navigate only returns the tab id,
// the snapshot holds the page heading), 3 -> a grep call, 4 or more -> the final text. The adapter's connection test ("Respond with
// the single word hello") and any request without tools get a plain answer.
// The same server serves the local page (GET /e2e-page) whose title the run must read.
//
// Usage: node mock-llm.mjs <port> <log file> <page url>
//   <page url> must use a host name, not an IP address: phi's browser refuses loopback IPs
//   and "localhost"; the test maps a name to 127.0.0.1 in /etc/hosts.
import fs from "node:fs";
import http from "node:http";

const port = Number(process.argv[2] ?? 18765);
const logFile = process.argv[3] ?? "mock-llm.log";
const pageUrl = process.argv[4] ?? `http://phibot-e2e.test:${port}/e2e-page`;
export const PAGE_TITLE = "Phi Bot E2E page 7f3a";
export const MEMORY_MARKER = "PHIBOT-E2E-MEMORY-5c1d";
export const FINAL_TEXT = "PHIBOT-E2E-DONE";
let counter = 0;

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text ?? "").join("");
  return "";
}

/** The next scripted step, from the number of tool results in the conversation. */
export function nextStep(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  if (/Respond with the single word hello/.test(textOf(lastUser?.content))) return { text: "hello" };
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return { text: "ok" };
  const done = messages.filter((message) => message.role === "tool").length;
  if (done === 0) {
    return { tool: "memory_write", args: { content: `Note du test de bout en bout : ${MEMORY_MARKER}`, file: "phibot-e2e.md" } };
  }
  if (done === 1) return { tool: "browser_navigate", args: { url: pageUrl, waitUntil: "load" } };
  if (done === 2) {
    const navigation = textOf(messages.filter((message) => message.role === "tool").at(-1)?.content);
    const tabId = /"tabId":\s*"([^"]+)"/.exec(navigation)?.[1] ?? "missing-tab-id";
    return { tool: "browser_snapshot", args: { tabId } };
  }
  if (done === 3) return { tool: "grep", args: { pattern: "PHIBOT-E2E", path: "." } };
  return { text: FINAL_TEXT };
}

function reply(res, step) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const base = { id: `cmpl-${counter}`, object: "chat.completion.chunk", created: 0, model: "mock-1" };
  if (step.tool) {
    sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${counter}`, type: "function", function: { name: step.tool, arguments: "" } }] }, finish_reason: null }] });
    sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.args) } }] }, finish_reason: null }] });
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  } else {
    sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    sse(res, { ...base, choices: [{ index: 0, delta: { content: step.text }, finish_reason: null }] });
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  }
  sse(res, { ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107 } });
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    if (req.method === "GET" && req.url.startsWith("/e2e-page")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>${PAGE_TITLE}</title></head><body><h1>${PAGE_TITLE}</h1></body></html>\n`);
      return;
    }
    counter += 1;
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }
    const tools = Array.isArray(parsed?.tools) ? parsed.tools.map((tool) => tool.function?.name ?? "") : [];
    const step = req.method === "POST" && req.url.endsWith("/chat/completions") ? nextStep(parsed) : null;
    fs.appendFileSync(
      logFile,
      `${JSON.stringify({ n: counter, method: req.method, url: req.url, auth: req.headers.authorization ?? null, tools, step, messages: parsed?.messages ?? null })}\n`,
    );
    if (req.method === "GET" && req.url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mock-1", object: "model" }] }));
      return;
    }
    if (!step) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    reply(res, step);
  });
});

if (process.argv[1] && process.argv[1].endsWith("mock-llm.mjs")) {
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`mock-llm listening on ${port}, page ${pageUrl}\n`);
  });
}
