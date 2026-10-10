import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export interface PasswordHasher {
  hashPassword(password: string): Promise<string>;
  verifyPassword(input: { hash: string; password: string }): Promise<boolean>;
}

function isPasswordHasher(value: unknown): value is PasswordHasher {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.hashPassword === "function" && typeof candidate.verifyPassword === "function";
}

/**
 * Loads `better-auth/crypto` from the dependencies of the installed `@paperclipai/server`,
 * so the stored hash is exactly the one the running server verifies (R1 §4.5).
 */
export async function loadServerPasswordHasher(): Promise<PasswordHasher> {
  const serverEntry = import.meta.resolve("@paperclipai/server");
  const cryptoPath = createRequire(serverEntry).resolve("better-auth/crypto");
  const loaded: unknown = await import(pathToFileURL(cryptoPath).href);
  if (!isPasswordHasher(loaded)) throw new Error(`better-auth/crypto (${cryptoPath}) ne fournit pas hashPassword et verifyPassword.`);
  return loaded;
}

/** 24 URL-safe characters (144 random bits). */
export function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}
