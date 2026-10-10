import { findEnvKeys } from "phi-code-ai/compat";
import { describe, expect, it } from "vitest";
import {
  findPhiBotProvider,
  PHIBOT_LLM_SECRET_KEYS,
  PHIBOT_PROVIDERS,
  PHIBOT_UNSET,
} from "./providers.js";

const nativeProviders = PHIBOT_PROVIDERS.filter((provider) => !provider.modelsJson);
const modelsJsonProviders = PHIBOT_PROVIDERS.filter((provider) => provider.modelsJson);

describe("PHIBOT_PROVIDERS", () => {
  it("lists the 15 providers of the specification, in order, with unique ids", () => {
    expect(PHIBOT_PROVIDERS.map((provider) => provider.id)).toEqual([
      "anthropic",
      "openai",
      "google",
      "openrouter",
      "xai",
      "deepseek",
      "mistral",
      "groq",
      "zai",
      "moonshotai",
      "minimax",
      "opencode-go",
      "alibaba",
      "custom",
      "custom-anthropic",
    ]);
    expect(new Set(PHIBOT_PROVIDERS.map((provider) => provider.phiProvider)).size).toBe(15);
  });

  it("gives every built-in phi provider its key variables and no models.json entry", () => {
    expect(nativeProviders).toHaveLength(12);
    for (const provider of nativeProviders) {
      expect(provider.envVars.length, provider.id).toBeGreaterThan(0);
      expect(provider.needsBaseUrl, provider.id).toBe(false);
      expect(provider.api, provider.id).toBeUndefined();
      expect(provider.phiProvider, provider.id).toBe(provider.id);
    }
    expect(findPhiBotProvider("google")?.envVars).toEqual(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
    expect(findPhiBotProvider("opencode-go")?.envVars).toEqual(["OPENCODE_API_KEY"]);
  });

  it("declares Alibaba and the two custom endpoints in models.json with an API type", () => {
    expect(
      modelsJsonProviders.map((provider) => [provider.id, provider.phiProvider, provider.api, provider.needsBaseUrl]),
    ).toEqual([
      ["alibaba", "alibaba-codingplan", "openai-completions", false],
      ["custom", "phibot-custom", "openai-completions", true],
      ["custom-anthropic", "phibot-custom-anthropic", "anthropic-messages", true],
    ]);
    for (const provider of modelsJsonProviders) expect(provider.envVars).toEqual([]);
  });

  it("matches the key variables phi itself reads (findEnvKeys of phi-code-ai)", () => {
    for (const provider of nativeProviders) {
      const env = Object.fromEntries(provider.envVars.map((name) => [name, "x"]));
      expect(findEnvKeys(provider.phiProvider, env), provider.id).toContain(provider.envVars[0]);
    }
  });

  it("exposes the secret names and the unset placeholder shared with the UI", () => {
    expect(PHIBOT_LLM_SECRET_KEYS).toEqual({
      provider: "PHIBOT_LLM_PROVIDER",
      apiKey: "PHIBOT_LLM_API_KEY",
      baseUrl: "PHIBOT_LLM_BASE_URL",
      defaultModel: "PHIBOT_DEFAULT_MODEL",
    });
    expect(PHIBOT_UNSET).toBe("unset");
    expect(findPhiBotProvider("bedrock")).toBeNull();
  });
});
