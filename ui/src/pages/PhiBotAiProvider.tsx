import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { PhiBotLlmFields } from "../components/phibot/PhiBotLlmFields";
import { PhiBotTestResult } from "../components/phibot/PhiBotTestResult";
import { describePhiBotError, phibotText } from "../components/phibot/phibot-text";
import { Button } from "../components/ui/button";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { usePhiBotLlmState } from "../hooks/usePhiBotLlmState";
import { testPhiBotConnection } from "../lib/phibot-agent";
import {
  PHIBOT_DEFAULT_PROVIDER_ID,
  PHI_ADAPTER_TYPE,
  describePhiBotSettingsChange,
  phiBotModelsForProvider,
  savePhiBotLlmSettings,
  validatePhiBotLlmValues,
  type PhiBotLlmValues,
} from "../lib/phibot-llm";
import { queryKeys } from "../lib/queryKeys";

/** Settings > AI provider: provider, API key and default model of the organization. */
export function PhiBotAiProvider() {
  const text = phibotText();
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const llm = usePhiBotLlmState(selectedCompanyId);
  const [values, setValues] = useState<PhiBotLlmValues>({
    provider: PHIBOT_DEFAULT_PROVIDER_ID,
    apiKey: "",
    baseUrl: "",
    model: "",
  });
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<AdapterEnvironmentTestResult | null>(null);
  const prefilledForRef = useRef<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: text.settingsTitle }]);
  }, [setBreadcrumbs, text.settingsTitle]);

  useEffect(() => {
    if (!selectedCompanyId || !llm.loaded || prefilledForRef.current === selectedCompanyId) return;
    prefilledForRef.current = selectedCompanyId;
    setValues({
      provider: llm.state.provider ?? PHIBOT_DEFAULT_PROVIDER_ID,
      apiKey: "",
      baseUrl: llm.state.baseUrl,
      model: llm.state.model,
    });
  }, [selectedCompanyId, llm.loaded, llm.state]);

  const modelsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.agents.adapterModels(selectedCompanyId, PHI_ADAPTER_TYPE, null)
      : ["agents", "none", "adapter-models", PHI_ADAPTER_TYPE, null],
    queryFn: () => agentsApi.adapterModels(selectedCompanyId!, PHI_ADAPTER_TYPE),
    enabled: Boolean(selectedCompanyId),
  });
  const modelOptions = useMemo(
    () => phiBotModelsForProvider(modelsQuery.data ?? [], values.provider),
    [modelsQuery.data, values.provider],
  );
  const change = describePhiBotSettingsChange(llm.state, values);

  async function handleSave() {
    if (!selectedCompanyId || busy) return;
    const invalid = validatePhiBotLlmValues(values, {
      requireApiKey: !llm.state.keyConfigured,
      requireModel: true,
    });
    if (invalid) {
      setError(text.errors[invalid]);
      return;
    }
    setBusy("save");
    setError(null);
    setTestResult(null);
    try {
      await savePhiBotLlmSettings({
        companyId: selectedCompanyId,
        provider: values.provider,
        apiKey: values.apiKey,
        baseUrl: values.baseUrl,
        model: values.model,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId) });
      setValues((previous) => ({ ...previous, apiKey: "" }));
      pushToast({ title: text.savedToast, tone: "success" });
    } catch (caught) {
      setError(describePhiBotError(caught, text));
    } finally {
      setBusy(null);
    }
  }

  async function handleTest() {
    if (!selectedCompanyId || busy) return;
    setBusy("test");
    setError(null);
    setTestResult(null);
    try {
      setTestResult(await testPhiBotConnection(selectedCompanyId));
    } catch (caught) {
      setError(describePhiBotError(caught, text));
    } finally {
      setBusy(null);
    }
  }

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">{text.selectCompany}</div>;
  }

  const keySecret = llm.state.keySecret;
  const keyLine =
    llm.state.keyConfigured && keySecret
      ? text.keySaved(
          keySecret.latestVersion,
          new Date(keySecret.lastRotatedAt ?? keySecret.updatedAt).toLocaleString(),
        )
      : text.keyMissing;
  const loadError = llm.error ? describePhiBotError(llm.error, text) : null;

  return (
    <div className="max-w-6xl space-y-8">
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{text.settingsTitle}</h1>
      </div>
      <div className="max-w-2xl space-y-6">
        <p className="text-sm text-muted-foreground">{text.settingsLede}</p>
        <div className="rounded-md border border-border px-3 py-2 text-sm">
          <p className="font-medium">
            {llm.state.configured ? text.statusConfigured : text.statusNotConfigured}
          </p>
          <p className="text-muted-foreground">{keyLine}</p>
        </div>
        <PhiBotLlmFields
          values={values}
          onChange={(next) => {
            setValues(next);
            setError(null);
          }}
          showProvider
          showApiKey
          showModel
          keyConfigured={llm.state.keyConfigured}
          modelOptions={modelOptions}
          modelsLoading={modelsQuery.isLoading}
          disabled={busy !== null || !llm.loaded}
        />
        {change.providerChanged && (
          <p className="text-xs text-amber-700 dark:text-amber-300">{text.providerChangeWarning}</p>
        )}
        <p
          role="note"
          className={
            change.restartsSessions
              ? "text-xs font-medium text-amber-700 dark:text-amber-300"
              : "text-xs text-muted-foreground"
          }
        >
          {text.sessionRestartWarning}
        </p>
        {testResult && <PhiBotTestResult result={testResult} />}
        {(error ?? loadError) && (
          <p role="alert" className="text-sm text-destructive">
            {error ?? loadError}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <Button type="button" onClick={() => void handleSave()} disabled={busy !== null || !llm.loaded}>
            {busy === "save" ? text.workingLabel : text.saveLabel}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleTest()}
            disabled={busy !== null || !llm.state.configured}
          >
            {busy === "test" ? text.workingLabel : text.testLabel}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{text.adminOnlyNote}</p>
      </div>
    </div>
  );
}
