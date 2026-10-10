import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import {
  buildRuntimeMountedSkillSnapshot,
  isPaperclipSkillSourceMissing,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { resolvePhiCompanyPaths } from "./paths.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Paperclip skills are not installed into a shared folder (pi_local linked
 * every agent's skills into one `~/.pi/agent/skills`, so every agent saw all
 * of them). Each run passes the desired skill folders to phi with `--skill`,
 * so the snapshot is "ephemeral" (runtime-mounted), like claude_local.
 */
async function buildPhiSkillSnapshot(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(ctx.config, availableEntries);
  const skillsHome = path.join(resolvePhiCompanyPaths(ctx.companyId).agentDir, "skills");
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildRuntimeMountedSkillSnapshot({
    adapterType: "phi_local",
    availableEntries,
    desiredSkills,
    configuredDetail: "Passed to phi with --skill on the next run.",
    externalInstalled: installed,
    externalLocationLabel: "~/.phi/phibot/companies/<company>/agent/skills",
    externalDetail: "Bundled with phi or installed outside Paperclip management.",
    skillsHome,
  });
}

export async function listPhiSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildPhiSkillSnapshot(ctx);
}

/** Nothing to install: the desired set is applied at the next run. */
export async function syncPhiSkills(ctx: AdapterSkillContext, _desiredSkills: string[]): Promise<AdapterSkillSnapshot> {
  return buildPhiSkillSnapshot(ctx);
}

/** Folders passed to phi with `--skill`, and their `bin/` folders for PATH. */
export async function resolvePhiRunSkills(config: Record<string, unknown>): Promise<{
  skillDirs: string[];
  binDirs: string[];
  missing: string[];
}> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desired = new Set(resolveLegacyPaperclipDesiredSkillNames(config, availableEntries));
  const skillDirs: string[] = [];
  const binDirs: string[] = [];
  const missing: string[] = [];
  for (const entry of availableEntries) {
    if (!desired.has(entry.key)) continue;
    if (isPaperclipSkillSourceMissing(entry) || entry.source.length === 0) {
      missing.push(entry.key);
      continue;
    }
    skillDirs.push(entry.source);
    binDirs.push(path.join(entry.source, "bin"));
  }
  return { skillDirs, binDirs, missing };
}
