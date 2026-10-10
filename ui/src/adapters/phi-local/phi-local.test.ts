import { describe, expect, it } from "vitest";
import { defaultCreateValues } from "../../components/agent-config-defaults";
import { setupEfforts } from "../../lib/agent-setup-fields";
import { getAdapterDisplay, getAdapterLabel } from "../adapter-display-registry";
import { getUIAdapter } from "../registry";

describe("phi_local UI adapter", () => {
  it("is registered with a per-transcript stdout parser", () => {
    const adapter = getUIAdapter("phi_local");
    expect(adapter.type).toBe("phi_local");
    expect(adapter.label).toBe("Phi");
    expect(typeof adapter.createStdoutParser).toBe("function");
    const first = adapter.createStdoutParser!();
    const second = adapter.createStdoutParser!();
    expect(first).not.toBe(second);
  });

  it("builds an agent config without a model, so the company default applies", () => {
    const config = getUIAdapter("phi_local").buildAdapterConfig({ ...defaultCreateValues, adapterType: "phi_local" });
    expect(config.model).toBeUndefined();
    expect(config.command).toBeUndefined();
  });

  it("is the recommended engine and offers the phi thinking levels", () => {
    expect(getAdapterLabel("phi_local")).toBe("Phi");
    expect(getAdapterDisplay("phi_local").recommended).toBe(true);
    expect(setupEfforts("phi_local", "")).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});
