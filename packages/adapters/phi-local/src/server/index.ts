import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Same shape as pi_local: `{ sessionId: <absolute .jsonl path>, cwd }`. */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id) ?? readNonEmptyString(record.session);
    if (!sessionId) return null;
    const cwd = readNonEmptyString(record.cwd) ?? readNonEmptyString(record.workdir) ?? readNonEmptyString(record.folder);
    return { sessionId, ...(cwd ? { cwd } : {}) };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id) ?? readNonEmptyString(params.session);
    if (!sessionId) return null;
    const cwd = readNonEmptyString(params.cwd) ?? readNonEmptyString(params.workdir) ?? readNonEmptyString(params.folder);
    return { sessionId, ...(cwd ? { cwd } : {}) };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id) ?? readNonEmptyString(params.session);
  },
};

export { execute, classifyPhiFailure, PHI_PROMPT_PREFIX } from "./execute.js";
export { listPhiSkills, syncPhiSkills, resolvePhiRunSkills } from "./skills.js";
export { testEnvironment } from "./test.js";
export {
  listPhiModels,
  refreshPhiModels,
  discoverPhiModels,
  discoverPhiModelsCached,
  parsePhiModelsOutput,
  toPhiBotModels,
  resetPhiModelsCacheForTests,
} from "./models.js";
export { parsePhiJsonl, isPhiSessionUnavailableError, PHI_SETTLED_EVENT_RE } from "./parse.js";
export { buildPhiChildEnv, isInheritedEnvKeyAllowed, INHERITED_ENV_ALLOWLIST } from "./child-env.js";
export { resolvePhiCli, findPhiPackageDir, compareVersions } from "./phi-binary.js";
export { resolvePhiProviderSelection, writeManagedModelsJson } from "./runtime-config.js";
export { buildPhiMcpConfig, phiSupportsMcpConfigFile, PHI_MCP_CONFIG_MIN_VERSION } from "./mcp-config.js";
export { resolvePhiBotRoot, resolvePhiCompanyPaths } from "./paths.js";
export { ensurePhiAgentDirReady, ensurePhiDefaultTools, PHIBOT_DEFAULT_TOOLS } from "./agent-dir.js";
export { PHI_EXCLUDED_TOOLS, PHIBOT_PLATFORM_PROMPT_LINE } from "./phi-cli-args.js";
export { preparePhiForCompany, PHI_EMBEDDING_MODEL_ID, type PreparedPhiCompany } from "./prepare.js";
