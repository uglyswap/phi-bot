import fs from "node:fs/promises";
import path from "node:path";
import { findPhiBotProvider, PHIBOT_LLM_SECRET_KEYS, PHIBOT_PROVIDERS, PHIBOT_UNSET } from "../providers.js";
import { writeFileAtomically } from "./fs-atomic.js";

/** Alibaba Coding Plan is not built into phi: declared in models.json like phi's own /setup does. */
export const ALIBABA_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";
/**
 * Models phi bundles for the Alibaba Coding Plan (no public listing endpoint):
 * copy of `phi-release/packages/coding-agent/extensions/phi/providers/alibaba.ts:54-110`
 * (phi 0.99.4). Refresh this list when phi refreshes its own.
 */
export const ALIBABA_CODING_PLAN_MODELS: ReadonlyArray<{
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  vision: boolean;
}> = [
  { id: "qwen3.7-plus", name: "Qwen 3.7 Plus", contextWindow: 1_000_000, maxTokens: 16_384, reasoning: true, vision: true },
  { id: "qwen3.6-plus", name: "Qwen 3.6 Plus", contextWindow: 1_000_000, maxTokens: 16_384, reasoning: true, vision: true },
  { id: "qwen3.5-plus", name: "Qwen 3.5 Plus", contextWindow: 1_000_000, maxTokens: 16_384, reasoning: true, vision: true },
  { id: "qwen3-max-2026-01-23", name: "Qwen 3 Max", contextWindow: 262_144, maxTokens: 16_384, reasoning: true, vision: false },
  { id: "qwen3-coder-plus", name: "Qwen 3 Coder Plus", contextWindow: 1_000_000, maxTokens: 16_384, reasoning: true, vision: false },
  { id: "qwen3-coder-next", name: "Qwen 3 Coder Next", contextWindow: 1_000_000, maxTokens: 16_384, reasoning: true, vision: false },
  { id: "kimi-k2.5", name: "Kimi K2.5", contextWindow: 262_144, maxTokens: 16_384, reasoning: true, vision: true },
  { id: "glm-5", name: "GLM 5", contextWindow: 200_000, maxTokens: 128_000, reasoning: true, vision: false },
  { id: "glm-4.7", name: "GLM 4.7", contextWindow: 200_000, maxTokens: 128_000, reasoning: true, vision: false },
  { id: "MiniMax-M2.5", name: "MiniMax M2.5", contextWindow: 1_000_000, maxTokens: 16_384, reasoning: true, vision: false },
];

/**
 * Request compatibility of the custom endpoints (spec 9.1), per phi API type.
 * Most OpenAI-compatible servers (Ollama, vLLM, LiteLLM) reject the
 * "developer" role and reasoning_effort; many Anthropic-compatible proxies
 * reject the per-tool `eager_input_streaming` field.
 */
const CUSTOM_ENDPOINT_COMPAT: Readonly<Record<string, Record<string, boolean>>> = {
  "openai-completions": { supportsDeveloperRole: false, supportsReasoningEffort: false },
  "anthropic-messages": { supportsEagerToolInputStreaming: false },
};

/** Every key variable phi_local may set (built-in phi providers); all are forced to the company key or left out. */
export const PHI_PROVIDER_KEY_ENV: readonly string[] = Array.from(
  new Set(PHIBOT_PROVIDERS.flatMap((provider) => provider.envVars)),
);

export interface PhiProviderSelection {
  /** Id of PHIBOT_PROVIDERS (value of PHIBOT_LLM_PROVIDER). */
  phibotProvider: string;
  /** Value passed to `phi --provider`. */
  phiProvider: string;
  /** Value passed to `phi --model`. */
  modelId: string;
  /** `<phibotProvider>/<modelId>`, reported to Paperclip and shown in logs. */
  displayModel: string;
  /** Provider key variables to force in the child environment. */
  providerEnv: Record<string, string>;
  /** `providers` object written to the managed models.json (empty for built-in providers). */
  managedProviders: Record<string, unknown>;
  /** True when the model came from PHIBOT_DEFAULT_MODEL rather than the agent. */
  usesCompanyDefaultModel: boolean;
}

export type PhiProviderSelectionResult =
  | { ok: true; selection: PhiProviderSelection }
  | { ok: false; code: string; message: string };

const NOT_CONFIGURED_HINT =
  "Configure the AI provider in Settings > AI provider (company secrets PHIBOT_LLM_*).";

