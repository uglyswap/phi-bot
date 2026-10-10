/**
 * Phi Bot patch P3: with PHIBOT_INVITE_ONLY_SIGNUP=true, credential sign-up
 * requires a usable invite token in the X-Phibot-Invite-Token header (company
 * invite or bootstrap CEO invite, not expired, revoked, accepted or reserved to
 * agents). Driven through the real Better Auth mount, as in
 * better-auth-credential-signup.integration.test.ts.
 */

import { createHash, randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authAccounts, authSessions, authUsers, companies, createDb, invites } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";

const ORIGIN = "http://127.0.0.1:41998";
const PASSWORD = "correct-horse-battery-staple";
const HOUR_MS = 60 * 60 * 1000;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function testConfig(): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    authDisableSignUp: false,
    allowedHostnames: ["127.0.0.1"],
    port: 41998,
  } as unknown as Config;
}

function newToken(prefix: string): string {
  return `${prefix}${randomBytes(24).toString("hex")}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

describeEmbeddedPostgres("Phi Bot invite-only sign-up (P3)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId = "";
  let emailCounter = 0;
  const originalEnv = {
    secret: process.env.BETTER_AUTH_SECRET,
    rateLimit: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
    inviteOnly: process.env.PHIBOT_INVITE_ONLY_SIGNUP,
  };

  function buildApp(inviteOnly: boolean): express.Express {
    if (inviteOnly) process.env.PHIBOT_INVITE_ONLY_SIGNUP = "true";
    else delete process.env.PHIBOT_INVITE_ONLY_SIGNUP;
    const auth = createBetterAuthInstance(db, testConfig(), [ORIGIN]);
    const app = express();
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
    return app;
  }

  async function signUp(app: express.Express, token?: string) {
    emailCounter += 1;
    const email = `member-${emailCounter}@example.com`;
    const req = request(app).post("/api/auth/sign-up/email").set("origin", ORIGIN);
    if (token !== undefined) req.set("X-Phibot-Invite-Token", token);
    const response = await req.send({ email, password: PASSWORD, name: `Member ${emailCounter}` });
    return { response, email };
  }

  async function insertInvite(values: Partial<typeof invites.$inferInsert> = {}): Promise<string> {
    const token = newToken("pcp_invite_");
    await db.insert(invites).values({
      companyId,
      inviteType: "company_join",
      allowedJoinTypes: "both",
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 72 * HOUR_MS),
      ...values,
    });
    return token;
  }

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-phibot-invite-tests";
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";
    database = await startEmbeddedPostgresTestDatabase("paperclip-phibot-invite-signup-");
    db = createDb(database.connectionString);
    const [company] = await db.insert(companies).values({ name: "Phi Bot invite test", issuePrefix: "PBI" }).returning();
    companyId = company!.id;
  }, 60_000);

  beforeEach(async () => {
    await db.delete(authSessions);
    await db.delete(authAccounts);
    await db.delete(authUsers);
    await db.delete(invites);
  });

  afterAll(async () => {
    await database?.cleanup();
    for (const [key, value] of [
      ["BETTER_AUTH_SECRET", originalEnv.secret],
      ["PAPERCLIP_AUTH_RATE_LIMIT_ENABLED", originalEnv.rateLimit],
      ["PHIBOT_INVITE_ONLY_SIGNUP", originalEnv.inviteOnly],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("refuses sign-up without an invite token and creates no user", async () => {
    const app = buildApp(true);
    const { response } = await signUp(app);
    expect(response.status).toBe(403);
    expect(response.body?.code).toBe("phibot_invite_required");
    expect(await db.select().from(authUsers)).toHaveLength(0);
  });

  it("refuses unknown, expired, revoked, accepted and agent-only invite tokens", async () => {
    const app = buildApp(true);
    const refused = [
      newToken("pcp_invite_"),
      await insertInvite({ expiresAt: new Date(Date.now() - HOUR_MS) }),
      await insertInvite({ revokedAt: new Date() }),
      await insertInvite({ acceptedAt: new Date() }),
      await insertInvite({ allowedJoinTypes: "agent" }),
    ];
    for (const token of refused) {
      const { response } = await signUp(app, token);
      expect(response.status).toBe(403);
      expect(response.body?.code).toBe("phibot_invite_required");
    }
    expect(await db.select().from(authUsers)).toHaveLength(0);
  });

  it("accepts a valid company invite and a valid bootstrap CEO invite", async () => {
    const app = buildApp(true);
    const companyInvite = await insertInvite({ allowedJoinTypes: "human" });
    const bootstrapInvite = await insertInvite({ companyId: null, inviteType: "bootstrap_ceo" });
    const first = await signUp(app, companyInvite);
    expect(first.response.status).toBe(200);
    expect(first.response.body?.user?.email).toBe(first.email);
    const second = await signUp(app, bootstrapInvite);
    expect(second.response.status).toBe(200);
    expect(second.response.body?.user?.email).toBe(second.email);
    expect(await db.select().from(authUsers)).toHaveLength(2);
  });

  it("keeps the upstream behavior when PHIBOT_INVITE_ONLY_SIGNUP is not true", async () => {
    const app = buildApp(false);
    const { response, email } = await signUp(app);
    expect(response.status).toBe(200);
    expect(response.body?.user?.email).toBe(email);
  });
});
