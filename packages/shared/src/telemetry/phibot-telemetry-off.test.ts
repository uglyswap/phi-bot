import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTelemetryConfig } from "./config.js";

// Phi Bot patch P8: no product telemetry, whatever the config file says.
const OPT_OUT_ENV_VARS = [
  "PAPERCLIP_TELEMETRY_DISABLED",
  "DO_NOT_TRACK",
  "CI",
  "CONTINUOUS_INTEGRATION",
  "BUILD_NUMBER",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
];

describe("Phi Bot product telemetry (P8)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stays disabled when the config enables it and no opt-out variable is set", () => {
    for (const key of OPT_OUT_ENV_VARS) vi.stubEnv(key, "");
    vi.stubEnv("PAPERCLIP_TELEMETRY_ENDPOINT", "https://telemetry.example.test");
    const config = resolveTelemetryConfig({ enabled: true });
    expect(config.enabled).toBe(false);
    expect(config.endpoint).toBeUndefined();
    // Caps and backoff are still resolved for any caller that reads them.
    expect(config.maxEventsPerBatch).toBe(50);
  });
});
