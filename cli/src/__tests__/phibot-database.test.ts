import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authAccounts,
  authSessions,
  authUsers,
  companies,
  companySecrets,
  createDb,
  instanceUserRoles,
  invites,
  type Db,
} from "@paperclipai/db";
import { createBootstrapCeoInvite } from "../commands/auth-bootstrap-ceo.js";
import { openPhibotDatabase, type PhibotDatabase } from "../phibot/database.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("createBootstrapCeoInvite", () => {
  it("revokes active bootstrap invites, inserts a hashed token and returns the clear token", async () => {
    const calls: Array<{ op: string; values?: Record<string, unknown> }> = [];
    const fakeDb = {
      update: () => ({ set: (values: Record<string, unknown>) => ({ where: async () => { calls.push({ op: "update", values }); } }) }),
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          returning: () => {
            calls.push({ op: "insert", values });
            return Promise.resolve([{ expiresAt: values.expiresAt }]);
          },
        }),
      }),
    };
    const before = Date.now();
    const created = await createBootstrapCeoInvite(fakeDb as unknown as Db, { expiresHours: 1 });
    expect(created.token).toMatch(/^pcp_bootstrap_[0-9a-f]{48}$/);
    expect(calls.map((call) => call.op)).toEqual(["update", "insert"]);
    expect(calls[0].values?.revokedAt).toBeInstanceOf(Date);
    const inserted = calls[1].values ?? {};
    expect(inserted.inviteType).toBe("bootstrap_ceo");
    expect(inserted.allowedJoinTypes).toBe("human");
    expect(inserted.invitedByUserId).toBe("system");
    expect(inserted.tokenHash).toBe(createHash("sha256").update(created.token).digest("hex"));
    const expiresInMs = created.expiresAt.getTime() - before;
    expect(expiresInMs).toBeGreaterThanOrEqual(3_600_000 - 5_000);
    expect(expiresInMs).toBeLessThanOrEqual(3_600_000 + 5_000);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("openPhibotDatabase (embedded Postgres)", () => {
  let database: EmbeddedPostgresTestDatabase;
  let raw: Db;
  let phibot: PhibotDatabase;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("phibot-database-");
    raw = createDb(database.connectionString);
    phibot = openPhibotDatabase(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await phibot?.close();
    await database?.cleanup();
  });

  it("reports an empty instance", async () => {
    expect(await phibot.instanceAdminCount()).toBe(0);
    expect(await phibot.companyIds()).toEqual([]);
    expect(await phibot.findUserIdByEmail("owner@exemple.fr")).toBeNull();
    expect(await phibot.llmProviderValue()).toBeNull();
  });

  it("creates a bootstrap invite valid one hour", async () => {
    const token = await phibot.createBootstrapInvite();
    const rows = await raw.select().from(invites);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(rows[0].inviteType).toBe("bootstrap_ceo");
  });

  it("finds users, admins, companies and the provider secret, and resets a password", async () => {
    const now = new Date();
    await raw.insert(authUsers).values({ id: "user-1", name: "Owner", email: "Owner@Exemple.fr", emailVerified: false, createdAt: now, updatedAt: now });
    await raw.insert(authAccounts).values({ id: "acct-1", issuer: "local:credential", accountId: "user-1", providerId: "credential", userId: "user-1", password: "old-hash", createdAt: now, updatedAt: now });
    await raw.insert(authSessions).values({ id: "sess-1", token: "t", expiresAt: new Date(now.getTime() + 3_600_000), userId: "user-1", createdAt: now, updatedAt: now });
    await raw.insert(instanceUserRoles).values({ userId: "user-1", role: "instance_admin" });
    const [company] = await raw.insert(companies).values({ name: "Acme" }).returning({ id: companies.id });
    await raw.insert(companySecrets).values({ companyId: company.id, key: "phibot_llm_provider", name: "PHIBOT_LLM_PROVIDER", providerMetadata: { phibotValue: "anthropic" } });

    expect(await phibot.findUserIdByEmail("owner@exemple.FR")).toBe("user-1");
    expect(await phibot.instanceAdminCount()).toBe(1);
    expect(await phibot.companyIds()).toEqual([company.id]);
    expect(await phibot.llmProviderValue()).toBe("anthropic");
    expect(await phibot.setCredentialPassword("user-1", "new-hash")).toBe(1);
    expect((await raw.select().from(authAccounts))[0].password).toBe("new-hash");
    expect(await phibot.deleteSessions("user-1")).toBe(1);
    expect(await raw.select().from(authSessions)).toEqual([]);
  });
});
