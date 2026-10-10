import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret, Environment } from "@paperclipai/shared";
import { PHIBOT_PROVIDERS } from "@paperclipai/adapter-phi-local/ui";

const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  enable: vi.fn(),
  rotate: vi.fn(),
  update: vi.fn(),
}));
const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../api/environments", () => ({ environmentsApi: mockEnvironmentsApi }));

import {
  PHIBOT_DEFAULT_PROVIDER_ID,
  derivePhiBotLlmState,
  describePhiBotSettingsChange,
  normalizePhiBotModel,
  phiBotModelsForProvider,
  resolvePhiBotTargetEnvironment,
  savePhiBotLlmSettings,
  validatePhiBotLlmValues,
} from "./phibot-llm";

function secret(
  key: string,
  providerMetadata: Record<string, unknown> | null,
  referenceCount = 1,
): CompanySecret {
  return {
    id: `id-${key}`,
    companyId: "company-1",
    scope: "company",
    ownerUserId: null,
    userSecretDefinitionId: null,
    key,
    name: key,
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata,
    latestVersion: 1,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    referenceCount,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function environment(id: string, driver: Environment["driver"]): Environment {
  return {
    id,
    name: id,
    description: null,
    driver,
    status: "active",
    config: {},
    envVars: {},
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/** Keys as the server stores them: lowercased (server/src/services/secrets.ts:761-768). */
function configuredSecrets(provider: string, model: string, baseUrl = ""): CompanySecret[] {
  return [
    secret("phibot_llm_provider", { phibotValue: provider }),
    secret("phibot_llm_api_key", { phibotKeySet: true }),
    secret("phibot_llm_base_url", { phibotValue: baseUrl }),
    secret("phibot_default_model", { phibotValue: model }),
  ];
}

describe("provider table", () => {
  it("uses the 15 providers of the adapter package, Anthropic first", () => {
    expect(PHIBOT_PROVIDERS).toHaveLength(15);
    expect(PHIBOT_DEFAULT_PROVIDER_ID).toBe("anthropic");
  });
});

describe("derivePhiBotLlmState", () => {
  it("matches the lowercase keys the server stores and the uppercase variable names", () => {
    const upper = configuredSecrets("openai", "openai/gpt-5").map((entry) => ({ ...entry, key: entry.key.toUpperCase() }));
    expect(derivePhiBotLlmState(upper).configured).toBe(true);
    expect(derivePhiBotLlmState(configuredSecrets("openai", "openai/gpt-5")).configured).toBe(true);
  });

  it("reports a complete configuration", () => {
    const state = derivePhiBotLlmState(configuredSecrets("anthropic", "anthropic/claude-sonnet-4-6"));
    expect(state.provider).toBe("anthropic");
    expect(state.keyConfigured).toBe(true);
    expect(state.configured).toBe(true);
  });

  it("requires a key typed in Phi Bot", () => {
    const secrets = configuredSecrets("openai", "openai/gpt-5");
    secrets[1] = secret("phibot_llm_api_key", null);
    expect(derivePhiBotLlmState(secrets).configured).toBe(false);
  });

  it("requires a base URL for both custom providers", () => {
    expect(derivePhiBotLlmState(configuredSecrets("custom", "custom/llama3")).configured).toBe(false);
    expect(derivePhiBotLlmState(configuredSecrets("custom-anthropic", "custom-anthropic/m")).configured).toBe(false);
    expect(
      derivePhiBotLlmState(configuredSecrets("custom", "custom/llama3", "http://127.0.0.1:8080/v1")).configured,
    ).toBe(true);
  });

  it("requires every secret to be bound", () => {
    const secrets = configuredSecrets("groq", "groq/llama-3.3-70b-versatile");
    secrets[3] = secret("phibot_default_model", { phibotValue: "groq/llama-3.3-70b-versatile" }, 0);
    expect(derivePhiBotLlmState(secrets).configured).toBe(false);
  });

  it("ignores an unknown provider and the unset placeholder", () => {
    const state = derivePhiBotLlmState(configuredSecrets("bedrock", "unset"));
    expect(state.provider).toBeNull();
    expect(state.model).toBe("");
    expect(state.configured).toBe(false);
  });
});

describe("validatePhiBotLlmValues", () => {
  it("rejects an unknown provider", () => {
    const values = { provider: "bedrock", apiKey: "secret-key-123", baseUrl: "", model: "" };
    expect(validatePhiBotLlmValues(values, { requireApiKey: true, requireModel: false })).toBe("providerRequired");
  });

  it("requires an http(s) base URL for the custom providers", () => {
    const values = { provider: "custom", apiKey: "secret-key-123", baseUrl: "ftp://x", model: "" };
    expect(validatePhiBotLlmValues(values, { requireApiKey: true, requireModel: false })).toBe("baseUrlInvalid");
    const anthropicCompatible = { provider: "custom-anthropic", apiKey: "secret-key-123", baseUrl: "", model: "" };
    expect(validatePhiBotLlmValues(anthropicCompatible, { requireApiKey: true, requireModel: false })).toBe(
      "baseUrlRequired",
    );
  });

  it("rejects a key with spaces or too short", () => {
    const values = { provider: "openai", apiKey: "sk 123", baseUrl: "", model: "" };
    expect(validatePhiBotLlmValues(values, { requireApiKey: true, requireModel: false })).toBe("apiKeyFormat");
  });

  it("accepts a stored key when none is typed", () => {
    const values = { provider: "openai", apiKey: "", baseUrl: "", model: "gpt-5" };
    expect(validatePhiBotLlmValues(values, { requireApiKey: false, requireModel: true })).toBeNull();
  });
});

describe("model helpers", () => {
  it("prefixes a model with the provider once", () => {
    expect(normalizePhiBotModel("openrouter", "anthropic/claude-sonnet-4.5")).toBe(
      "openrouter/anthropic/claude-sonnet-4.5",
    );
    expect(normalizePhiBotModel("anthropic", "anthropic/claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4-6");
  });

  it("keeps only the models of the provider", () => {
    const models = [
      { id: "anthropic/a", label: "A" },
      { id: "openai/b", label: "B" },
      { id: "custom-anthropic/c", label: "C" },
    ];
    expect(phiBotModelsForProvider(models, "openai")).toEqual([{ id: "openai/b", label: "B" }]);
    expect(phiBotModelsForProvider(models, "custom")).toEqual([]);
  });
});

describe("describePhiBotSettingsChange", () => {
  const state = derivePhiBotLlmState(configuredSecrets("anthropic", "anthropic/claude-sonnet-4-6"));

  it("announces a session restart when the provider, key or model changes", () => {
    const same = { provider: "anthropic", apiKey: "", baseUrl: "", model: "claude-sonnet-4-6" };
    expect(describePhiBotSettingsChange(state, same)).toEqual({ providerChanged: false, restartsSessions: false });
    expect(describePhiBotSettingsChange(state, { ...same, apiKey: "sk-new-key-123" }).restartsSessions).toBe(true);
    expect(describePhiBotSettingsChange(state, { ...same, model: "claude-opus-4-1" }).restartsSessions).toBe(true);
    expect(describePhiBotSettingsChange(state, { ...same, provider: "openai", model: "" })).toEqual({
      providerChanged: true,
      restartsSessions: true,
    });
  });

  it("announces nothing before the first setup", () => {
    const empty = derivePhiBotLlmState([]);
    const values = { provider: "openai", apiKey: "sk-new-key-123", baseUrl: "", model: "gpt-5" };
    expect(describePhiBotSettingsChange(empty, values)).toEqual({ providerChanged: false, restartsSessions: false });
  });
});

describe("resolvePhiBotTargetEnvironment", () => {
  it("picks the active local environment", () => {
    const environments = [environment("ssh", "ssh"), environment("local", "local")];
    expect(resolvePhiBotTargetEnvironment(environments)?.id).toBe("local");
  });

  it("returns null without a local environment", () => {
    expect(resolvePhiBotTargetEnvironment([environment("ssh", "ssh")])).toBeNull();
  });
});

describe("savePhiBotLlmSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnvironmentsApi.list.mockResolvedValue([environment("env-ssh", "ssh"), environment("env-local", "local")]);
    mockEnvironmentsApi.update.mockResolvedValue({});
    mockSecretsApi.create.mockResolvedValue({});
  });

  it("creates the four secrets on the first setup and binds them once in the local environment", async () => {
    const created = configuredSecrets("custom", "", "http://127.0.0.1:18765/v1").map((entry) => ({
      ...entry,
      referenceCount: 0,
    }));
    mockSecretsApi.list.mockResolvedValueOnce([]).mockResolvedValueOnce(created);

    await savePhiBotLlmSettings({
      companyId: "company-1",
      provider: "custom",
      apiKey: " sk-test-123456 ",
      baseUrl: "http://127.0.0.1:18765/v1",
      model: null,
    });

    expect(mockSecretsApi.create.mock.calls.map(([, body]) => [body.key, body.value])).toEqual([
      ["PHIBOT_LLM_PROVIDER", "custom"],
      ["PHIBOT_LLM_BASE_URL", "http://127.0.0.1:18765/v1"],
      ["PHIBOT_DEFAULT_MODEL", "unset"],
      ["PHIBOT_LLM_API_KEY", "sk-test-123456"],
    ]);
    expect(mockSecretsApi.create.mock.calls[3]?.[1].providerMetadata).toEqual({ phibotKeySet: true });
    expect(mockEnvironmentsApi.update).toHaveBeenCalledTimes(1);
    const [environmentId, body, companyId] = mockEnvironmentsApi.update.mock.calls[0]!;
    expect(environmentId).toBe("env-local");
    expect(companyId).toBe("company-1");
    expect(body.envVars.PHIBOT_LLM_API_KEY).toEqual({
      type: "secret_ref",
      secretId: "id-phibot_llm_api_key",
      version: "latest",
    });
    expect(Object.keys(body.envVars).sort()).toEqual([
      "PHIBOT_DEFAULT_MODEL",
      "PHIBOT_LLM_API_KEY",
      "PHIBOT_LLM_BASE_URL",
      "PHIBOT_LLM_PROVIDER",
    ]);
  });

  it("rotates only the changed values of a bound configuration and never rebinds", async () => {
    mockSecretsApi.list.mockResolvedValueOnce(configuredSecrets("anthropic", "anthropic/claude-sonnet-4-6"));

    await savePhiBotLlmSettings({
      companyId: "company-1",
      provider: "anthropic",
      apiKey: "",
      baseUrl: "ignored",
      model: "claude-opus-4-1",
    });

    expect(mockSecretsApi.create).not.toHaveBeenCalled();
    expect(mockSecretsApi.rotate.mock.calls).toEqual([["id-phibot_default_model", { value: "anthropic/claude-opus-4-1" }]]);
    expect(mockEnvironmentsApi.update).not.toHaveBeenCalled();
  });

  it("refuses to save without any key", async () => {
    mockSecretsApi.list.mockResolvedValueOnce([]);
    await expect(
      savePhiBotLlmSettings({ companyId: "company-1", provider: "openai", apiKey: "", baseUrl: "", model: null }),
    ).rejects.toMatchObject({ code: "apiKeyRequired" });
  });
});
