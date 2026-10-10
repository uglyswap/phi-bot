import { afterEach, describe, expect, it } from "vitest";
import { runChildProcess } from "./server-utils.js";

// Phi Bot patch P1: `inheritProcessEnv: false` gives the child exactly `env`.
const DUMP_ENV_SCRIPT = "process.stdout.write(JSON.stringify(process.env))";
const SERVER_SECRET = "postgres://paperclip:secret@localhost:54329/paperclip";
const savedDatabaseUrl = process.env.DATABASE_URL;

// Node cannot start on Windows without SYSTEMROOT; Linux needs nothing extra.
function platformBaseEnv(): Record<string, string> {
  return process.platform === "win32" && process.env.SYSTEMROOT
    ? { SYSTEMROOT: process.env.SYSTEMROOT }
    : {};
}

async function runAndReadChildEnv(inheritProcessEnv: boolean | undefined): Promise<Record<string, string>> {
  const result = await runChildProcess(
    `inherit-env-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    process.execPath,
    ["-e", DUMP_ENV_SCRIPT],
    {
      cwd: process.cwd(),
      env: { ...platformBaseEnv(), PHIBOT_P1_MARKER: "marker" },
      timeoutSec: 30,
      graceSec: 3,
      onLog: async () => {},
      ...(inheritProcessEnv === undefined ? {} : { inheritProcessEnv }),
    },
  );
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as Record<string, string>;
}

afterEach(() => {
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
});

describe("runChildProcess inheritProcessEnv", () => {
  it("gives the child only the provided env when inheritProcessEnv is false", async () => {
    process.env.DATABASE_URL = SERVER_SECRET;
    const childEnv = await runAndReadChildEnv(false);
    expect(childEnv.PHIBOT_P1_MARKER).toBe("marker");
    expect(childEnv.DATABASE_URL).toBeUndefined();
  });

  it("keeps inheriting the server environment by default", async () => {
    process.env.DATABASE_URL = SERVER_SECRET;
    const childEnv = await runAndReadChildEnv(undefined);
    expect(childEnv.PHIBOT_P1_MARKER).toBe("marker");
    expect(childEnv.DATABASE_URL).toBe(SERVER_SECRET);
  });
});
