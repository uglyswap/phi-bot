import { describe, expect, it } from "vitest";
import type { PhibotDatabase } from "../phibot/database.js";
import { generatePassword, loadServerPasswordHasher, type PasswordHasher } from "../phibot/password-hash.js";
import { runResetPassword } from "../phibot/reset-password.js";
import { MemoryLogger } from "./helpers/phibot-fake-system.js";

class FakeUsers implements PhibotDatabase {
  updates: Array<{ userId: string; hash: string }> = [];
  deleted: string[] = [];
  constructor(private readonly users: Record<string, { id: string; credential: boolean }>, private readonly failure?: Error) {}
  async instanceAdminCount() { return 1; }
  async companyIds() { return []; }
  async findUserIdByEmail(email: string) {
    if (this.failure) throw this.failure;
    return this.users[email.toLowerCase()]?.id ?? null;
  }
  async createBootstrapInvite() { return ""; }
  async setCredentialPassword(userId: string, hash: string) {
    const user = Object.values(this.users).find((candidate) => candidate.id === userId);
    if (!user?.credential) return 0;
    this.updates.push({ userId, hash });
    return 1;
  }
  async deleteSessions(userId: string) { this.deleted.push(userId); return 2; }
  async llmProviderValue() { return null; }
  async close() {}
}

const HASHER: PasswordHasher = {
  hashPassword: async (password) => `hash(${password})`,
  verifyPassword: async ({ hash, password }) => hash === `hash(${password})`,
};

describe("user reset-password (R1 §4.5)", () => {
  it("stores the hash of a new random password, revokes the sessions and shows the password once", async () => {
    const db = new FakeUsers({ "owner@exemple.fr": { id: "user-1", credential: true } });
    const logger = new MemoryLogger();
    const password = await runResetPassword({ email: "Owner@Exemple.fr" }, { db, hasher: HASHER, logger, generate: () => "Nouveau-Mot-De-Passe-24c" });
    expect(password).toBe("Nouveau-Mot-De-Passe-24c");
    expect(db.updates).toEqual([{ userId: "user-1", hash: "hash(Nouveau-Mot-De-Passe-24c)" }]);
    expect(db.deleted).toEqual(["user-1"]);
    expect(logger.entries).toEqual([
      { level: "success", message: "Nouveau mot de passe de Owner@Exemple.fr : Nouveau-Mot-De-Passe-24c" },
      { level: "info", message: "Il n'est affiché qu'une fois. 2 session(s) fermée(s). L'utilisateur peut le changer dans son profil." },
    ]);
  });

  it("explains an unknown account, an account without password and a stopped service", async () => {
    const logger = new MemoryLogger();
    await expect(runResetPassword({ email: "absent@exemple.fr" }, { db: new FakeUsers({}), hasher: HASHER, logger })).rejects.toThrow("aucun compte pour absent@exemple.fr");
    await expect(runResetPassword({ email: "sso@exemple.fr" }, { db: new FakeUsers({ "sso@exemple.fr": { id: "u", credential: false } }), hasher: HASHER, logger })).rejects.toThrow("n'a pas de connexion par mot de passe");
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:54329"), { code: "ECONNREFUSED" });
    await expect(runResetPassword({ email: "a@exemple.fr" }, { db: new FakeUsers({}, refused), hasher: HASHER, logger })).rejects.toThrow("Démarrez le service (sudo phibot service start)");
  });

  it("generates 24 URL-safe characters", () => {
    expect(generatePassword()).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });

  it("hashes with the server's own better-auth (scrypt salt:key)", async () => {
    const hasher = await loadServerPasswordHasher();
    const hash = await hasher.hashPassword("mot-de-passe-de-test");
    expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(await hasher.verifyPassword({ hash, password: "mot-de-passe-de-test" })).toBe(true);
    expect(await hasher.verifyPassword({ hash, password: "autre" })).toBe(false);
  });
});
