/**
 * Phi Bot: company-wide AI provider settings for the phi_local engine.
 *
 * Four company secrets hold the values that every run of every agent receives
 * as environment variables, through a one-time binding (secret_ref, version
 * "latest") in the envVars of the company's local environment, the one runs
 * and adapter tests use when an agent has no environment of its own.
 *
 * The board cannot read secret values back, so each non-sensitive value is
 * mirrored in the secret's providerMetadata ("phibotValue") for display.
 * A managed secret cannot be empty: PHIBOT_UNSET ("unset") stands for "no value".
 *
 * The provider table comes from the adapter package, so the screens and the
 * adapter can never disagree on ids, labels or base URL needs.
 */
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
import type {
  AdapterEnvironmentTestResult,
  CompanySecret,
  EnvBinding,
  Environment,
} from "@paperclipai/shared";
import {
  PHIBOT_LLM_SECRET_KEYS,
  PHIBOT_PROVIDERS,
  PHIBOT_UNSET,
  findPhiBotProvider,
  type PhiBotProvider,
} from "@paperclipai/adapter-phi-local/ui";
import type { AdapterModel } from "../api/agents";
import { environmentsApi } from "../api/environments";
import { secretsApi } from "../api/secrets";

/** The only engine of Phi Bot. */
export const PHI_ADAPTER_TYPE = "phi_local";

/** Phi Bot runs a single organization per installation. */
export const PHIBOT_SINGLE_ORGANIZATION = true;

type PhiBotSecretKey = (typeof PHIBOT_LLM_SECRET_KEYS)[keyof typeof PHIBOT_LLM_SECRET_KEYS];

const PHIBOT_SECRET_NAMES: Record<PhiBotSecretKey, string> = {
  PHIBOT_LLM_PROVIDER: "Phi Bot - AI provider",
  PHIBOT_LLM_API_KEY: "Phi Bot - AI provider API key",
  PHIBOT_LLM_BASE_URL: "Phi Bot - AI provider base URL",
  PHIBOT_DEFAULT_MODEL: "Phi Bot - default model",
};

const PHIBOT_SECRET_DESCRIPTION = "Managed by Phi Bot. Change it in Settings > AI provider.";

const PHIBOT_VALUE_FIELD = "phibotValue";
const PHIBOT_KEY_SET_FIELD = "phibotKeySet";
const MIN_API_KEY_LENGTH = 8;
const MAX_API_KEY_LENGTH = 16384;
const MAX_MODEL_LENGTH = 200;

/** Provider preselected on a fresh installation (first entry of the table). */
export const PHIBOT_DEFAULT_PROVIDER_ID = PHIBOT_PROVIDERS[0]?.id ?? "anthropic";

export function isPhiBotProviderId(value: string): boolean {
  return findPhiBotProvider(value) !== null;
}

export function getPhiBotProvider(id: string): PhiBotProvider {
  const provider = findPhiBotProvider(id);
  if (!provider) throw new Error(`Unknown Phi Bot provider: ${id}`);
  return provider;
}

/** Form values. The API key is only ever held in memory, never in a draft. */
export interface PhiBotLlmValues {
  /** A provider id of PHIBOT_PROVIDERS. */
  provider: string;
  /** Empty keeps the stored key. */
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface PhiBotLlmState {
  provider: string | null;
  baseUrl: string;
  model: string;
  keySecret: CompanySecret | null;
  /** A key typed in Phi Bot is stored (not a provisioning placeholder). */
  keyConfigured: boolean;
  /** Every value is present and every secret is bound to an environment. */
  configured: boolean;
}

export type PhiBotErrorCode =
  | "providerRequired"
  | "apiKeyRequired"
  | "apiKeyFormat"
  | "baseUrlRequired"
  | "baseUrlInvalid"
  | "modelRequired"
  | "modelInvalid"
  | "companyNameRequired"
  | "environmentMissing"
  | "secretMissing";

/** A failure whose message the caller takes from the text dictionary. */
export class PhiBotSetupError extends Error {
  readonly code: PhiBotErrorCode;

