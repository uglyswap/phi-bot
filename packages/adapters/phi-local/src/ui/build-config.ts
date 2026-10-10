import { buildAdapterEnvConfig, type CreateConfigValues } from "@paperclipai/adapter-utils";

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * adapterConfig of a new phi_local agent. No model is imposed: an empty model
 * means the company default (PHIBOT_DEFAULT_MODEL). No command either: the
 * phi shipped with Phi Bot is always used.
 */
export function buildPhiLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.model && v.model.trim()) ac.model = v.model.trim();
  if (v.thinkingEffort) ac.thinking = v.thinkingEffort;

  // Runs end when phi settles; no wall-clock timeout by default (0).
  ac.timeoutSec = 0;
  ac.graceSec = 20;

  const env = buildAdapterEnvConfig(v.envBindings, v.envVars);
  if (Object.keys(env).length > 0) ac.env = env;
  // pi_local stored the raw string, which the server ignored (asStringArray).
  if (v.extraArgs) ac.extraArgs = parseCommaArgs(v.extraArgs);
  return ac;
}
