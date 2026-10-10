import { describe, expect, it } from "vitest";
import type { PhibotDatabase } from "../phibot/database.js";
import {
  collectOwnerInfo,
  cookieHeaderFrom,
  createOwnerHttp,
  ensureOwnerAndCompany,
  readPasswordFile,
  resolveAuthOrigin,
  type OwnerHttp,
  type OwnerInfo,
} from "../phibot/owner.js";
import { FakeSystem, MemoryLogger, ScriptedPrompter } from "./helpers/phibot-fake-system.js";

const PASSWORD = "correct-horse-battery";

describe("collectOwnerInfo", () => {
  it("requires --owner-email, --owner-password-file and --company with --yes", async () => {
    await expect(collectOwnerInfo({ yes: true, ownerEmail: "a@b.fr" }, { sys: new FakeSystem(), prompter: new ScriptedPrompter([]) })).rejects.toThrow(
      "avec --yes, il manque : --owner-password-file, --company.",
    );
  });

  it("reads the password file and derives the name from the e-mail", async () => {
    const sys = new FakeSystem().addFile("/root/pw", `${PASSWORD}\n`, 0o600);
    const info = await collectOwnerInfo(
      { yes: true, ownerEmail: "Marie.Curie@exemple.fr", ownerPasswordFile: "/root/pw", company: "Acme" },
      { sys, prompter: new ScriptedPrompter([]) },
    );
    expect(info).toEqual({ name: "Marie.Curie", email: "Marie.Curie@exemple.fr", password: PASSWORD, companyName: "Acme" });
  });

  it("refuses a password file readable by others, with two lines or too short", () => {
    const sys = new FakeSystem()
      .addFile("/root/open", `${PASSWORD}\n`, 0o644)
      .addFile("/root/two", `${PASSWORD}\nsecond\n`, 0o600)
      .addFile("/root/short", "court\n", 0o600);
    expect(() => readPasswordFile(sys, "/root/open")).toThrow("lisible par d'autres comptes (mode 644)");
    expect(() => readPasswordFile(sys, "/root/two")).toThrow("une seule ligne");
    expect(() => readPasswordFile(sys, "/root/short")).toThrow("12 caractères minimum");
    expect(() => readPasswordFile(sys, "/root/absent")).toThrow("introuvable");
  });

  it("asks the missing values, the password twice", async () => {
    const prompter = new ScriptedPrompter(["owner@exemple.fr", "Owner", PASSWORD, PASSWORD, "Mon entreprise"]);
    const info = await collectOwnerInfo({}, { sys: new FakeSystem(), prompter });
    expect(info).toEqual({ name: "Owner", email: "owner@exemple.fr", password: PASSWORD, companyName: "Mon entreprise" });
    expect(prompter.asked).toEqual([
      "E-mail du propriétaire",
      "Nom du propriétaire",
      "Mot de passe du propriétaire (12 caractères minimum)",
      "Saisissez à nouveau le mot de passe",
      "Nom de l'entreprise",
    ]);
  });

  it("stops when the two passwords differ or the terminal is not interactive", async () => {
    const prompter = new ScriptedPrompter(["owner@exemple.fr", "Owner", PASSWORD, `${PASSWORD}x`]);
    await expect(collectOwnerInfo({}, { sys: new FakeSystem(), prompter })).rejects.toThrow("les deux saisies du mot de passe diffèrent");
    await expect(collectOwnerInfo({}, { sys: new FakeSystem(), prompter: new ScriptedPrompter([], false) })).rejects.toThrow("terminal non interactif");
  });
});

