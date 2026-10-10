// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const changePasswordMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/auth")>();
  return { ...actual, authApi: { ...actual.authApi, changePassword: changePasswordMock } };
});

import { AuthApiError } from "../../api/auth";
import { PhiBotChangePasswordCard } from "./PhiBotChangePasswordCard";
import { phibotText } from "./phibot-text";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const text = phibotText();

function setInput(container: HTMLElement, name: string, value: string) {
  const input = container.querySelector(`input[name="${name}"]`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submit(container: HTMLElement) {
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("PhiBotChangePasswordCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<PhiBotChangePasswordCard />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("refuses two different new passwords without calling the server", async () => {
    await act(async () => {
      setInput(container, "currentPassword", "old-password");
      setInput(container, "newPassword", "new-password-1");
      setInput(container, "confirmPassword", "new-password-2");
    });
    await submit(container);
    expect(changePasswordMock).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(text.passwordErrors.passwordMismatch);
  });

  it("changes the password and clears the fields", async () => {
    changePasswordMock.mockResolvedValue(undefined);
    await act(async () => {
      setInput(container, "currentPassword", "old-password");
      setInput(container, "newPassword", "new-password-1");
      setInput(container, "confirmPassword", "new-password-1");
    });
    await submit(container);
    expect(changePasswordMock).toHaveBeenCalledWith({ currentPassword: "old-password", newPassword: "new-password-1" });
    expect((container.querySelector('input[name="newPassword"]') as HTMLInputElement).value).toBe("");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("reports a wrong current password", async () => {
    changePasswordMock.mockRejectedValue(new AuthApiError("Invalid password", 400, null, "INVALID_PASSWORD"));
    await act(async () => {
      setInput(container, "currentPassword", "wrong-password");
      setInput(container, "newPassword", "new-password-1");
      setInput(container, "confirmPassword", "new-password-1");
    });
    await submit(container);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(text.passwordErrors.currentPasswordInvalid);
  });
});