  constructor(code: PhiBotErrorCode) {
    super(code);
    this.name = "PhiBotSetupError";
    this.code = code;
  }
}

/**
 * The server stores secret keys lowercased (normalizeSecretKey,
 * server/src/services/secrets.ts:761-768); the environment variable names
 * bound in the local environment keep their uppercase form.
 */
function findSecret(secrets: readonly CompanySecret[], key: PhiBotSecretKey): CompanySecret | null {
  const storedKey = key.toLowerCase();
  return secrets.find((secret) => secret.key.toLowerCase() === storedKey) ?? null;
}

function mirroredValue(secret: CompanySecret | null): string {
  const raw = secret?.providerMetadata?.[PHIBOT_VALUE_FIELD];
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  return value === PHIBOT_UNSET ? "" : value;
}

function isBound(secret: CompanySecret | null): boolean {
  return Boolean(secret && secret.status === "active" && (secret.referenceCount ?? 0) > 0);
}

/** Current settings, read from the secret list alone (readable by every board member). */
export function derivePhiBotLlmState(secrets: readonly CompanySecret[]): PhiBotLlmState {
  const providerSecret = findSecret(secrets, PHIBOT_LLM_SECRET_KEYS.provider);
  const keySecret = findSecret(secrets, PHIBOT_LLM_SECRET_KEYS.apiKey);
  const baseUrlSecret = findSecret(secrets, PHIBOT_LLM_SECRET_KEYS.baseUrl);
  const modelSecret = findSecret(secrets, PHIBOT_LLM_SECRET_KEYS.defaultModel);
  const providerEntry = findPhiBotProvider(mirroredValue(providerSecret));
  const provider = providerEntry ? providerEntry.id : null;
  const baseUrl = mirroredValue(baseUrlSecret);
  const model = mirroredValue(modelSecret);
  const keyConfigured = Boolean(
    keySecret &&
      keySecret.status === "active" &&
      keySecret.providerMetadata?.[PHIBOT_KEY_SET_FIELD] === true,
  );
  const allBound = [providerSecret, keySecret, baseUrlSecret, modelSecret].every(isBound);
  const configured = Boolean(
    allBound && keyConfigured && providerEntry && model && (!providerEntry.needsBaseUrl || baseUrl),
  );
  return { provider, baseUrl, model, keySecret, keyConfigured, configured };
}

function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Not a URL at all: the caller reports it as "baseUrlInvalid".
    return false;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:";
}

/** Validates the form; returns the first problem found, or null. */
export function validatePhiBotLlmValues(
  values: PhiBotLlmValues,
  options: { requireApiKey: boolean; requireModel: boolean },
): PhiBotErrorCode | null {
  const provider = findPhiBotProvider(values.provider);
  if (!provider) return "providerRequired";
  const apiKey = values.apiKey.trim();
  if (options.requireApiKey && !apiKey) return "apiKeyRequired";
  if (apiKey && (apiKey.length < MIN_API_KEY_LENGTH || apiKey.length > MAX_API_KEY_LENGTH || /\s/.test(apiKey))) {
    return "apiKeyFormat";
  }
  if (provider.needsBaseUrl) {
    const baseUrl = values.baseUrl.trim();
    if (!baseUrl) return "baseUrlRequired";
    if (!isHttpUrl(baseUrl)) return "baseUrlInvalid";
  }
  const model = values.model.trim();
  if (options.requireModel && !model) return "modelRequired";
  if (model && (model.length > MAX_MODEL_LENGTH || /\s/.test(model))) return "modelInvalid";
  return null;
}

/** Stored form: "<provider>/<model>", the same ids the phi_local model list returns. */
export function normalizePhiBotModel(provider: string, raw: string): string {
  const model = raw.trim();
  if (!model) return "";
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}

/** Keeps the models of one provider (ids prefixed "<provider>/"). */
export function phiBotModelsForProvider(
  models: readonly AdapterModel[],
  provider: string,
): AdapterModel[] {
  const prefix = `${provider}/`;
  return models.filter((model) => model.id.startsWith(prefix));
}

export interface PhiBotSettingsChange {
  /** The provider differs from the stored one (the default model is cleared). */
  providerChanged: boolean;
  /**
   * Saving would change the provider, the key, the base URL or the default
   * model of a configured company: every task restarts its phi session at its
   * next run (adapter configuration fingerprint).
   */
  restartsSessions: boolean;
}

/** What saving `values` would change compared with the stored settings. */
export function describePhiBotSettingsChange(
  state: PhiBotLlmState,
  values: PhiBotLlmValues,
): PhiBotSettingsChange {
  const providerChanged = state.provider !== null && state.provider !== values.provider;
  const provider = findPhiBotProvider(values.provider);
  const baseUrl = provider?.needsBaseUrl ? values.baseUrl.trim() : "";
  const changed =
    providerChanged ||
    values.apiKey.trim() !== "" ||
    baseUrl !== state.baseUrl ||
    normalizePhiBotModel(values.provider, values.model) !== state.model;
  return { providerChanged, restartsSessions: state.configured && changed };
}

/** Same blocking rule as the onboarding wizard (OnboardingWizard.tsx:173-176). */
export function phiBotTestBlocks(result: AdapterEnvironmentTestResult): boolean {
  if (result.status === "fail") return true;
  return result.checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE);
}

/**
 * The company's local environment: runs of agents without an environment of
 * their own use it, and so does the adapter test route (patch P7).
 */
export function resolvePhiBotTargetEnvironment(environments: readonly Environment[]): Environment | null {
  return (
    environments.find(
      (environment) => environment.driver === "local" && environment.status === "active",
    ) ?? null
  );
}

async function loadTargetEnvironment(companyId: string): Promise<Environment> {
  const target = resolvePhiBotTargetEnvironment(await environmentsApi.list(companyId));
  if (!target) throw new PhiBotSetupError("environmentMissing");
  return target;
}

export async function phiBotTargetEnvironmentId(companyId: string): Promise<string> {
  return (await loadTargetEnvironment(companyId)).id;
}