describe("createOwnerHttp", () => {
  function recordingFetch(responses: Response[]) {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected request ${url}`);
      return next;
    };
    return { fetchImpl, requests };
  }
  function headersOf(init?: RequestInit): Record<string, string> {
    return { ...(init?.headers as Record<string, string>) };
  }

  it("signs up with the public Origin, then accepts and creates the company with the local Origin and the cookie", async () => {
    const signUp = new Response("{}", { status: 200, headers: [["set-cookie", "__Secure-paperclip-default.session_token=abc; Path=/; HttpOnly; Secure"], ["set-cookie", "__Secure-paperclip-default.session_data=xyz; Path=/"]] });
    const { fetchImpl, requests } = recordingFetch([
      signUp,
      new Response(JSON.stringify({ bootstrapAccepted: true }), { status: 202 }),
      new Response(JSON.stringify({ id: "company-1", name: "Acme" }), { status: 201 }),
      new Response(JSON.stringify([{ id: "company-1", name: "Acme" }]), { status: 200 }),
    ]);
    const http = createOwnerHttp(fetchImpl, { authOrigin: "https://bot.exemple.fr" });
    const cookie = await http.signUp({ name: "Owner", email: "owner@exemple.fr", password: PASSWORD, inviteToken: "pcp_bootstrap_x" });
    expect(cookie).toBe("__Secure-paperclip-default.session_token=abc; __Secure-paperclip-default.session_data=xyz");
    await http.acceptBootstrapInvite(cookie, "pcp_bootstrap_x");
    expect(await http.createCompany(cookie, "Acme")).toBe("company-1");
    expect(await http.listCompanies(cookie)).toEqual([{ id: "company-1", name: "Acme" }]);

    expect(requests.map((request) => `${request.init?.method ?? "GET"} ${request.url}`)).toEqual([
      "POST http://127.0.0.1:3100/api/auth/sign-up/email",
      "POST http://127.0.0.1:3100/api/invites/pcp_bootstrap_x/accept",
      "POST http://127.0.0.1:3100/api/companies",
      "GET http://127.0.0.1:3100/api/companies",
    ]);
    expect(headersOf(requests[0].init)).toEqual({ "Content-Type": "application/json", Origin: "https://bot.exemple.fr", "X-Phibot-Invite-Token": "pcp_bootstrap_x" });
    expect(headersOf(requests[1].init).Origin).toBe("http://127.0.0.1:3100");
    expect(headersOf(requests[1].init).Cookie).toBe(cookie);
    expect(requests[1].init?.body).toBe('{"requestType":"human"}');
    expect(headersOf(requests[2].init).Origin).toBe("http://127.0.0.1:3100");
  });

  it("reports the HTTP status of a refused call", async () => {
    const { fetchImpl } = recordingFetch([new Response('{"code":"INVALID_ORIGIN"}', { status: 403 })]);
    await expect(createOwnerHttp(fetchImpl, { authOrigin: "http://127.0.0.1:3100" }).signIn({ email: "a@b.fr", password: PASSWORD })).rejects.toThrow(
      'connexion du propriétaire : réponse HTTP 403 {"code":"INVALID_ORIGIN"}.',
    );
  });

  it("uses the public origin in explicit mode and the local origin in auto mode", () => {
    expect(resolveAuthOrigin({ baseUrlMode: "explicit", publicBaseUrl: "https://bot.exemple.fr" })).toBe("https://bot.exemple.fr");
    expect(resolveAuthOrigin({ baseUrlMode: "auto" })).toBe("http://127.0.0.1:3100");
  });

  it("keeps only the name=value part of each cookie", () => {
    const response = new Response(null, { headers: [["set-cookie", "a=1; Path=/"], ["set-cookie", "b=2"]] });
    expect(cookieHeaderFrom(response)).toBe("a=1; b=2");
  });
});

class FakeOwnerDb implements PhibotDatabase {
  invites = 0;
  constructor(public admins: number, public companies: string[], public userId: string | null) {}
  async instanceAdminCount() { return this.admins; }
  async companyIds() { return this.companies; }
  async findUserIdByEmail() { return this.userId; }
  async createBootstrapInvite() { this.invites += 1; return `pcp_bootstrap_${this.invites}`; }
  async setCredentialPassword() { return 0; }
  async deleteSessions() { return 0; }
  async llmProviderValue() { return null; }
  async close() {}
}

function fakeHttp(db: FakeOwnerDb, calls: string[]): OwnerHttp {
  return {
    async signUp(input) { calls.push(`signUp ${input.inviteToken}`); db.userId = "user-1"; return "cookie"; },
    async signIn() { calls.push("signIn"); return "cookie"; },
    async acceptBootstrapInvite(_cookie, token) { calls.push(`accept ${token}`); db.admins = 1; },
    async createCompany(_cookie, name) { calls.push(`createCompany ${name}`); db.companies = ["company-1"]; return "company-1"; },
    async listCompanies() { calls.push("listCompanies"); return db.companies.map((id) => ({ id, name: "Acme" })); },
  };
}

function owner(): OwnerInfo {
  return { name: "Owner", email: "owner@exemple.fr", password: PASSWORD, companyName: "Acme" };
}

describe("ensureOwnerAndCompany", () => {
  it("creates the owner, accepts the bootstrap invite and creates the company", async () => {
    const db = new FakeOwnerDb(0, [], null);
    const calls: string[] = [];
    const info = owner();
    const outcome = await ensureOwnerAndCompany({ http: fakeHttp(db, calls), db, logger: new MemoryLogger() }, info);
    expect(calls).toEqual(["signUp pcp_bootstrap_1", "accept pcp_bootstrap_1", "createCompany Acme", "listCompanies"]);
    expect(outcome).toEqual({ companyId: "company-1", createdUser: true, acceptedInvite: true, createdCompany: true });
    expect(info.password).toBe("");
  });

  it("signs in an owner created before an interruption and gives it the admin role", async () => {
    const db = new FakeOwnerDb(0, [], "user-1");
    const calls: string[] = [];
    await ensureOwnerAndCompany({ http: fakeHttp(db, calls), db, logger: new MemoryLogger() }, owner());
    expect(calls).toEqual(["signIn", "accept pcp_bootstrap_1", "createCompany Acme", "listCompanies"]);
  });

  it("only creates the company when the admin exists without company", async () => {
    const db = new FakeOwnerDb(1, [], "user-1");
    const calls: string[] = [];
    await ensureOwnerAndCompany({ http: fakeHttp(db, calls), db, logger: new MemoryLogger() }, owner());
    expect(calls).toEqual(["signIn", "createCompany Acme", "listCompanies"]);
    expect(db.invites).toBe(0);
  });

  it("does nothing when the admin and the company exist", async () => {
    const db = new FakeOwnerDb(1, ["company-1"], "user-1");
    const calls: string[] = [];
    const outcome = await ensureOwnerAndCompany({ http: fakeHttp(db, calls), db, logger: new MemoryLogger() }, owner());
    expect(calls).toEqual([]);
    expect(outcome.companyId).toBe("company-1");
  });
});
