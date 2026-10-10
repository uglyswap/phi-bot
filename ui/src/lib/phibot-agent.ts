import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { getUIAdapter } from "../adapters";
import { defaultCreateValues } from "../components/agent-config-defaults";
import { PHI_ADAPTER_TYPE, phiBotTargetEnvironmentId } from "./phibot-llm";

/** Configuration of a new Phi Bot agent: no model of its own, so the company default applies. */
export function buildDefaultPhiAgentConfig(): Record<string, unknown> {
  return getUIAdapter(PHI_ADAPTER_TYPE).buildAdapterConfig({
    ...defaultCreateValues,
    adapterType: PHI_ADAPTER_TYPE,
  });
}

/** Probes the saved settings exactly as a run sees them (local environment variables merged server-side). */
export async function testPhiBotConnection(companyId: string): Promise<AdapterEnvironmentTestResult> {
  const environmentId = await phiBotTargetEnvironmentId(companyId);
  return agentsApi.testEnvironment(companyId, PHI_ADAPTER_TYPE, {
    adapterConfig: buildDefaultPhiAgentConfig(),
    environmentId,
  });
}
