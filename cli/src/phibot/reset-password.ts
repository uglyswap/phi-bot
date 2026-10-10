import type { PhibotDatabase } from "./database.js";
import { generatePassword, type PasswordHasher } from "./password-hash.js";
import { type PhibotLogger, PhibotStepError } from "./system.js";
import { isValidEmail } from "./units.js";

const STEP = "Réinitialisation du mot de passe";

function isConnectionRefused(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { code?: unknown }).code ?? "")}` : String(error);
  return /ECONNREFUSED|connection refused/i.test(text);
}

/**
 * `phibot user reset-password --email <e-mail>` (R1 §4.5): no e-mail is ever sent by Phi Bot, so
 * the server operator sets a new random password, shown once, and the user's sessions are revoked.
 */
export async function runResetPassword(
  input: { email: string },
  deps: { db: PhibotDatabase; hasher: PasswordHasher; logger: PhibotLogger; generate?: () => string },
): Promise<string> {
  const email = input.email.trim();
  if (!isValidEmail(email)) throw new PhibotStepError(STEP, `adresse e-mail invalide : ${email}.`, "Indiquez l'e-mail du compte avec --email.");
  try {
    const userId = await deps.db.findUserIdByEmail(email);
    if (!userId) throw new PhibotStepError(STEP, `aucun compte pour ${email}.`, "Vérifiez l'adresse e-mail du compte.");
    const password = (deps.generate ?? generatePassword)();
    const updated = await deps.db.setCredentialPassword(userId, await deps.hasher.hashPassword(password));
    if (updated === 0) throw new PhibotStepError(STEP, `le compte ${email} n'a pas de connexion par mot de passe.`, "Aucune action possible pour ce compte.");
    const sessions = await deps.db.deleteSessions(userId);
    deps.logger.success(`Nouveau mot de passe de ${email} : ${password}`);
    deps.logger.info(`Il n'est affiché qu'une fois. ${sessions} session(s) fermée(s). L'utilisateur peut le changer dans son profil.`);
    return password;
  } catch (error) {
    if (isConnectionRefused(error)) {
      throw new PhibotStepError(STEP, "la base de Phi Bot ne répond pas.", "Démarrez le service (sudo phibot service start) puis relancez la commande.");
    }
    throw error;
  }
}
