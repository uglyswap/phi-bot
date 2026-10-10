import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Phi Bot patch P9: the paths that create agents without the PAPERCLIP_ADAPTERS
// check now refuse disabled adapters, and the configuration index read by
// agents only announces enabled adapters. The disabled set is the adapter
// store's, which PAPERCLIP_ADAPTERS fills at startup.
const disabledTypes = vi.hoisted(() => new Set<string>());

vi.mock("../services/adapter-plugin-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/adapter-plugin-store.js")>()),
  isAdapterDisabled: (type: string) => disabledTypes.has(type),
  getDisabledAdapterTypes: () => [...disabledTypes],
}));

import { assertLegacyAgentInviteAdapterType } from "../routes/access.js";
import { llmRoutes } from "../routes/llms.js";
import { errorHandler } from "../middleware/index.js";
import { listServerAdapters } from "../adapters/index.js";
import { deriveBuiltInAgentStatus, listBuiltInAgentDefinitions } from "../services/built-in-agents.js";

function disableEverythingBut(type: string) {
  disabledTypes.clear();
  for (const adapter of listServerAdapters()) {
    if (adapter.type !== type) disabledTypes.add(adapter.type);
  }
  disabledTypes.add("process");
}

describe("Phi Bot single engine (P9)", () => {
  beforeEach(() => {
    disabledTypes.clear();
  });

  it("refuses an external agent join request for a disabled adapter (M2)", () => {
    disableEverythingBut("phi_local");
    // The approval creates the agent with `adapterType ?? "process"`.
    expect(() => assertLegacyAgentInviteAdapterType(null)).toThrow(/Adapter "process" is not available on this instance\./);
    expect(() => assertLegacyAgentInviteAdapterType("codex_local")).toThrow(/Adapter "codex_local" is not available/);
    expect(() => assertLegacyAgentInviteAdapterType("phi_local")).not.toThrow();
  });

  it("makes phi_local the first choice of every built-in agent (M3)", () => {
    for (const definition of listBuiltInAgentDefinitions()) {
      expect(definition.allowedAdapterTypes?.[0], definition.key).toBe("phi_local");
    }
    const summarizer = listBuiltInAgentDefinitions().find((definition) => definition.key === "summarizer");
    expect(summarizer).toMatchObject({ defaultAdapterType: "phi_local", defaultAdapterConfig: {} });
    // As for every adapter, a built-in agent is ready once its model is chosen.
    expect(
      deriveBuiltInAgentStatus({ adapterType: "phi_local", adapterConfig: {}, status: "idle", pausedAt: null } as never),
    ).toBe("needs_setup");
    expect(
      deriveBuiltInAgentStatus({
        adapterType: "phi_local",
        adapterConfig: { model: "anthropic/claude-sonnet-4-6" },
        status: "idle",
        pausedAt: null,
      } as never),
    ).toBe("ready");
  });

  it("announces only enabled adapters in the agent configuration index (M4)", async () => {
    disableEverythingBut("phi_local");
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "board-user", companyIds: [], source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", llmRoutes({} as never));
    app.use(errorHandler);

    const res = await request(app).get("/api/llms/agent-configuration.txt");

    expect(res.status).toBe(200);
    expect(res.text).toContain("- phi_local: /llms/agent-configuration/phi_local.txt");
    expect(res.text).not.toContain("- codex_local: /llms/agent-configuration/codex_local.txt");
    expect(res.text).not.toContain("- claude_local: /llms/agent-configuration/claude_local.txt");
  });
});
