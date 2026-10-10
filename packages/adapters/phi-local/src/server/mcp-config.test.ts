import { describe, expect, it } from "vitest";
import { buildPhiMcpConfig, phiSupportsMcpConfigFile } from "./mcp-config.js";

describe("buildPhiMcpConfig", () => {
  it("turns ctx.runtimeMcp servers into phi streamable-http servers with bearer headers", () => {
    const config = buildPhiMcpConfig([
      { name: "Paperclip projects", url: "http://127.0.0.1:3100/api/mcp/project-tools", token: "jwt", connectionId: "p" },
      { name: "Paperclip connections", url: "http://127.0.0.1:3100/mcp/runtime-tools", token: "rt", connectionId: "c" },
      { name: "paperclip-assigned", url: "http://127.0.0.1:3100/mcp/gateways/gw1", token: "pcgw_x", connectionId: "a" },
      { name: "Paperclip projects", url: "http://127.0.0.1:3100/other", token: "t", connectionId: "d" },
    ]);
    expect(config.settings).toEqual({ toolPrefix: "mcp", requestTimeoutMs: 60000 });
    expect(Object.keys(config.mcpServers)).toEqual([
      "paperclip_projects",
      "paperclip_connections",
      "paperclip_assigned",
      "paperclip_projects_2",
    ]);
    expect(config.mcpServers.paperclip_assigned).toEqual({
      transport: "streamable-http",
      url: "http://127.0.0.1:3100/mcp/gateways/gw1",
      headers: { Authorization: "Bearer pcgw_x" },
      lifecycle: "eager",
    });
  });

  it("only uses a per-run MCP file from phi 0.100.0", () => {
    expect(phiSupportsMcpConfigFile("0.99.5")).toBe(false);
    expect(phiSupportsMcpConfigFile("0.100.0")).toBe(true);
    expect(phiSupportsMcpConfigFile(null)).toBe(false);
  });
});
