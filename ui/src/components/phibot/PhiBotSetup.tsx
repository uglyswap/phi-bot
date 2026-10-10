import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { randomAgentAppearance } from "@paperclipai/shared";
import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { useLocation, useNavigate, useParams } from "@/lib/router";
import { agentsApi } from "../../api/agents";
import { approvalsApi } from "../../api/approvals";
import { companiesApi } from "../../api/companies";
import { goalsApi } from "../../api/goals";
import { issuesApi } from "../../api/issues";
import { projectsApi } from "../../api/projects";
import { useCompany } from "../../context/CompanyContext";
import { useDialog } from "../../context/DialogContext";
import { useCloudInstance } from "../../hooks/useCloudInstance";
import { usePhiBotLlmState } from "../../hooks/usePhiBotLlmState";
import { buildNewAgentRuntimeConfig } from "../../lib/new-agent-runtime-config";
import {
  buildOnboardingIssuePayload,
  buildOnboardingProjectPayload,
  selectDefaultCompanyGoalId,
  selectReusableOnboardingProject,
} from "../../lib/onboarding-launch";
import {
  companyPrefixFromOnboardingPath,
  resolveRouteOnboardingOptions,
} from "../../lib/onboarding-route";
import { buildDefaultPhiAgentConfig, testPhiBotConnection } from "../../lib/phibot-agent";
import {
  PHIBOT_DEFAULT_PROVIDER_ID,
  PHI_ADAPTER_TYPE,
  phiBotModelsForProvider,
  phiBotTestBlocks,
  savePhiBotLlmSettings,
  validatePhiBotLlmValues,
  type PhiBotLlmValues,
} from "../../lib/phibot-llm";
import { queryKeys } from "../../lib/queryKeys";
import { Field } from "../agent-config-primitives";
import { OnboardingCard, OnboardingHeading } from "../onboarding/OnboardingPrimitives";
import { Button } from "../ui/button";
import { Dialog, DialogPortal } from "../ui/dialog";
import { Input } from "../ui/input";
import { PhiBotLlmFields } from "./PhiBotLlmFields";
import { PhiBotTestResult } from "./PhiBotTestResult";
import { describePhiBotError, phibotText, type PhiBotText } from "./phibot-text";

type SetupPhase = "provider" | "model";

const EMPTY_VALUES: PhiBotLlmValues = { provider: PHIBOT_DEFAULT_PROVIDER_ID, apiKey: "", baseUrl: "", model: "" };

/** Same open rule as OnboardingWizard.tsx:487-525: the dialog context or an onboarding route. */
function useSetupOpenState() {
  const location = useLocation();
  const { companyPrefix: matchedCompanyPrefix } = useParams<{ companyPrefix?: string }>();
  const dialog = useDialog();
  const { companies, loading: companiesLoading } = useCompany();
  const cloudInstance = useCloudInstance();
  const { setOnboardingRouteDismissed } = dialog;

  useEffect(() => {
    setOnboardingRouteDismissed(false);
  }, [location.pathname, setOnboardingRouteDismissed]);

  const companyPrefix = matchedCompanyPrefix ?? companyPrefixFromOnboardingPath(location.pathname);
  const routeOptions =
    companyPrefix && companiesLoading
      ? null
      : resolveRouteOnboardingOptions({
          pathname: location.pathname,
          companyPrefix,
          companies,
          cloudManaged: Boolean(cloudInstance),
        });
  const open = dialog.onboardingOpen || (routeOptions !== null && !dialog.onboardingRouteDismissed);
  const requestedCompanyId = dialog.onboardingOpen
    ? dialog.onboardingOptions.companyId
    : routeOptions?.companyId;

  function close() {
    dialog.closeOnboarding();
    setOnboardingRouteDismissed(true);
  }

  return { open, requestedCompanyId, close };
}

/** Hires the CEO when the organization has no agent yet; returns its id, or null. */
async function hireFirstAgent(companyId: string, text: PhiBotText): Promise<string | null> {
  const agents = await agentsApi.list(companyId);
  if (agents.some((agent) => agent.status !== "terminated")) return null;
  const hire = await agentsApi.hire(companyId, {
    name: text.ceoName,
    role: "ceo",
    appearance: randomAgentAppearance(),
    adapterType: PHI_ADAPTER_TYPE,
    adapterConfig: buildDefaultPhiAgentConfig(),
    onboardingFirstAgent: true,
    runtimeConfig: buildNewAgentRuntimeConfig(),
  });
  if (hire.approval) await approvalsApi.approve(hire.approval.id, text.approvalNote);
  return hire.agent.id;
}

