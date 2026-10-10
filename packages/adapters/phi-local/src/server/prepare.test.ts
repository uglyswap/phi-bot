import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetPhiCliVersionCacheForTests } from "./phi-binary.js";
import { preparePhiForCompany } from "./prepare.js";

// Stand-in for phi's CLI: `--version`, and the first-start copy triggered by `--list-models`.
const FAKE_PHI_CLI = String.raw`
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("9.9.9\n");
  process.exit(0);
}
const dir = process.env.PHI_CODING_AGENT_DIR;
fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
if (!fs.existsSync(path.join(dir, "settings.json"))) {
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ quietStartup: true }));
}
fs.writeFileSync(path.join(dir, ".bundled-assets-version"), "9.9.9");
process.stdout.write("No models matching \"phibot-warmup\"\n");
`;

// Stand-in for phi's sigma-memory (CommonJS like the real package): the model "download" writes the q8 model file.
const FAKE_SIGMA_MEMORY = String.raw`
const fs = require("node:fs");
const path = require("node:path");
exports.SigmaMemory = class SigmaMemory {
  constructor(config) {
    fs.mkdirSync(path.join(config.memoryDir, "notes"), { recursive: true });
    this.vectors = {
      init: async () => {},
      addDocument: async () => {
        // The child environment is an allowlist: a marker file simulates an unreachable model hub.
        if (fs.existsSync(path.join(__dirname, "FAIL"))) throw new Error("fetch failed: huggingface.co unreachable");
        const dir = path.join(config.modelCacheDir, "Xenova", "all-MiniLM-L6-v2", "onnx");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "model_quantized.onnx"), "onnx");
        return true;
      },
      close: () => {},
    };
  }
};
`;

const savedEnv = { ...process.env };
let root = "";

async function writeFile(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "phi-prepare-"));
  // Global install layout: sigma-memory hoisted next to phi, not inside it.
  const phiDir = path.join(root, "node_modules", "@phi-code-admin", "phi-code");
  await writeFile(
    path.join(phiDir, "package.json"),
    JSON.stringify({ name: "@phi-code-admin/phi-code", version: "9.9.9", type: "module", bin: { phi: "dist/cli.js" } }),
  );
  await writeFile(path.join(phiDir, "dist", "cli.js"), FAKE_PHI_CLI);
  const sigmaDir = path.join(root, "node_modules", "sigma-memory");
  await writeFile(path.join(sigmaDir, "package.json"), JSON.stringify({ name: "sigma-memory", main: "index.js" }));
  await writeFile(path.join(sigmaDir, "index.js"), FAKE_SIGMA_MEMORY);
  process.env.PHIBOT_PHI_CLI = path.join(phiDir, "dist", "cli.js");
  process.env.PHIBOT_HOME = path.join(root, "phibot");
  resetPhiCliVersionCacheForTests();
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await fs.rm(root, { recursive: true, force: true });
});

describe("preparePhiForCompany", () => {
  it("prepares the company agent dir and downloads the embedding model into its cache", async () => {
    const companyId = randomUUID();
    const prepared = await preparePhiForCompany(companyId);
    const agentDir = path.join(root, "phibot", "companies", companyId, "agent");
    expect(prepared).toEqual({
      agentDir,
      phiVersion: "9.9.9",
      embeddingModelDir: path.join(agentDir, "cache", "models", "Xenova", "all-MiniLM-L6-v2"),
    });
    expect(await fs.readFile(path.join(agentDir, ".bundled-assets-version"), "utf8")).toBe("9.9.9");
    expect(JSON.parse(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"))).toEqual({
      quietStartup: true,
      defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    });
    await expect(fs.stat(path.join(prepared.embeddingModelDir, "onnx", "model_quantized.onnx"))).resolves.toBeTruthy();
    // The throwaway memory dir of the warm-up is removed; nothing is written under the company root.
    expect((await fs.readdir(path.join(root, "phibot", "companies", companyId))).sort()).toEqual(["agent"]);
  });

  it("resolves phi's dependencies from its real location when phi is reached through a link", async () => {
    // The link lives in another tree: sigma-memory is only reachable from phi's real location.
    const linkRoot = await fs.mkdtemp(path.join(os.tmpdir(), "phi-prepare-link-"));
    try {
      const linkedDir = path.join(linkRoot, "node_modules", "@phi-code-admin", "phi-code");
      await fs.mkdir(path.dirname(linkedDir), { recursive: true });
      await fs.symlink(
        path.join(root, "node_modules", "@phi-code-admin", "phi-code"),
        linkedDir,
        process.platform === "win32" ? "junction" : "dir",
      );
      process.env.PHIBOT_PHI_CLI = path.join(linkedDir, "dist", "cli.js");
      const prepared = await preparePhiForCompany(randomUUID());
      await expect(fs.stat(path.join(prepared.embeddingModelDir, "onnx", "model_quantized.onnx"))).resolves.toBeTruthy();
    } finally {
      await fs.rm(linkRoot, { recursive: true, force: true });
    }
  });

  it("reports a failed model download explicitly", async () => {
    await writeFile(path.join(root, "node_modules", "sigma-memory", "FAIL"), "");
    await expect(preparePhiForCompany(randomUUID())).rejects.toThrow(
      /Downloading the embedding model Xenova\/all-MiniLM-L6-v2 into .* failed: fetch failed: huggingface\.co unreachable/,
    );
  });

  it("refuses to run without the phi package", async () => {
    const lonely = path.join(root, "lonely", "cli.js");
    await writeFile(lonely, "");
    process.env.PHIBOT_PHI_CLI = lonely;
    await expect(preparePhiForCompany(randomUUID())).rejects.toThrow(/phi is not installed: @phi-code-admin\/phi-code was not found/);
  });
});
