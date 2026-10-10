import { afterEach, describe, expect, it, vi } from "vitest";
import { getCLIAdapter } from "../adapters/registry.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CLI adapter registry (Phi Bot)", () => {
  it("prints phi_local events with the phi formatter", () => {
    const adapter = getCLIAdapter("phi_local");
    expect(adapter.type).toBe("phi_local");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    adapter.formatStdoutEvent(
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }),
      false,
    );
    expect(log.mock.calls.flat().join("\n")).toContain("assistant: hello");
  });
});
