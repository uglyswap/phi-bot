import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthApiError, authApi } from "./auth";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Phi Bot auth calls", () => {
  it("sends the invite token header with an invited sign-up", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ token: null }));
    vi.stubGlobal("fetch", fetchMock);

    await authApi.signUpEmail(
      { name: "Jane", email: "jane@example.com", password: "supersecret" },
      { inviteToken: " pcp_invite_test " },
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/sign-up/email");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "X-Phibot-Invite-Token": "pcp_invite_test" });
  });

  it("sends no invite header without a token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ token: null }));
    vi.stubGlobal("fetch", fetchMock);

    await authApi.signUpEmail({ name: "Jane", email: "jane@example.com", password: "supersecret" });

    expect(fetchMock.mock.calls[0]![1].headers).toEqual({ "Content-Type": "application/json" });
  });

  it("changes the password and revokes the other sessions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ token: "t", user: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await authApi.changePassword({ currentPassword: "old-password", newPassword: "new-password-1" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/change-password");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      currentPassword: "old-password",
      newPassword: "new-password-1",
      revokeOtherSessions: true,
    });
  });

  it("surfaces the Better Auth error code of a wrong current password", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ code: "INVALID_PASSWORD", message: "Invalid password" }, 400)),
    );

    const failure = authApi.changePassword({ currentPassword: "wrong-pass", newPassword: "new-password-1" });

    await expect(failure).rejects.toBeInstanceOf(AuthApiError);
    await expect(failure).rejects.toMatchObject({ status: 400, code: "INVALID_PASSWORD" });
  });
});
