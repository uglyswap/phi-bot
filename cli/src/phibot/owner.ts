import { PHIBOT_DEFAULT_COMPANY_NAME, PHIBOT_LOCAL_URL, PHIBOT_MIN_PASSWORD_LENGTH } from "./constants.js";
import type { PhibotDatabase } from "./database.js";
import { type PhibotLogger, type PhibotPrompter, type PhibotSystem, PhibotStepError } from "./system.js";
import { isValidEmail } from "./units.js";

export interface OwnerInfo {
  name: string;
  email: string;
  /** Emptied as soon as the account exists (spec 6.4). */
  password: string;
  companyName: string;
}

export interface OwnerOptions {
  ownerName?: string;
  ownerEmail?: string;
  ownerPasswordFile?: string;
  company?: string;
  yes?: boolean;
}

const STEP = "Propriétaire et entreprise";

function localPart(email: string): string {
  return email.split("@")[0] ?? email;
}

function checkPassword(value: string): string | undefined {
  return value.length >= PHIBOT_MIN_PASSWORD_LENGTH ? undefined : `${PHIBOT_MIN_PASSWORD_LENGTH} caractères minimum.`;
}

function checkName(label: string, value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return `${label} obligatoire.`;
  return trimmed.length > 200 ? `${label} trop long (200 caractères maximum).` : undefined;
}

/** `--owner-password-file`: one line, not readable by group or others, 12 characters minimum. */
export function readPasswordFile(sys: PhibotSystem, file: string): string {
  if (!sys.exists(file)) throw new PhibotStepError(STEP, `fichier de mot de passe introuvable : ${file}.`, "Indiquez un fichier existant avec --owner-password-file.");
  const mode = sys.fileMode(file);
  if (sys.platform !== "win32" && mode !== null && (mode & 0o077) !== 0) {
    throw new PhibotStepError(STEP, `le fichier ${file} est lisible par d'autres comptes (mode ${mode.toString(8)}).`, `Lancez chmod 600 ${file} puis relancez la commande.`);
  }
  const contents = sys.readFile(file).replace(/\r?\n$/, "");
  if (/[\r\n]/.test(contents)) throw new PhibotStepError(STEP, `le fichier ${file} doit contenir une seule ligne.`, "Écrivez le mot de passe sur une seule ligne.");
  const problem = checkPassword(contents);
  if (problem) throw new PhibotStepError(STEP, `mot de passe trop court dans ${file} : ${problem}`, "Choisissez un mot de passe plus long.");
  return contents;
}

async function askPassword(prompter: PhibotPrompter): Promise<string> {
  const first = await prompter.password({ message: "Mot de passe du propriétaire (12 caractères minimum)", validate: checkPassword });
  const second = await prompter.password({ message: "Saisissez à nouveau le mot de passe" });
  if (first !== second) throw new PhibotStepError(STEP, "les deux saisies du mot de passe diffèrent.", "Relancez la commande et saisissez deux fois le même mot de passe.");
  return first;
}

/** Step 2 of `setup` and first part of `owner create`. */
export async function collectOwnerInfo(opts: OwnerOptions, deps: { sys: PhibotSystem; prompter: PhibotPrompter }): Promise<OwnerInfo> {
  if (opts.yes) {
    const missing = [
      opts.ownerEmail ? null : "--owner-email",
      opts.ownerPasswordFile ? null : "--owner-password-file",
      opts.company ? null : "--company",
    ].filter((value): value is string => value !== null);
    if (missing.length > 0) {
      throw new PhibotStepError("Informations du propriétaire", `avec --yes, il manque : ${missing.join(", ")}.`, "Ajoutez ces options ou retirez --yes pour répondre aux questions.");
    }
  } else if (!deps.prompter.interactive && (!opts.ownerEmail || !opts.ownerPasswordFile || !opts.company)) {
    throw new PhibotStepError("Informations du propriétaire", "terminal non interactif.", "Utilisez --yes avec --owner-email, --owner-password-file et --company.");
  }
  const email = (opts.ownerEmail ?? (await deps.prompter.text({ message: "E-mail du propriétaire", validate: (v) => (isValidEmail(v) ? undefined : "Adresse e-mail invalide.") }))).trim();
  if (!isValidEmail(email)) throw new PhibotStepError("Informations du propriétaire", `adresse e-mail invalide : ${email}.`, "Corrigez --owner-email.");
  const name = (opts.ownerName ?? (opts.yes ? localPart(email) : await deps.prompter.text({ message: "Nom du propriétaire", initialValue: localPart(email), validate: (v) => checkName("Nom", v) }))).trim();
  const password = opts.ownerPasswordFile ? readPasswordFile(deps.sys, opts.ownerPasswordFile) : await askPassword(deps.prompter);
  const companyName = (opts.company ?? (await deps.prompter.text({ message: "Nom de l'entreprise", initialValue: PHIBOT_DEFAULT_COMPANY_NAME, validate: (v) => checkName("Nom de l'entreprise", v) }))).trim();
  for (const [label, value] of [["Nom", name], ["Nom de l'entreprise", companyName]] as const) {
    const problem = checkName(label, value);
    if (problem) throw new PhibotStepError("Informations du propriétaire", problem, "Corrigez la valeur et relancez la commande.");
  }
  return { name, email, password, companyName };
}

