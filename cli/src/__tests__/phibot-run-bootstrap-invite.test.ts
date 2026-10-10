import { afterEach, describe, expect, it } from "vitest";
import { shouldGenerateBootstrapInviteAfterStart } from "../commands/run.js";
import type { PaperclipConfig } from "../config/schema.js";

// Phi Bot patch P5: a run started by the service manager never generates nor
// prints the bootstrap CEO invite (the link would land in the journal).
function config(deploymentMode: string, databaseMode: string): PaperclipConfig {
  return { server: { deploymentMode }, database: { mode: databaseMode } } as unknown as PaperclipConfig;
}

describe("bootstrap invite after start (P5)", () => {
  const saved = process.env.PAPERCLIP_SERVICE_MANAGED;

  afterEach(() => {
    if (saved === undefined) delete process.env.PAPERCLIP_SERVICE_MANAGED;
    else process.env.PAPERCLIP_SERVICE_MANAGED = saved;
  });

  it("keeps the upstream rule for a foreground run", () => {
    delete process.env.PAPERCLIP_SERVICE_MANAGED;
    expect(shouldGenerateBootstrapInviteAfterStart(config("authenticated", "embedded-postgres"))).toBe(true);
    expect(shouldGenerateBootstrapInviteAfterStart(config("local_trusted", "embedded-postgres"))).toBe(false);
    expect(shouldGenerateBootstrapInviteAfterStart(config("authenticated", "postgres"))).toBe(false);
  });

  it("never generates the invite under the service manager", () => {
    process.env.PAPERCLIP_SERVICE_MANAGED = "1";
    expect(shouldGenerateBootstrapInviteAfterStart(config("authenticated", "embedded-postgres"))).toBe(false);
  });
});
