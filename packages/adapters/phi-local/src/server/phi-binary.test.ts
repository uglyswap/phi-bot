import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareVersions, findPhiPackageDir, resolvePhiCli } from "./phi-binary.js";

const dirs: string[] = [];

async function makeInstall(): Promise<{ root: string; fromFile: string; cli: string }> {
  // Layout of a global install: <root>/node_modules/@phi-code-admin/phi-code next to the app.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "phi-bin-"));
  dirs.push(root);
  const pkgDir = path.join(root, "node_modules", "@phi-code-admin", "phi-code");
  await fs.mkdir(path.join(pkgDir, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@phi-code-admin/phi-code",
      version: "0.99.5",
      type: "module",
      bin: { phi: "dist/cli.js" },
      // Same exports map as the real package: "./package.json" is not exported.
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    }),
  );
  await fs.writeFile(path.join(pkgDir, "dist", "cli.js"), "#!/usr/bin/env node\n");
  await fs.writeFile(path.join(pkgDir, "dist", "index.js"), "export {};\n");
  const appDir = path.join(root, "node_modules", "@paperclipai", "adapter-phi-local", "dist", "server");
  await fs.mkdir(appDir, { recursive: true });
  const fromFile = path.join(appDir, "phi-binary.js");
  await fs.writeFile(fromFile, "");
  return { root, fromFile, cli: path.join(pkgDir, "dist", "cli.js") };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("resolvePhiCli", () => {
  it("documents why require.resolve('<pkg>/package.json') cannot be used", async () => {
    const { fromFile } = await makeInstall();
    const require = createRequire(fromFile);
    expect(() => require.resolve("@phi-code-admin/phi-code/package.json")).toThrow(/ERR_PACKAGE_PATH_NOT_EXPORTED|not defined by "exports"/);
  });

  it("finds the nested package and launches its bin with the current Node binary", async () => {
    const { fromFile, cli } = await makeInstall();
    expect(findPhiPackageDir(fromFile)).toBe(path.dirname(path.dirname(cli)));
    expect(resolvePhiCli({ env: {}, fromFile })).toEqual({
      command: process.execPath,
      prefixArgs: [cli],
      version: "0.99.5",
      source: "package",
      displayPath: cli,
    });
  });

  it("honors PHIBOT_PHI_CLI, then falls back to phi on PATH", async () => {
    const override = path.resolve("/opt/phi/dist/cli.js");
    expect(resolvePhiCli({ env: { PHIBOT_PHI_CLI: override }, fromFile: path.join(os.tmpdir(), "x.js") })).toMatchObject({
      command: process.execPath,
      prefixArgs: [override],
      source: "env",
    });
    const lonely = await fs.mkdtemp(path.join(os.tmpdir(), "phi-none-"));
    dirs.push(lonely);
    expect(resolvePhiCli({ env: {}, fromFile: path.join(lonely, "a.js") }).source).toMatch(/^(path|package)$/);
  });
});

describe("compareVersions", () => {
  it("compares x.y.z numerically", () => {
    expect(compareVersions("0.100.0", "0.99.5")).toBeGreaterThan(0);
    expect(compareVersions("0.99.4", "0.100.0")).toBeLessThan(0);
    expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBe(0);
  });
});
