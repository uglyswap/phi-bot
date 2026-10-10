import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALIBABA_BASE_URL,
  ALIBABA_CODING_PLAN_MODELS,
  resolvePhiProviderSelection,
  writeManagedModelsJson,
} from "./runtime-config.js";

const env = (values: Record<string, string>) => values;

describe("resolvePhiProviderSelection", () => {
  it("refuses to run without provider, key or model, treating 'unset' as absent", () => {
    expect(resolvePhiProviderSelection({ env: env({}), agentModel: "" })).toMatchObject({ ok: false, code: "phibot_llm_provider_missing" });
    expect(
      resolvePhiProviderSelection({ env: env({ PHIBOT_LLM_PROVIDER: "anthropic", PHIBOT_LLM_API_KEY: "unset" }), agentModel: "" }),
    ).toMatchObject({ ok: false, code: "phibot_llm_api_key_missing" });
    expect(
      resolvePhiProviderSelection({
        env: env({ PHIBOT_LLM_PROVIDER: "anthropic", PHIBOT_LLM_API_KEY: "sk", PHIBOT_DEFAULT_MODEL: "unset" }),
        agentModel: "",
      }),
    ).toMatchObject({ ok: false, code: "phibot_model_missing" });
    expect(
      resolvePhiProviderSelection({ env: env({ PHIBOT_LLM_PROVIDER: "bedrock", PHIBOT_LLM_API_KEY: "sk" }), agentModel: "x" }),
    ).toMatchObject({ ok: false, code: "phibot_llm_provider_invalid" });
  });

  it("maps a native provider to phi's key variable and strips the provider prefix", () => {
    const result = resolvePhiProviderSelection({
      env: env({ PHIBOT_LLM_PROVIDER: "anthropic", PHIBOT_LLM_API_KEY: "sk-ant", PHIBOT_DEFAULT_MODEL: "anthropic/claude-sonnet-4-6" }),
      agentModel: "",
    });
    expect(result).toEqual({
      ok: true,
      selection: {
        phibotProvider: "anthropic",
        phiProvider: "anthropic",
        modelId: "claude-sonnet-4-6",
        displayModel: "anthropic/claude-sonnet-4-6",
        providerEnv: { ANTHROPIC_API_KEY: "sk-ant" },
        managedProviders: {},
        usesCompanyDefaultModel: true,
      },
    });
  });

  it("prefers the agent model and keeps slashes of OpenRouter ids", () => {
    const result = resolvePhiProviderSelection({
      env: env({ PHIBOT_LLM_PROVIDER: "openrouter", PHIBOT_LLM_API_KEY: "sk-or", PHIBOT_DEFAULT_MODEL: "openrouter/x/y" }),
      agentModel: "openrouter/anthropic/claude-sonnet-4.5",
    });
    expect(result.ok && result.selection.modelId).toBe("anthropic/claude-sonnet-4.5");
    expect(result.ok && result.selection.providerEnv).toEqual({ OPENROUTER_API_KEY: "sk-or" });
    expect(result.ok && result.selection.usesCompanyDefaultModel).toBe(false);
  });

  it("maps Z.ai, Moonshot, MiniMax and OpenCode Go to the key variable phi reads", () => {
    const cases: Array<[string, string]> = [
      ["zai", "ZAI_API_KEY"],
      ["moonshotai", "MOONSHOT_API_KEY"],
      ["minimax", "MINIMAX_API_KEY"],
      ["opencode-go", "OPENCODE_API_KEY"],
    ];
    for (const [provider, keyEnv] of cases) {
      const result = resolvePhiProviderSelection({
        env: env({ PHIBOT_LLM_PROVIDER: provider, PHIBOT_LLM_API_KEY: "k", PHIBOT_DEFAULT_MODEL: `${provider}/m-1` }),
        agentModel: "",
      });
      expect(result, provider).toMatchObject({
        ok: true,
        selection: { phiProvider: provider, modelId: "m-1", providerEnv: { [keyEnv]: "k" }, managedProviders: {} },
      });
    }
  });

  it("sets both Google key variables", () => {
    const result = resolvePhiProviderSelection({
      env: env({ PHIBOT_LLM_PROVIDER: "google", PHIBOT_LLM_API_KEY: "g", PHIBOT_DEFAULT_MODEL: "google/gemini-2.5-pro" }),
      agentModel: "",
    });
    expect(result.ok && result.selection.providerEnv).toEqual({ GEMINI_API_KEY: "g", GOOGLE_API_KEY: "g" });
  });

  it("declares Alibaba in models.json with an env reference, never the key", () => {
    const result = resolvePhiProviderSelection({
      env: env({ PHIBOT_LLM_PROVIDER: "alibaba", PHIBOT_LLM_API_KEY: "sk-sp-secret", PHIBOT_DEFAULT_MODEL: "alibaba/qwen3-coder-plus" }),
      agentModel: "",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection.phiProvider).toBe("alibaba-codingplan");
    expect(result.selection.providerEnv).toEqual({});
    const provider = result.selection.managedProviders["alibaba-codingplan"] as Record<string, unknown>;
    expect(provider.baseUrl).toBe(ALIBABA_BASE_URL);
    expect(provider.apiKey).toBe("$PHIBOT_LLM_API_KEY");
    expect((provider.models as unknown[]).length).toBe(ALIBABA_CODING_PLAN_MODELS.length);
    expect(JSON.stringify(result.selection.managedProviders)).not.toContain("sk-sp-secret");
  });

  it("requires an http(s) base URL for a custom provider", () => {
    expect(
      resolvePhiProviderSelection({
        env: env({ PHIBOT_LLM_PROVIDER: "custom", PHIBOT_LLM_API_KEY: "k", PHIBOT_LLM_BASE_URL: "unset", PHIBOT_DEFAULT_MODEL: "custom/llama3" }),
        agentModel: "",
      }),
    ).toMatchObject({ ok: false, code: "phibot_llm_base_url_invalid" });
    const result = resolvePhiProviderSelection({
      env: env({
        PHIBOT_LLM_PROVIDER: "custom",
        PHIBOT_LLM_API_KEY: "k",
        PHIBOT_LLM_BASE_URL: "http://127.0.0.1:11434/v1",
        PHIBOT_DEFAULT_MODEL: "custom/llama3.1:70b",
      }),
      agentModel: "custom/qwen2.5-coder",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection.phiProvider).toBe("phibot-custom");
    expect(result.selection.modelId).toBe("qwen2.5-coder");
    expect(result.selection.managedProviders).toEqual({
      "phibot-custom": {
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        apiKey: "$PHIBOT_LLM_API_KEY",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        // The company default model is listed (stable file); other ids use phi's fallback.
        models: [{ id: "llama3.1:70b" }],
      },
    });
  });

  it("declares an Anthropic-compatible endpoint with the anthropic-messages API (custom-anthropic)", () => {
    expect(
      resolvePhiProviderSelection({
        env: env({ PHIBOT_LLM_PROVIDER: "custom-anthropic", PHIBOT_LLM_API_KEY: "k", PHIBOT_DEFAULT_MODEL: "custom-anthropic/m" }),
        agentModel: "",
      }),
    ).toMatchObject({ ok: false, code: "phibot_llm_base_url_invalid" });
    const result = resolvePhiProviderSelection({
      env: env({
        PHIBOT_LLM_PROVIDER: "custom-anthropic",
        PHIBOT_LLM_API_KEY: "sk-proxy-secret",
        PHIBOT_LLM_BASE_URL: "https://llm-proxy.example.com",
        PHIBOT_DEFAULT_MODEL: "custom-anthropic/claude-sonnet-4-6",
      }),
      agentModel: "",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection.phiProvider).toBe("phibot-custom-anthropic");
    expect(result.selection.modelId).toBe("claude-sonnet-4-6");
    expect(result.selection.displayModel).toBe("custom-anthropic/claude-sonnet-4-6");
    expect(result.selection.providerEnv).toEqual({});
    expect(result.selection.managedProviders).toEqual({
      "phibot-custom-anthropic": {
        baseUrl: "https://llm-proxy.example.com",
        api: "anthropic-messages",
        apiKey: "$PHIBOT_LLM_API_KEY",
        compat: { supportsEagerToolInputStreaming: false },
        models: [{ id: "claude-sonnet-4-6" }],
      },
    });
    expect(JSON.stringify(result.selection.managedProviders)).not.toContain("sk-proxy-secret");
  });
});

describe("writeManagedModelsJson", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("writes atomically and skips identical content", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "phi-models-json-"));
    dirs.push(dir);
    const first = await writeManagedModelsJson(dir, { a: { baseUrl: "http://x" } });
    expect(first.changed).toBe(true);
    expect(JSON.parse(await fs.readFile(first.path, "utf8"))).toEqual({ providers: { a: { baseUrl: "http://x" } } });
    expect((await writeManagedModelsJson(dir, { a: { baseUrl: "http://x" } })).changed).toBe(false);
    expect((await writeManagedModelsJson(dir, {})).changed).toBe(true);
    expect((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
