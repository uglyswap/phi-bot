import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensurePhiAgentDirReady, ensurePhiDefaultTools, PHIBOT_DEFAULT_TOOLS, readPhiAgentDirStamp } from "./agent-dir.js";
import { buildPhiChildEnv } from "./child-env.js";

// Stand-in for phi's first start: slow copy, then the version stamp.
const FAKE_PHI = String.raw`
import fs from "node:fs";
import path from "node:path";
const dir = process.env.PHI_CODING_AGENT_DIR;
fs.appendFileSync(process.env.WARMUP_COUNTER, "x");
setTimeout(() => {
  fs.writeFileSync(path.join(dir, ".bundled-assets-version"), "9.9.9");
  process.stdout.write("No models matching \"phibot-warmup\"\n");
}, 300);
`;

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "phi-agentdir-"));
  roots.push(root);
  return root;
}

async function readSettings(agentDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
}

describe("ensurePhiAgentDirReady", () => {
  it("runs phi's first-start copy once for concurrent runs, then never again", async () => {
    const root = await makeRoot();
    const agentDir = path.join(root, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    const fake = path.join(root, "fake-phi.mjs");
    await fs.writeFile(fake, FAKE_PHI);
    const counter = path.join(root, "counter.txt");
    const cli = { command: process.execPath, prefixArgs: [fake], version: "9.9.9", source: "env" as const, displayPath: fake };
    const env = buildPhiChildEnv({
      inherited: process.env,
      runEnv: {},
      forced: { PHI_CODING_AGENT_DIR: agentDir, WARMUP_COUNTER: counter },
    });

    await Promise.all([1, 2, 3].map(() => ensurePhiAgentDirReady({ cli, version: "9.9.9", agentDir, cwd: root, env })));
    expect(await fs.readFile(counter, "utf8")).toBe("x");
    expect(await readPhiAgentDirStamp(agentDir)).toBe("9.9.9");
    expect((await readSettings(agentDir)).defaultTools).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);

    await ensurePhiAgentDirReady({ cli, version: "9.9.9", agentDir, cwd: root, env });
    expect(await fs.readFile(counter, "utf8")).toBe("x");

    // Unknown version (phi from PATH): nothing to compare, no warm-up, defaultTools still set.
    const otherDir = path.join(root, "other");
    await ensurePhiAgentDirReady({ cli, version: null, agentDir: otherDir, cwd: root, env });
    expect(await fs.readFile(counter, "utf8")).toBe("x");
    expect((await readSettings(otherDir)).defaultTools).toEqual([...PHIBOT_DEFAULT_TOOLS]);
  });
});

describe("ensurePhiDefaultTools", () => {
  it("merges defaultTools into settings.json, keeps the other keys and writes only once", async () => {
    const agentDir = await makeRoot();
    await fs.writeFile(path.join(agentDir, "settings.json"), `${JSON.stringify({ quietStartup: true, defaultTools: ["read"] })}\n`);
    expect(await ensurePhiDefaultTools(agentDir)).toEqual({ changed: true });
    expect(await readSettings(agentDir)).toEqual({
      quietStartup: true,
      defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    });
    expect(await ensurePhiDefaultTools(agentDir)).toEqual({ changed: false });
    expect((await fs.readdir(agentDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses to overwrite a settings file that is not a JSON object", async () => {
    const agentDir = await makeRoot();
    await fs.writeFile(path.join(agentDir, "settings.json"), "{ not json");
    await expect(ensurePhiDefaultTools(agentDir)).rejects.toThrow(/is not valid JSON/);
    expect(await fs.readFile(path.join(agentDir, "settings.json"), "utf8")).toBe("{ not json");
  });
});
