export const type = "phi_local";
export const label = "Phi";

/** npm package that ships the `phi` CLI; resolved at run time, never installed by the adapter. */
export const PHI_PACKAGE_NAME = "@phi-code-admin/phi-code";

export {
  PHIBOT_LLM_SECRET_KEYS,
  PHIBOT_PROVIDERS,
  PHIBOT_UNSET,
  findPhiBotProvider,
  type PhiBotProvider,
} from "./providers.js";

/** Static list is empty: the catalog is read from phi (`listModels`). */
export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# phi_local agent configuration

Adapter: phi_local

Use when:
- You want Phi Bot to run phi (phi-code) on the Phi Bot server as the agent runtime.

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing).
- instructionsFilePath (string, optional): absolute path to a markdown instructions file appended to phi's system prompt.
- promptTemplate (string, optional): run prompt template.
- model (string, optional): "<provider>/<model>" for the company's provider (for example anthropic/claude-sonnet-4-6).
  Empty means the company default model (PHIBOT_DEFAULT_MODEL).
- thinking (string, optional): off, minimal, low, medium, high, xhigh, max.
- env (object, optional): KEY=VALUE environment variables.
- extraArgs (string[], optional): additional phi CLI arguments.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds (0 or absent: none).
- graceSec (number, optional): SIGTERM grace period in seconds.

Notes:
- Provider, API key, base URL and default model come from the company secrets PHIBOT_LLM_PROVIDER,
  PHIBOT_LLM_API_KEY, PHIBOT_LLM_BASE_URL and PHIBOT_DEFAULT_MODEL bound to the execution environment.
- phi is the copy shipped with Phi Bot; adapterConfig.command is ignored.
- Sessions live in ~/.phi/phibot/companies/<companyId>/sessions/<agentId>/ and are resumed with --session.
- The task is sent on stdin; agent instructions are appended with --append-system-prompt <file>.
`;
