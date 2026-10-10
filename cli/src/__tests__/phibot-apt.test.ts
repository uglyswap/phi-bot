import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PHIBOT_APT_PACKAGES,
  installSystemPackages,
  parseAptCachePolicy,
  selectAptPackages,
} from "../phibot/apt.js";
import { FakeSystem, MemoryLogger } from "./helpers/phibot-fake-system.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
function policyOf(distro: string): string {
  return fs.readFileSync(path.join(fixturesDir, `apt-cache-policy-${distro}.txt`), "utf8");
}

const COMMON = [
  "ca-certificates", "curl", "tar", "unzip", "git", "ripgrep", "fd-find", "python3", "jq", "openssh-client", "xvfb",
];
const TAIL = [
  "libx11-xcb1", "libxcomposite1", "libxcursor1", "libxdamage1", "libxfixes3", "libxi6", "libxrandr2", "libxrender1",
  "libxss1", "libxtst6", "libegl1", "libgl1-mesa-dri", "libgbm1", "fonts-liberation", "fonts-noto-color-emoji",
  "fonts-wqy-zenhei", "fontconfig", "nftables",
];

describe("parseAptCachePolicy", () => {
  it("reads candidate versions, virtual packages and unknown names (Ubuntu 24.04)", () => {
    const policy = parseAptCachePolicy(policyOf("noble"));
    expect(policy.get("libgtk-3-0t64")).toBe("3.24.41-4ubuntu1.3");
    expect(policy.get("libgtk-3-0")).toBeNull();
    expect(policy.has("libgtk-3-0")).toBe(true);
    expect(policy.has("libegl1-mesa")).toBe(false);
    expect(policy.get("tar")).toBe("1.35+dfsg-3ubuntu0.4");
  });

  it("ignores architecture suffixes in section headers", () => {
    const policy = parseAptCachePolicy("libfoo:i386:\n  Installed: (none)\n  Candidate: 1.0\n  Version table:\n");
    expect(policy.get("libfoo")).toBe("1.0");
  });
});

describe("selectAptPackages", () => {
  it("picks the t64 names on Ubuntu 24.04", () => {
    const selection = selectAptPackages(parseAptCachePolicy(policyOf("noble")));
    expect(selection.install).toEqual([
      ...COMMON, "libgtk-3-0t64", "libdbus-glib-1-2", "libxt6t64", "libasound2t64", ...TAIL,
    ]);
    expect(selection.missingRequired).toEqual([]);
    expect(selection.missingOptional).toEqual([]);
  });

  it("falls back to the classic names on Ubuntu 22.04 and Debian 12", () => {
    for (const distro of ["jammy", "bookworm"]) {
      const selection = selectAptPackages(parseAptCachePolicy(policyOf(distro)));
      expect(selection.install).toEqual([
        ...COMMON, "libgtk-3-0", "libdbus-glib-1-2", "libxt6", "libasound2", ...TAIL,
      ]);
      expect(selection.missingRequired).toEqual([]);
    }
  });

  it("separates missing required and optional packages", () => {
    const selection = selectAptPackages(new Map([["curl", "1"], ["jq", null]]), PHIBOT_APT_PACKAGES.slice(1, 9));
    expect(selection.install).toEqual(["curl"]);
    expect(selection.missingRequired.map((spec) => spec.key)).toEqual(["tar", "unzip", "git", "ripgrep"]);
    expect(selection.missingOptional.map((spec) => spec.key)).toEqual(["fd", "python3", "jq"]);
  });
});

describe("installSystemPackages", () => {
  it("updates, queries with LC_ALL=C and installs the selected names", async () => {
    const sys = new FakeSystem().onExec("apt-cache policy", { code: 0, stdout: policyOf("noble"), stderr: "" });
    const logger = new MemoryLogger();
    const selection = await installSystemPackages(sys, logger);
    expect(sys.lines()[0]).toBe("apt-get -o DPkg::Lock::Timeout=600 update");
    expect(sys.calls[1].line.startsWith("apt-cache policy ca-certificates curl tar")).toBe(true);
    expect(sys.calls[1].options?.env?.LC_ALL).toBe("C");
    expect(sys.lines()[2]).toBe(`apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends ${selection.install.join(" ")}`);
    expect(sys.calls[2].options?.env?.DEBIAN_FRONTEND).toBe("noninteractive");
    expect(sys.calls[2].options?.env?.NEEDRESTART_MODE).toBe("a");
    expect(logger.text()).toContain("attend jusqu'à 10 minutes");
  });

  it("stops before apt-get install when a required package is missing", async () => {
    const sys = new FakeSystem().onExec("apt-cache policy", { code: 0, stdout: "curl:\n  Installed: (none)\n  Candidate: 1\n", stderr: "" });
    await expect(installSystemPackages(sys, new MemoryLogger())).rejects.toThrow("paquets obligatoires introuvables");
    expect(sys.lines().some((line) => line.startsWith("apt-get install"))).toBe(false);
  });
});
