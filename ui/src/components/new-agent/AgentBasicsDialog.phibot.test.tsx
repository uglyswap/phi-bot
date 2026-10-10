// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentBasicsDialog } from "./AgentBasicsDialog";

const state = vi.hoisted(() => ({ adapters: [] as object[] }));
vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: { getExperimental: async () => ({ enableNativeRunner: false }) },
}));
vi.mock("@/api/adapters", () => ({ adaptersApi: { list: async () => state.adapters } }));
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../onboarding/PillGuy", () => ({ PillGuy: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const onContinue = vi.fn();
const onInvite = vi.fn();

async function render() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <AgentBasicsDialog open onClose={vi.fn()} onContinue={onContinue} onInvite={onInvite} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function typeName(value: string) {
  const input = document.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(label: string) {
  return [...document.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
}

describe("AgentBasicsDialog with Phi Bot's single engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("skips the adapter step and hides the external agent invite", async () => {
    state.adapters = [
      { type: "phi_local", loaded: true },
      { type: "claude_local", loaded: true, disabled: true },
    ];
    await render();
    expect(document.body.textContent).not.toContain("Invite an external agent");
    await typeName("Researcher");
    expect(button("Choose adapter")).toBeUndefined();
    await act(async () => button("Configure agent")!.click());
    expect(onContinue).toHaveBeenCalledWith({ name: "Researcher", adapterType: "phi_local", runnerProvider: "codex" });
  });

  it("keeps the upstream adapter step for another single engine", async () => {
    state.adapters = [{ type: "codex_local", loaded: true }];
    await render();
    expect(document.body.textContent).toContain("Invite an external agent");
    await typeName("Researcher");
    await act(async () => button("Choose adapter")!.click());
    expect(onContinue).not.toHaveBeenCalled();
  });
});
