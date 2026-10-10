#!/usr/bin/env node
// Checks what the scripted fake provider (ci/e2e/mock-llm.mjs) received during the run of the
// end-to-end test (spec 15.2 point 3): the full tool sequence, grep offered in every tool list,
// the browser snapshot of the local page with its title, the company key as bearer token.
// Usage: node verify-mock-log.mjs <mock log>
import { readFileSync } from "node:fs";

const entries = readFileSync(process.argv[2], "utf8").trim().split("\n").map((line) => JSON.parse(line));
const withTools = entries.filter((entry) => Array.isArray(entry.tools) && entry.tools.length > 0 && entry.step);
const steps = withTools.map((entry) => entry.step.tool ?? entry.step.text).filter((step) => step !== "hello");
const expected = ["memory_write", "browser_navigate", "browser_snapshot", "grep", "PHIBOT-E2E-DONE"];
let failed = 0;
const check = (name, ok, detail) => {
  console.log(ok ? `E2E OK ${name}` : `E2E FAIL ${name}: ${detail}`);
  if (!ok) failed += 1;
};
const firstRun = steps.slice(0, expected.length);
check("tool sequence memory_write, browser_navigate, browser_snapshot, grep, text", JSON.stringify(firstRun) === JSON.stringify(expected), JSON.stringify(steps));
check("grep in the tool list", withTools.every((entry) => entry.tools.includes("grep")), "a request without grep");
const final = withTools.find((entry) => entry.step.text === "PHIBOT-E2E-DONE");
const toolResults = (final?.messages ?? []).filter((message) => message.role === "tool").map((message) => JSON.stringify(message.content));
check("navigation result has the page title", toolResults.some((text) => text.includes("Phi Bot E2E page 7f3a")), toolResults.join(" | ").slice(0, 600));
check("company key sent to the provider", withTools.every((entry) => entry.auth === "Bearer sk-test-e2e-9b2f"), "other authorization");
process.exitCode = failed === 0 ? 0 : 1;
