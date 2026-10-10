import { and, eq, isNull, sql } from "drizzle-orm";
import {
  authAccounts,
  authSessions,
  authUsers,
  companies,
  companySecrets,
  createDb,
  instanceUserRoles,
} from "@paperclipai/db";
import { createBootstrapCeoInvite } from "../commands/auth-bootstrap-ceo.js";
import { PHIBOT_DB_URL } from "./constants.js";

/** The few queries Phi Bot runs against the embedded database (served by the running service). */
export interface PhibotDatabase {
  instanceAdminCount(): Promise<number>;
  companyIds(): Promise<string[]>;
  findUserIdByEmail(email: string): Promise<string | null>;
  /** New `bootstrap_ceo` invite valid one hour; returns the clear token. */
  createBootstrapInvite(): Promise<string>;
  /** Number of credential accounts updated (0 when the user has no password login). */
  setCredentialPassword(userId: string, passwordHash: string): Promise<number>;
  deleteSessions(userId: string): Promise<number>;
  /** `providerMetadata.phibotValue` of the PHIBOT_LLM_PROVIDER secret (key stored lowercase by the server), or null. */
  llmProviderValue(): Promise<string | null>;
  close(): Promise<void>;
}

type ClosableDb = ReturnType<typeof createDb> & { $client?: { end?: (options?: { timeout?: number }) => Promise<void> } };

export function openPhibotDatabase(connectionString: string = PHIBOT_DB_URL): PhibotDatabase {
  const db = createDb(connectionString) as ClosableDb;
  return {
    async instanceAdminCount() {
      const rows = await db.select({ id: instanceUserRoles.id }).from(instanceUserRoles).where(eq(instanceUserRoles.role, "instance_admin"));
      return rows.length;
    },
    async companyIds() {
      const rows = await db.select({ id: companies.id }).from(companies);
      return rows.map((row) => row.id);
    },
    async findUserIdByEmail(email) {
      const rows = await db.select({ id: authUsers.id }).from(authUsers).where(sql`lower(${authUsers.email}) = lower(${email})`);
      return rows[0]?.id ?? null;
    },
    async createBootstrapInvite() {
      return (await createBootstrapCeoInvite(db, { expiresHours: 1 })).token;
    },
    async setCredentialPassword(userId, passwordHash) {
      const rows = await db
        .update(authAccounts)
        .set({ password: passwordHash, updatedAt: new Date() })
        .where(and(eq(authAccounts.providerId, "credential"), eq(authAccounts.userId, userId)))
        .returning({ id: authAccounts.id });
      return rows.length;
    },
    async deleteSessions(userId) {
      const rows = await db.delete(authSessions).where(eq(authSessions.userId, userId)).returning({ id: authSessions.id });
      return rows.length;
    },
    async llmProviderValue() {
      const rows = await db
        .select({ metadata: companySecrets.providerMetadata })
        .from(companySecrets)
        .where(and(sql`lower(${companySecrets.key}) = 'phibot_llm_provider'`, isNull(companySecrets.deletedAt)));
      const value = rows[0]?.metadata?.phibotValue;
      return typeof value === "string" && value.trim() !== "" && value !== "unset" ? value : null;
    },
    async close() {
      await db.$client?.end?.({ timeout: 5 }).catch(() => undefined);
    },
  };
}