/** Calls of spec 6.4 on the loopback; each throws a PhibotStepError on an unexpected answer. */
export interface OwnerHttp {
  signUp(input: { name: string; email: string; password: string; inviteToken: string }): Promise<string>;
  signIn(input: { email: string; password: string }): Promise<string>;
  acceptBootstrapInvite(cookie: string, token: string): Promise<void>;
  createCompany(cookie: string, name: string): Promise<string>;
  listCompanies(cookie: string): Promise<Array<{ id: string; name: string }>>;
}

async function describeFailure(call: string, response: Response): Promise<PhibotStepError> {
  const body = (await response.text().catch(() => "")).slice(0, 300);
  return new PhibotStepError(STEP, `${call} : réponse HTTP ${response.status}${body ? ` ${body}` : ""}.`, "Consultez sudo phibot service logs puis relancez la commande.");
}

/** Session cookie for the next calls, from every Set-Cookie header. */
export function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0]?.trim())
    .filter((pair): pair is string => Boolean(pair))
    .join("; ");
}

/**
 * Origin trusted by Better Auth for the sign-up and sign-in calls. Node's fetch sends
 * `Sec-Fetch-Mode: cors`, which makes Better Auth 1.7.2 require an Origin from its trusted
 * list: the public URL in "explicit" mode, the requested host (127.0.0.1:3100) in "auto" mode.
 */
export function resolveAuthOrigin(auth: { baseUrlMode: string; publicBaseUrl?: string }): string {
  return auth.baseUrlMode === "explicit" && auth.publicBaseUrl ? new URL(auth.publicBaseUrl).origin : PHIBOT_LOCAL_URL;
}