async function upsertMirroredSecret(
  companyId: string,
  existing: CompanySecret | null,
  key: PhiBotSecretKey,
  value: string,
): Promise<void> {
  const storedValue = value || PHIBOT_UNSET;
  if (!existing) {
    await secretsApi.create(companyId, {
      name: PHIBOT_SECRET_NAMES[key],
      key,
      value: storedValue,
      description: PHIBOT_SECRET_DESCRIPTION,
      providerMetadata: { [PHIBOT_VALUE_FIELD]: value },
    });
    return;
  }
  if (existing.status !== "active") await secretsApi.enable(existing.id);
  if (existing.providerMetadata?.[PHIBOT_VALUE_FIELD] === value) return;
  await secretsApi.rotate(existing.id, { value: storedValue });
  await secretsApi.update(existing.id, {
    providerMetadata: { ...(existing.providerMetadata ?? {}), [PHIBOT_VALUE_FIELD]: value },
  });
}

async function upsertApiKeySecret(
  companyId: string,
  existing: CompanySecret | null,
  apiKey: string,
): Promise<void> {
  if (!existing) {
    await secretsApi.create(companyId, {
      name: PHIBOT_SECRET_NAMES[PHIBOT_LLM_SECRET_KEYS.apiKey],
      key: PHIBOT_LLM_SECRET_KEYS.apiKey,
      value: apiKey,
      description: PHIBOT_SECRET_DESCRIPTION,
      providerMetadata: { [PHIBOT_KEY_SET_FIELD]: true },
    });
    return;
  }
  if (existing.status !== "active") await secretsApi.enable(existing.id);
  await secretsApi.rotate(existing.id, { value: apiKey });
  await secretsApi.update(existing.id, {
    providerMetadata: { ...(existing.providerMetadata ?? {}), [PHIBOT_KEY_SET_FIELD]: true },
  });
}

/**
 * Binds the four secrets in the local environment. Needs instance admin
 * rights (PATCH /environments/:id): done once, at the first setup.
 */
async function bindPhiBotSecrets(companyId: string): Promise<void> {
  const [secrets, target] = await Promise.all([
    secretsApi.list(companyId),
    loadTargetEnvironment(companyId),
  ]);
  const envVars: Record<string, EnvBinding> = { ...target.envVars };
  for (const key of Object.values(PHIBOT_LLM_SECRET_KEYS)) {
    const secret = findSecret(secrets, key);
    if (!secret) throw new PhiBotSetupError("secretMissing");
    envVars[key] = { type: "secret_ref", secretId: secret.id, version: "latest" };
  }
  await environmentsApi.update(target.id, { envVars }, companyId);
}

export interface SavePhiBotLlmInput {
  companyId: string;
  /** A provider id of PHIBOT_PROVIDERS. */
  provider: string;
  /** Empty keeps the stored key. */
  apiKey: string;
  /** Read only for the providers that need a base URL. */
  baseUrl: string;
  /** null keeps the stored model, except after a provider change, which clears it. */
  model: string | null;
}

/** Creates or rotates the four secrets, then binds them if any is not bound yet. */
export async function savePhiBotLlmSettings(input: SavePhiBotLlmInput): Promise<void> {
  const provider = findPhiBotProvider(input.provider);
  if (!provider) throw new PhiBotSetupError("providerRequired");
  const secrets = await secretsApi.list(input.companyId);
  const current = derivePhiBotLlmState(secrets);
  const apiKey = input.apiKey.trim();
  if (!apiKey && !current.keyConfigured) throw new PhiBotSetupError("apiKeyRequired");
  const providerChanged = current.provider !== provider.id;
  const model =
    input.model !== null
      ? normalizePhiBotModel(provider.id, input.model)
      : providerChanged
        ? ""
        : current.model;
  const baseUrl = provider.needsBaseUrl ? input.baseUrl.trim() : "";

  await upsertMirroredSecret(
    input.companyId,
    findSecret(secrets, PHIBOT_LLM_SECRET_KEYS.provider),
    PHIBOT_LLM_SECRET_KEYS.provider,
    provider.id,
  );
  await upsertMirroredSecret(
    input.companyId,
    findSecret(secrets, PHIBOT_LLM_SECRET_KEYS.baseUrl),
    PHIBOT_LLM_SECRET_KEYS.baseUrl,
    baseUrl,
  );
  await upsertMirroredSecret(
    input.companyId,
    findSecret(secrets, PHIBOT_LLM_SECRET_KEYS.defaultModel),
    PHIBOT_LLM_SECRET_KEYS.defaultModel,
    model,
  );
  if (apiKey) {
    await upsertApiKeySecret(input.companyId, findSecret(secrets, PHIBOT_LLM_SECRET_KEYS.apiKey), apiKey);
  }

  const unbound = Object.values(PHIBOT_LLM_SECRET_KEYS).some(
    (key) => (findSecret(secrets, key)?.referenceCount ?? 0) === 0,
  );
  if (unbound) await bindPhiBotSecrets(input.companyId);
}
