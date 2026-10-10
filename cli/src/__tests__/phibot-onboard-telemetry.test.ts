import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onboard } from "../commands/onboard.js";

// Phi Bot patch P8: the onboarding writes telemetry.enabled=false.
vi.mock("../commands/run.js", () => ({
  runCommand: vi.fn(),
}));

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("onboard telemetry default (Phi Bot P8)", () => {
  it("writes telemetry.enabled=false in a fresh config", async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("PAPERCLIP_") || key === "DATABASE_URL" || key === "HOST") delete process.env[key];
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phibot-onboard-telemetry-"));
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    const configPath = path.join(root, ".paperclip", "config.json");

    await onboard({ config: configPath, yes: true, invokedByRun: true });

    const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as { telemetry?: unknown };
    expect(written.telemetry).toEqual({ enabled: false });
    fs.rmSync(root, { recursive: true, force: true });
  });
});