export function createOwnerHttp(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  options: { authOrigin: string; baseUrl?: string },
): OwnerHttp {
  const baseUrl = options.baseUrl ?? PHIBOT_LOCAL_URL;
  const json = { "Content-Type": "application/json" };
  const authHeaders = { ...json, Origin: options.authOrigin };
  // Paperclip's CSRF guard always trusts http://127.0.0.1:3100 for board mutations.
  const boardHeaders = (cookie: string) => ({ ...json, Cookie: cookie, Origin: baseUrl });
  const session = async (call: string, response: Response): Promise<string> => {
    if (response.status !== 200) throw await describeFailure(call, response);
    const cookie = cookieHeaderFrom(response);
    if (!cookie) throw new PhibotStepError(STEP, `${call} : aucun cookie de session reçu.`, "Consultez sudo phibot service logs puis relancez la commande.");
    return cookie;
  };
  return {
    async signUp(input) {
      let body = JSON.stringify({ name: input.name, email: input.email, password: input.password });
      const response = await fetchImpl(`${baseUrl}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { ...authHeaders, "X-Phibot-Invite-Token": input.inviteToken },
        body,
      });
      body = "";
      return session("inscription du propriétaire", response);
    },
    async signIn(input) {
      let body = JSON.stringify({ email: input.email, password: input.password });
      const response = await fetchImpl(`${baseUrl}/api/auth/sign-in/email`, { method: "POST", headers: authHeaders, body });
      body = "";
      return session("connexion du propriétaire", response);
    },
    async acceptBootstrapInvite(cookie, token) {
      const response = await fetchImpl(`${baseUrl}/api/invites/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        headers: boardHeaders(cookie),
        body: JSON.stringify({ requestType: "human" }),
      });
      const result = (await response.clone().json().catch(() => null)) as { bootstrapAccepted?: unknown } | null;
      if (response.status !== 202 || result?.bootstrapAccepted !== true) throw await describeFailure("acceptation de l'invitation d'administrateur", response);
    },
    async createCompany(cookie, name) {
      const response = await fetchImpl(`${baseUrl}/api/companies`, { method: "POST", headers: boardHeaders(cookie), body: JSON.stringify({ name }) });
      const company = (await response.clone().json().catch(() => null)) as { id?: unknown } | null;
      if (response.status !== 201 || typeof company?.id !== "string") throw await describeFailure("création de l'entreprise", response);
      return company.id;
    },
    async listCompanies(cookie) {
      const response = await fetchImpl(`${baseUrl}/api/companies`, { headers: { Cookie: cookie } });
      const companies = (await response.clone().json().catch(() => null)) as unknown;
      if (response.status !== 200 || !Array.isArray(companies)) throw await describeFailure("liste des entreprises", response);
      return companies.map((company: { id?: unknown; name?: unknown }) => ({ id: String(company.id), name: String(company.name) }));
    },
  };
}

export interface OwnerOutcome {
  companyId: string;
  createdUser: boolean;
  acceptedInvite: boolean;
  createdCompany: boolean;
}

/**
 * Step 9 (spec 6.4), resumable (review M5): reuses an existing owner account by signing in,
 * accepts a new bootstrap invite only if no instance admin exists, creates the company only if
 * there is none, and always returns the company id read from the database.
 */
export async function ensureOwnerAndCompany(deps: { http: OwnerHttp; db: PhibotDatabase; logger: PhibotLogger }, info: OwnerInfo): Promise<OwnerOutcome> {
  const admins = await deps.db.instanceAdminCount();
  const companies = await deps.db.companyIds();
  if (companies.length > 1) throw new PhibotStepError(STEP, `${companies.length} entreprises en base (une seule attendue).`, "Contactez le support Phi Bot.");
  const outcome: OwnerOutcome = { companyId: companies[0] ?? "", createdUser: false, acceptedInvite: false, createdCompany: false };
  if (admins > 0 && companies.length === 1) {
    info.password = "";
    return outcome;
  }
  const existingUser = await deps.db.findUserIdByEmail(info.email);
  const token = admins === 0 ? await deps.db.createBootstrapInvite() : null;
  let cookie: string;
  if (existingUser) {
    deps.logger.info(`Compte ${info.email} déjà présent : connexion avec ce compte.`);
    cookie = await deps.http.signIn({ email: info.email, password: info.password });
  } else {
    if (!token) throw new PhibotStepError(STEP, "un administrateur existe déjà et le compte du propriétaire est introuvable.", `Relancez avec l'e-mail de l'administrateur existant (--owner-email).`);
    cookie = await deps.http.signUp({ name: info.name, email: info.email, password: info.password, inviteToken: token });
    outcome.createdUser = true;
  }
  info.password = "";
  if (token) {
    await deps.http.acceptBootstrapInvite(cookie, token);
    outcome.acceptedInvite = true;
  }
  if (companies.length === 0) {
    await deps.http.createCompany(cookie, info.companyName);
    outcome.createdCompany = true;
  }
  const visible = await deps.http.listCompanies(cookie);
  if (visible.length !== 1) throw new PhibotStepError(STEP, `le compte du propriétaire voit ${visible.length} entreprises (une attendue).`, "Consultez sudo phibot service logs.");
  const ids = await deps.db.companyIds();
  if (ids.length !== 1) throw new PhibotStepError(STEP, `${ids.length} entreprises en base après création (une attendue).`, "Consultez sudo phibot service logs.");
  outcome.companyId = ids[0];
  return outcome;
}
