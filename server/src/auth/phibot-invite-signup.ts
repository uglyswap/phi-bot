/**
 * Phi Bot patch P3: credential sign-up only for invite holders.
 *
 * With PHIBOT_INVITE_ONLY_SIGNUP=true, POST /api/auth/sign-up/email must carry
 * the raw token of a usable invite in the X-Phibot-Invite-Token header: a
 * company invite or the bootstrap CEO invite, not expired, not revoked, not
 * accepted, and not reserved to agents. `PAPERCLIP_AUTH_DISABLE_SIGN_UP` is
 * not an option: it also blocks invited teammates.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { invites, type Db } from "@paperclipai/db";

/** Header sent by the Phi Bot invite page and by `phibot setup` with the sign-up request. */
export const PHIBOT_INVITE_TOKEN_HEADER = "x-phibot-invite-token";
/** Error code of the 403 answer. */
export const PHIBOT_INVITE_REQUIRED_CODE = "phibot_invite_required";

const SIGN_UP_EMAIL_PATH = "/sign-up/email";
const MAX_INVITE_TOKEN_LENGTH = 256;

export function isPhiBotInviteOnlySignupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PHIBOT_INVITE_ONLY_SIGNUP === "true";
}

/** Same digest as the invite routes (`hashToken`, server/src/routes/access.ts): invites only store sha256(token). */
function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

type SignupInvite = Pick<
  typeof invites.$inferSelect,
  "inviteType" | "allowedJoinTypes" | "expiresAt" | "revokedAt" | "acceptedAt"
>;

/**
 * Same "active" rule as `inviteState` of the invite routes (not revoked, not
 * accepted, not expired), for the two invite types a human can accept.
 */
export function isInviteUsableForSignup(invite: SignupInvite, now: Date = new Date()): boolean {
  if (invite.inviteType !== "company_join" && invite.inviteType !== "bootstrap_ceo") return false;
  if (invite.revokedAt || invite.acceptedAt) return false;
  if (invite.expiresAt.getTime() <= now.getTime()) return false;
  return invite.allowedJoinTypes !== "agent";
}

export async function hasUsableSignupInvite(db: Db, rawToken: string | null | undefined): Promise<boolean> {
  const token = rawToken?.trim() ?? "";
  if (!token || token.length > MAX_INVITE_TOKEN_LENGTH) return false;
  const invite = await db
    .select({
      inviteType: invites.inviteType,
      allowedJoinTypes: invites.allowedJoinTypes,
      expiresAt: invites.expiresAt,
      revokedAt: invites.revokedAt,
      acceptedAt: invites.acceptedAt,
    })
    .from(invites)
    .where(eq(invites.tokenHash, hashInviteToken(token)))
    .then((rows) => rows[0] ?? null);
  return invite !== null && isInviteUsableForSignup(invite);
}

/** Better Auth `hooks.before` handler: runs for every auth endpoint, acts on /sign-up/email only. */
export function createPhiBotInviteOnlySignupHook(db: Db) {
  return createAuthMiddleware(async (ctx) => {
    if (ctx.path !== SIGN_UP_EMAIL_PATH) return;
    const token = ctx.headers?.get(PHIBOT_INVITE_TOKEN_HEADER) ?? null;
    if (await hasUsableSignupInvite(db, token)) return;
    throw new APIError("FORBIDDEN", {
      code: PHIBOT_INVITE_REQUIRED_CODE,
      message: "Sign-up requires a valid invitation link.",
    });
  });
}