/** A PHIBOT_* value, or null when absent, blank or the "unset" placeholder. */
export function readPhiBotValue(env: Record<string, string | undefined>, key: string): string | null {
  const value = env[key]?.trim();
  if (!value || value === PHIBOT_UNSET) return null;
  return value;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function resolvePhiProviderSelection(input: {
  env: Record<string, string | undefined>;
  agentModel: string;
}): PhiProviderSelectionResult {
  const provider = readPhiBotValue(input.env, PHIBOT_LLM_SECRET_KEYS.provider);
  if (!provider) {
    return { ok: false, code: "phibot_llm_provider_missing", message: `No AI provider is configured. ${NOT_CONFIGURED_HINT}` };
  }
  const entry = findPhiBotProvider(provider);
  if (!entry) {
    return {
      ok: false,
      code: "phibot_llm_provider_invalid",
      message: `Unknown AI provider "${provider}". Expected one of: ${PHIBOT_PROVIDERS.map((item) => item.id).join(", ")}.`,
    };
  }
  const apiKey = readPhiBotValue(input.env, PHIBOT_LLM_SECRET_KEYS.apiKey);
  if (!apiKey) {
    return { ok: false, code: "phibot_llm_api_key_missing", message: `No API key is configured for "${provider}". ${NOT_CONFIGURED_HINT}` };
  }

  const agentModel = input.agentModel.trim();
  const companyModel = readPhiBotValue(input.env, PHIBOT_LLM_SECRET_KEYS.defaultModel);
  const rawModel = agentModel || companyModel || "";
  if (!rawModel) {
    return { ok: false, code: "phibot_model_missing", message: `No model is selected. Choose a default model. ${NOT_CONFIGURED_HINT}` };
  }
  const providerPrefix = `${provider}/`;
  const modelId = rawModel.startsWith(providerPrefix) ? rawModel.slice(providerPrefix.length).trim() : rawModel;
  if (!modelId) {
    return { ok: false, code: "phibot_model_missing", message: `The model "${rawModel}" has no model id. ${NOT_CONFIGURED_HINT}` };
  }

  const base = {
    phibotProvider: provider,
    phiProvider: entry.phiProvider,
    modelId,
    displayModel: `${provider}/${modelId}`,
    usesCompanyDefaultModel: agentModel.length === 0,
  };

  if (!entry.modelsJson) {
    return {
      ok: true,
      selection: {
        ...base,
        providerEnv: Object.fromEntries(entry.envVars.map((key) => [key, apiKey])),
        managedProviders: {},
      },
    };
  }

  const api = entry.api ?? "openai-completions";
  if (entry.id === "alibaba") {
    return {
      ok: true,
      selection: {
        ...base,
        providerEnv: {},
        managedProviders: {
          [entry.phiProvider]: {
            baseUrl: ALIBABA_BASE_URL,
            api,
            // Interpolated by phi from the child environment; the key never lands on disk.
            apiKey: `$${PHIBOT_LLM_SECRET_KEYS.apiKey}`,
            // Static list (same content for every agent): exact context windows for compaction.
            models: ALIBABA_CODING_PLAN_MODELS.map((model) => ({
              id: model.id,
              name: model.name,
              reasoning: model.reasoning,
              input: model.vision ? ["text", "image"] : ["text"],
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
            })),
          },
        },
      },
    };
  }

  // Custom endpoints ("custom", "custom-anthropic"): the company enters the base URL.
  const baseUrl = readPhiBotValue(input.env, PHIBOT_LLM_SECRET_KEYS.baseUrl);
  if (!baseUrl || !isHttpUrl(baseUrl)) {
    return {
      ok: false,
      code: "phibot_llm_base_url_invalid",
      message: `The provider "${provider}" needs an http(s) base URL in PHIBOT_LLM_BASE_URL. ${NOT_CONFIGURED_HINT}`,
    };
  }
  // models.json lists one stable model (the company default when set) so that
  // concurrent runs of agents using other models do not keep rewriting it.
  const companyModelId =
    companyModel && companyModel.startsWith(providerPrefix)
      ? companyModel.slice(providerPrefix.length).trim()
      : companyModel;
  const listedModelId = companyModelId || modelId;
  return {
    ok: true,
    selection: {
      ...base,
      providerEnv: {},
      managedProviders: {
        [entry.phiProvider]: {
          baseUrl,
          api,
          apiKey: `$${PHIBOT_LLM_SECRET_KEYS.apiKey}`,
          compat: CUSTOM_ENDPOINT_COMPAT[api] ?? {},
          models: [{ id: listedModelId }],
        },
      },
    },
  };
}

/**
 * Write `<agentDir>/models.json` atomically, only when its content changes.
 * The file is owned by Phi Bot (dedicated agent dir). A model id absent from
 * the list still works: phi falls back to a custom model id of a known
 * provider ("Using custom model id"), so concurrent runs of agents using
 * different models of the same provider cannot break each other.
 */
export async function writeManagedModelsJson(
  agentDir: string,
  providers: Record<string, unknown>,
): Promise<{ path: string; changed: boolean }> {
  const target = path.join(agentDir, "models.json");
  const content = `${JSON.stringify({ providers }, null, 2)}\n`;
  const current = await fs.readFile(target, "utf8").catch(() => null);
  if (current === content) return { path: target, changed: false };
  await fs.mkdir(agentDir, { recursive: true });
  await writeFileAtomically(target, content);
  return { path: target, changed: true };
}
