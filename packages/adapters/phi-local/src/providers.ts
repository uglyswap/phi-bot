/**
 * AI providers a Phi Bot company can connect. Single table shared by the
 * phi_local adapter (server) and the Phi Bot screens (UI, through `./ui`):
 * both sides read the same list, so they cannot drift apart.
 *
 * This module must stay free of Node.js imports: the UI bundles it.
 */
export interface PhiBotProvider {
  /** Value stored in the PHIBOT_LLM_PROVIDER company secret and used as model id prefix. */
  id: string;
  /** Name shown in the provider picker. */
  label: string;
  /** Value passed to `phi --provider`. */
  phiProvider: string;
  /** Environment variables the adapter sets to the company key (built-in phi providers). */
  envVars: string[];
  /** True when the company must also enter a base URL (PHIBOT_LLM_BASE_URL). */
  needsBaseUrl: boolean;
  /** True when the adapter declares the provider in the managed models.json. */
  modelsJson: boolean;
  /** phi API type written to models.json (providers with `modelsJson`). */
  api?: string;
  /** Typical beginning of a key, for the key field placeholder (never enforced). */
  keyHint?: string;
}

/** Names of the four company secrets, which are also the environment variables read by phi_local. */
export const PHIBOT_LLM_SECRET_KEYS = {
  provider: "PHIBOT_LLM_PROVIDER",
  apiKey: "PHIBOT_LLM_API_KEY",
  baseUrl: "PHIBOT_LLM_BASE_URL",
  defaultModel: "PHIBOT_DEFAULT_MODEL",
} as const;

/** Stored in a PHIBOT_* company secret that has no value (a managed secret cannot be empty). */
export const PHIBOT_UNSET = "unset";

/**
 * Built-in phi providers read their key from the variables of
 * `phi:packages/ai/src/env-api-keys.ts` (checked by providers.test.ts against
 * `findEnvKeys` of phi-code-ai). Google: phi's runtime reads GEMINI_API_KEY and
 * its /setup catalog names GOOGLE_API_KEY, so both are set. `alibaba`,
 * `custom` and `custom-anthropic` are declared in models.json with
 * `"apiKey": "$PHIBOT_LLM_API_KEY"`: the key is never written to disk.
 */
export const PHIBOT_PROVIDERS: readonly PhiBotProvider[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    phiProvider: "anthropic",
    envVars: ["ANTHROPIC_API_KEY"],
    needsBaseUrl: false,
    modelsJson: false,
    keyHint: "sk-ant-...",
  },
  {
    id: "openai",
    label: "OpenAI",
    phiProvider: "openai",
    envVars: ["OPENAI_API_KEY"],
    needsBaseUrl: false,
    modelsJson: false,
    keyHint: "sk-...",
  },
  {
    id: "google",
    label: "Google Gemini",
    phiProvider: "google",
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    needsBaseUrl: false,
    modelsJson: false,
    keyHint: "AIza...",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    phiProvider: "openrouter",
    envVars: ["OPENROUTER_API_KEY"],
    needsBaseUrl: false,
    modelsJson: false,
    keyHint: "sk-or-...",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    phiProvider: "xai",
    envVars: ["XAI_API_KEY"],
    needsBaseUrl: false,
    modelsJson: false,
    keyHint: "xai-...",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    phiProvider: "deepseek",
    envVars: ["DEEPSEEK_API_KEY"],
    needsBaseUrl: false,
    modelsJson: false,
    keyHint: "sk-...",
  },
  {
    id: "mistral",
    label: "Mistral",
    phiProvider: "mistral",
    envVars: ["MISTRAL_API_KEY"],
    needsBaseUrl: false,
    modelsJson: false,
  },
  {
    id: "groq",
    label: "Groq",
    phiProvider: "groq",
    envVars: ["GROQ_API_KEY"],
    needsBaseUrl: false,
    modelsJson: false,
    keyHint: "gsk_...",
  },
  {
    id: "zai",
    label: "Z.ai (GLM)",
    phiProvider: "zai",
    envVars: ["ZAI_API_KEY"],
    needsBaseUrl: false,
    modelsJson: false,
  },
  {
    id: "moonshotai",
    label: "Moonshot (Kimi)",
    phiProvider: "moonshotai",
    envVars: ["MOONSHOT_API_KEY"],
    needsBaseUrl: false,
    modelsJson: false,
    keyHint: "sk-...",
  },
  {
    id: "minimax",
    label: "MiniMax",
    phiProvider: "minimax",
    envVars: ["MINIMAX_API_KEY"],
    needsBaseUrl: false,
    modelsJson: false,
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    phiProvider: "opencode-go",
    envVars: ["OPENCODE_API_KEY"],
    needsBaseUrl: false,
    modelsJson: false,
  },
  {
    id: "alibaba",
    label: "Alibaba Coding Plan",
    phiProvider: "alibaba-codingplan",
    envVars: [],
    needsBaseUrl: false,
    modelsJson: true,
    api: "openai-completions",
    keyHint: "sk-sp-...",
  },
  {
    id: "custom",
    label: "Compatible OpenAI (URL personnalisée)",
    phiProvider: "phibot-custom",
    envVars: [],
    needsBaseUrl: true,
    modelsJson: true,
    api: "openai-completions",
  },
  {
    id: "custom-anthropic",
    label: "Compatible Anthropic (URL personnalisée)",
    phiProvider: "phibot-custom-anthropic",
    envVars: [],
    needsBaseUrl: true,
    modelsJson: true,
    api: "anthropic-messages",
  },
];

/** The provider whose id is `id`, or null. */
export function findPhiBotProvider(id: string): PhiBotProvider | null {
  return PHIBOT_PROVIDERS.find((provider) => provider.id === id) ?? null;
}