/** Same launch as OnboardingWizard.tsx:1696-1755: onboarding project, then the first task. */
async function createFirstTask(companyId: string, agentId: string, title: string): Promise<string> {
  const goalId = selectDefaultCompanyGoalId(await goalsApi.list(companyId));
  const project =
    selectReusableOnboardingProject(await projectsApi.list(companyId)) ??
    (await projectsApi.create(companyId, buildOnboardingProjectPayload(goalId)));
  const issue = await issuesApi.create(
    companyId,
    buildOnboardingIssuePayload({ title, assigneeAgentId: agentId, projectId: project.id, goalId }),
  );
  return issue.identifier ?? issue.id;
}

function landingPath(prefix: string | null, issueRef: string | null): string {
  if (issueRef) return prefix ? `/${prefix}/issues/${issueRef}` : `/issues/${issueRef}`;
  return prefix ? `/${prefix}/dashboard` : "/";
}

/**
 * Phi Bot first-run setup, mounted in place of the onboarding wizard
 * (OnboardingWizardVariant.tsx). Screen 1: provider and API key. Screen 2:
 * default model, then test, CEO hire and first task.
 */
export function PhiBotSetup() {
  const text = phibotText();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { companies, loading: companiesLoading, setSelectedCompanyId } = useCompany();
  const { open, requestedCompanyId, close } = useSetupOpenState();
  const [createdCompany, setCreatedCompany] = useState<{ id: string; issuePrefix: string } | null>(null);
  const companyId = requestedCompanyId ?? createdCompany?.id ?? companies[0]?.id ?? null;
  const companyIssuePrefix =
    companies.find((company) => company.id === companyId)?.issuePrefix ??
    (createdCompany && createdCompany.id === companyId ? createdCompany.issuePrefix : null);

  const [phase, setPhase] = useState<SetupPhase>("provider");
  const [companyName, setCompanyName] = useState(text.defaultCompanyName);
  const [values, setValues] = useState<PhiBotLlmValues>(EMPTY_VALUES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<AdapterEnvironmentTestResult | null>(null);
  const busyRef = useRef(false);
  const prefilledForRef = useRef<string | null>(null);
  const modelPrefilledRef = useRef(false);

  const llm = usePhiBotLlmState(companyId, open);
  useEffect(() => {
    if (!companyId || !llm.loaded || prefilledForRef.current === companyId) return;
    prefilledForRef.current = companyId;
    setValues((previous) => ({
      provider: llm.state.provider ?? previous.provider,
      apiKey: "",
      baseUrl: llm.state.baseUrl || previous.baseUrl,
      model: llm.state.model || previous.model,
    }));
  }, [companyId, llm.loaded, llm.state]);

  const modelsQuery = useQuery({
    queryKey: companyId
      ? queryKeys.agents.adapterModels(companyId, PHI_ADAPTER_TYPE, null)
      : ["agents", "none", "adapter-models", PHI_ADAPTER_TYPE, null],
    queryFn: () => agentsApi.adapterModels(companyId!, PHI_ADAPTER_TYPE),
    enabled: open && Boolean(companyId) && phase === "model",
  });
  const modelOptions = useMemo(
    () => phiBotModelsForProvider(modelsQuery.data ?? [], values.provider),
    [modelsQuery.data, values.provider],
  );
  useEffect(() => {
    if (phase !== "model") {
      modelPrefilledRef.current = false;
      return;
    }
    const first = modelOptions[0];
    if (modelPrefilledRef.current || !first) return;
    modelPrefilledRef.current = true;
    setValues((previous) => (previous.model ? previous : { ...previous, model: first.id }));
  }, [phase, modelOptions]);

  async function runBusy(task: () => Promise<void>) {
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      await task();
    } catch (caught) {
      setError(describePhiBotError(caught, text));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function handleContinue() {
    if (busyRef.current) return;
    const invalid = validatePhiBotLlmValues(values, {
      requireApiKey: !llm.state.keyConfigured,
      requireModel: false,
    });
    if (invalid) {
      setError(text.errors[invalid]);
      return;
    }
    if (!companyId && !companyName.trim()) {
      setError(text.errors.companyNameRequired);
      return;
    }
    await runBusy(async () => {
      let targetCompanyId = companyId;
      if (!targetCompanyId) {
        const company = await companiesApi.create({ name: companyName.trim() });
        setCreatedCompany({ id: company.id, issuePrefix: company.issuePrefix });
        setSelectedCompanyId(company.id);
        targetCompanyId = company.id;
        await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      }
      await savePhiBotLlmSettings({
        companyId: targetCompanyId,
        provider: values.provider,
        apiKey: values.apiKey,
        baseUrl: values.baseUrl,
        model: null,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(targetCompanyId) });
      setValues((previous) => ({ ...previous, apiKey: "" }));
      setPhase("model");
    });
  }

  async function handleStart() {
    if (busyRef.current || !companyId) return;
    const invalid = validatePhiBotLlmValues(values, { requireApiKey: false, requireModel: true });
    if (invalid) {
      setError(text.errors[invalid]);
      return;
    }
    const targetCompanyId = companyId;
    await runBusy(async () => {
      await savePhiBotLlmSettings({
        companyId: targetCompanyId,
        provider: values.provider,
        apiKey: "",
        baseUrl: values.baseUrl,
        model: values.model,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(targetCompanyId) });
      const result = await testPhiBotConnection(targetCompanyId);
      setTestResult(result);
      if (phiBotTestBlocks(result)) {
        setError(text.errors.testBlocked);
        return;
      }
      const agentId = await hireFirstAgent(targetCompanyId, text);
      const issueRef = agentId ? await createFirstTask(targetCompanyId, agentId, text.firstTaskTitle) : null;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(targetCompanyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(targetCompanyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(targetCompanyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(targetCompanyId) }),
      ]);
      setSelectedCompanyId(targetCompanyId, { source: "route_sync" });
      close();
      navigate(landingPath(companyIssuePrefix, issueRef));
    });
  }

  if (!open) return null;

  const loadError = llm.error ? describePhiBotError(llm.error, text) : null;
  const waiting = busy || companiesLoading || (Boolean(companyId) && !llm.loaded && !llm.error);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogPortal>
        <div className="fixed inset-0 z-50 bg-background" />
        <div data-testid="onboarding-wizard" className="fixed inset-0 z-50 flex overflow-y-auto">
          <div className="m-auto w-full px-4 py-10">
            <OnboardingCard className="mx-auto">
              <div className="mb-8">
                <OnboardingHeading
                  center
                  title={phase === "provider" ? text.setupProviderTitle : text.setupModelTitle}
                  lede={phase === "provider" ? text.setupProviderLede : text.setupModelLede}
                />
              </div>
              <form
                className="space-y-6"
                onSubmit={(event) => {
                  event.preventDefault();
                  void (phase === "provider" ? handleContinue() : handleStart());
                }}
              >
                {phase === "provider" && !companyId && (
                  <Field label={text.companyNameLabel}>
                    <Input
                      aria-label={text.companyNameLabel}
                      maxLength={100}
                      disabled={busy}
                      value={companyName}
                      onChange={(event) => setCompanyName(event.target.value)}
                    />
                  </Field>
                )}
                <PhiBotLlmFields
                  values={values}
                  onChange={(next) => {
                    setValues(next);
                    setError(null);
                  }}
                  showProvider={phase === "provider"}
                  showApiKey={phase === "provider"}
                  showModel={phase === "model"}
                  keyConfigured={llm.state.keyConfigured}
                  modelOptions={modelOptions}
                  modelsLoading={modelsQuery.isLoading}
                  disabled={busy}
                  autoFocusApiKey={phase === "provider"}
                />
                {testResult && <PhiBotTestResult result={testResult} />}
                {(error ?? loadError) && (
                  <p role="alert" className="text-sm text-destructive">
                    {error ?? loadError}
                  </p>
                )}
                <div className="flex items-center justify-between gap-3 pt-2">
                  {phase === "model" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setPhase("provider");
                        setError(null);
                        setTestResult(null);
                      }}
                    >
                      {text.backLabel}
                    </Button>
                  ) : (
                    <Button type="button" variant="ghost" disabled={busy} onClick={close}>
                      {text.laterLabel}
                    </Button>
                  )}
                  <Button type="submit" disabled={waiting}>
                    {busy ? text.workingLabel : phase === "provider" ? text.continueLabel : text.startLabel}
                  </Button>
                </div>
              </form>
            </OnboardingCard>
          </div>
        </div>
      </DialogPortal>
    </Dialog>
  );
}
