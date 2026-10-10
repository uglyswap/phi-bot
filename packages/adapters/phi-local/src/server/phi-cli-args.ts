/**
 * phi tools removed from every phi_local run and probe (spec 8.5). All other
 * tools stay active, including the extension and MCP tools:
 * - `goal_complete` ends the turn without a final answer when no /goal is active;
 * - `phase_result` only serves the interactive /plan mode.
 */
export const PHI_EXCLUDED_TOOLS: readonly string[] = ["goal_complete", "phase_result"];

/** Value passed to `phi --exclude-tools`. */
export const PHI_EXCLUDE_TOOLS_ARG = PHI_EXCLUDED_TOOLS.join(",");

/** Last line of the system prompt file of every run (spec 8.5). */
export const PHIBOT_PLATFORM_PROMPT_LINE =
  "The platform you work in is called Phi Bot (its API and skills still use the technical name Paperclip).";
