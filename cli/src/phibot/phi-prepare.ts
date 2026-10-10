import type { PhibotLogger } from "./system.js";

/** Contract of plan B (spec 8.9 point 5): exported by @paperclipai/adapter-phi-local/server. */
export interface PhiPrepareResult {
  agentDir: string;
  phiVersion: string | null;
  embeddingModelDir: string;
}

export type PreparePhiForCompany = (companyId: string) => Promise<PhiPrepareResult>;

export const PHI_ADAPTER_SERVER_SPECIFIER = "@paperclipai/adapter-phi-local/server";
const COMPANY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPhiPrepareResult(value: unknown): value is PhiPrepareResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.agentDir === "string" &&
    typeof result.embeddingModelDir === "string" &&
    (result.phiVersion === null || typeof result.phiVersion === "string")
  );
}

/**
 * Loads the adapter at run time. The specifier is a parameter, not a literal, so esbuild leaves
 * the import alone: the adapter stays in its own package (node_modules of the Phi Bot package).
 */
export async function loadPreparePhiForCompany(specifier: string = PHI_ADAPTER_SERVER_SPECIFIER): Promise<PreparePhiForCompany> {
  const loaded: unknown = await import(specifier);
  const candidate = (loaded as { preparePhiForCompany?: unknown }).preparePhiForCompany;
  if (typeof candidate !== "function") throw new Error(`preparePhiForCompany introuvable dans ${specifier}.`);
  return async (companyId) => {
    const result: unknown = await (candidate as (id: string) => Promise<unknown>)(companyId);
    if (!isPhiPrepareResult(result)) throw new Error("preparePhiForCompany a renvoyé une valeur inattendue.");
    return result;
  };
}

/** `phibot phi:prepare --company <id>` (spec 12.1): agent folder and embedding model of the company. */
export async function runPhiPrepare(
  companyId: string,
  deps: { logger: PhibotLogger; load?: () => Promise<PreparePhiForCompany> },
): Promise<PhiPrepareResult> {
  if (!COMPANY_ID_PATTERN.test(companyId)) throw new Error(`Identifiant d'entreprise invalide : « ${companyId} ».`);
  deps.logger.step(`Préparation de phi pour l'entreprise ${companyId} (dossier agent, modèle d'embedding)...`);
  const prepare = await (deps.load ?? (() => loadPreparePhiForCompany()))();
  const result = await prepare(companyId);
  deps.logger.success(`Dossier agent : ${result.agentDir}`);
  deps.logger.info(`Version de phi : ${result.phiVersion ?? "inconnue"} ; modèle d'embedding : ${result.embeddingModelDir}`);
  return result;
}
