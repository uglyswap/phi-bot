import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PhibotStepError, createNodeSystem, execOrThrow, tailLines } from "../phibot/system.js";
import { FakeSystem } from "./helpers/phibot-fake-system.js";

describe("createNodeSystem", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phibot-system-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("captures stdout, stderr and the exit code without throwing", async () => {
    const sys = createNodeSystem();
    const ok = await sys.exec(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err')"]);
    expect(ok).toEqual({ code: 0, stdout: "out", stderr: "err" });
    const failed = await sys.exec(process.execPath, ["-e", "process.exit(3)"]);
    expect(failed.code).toBe(3);
  });

  it("writes stdin and reports a missing command as code 127", async () => {
    const sys = createNodeSystem();
    const echoed = await sys.exec(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "bonjour" });
    expect(echoed.stdout).toBe("bonjour");
    const missing = await sys.exec("phibot-command-that-does-not-exist", []);
    expect(missing.code).toBe(127);
  });

  it("reads, writes, lists and removes files", () => {
    const sys = createNodeSystem();
    const dir = path.join(root, "a", "b");
    sys.makeDir(dir, 0o700);
    const file = path.join(dir, "f.txt");
    sys.writeFile(file, "contenu", 0o600);
    expect(sys.exists(file)).toBe(true);
    expect(sys.readFile(file)).toBe("contenu");
    expect(sys.listDir(dir)).toEqual(["f.txt"]);
    expect(sys.fileMode(file)).not.toBeNull();
    expect(sys.fileMode(path.join(dir, "absent"))).toBeNull();
    expect(sys.modifiedAtMs(file)).toBeGreaterThan(0);
    expect(sys.freeDiskBytes(root)).toBeGreaterThan(0);
    sys.remove(path.join(root, "a"));
    expect(sys.exists(file)).toBe(false);
    expect(sys.listDir(dir)).toEqual([]);
  });
});

describe("execOrThrow", () => {
  it("names the step, the failing command and the correction", async () => {
    const sys = new FakeSystem().onExec("apt-get update", { code: 100, stdout: "", stderr: "E: dépôt injoignable" });
    await expect(
      execOrThrow(sys, "apt-get", ["update"], { step: "Paquets système", fix: "Vérifiez le réseau." }),
    ).rejects.toThrow(
      "Étape « Paquets système » : la commande « apt-get update » a échoué (code 100).\nE: dépôt injoignable\nCorrection : Vérifiez le réseau.",
    );
  });

  it("returns the result when the command succeeds", async () => {
    const sys = new FakeSystem().onExec("uname", { code: 0, stdout: "Linux\n", stderr: "" });
    await expect(execOrThrow(sys, "uname", [], { step: "x", fix: "y" })).resolves.toEqual({ code: 0, stdout: "Linux\n", stderr: "" });
  });
});

describe("PhibotStepError and tailLines", () => {
  it("formats the message in French", () => {
    const error = new PhibotStepError("Contrôles", "Linux requis.", "Utilisez Ubuntu 24.04.");
    expect(error.message).toBe("Étape « Contrôles » : Linux requis.\nCorrection : Utilisez Ubuntu 24.04.");
  });

  it("keeps the last lines", () => {
    expect(tailLines("a\nb\nc\n", 2)).toBe("b\nc");
  });
});
