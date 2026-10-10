#!/usr/bin/env node
// Functional path of the Phi Bot end-to-end test (spec 15.2 point 3), through the HTTP API exactly
// as the Phi Bot setup assistant does it (ui/src/lib/phibot-llm.ts, ui/src/lib/phibot-agent.ts,
// ui/src/components/phibot/PhiBotSetup.tsx): the four Phi Bot secrets, their binding on the local
// environment, the connection test, the CEO hire, the first task, then the run of that task.
// Every check prints one line "E2E OK <name>" or "E2E FAIL <name>: <detail>"; exit code 1 on a failure.
//
// Environment: E2E_EMAIL, E2E_PASSWORD_FILE, E2E_API_KEY (fake key), E2E_PROVIDER_URL
// (OpenAI-compatible base URL of ci/e2e/mock-llm.mjs), E2E_AUTH_ORIGIN (Origin trusted by
// Better Auth: the public URL in "explicit" mode, http://127.0.0.1:3100 in "auto" mode).
import { readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:3100";
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
};

let failures = 0;
function report(name, ok, detail = "") {
  if (ok) console.log(`E2E OK ${name}`);
  else {
    failures += 1;
    console.log(`E2E FAIL ${name}: ${detail}`);
  }
  return ok;
}

let cookie = "";
async function call(method, path, body, origin = BASE) {
  const headers = { "Content-Type": "application/json", Origin: origin };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return { response, json };
}

async function signIn() {
  const password = readFileSync(env("E2E_PASSWORD_FILE"), "utf8").trim();
  const { response } = await call("POST", "/auth/sign-in/email", { email: env("E2E_EMAIL"), password }, env("E2E_AUTH_ORIGIN"));
  cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  return report("owner sign-in", cookie.length > 0, "no session cookie");
}

const SECRETS = () => ({
  PHIBOT_LLM_PROVIDER: { name: "Phi Bot - AI provider", value: "custom", metadata: { phibotValue: "custom" } },
  PHIBOT_LLM_BASE_URL: { name: "Phi Bot - AI provider base URL", value: env("E2E_PROVIDER_URL"), metadata: { phibotValue: env("E2E_PROVIDER_URL") } },
  PHIBOT_DEFAULT_MODEL: { name: "Phi Bot - default model", value: "custom/mock-1", metadata: { phibotValue: "custom/mock-1" } },
  PHIBOT_LLM_API_KEY: { name: "Phi Bot - AI provider API key", value: env("E2E_API_KEY"), metadata: { phibotKeySet: true } },
});

async function configureProvider(companyId) {
  const created = {};
  for (const [key, secret] of Object.entries(SECRETS())) {
    const { json } = await call("POST", `/companies/${companyId}/secrets`, {
      name: secret.name,
      key,
      value: secret.value,
      description: "Managed by Phi Bot. Change it in Settings > AI provider.",
      providerMetadata: secret.metadata,
    });
    created[key] = json.id;
  }
  report("four Phi Bot secrets", Object.values(created).every(Boolean));
  const { json: environments } = await call("GET", `/companies/${companyId}/environments`);
  const local = environments.find((environment) => environment.driver === "local" && environment.status === "active");
  if (!report("local environment", Boolean(local), JSON.stringify(environments).slice(0, 200))) return null;
  const envVars = { ...(local.envVars ?? {}) };
  for (const [key, secretId] of Object.entries(created)) envVars[key] = { type: "secret_ref", secretId, version: "latest" };
  await call("PATCH", `/environments/${local.id}?companyId=${encodeURIComponent(companyId)}`, { envVars });
  report("secrets bound to the local environment", true);
  return local.id;
}

async function testConnection(companyId, environmentId) {
  const { json } = await call("POST", `/companies/${companyId}/adapters/phi_local/test-environment`, {
    adapterConfig: { timeoutSec: 0, graceSec: 20 },
    environmentId,
  });
  return report("connection test = pass", json?.status === "pass", JSON.stringify(json).slice(0, 400));
}

