import { useId } from "react";
import { PHIBOT_PROVIDERS, findPhiBotProvider } from "@paperclipai/adapter-phi-local/ui";
import type { AdapterModel } from "../../api/agents";
import { getPhiBotProvider, type PhiBotLlmValues } from "../../lib/phibot-llm";
import { Field } from "../agent-config-primitives";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/select";
import { phiBotProviderName, phibotText } from "./phibot-text";

/** Provider, key, base URL and model fields shared by the setup screen and the settings page. */
export function PhiBotLlmFields({
  values,
  onChange,
  showProvider,
  showApiKey,
  showModel,
  keyConfigured,
  modelOptions,
  modelsLoading,
  disabled = false,
  autoFocusApiKey = false,
}: {
  values: PhiBotLlmValues;
  onChange: (next: PhiBotLlmValues) => void;
  showProvider: boolean;
  showApiKey: boolean;
  showModel: boolean;
  keyConfigured: boolean;
  modelOptions: readonly AdapterModel[];
  modelsLoading: boolean;
  disabled?: boolean;
  autoFocusApiKey?: boolean;
}) {
  const text = phibotText();
  const provider = getPhiBotProvider(values.provider);
  const modelListId = useId();
  const keyPlaceholder = keyConfigured
    ? text.apiKeyKeepPlaceholder
    : provider.keyHint ?? text.apiKeyPlaceholder;
  const baseUrlHint = provider.api === "anthropic-messages" ? text.baseUrlAnthropicHint : text.baseUrlHint;

  return (
    <div className="space-y-5">
      {showProvider ? (
        <Field label={text.providerLabel}>
          <NativeSelect
            aria-label={text.providerLabel}
            value={values.provider}
            disabled={disabled}
            onChange={(event) => {
              const next = findPhiBotProvider(event.target.value);
              if (!next || next.id === values.provider) return;
              onChange({
                ...values,
                provider: next.id,
                model: "",
                baseUrl: next.needsBaseUrl ? values.baseUrl : "",
              });
            }}
          >
            {PHIBOT_PROVIDERS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {phiBotProviderName(entry, text)}
              </option>
            ))}
          </NativeSelect>
        </Field>
      ) : (
        <p className="text-sm text-muted-foreground">{text.providerSummary(phiBotProviderName(provider, text))}</p>
      )}
      {showApiKey && (
        <Field label={text.apiKeyLabel}>
          <Input
            aria-label={text.apiKeyLabel}
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoFocus={autoFocusApiKey}
            disabled={disabled}
            value={values.apiKey}
            placeholder={keyPlaceholder}
            onChange={(event) => onChange({ ...values, apiKey: event.target.value })}
          />
          <p className="mt-1 text-xs text-muted-foreground">{text.apiKeyHint}</p>
        </Field>
      )}
      {showApiKey && provider.needsBaseUrl && (
        <Field label={text.baseUrlLabel}>
          <Input
            aria-label={text.baseUrlLabel}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            value={values.baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(event) => onChange({ ...values, baseUrl: event.target.value })}
          />
          <p className="mt-1 text-xs text-muted-foreground">{baseUrlHint}</p>
        </Field>
      )}
      {showModel && (
        <Field label={text.modelLabel}>
          <Input
            aria-label={text.modelLabel}
            list={modelListId}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            value={values.model}
            placeholder={modelsLoading ? text.modelsLoading : text.modelPlaceholder}
            onChange={(event) => onChange({ ...values, model: event.target.value })}
          />
          <datalist id={modelListId}>
            {modelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </datalist>
          <p className="mt-1 text-xs text-muted-foreground">{text.modelHint}</p>
        </Field>
      )}
    </div>
  );
}
