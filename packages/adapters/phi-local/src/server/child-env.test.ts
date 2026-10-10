import { describe, expect, it } from "vitest";
import { buildPhiChildEnv, isInheritedEnvKeyAllowed } from "./child-env.js";

const serverEnv: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/phibot",
  LANG: "fr_FR.UTF-8",
  LC_ALL: "fr_FR.UTF-8",
  HTTPS_PROXY: "http://proxy:3128",
  DATABASE_URL: "postgres://paperclip:secret@localhost:54329/paperclip",
  BETTER_AUTH_SECRET: "better-auth-secret",
  PAPERCLIP_AGENT_JWT_SECRET: "jwt-secret",
  PAPERCLIP_SECRETS_MASTER_KEY: "master-key",
  PAPERCLIP_LISTEN_PORT: "3100",
  ANTHROPIC_API_KEY: "operator-personal-key",
  OPENAI_API_KEY: "operator-openai-key",
  NODE_OPTIONS: "--require /tmp/hook.js",
  CI: "true",
  PHI_SKIP_POSTINSTALL: "1",
  PHI_CODING_AGENT_DIR: "/home/phibot/.phi/agent",
};

describe("buildPhiChildEnv", () => {
  it("keeps only allowlisted server variables, then the run env, then forced values", () => {
    const env = buildPhiChildEnv({
      inherited: serverEnv,
      runEnv: { PAPERCLIP_API_KEY: "run-jwt", PHIBOT_LLM_API_KEY: "company-key", TMPDIR: "/tmp/run" },
      forced: { ANTHROPIC_API_KEY: "company-key", PHI_CODING_AGENT_DIR: "/data/agent", PHI_OFFLINE: "1" },
      platform: "linux",
    });
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/phibot",
      LANG: "fr_FR.UTF-8",
      LC_ALL: "fr_FR.UTF-8",
      HTTPS_PROXY: "http://proxy:3128",
      PAPERCLIP_API_KEY: "run-jwt",
      PHIBOT_LLM_API_KEY: "company-key",
      TMPDIR: "/tmp/run",
      ANTHROPIC_API_KEY: "company-key",
      PHI_CODING_AGENT_DIR: "/data/agent",
      PHI_OFFLINE: "1",
    });
  });

  it("never inherits server secrets, provider keys, NODE_OPTIONS, CI or PHI_* variables", () => {
    for (const key of [
      "DATABASE_URL",
      "BETTER_AUTH_SECRET",
      "PAPERCLIP_AGENT_JWT_SECRET",
      "PAPERCLIP_SECRETS_MASTER_KEY",
      "PAPERCLIP_LISTEN_PORT",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "NODE_OPTIONS",
      "CI",
      "PHI_SKIP_POSTINSTALL",
      "PHI_CODING_AGENT_DIR",
    ]) {
      expect(isInheritedEnvKeyAllowed(key)).toBe(false);
    }
  });

  it("matches Windows names case-insensitively and keeps one PATH spelling", () => {
    const env = buildPhiChildEnv({
      inherited: { Path: "C:\\Windows\\System32", SystemRoot: "C:\\WINDOWS", USERPROFILE: "C:\\Users\\a" },
      runEnv: { PATH: "C:\\launchers;C:\\Windows\\System32" },
      forced: {},
      prependPath: ["C:\\skills\\x\\bin"],
      platform: "win32",
    });
    expect(env).toEqual({
      SystemRoot: "C:\\WINDOWS",
      USERPROFILE: "C:\\Users\\a",
      PATH: "C:\\skills\\x\\bin;C:\\launchers;C:\\Windows\\System32",
    });
  });
});