async function hireCeo(companyId) {
  const { json } = await call("POST", `/companies/${companyId}/agent-hires`, {
    name: "CEO",
    role: "ceo",
    adapterType: "phi_local",
    adapterConfig: { timeoutSec: 0, graceSec: 20 },
    onboardingFirstAgent: true,
    runtimeConfig: { heartbeat: { enabled: false, intervalSec: 3600, wakeOnDemand: true, skipTimerWhenNoActionableWork: true, cooldownSec: 10 } },
  });
  if (json?.approval?.id) await call("POST", `/approvals/${json.approval.id}/approve`, { decisionNote: "Test de bout en bout" });
  report("CEO hired", Boolean(json?.agent?.id), JSON.stringify(json).slice(0, 200));
  return json?.agent?.id ?? null;
}

async function assignFirstTask(companyId, agentId) {
  const { json: goals } = await call("GET", `/companies/${companyId}/goals`);
  const goal = goals.find((item) => item.level === "company" && !item.parentId) ?? null;
  const { json: projects } = await call("GET", `/companies/${companyId}/projects`);
  let project = projects.find((item) => item.status !== "cancelled" && item.name.trim().toLowerCase() === "onboarding");
  if (!project) {
    project = (await call("POST", `/companies/${companyId}/projects`, { name: "Onboarding", status: "in_progress", ...(goal ? { goalIds: [goal.id] } : {}) })).json;
  }
  const { json: issue } = await call("POST", `/companies/${companyId}/issues`, {
    title: "Test de bout en bout",
    assigneeAgentId: agentId,
    projectId: project.id,
    ...(goal ? { goalId: goal.id } : {}),
    status: "todo",
    onboardingFirstTask: true,
  });
  report("task assigned to the CEO", Boolean(issue?.id), JSON.stringify(issue).slice(0, 200));
  // The onboarding first task never wakes its assignee by itself: the owner's first comment does
  // (server/src/routes/issues.ts, "Do not auto-wake the onboarding first task").
  const { json: comment } = await call("POST", `/issues/${issue.id}/comments`, { body: "Commence la tâche." });
  report("owner comment on the task", Boolean(comment?.id), JSON.stringify(comment).slice(0, 200));
}

async function waitForRun(companyId, agentId) {
  const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { json: runs } = await call("GET", `/companies/${companyId}/heartbeat-runs?agentId=${encodeURIComponent(agentId)}&limit=20`);
    const succeeded = runs.find((run) => run.status === "succeeded");
    if (succeeded) return report("run succeeded", true) && succeeded.id;
    const failed = runs.find((run) => terminal.has(run.status) && run.status !== "succeeded");
    if (failed && runs.every((run) => terminal.has(run.status))) {
      report("run succeeded", false, `${failed.id} ${failed.status} ${failed.error ?? ""}`);
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  report("run succeeded", false, "timeout");
  return null;
}

// "signin": owner sign-in and the single company only; "full" (default): the whole path.
const mode = process.argv[2] ?? "full";
try {
  if (await signIn()) {
    const { json: companies } = await call("GET", "/companies");
    report("one company named CI", Array.isArray(companies) && companies.length === 1 && companies[0].name === "CI", JSON.stringify(companies?.map?.((c) => c.name)));
    const companyId = companies[0].id;
    console.log(`E2E COMPANY ${companyId}`);
    const environmentId = mode === "full" ? await configureProvider(companyId) : null;
    if (environmentId && (await testConnection(companyId, environmentId))) {
      const agentId = await hireCeo(companyId);
      if (agentId) {
        await assignFirstTask(companyId, agentId);
        const runId = await waitForRun(companyId, agentId);
        if (runId) console.log(`E2E RUN ${runId}`);
      }
    }
  }
} catch (error) {
  report("functional path", false, error instanceof Error ? error.message : String(error));
}
process.exitCode = failures === 0 ? 0 : 1;
