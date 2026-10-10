// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret } from "@paperclipai/shared";

const listSecretsMock = vi.hoisted(() => vi.fn());
const adapterModelsMock = vi.hoisted(() => vi.fn());

vi.mock("../api/secrets", () => ({ secretsApi: { list: listSecretsMock } }));
vi.mock("../api/agents", () => ({ agentsApi: { adapterModels: adapterModelsMock } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));

import { phibotText } from "../components/phibot/phibot-text";
import { PhiBotAiProvider } from "./PhiBotAiProvider";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const text = phibotText();

function secret(key: string, providerMetadata: Record<string, unknown>): CompanySecret {
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
    latestVersion: 2,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    referenceCount: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("PhiBotAiProvider", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    listSecretsMock.mockResolvedValue([
      secret("phibot_llm_provider", { phibotValue: "custom" }),
      secret("phibot_llm_api_key", { phibotKeySet: true }),
      secret("phibot_llm_base_url", { phibotValue: "http://127.0.0.1:18765/v1" }),
      secret("phibot_default_model", { phibotValue: "custom/mock-model" }),
    ]);
    adapterModelsMock.mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <PhiBotAiProvider />
        </QueryClientProvider>,
      ),
    );
    await flush();
    await flush();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows the stored settings of a configured company", () => {
    expect(container.textContent).toContain(text.statusConfigured);
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("custom");
    expect(select.options).toHaveLength(15);
    const baseUrl = container.querySelector(`input[aria-label="${text.baseUrlLabel}"]`) as HTMLInputElement;
    expect(baseUrl.value).toBe("http://127.0.0.1:18765/v1");
  });

  it("warns that a new key restarts the task sessions", async () => {
    const note = () => container.querySelector('[role="note"]') as HTMLElement;
    expect(note().textContent).toBe(text.sessionRestartWarning);
    expect(note().className).toContain("text-muted-foreground");
    const apiKey = container.querySelector(`input[aria-label="${text.apiKeyLabel}"]`) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(apiKey, "sk-test-rotated-123");
      apiKey.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(note().className).toContain("text-amber-700");
  });
});
