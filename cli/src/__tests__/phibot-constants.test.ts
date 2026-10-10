import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CADDY_ARCHIVE_SHA512,
  CADDY_ARCHIVE_URL,
  CADDY_VERSION,
  PHIBOT_BIN_NAME,
  PHIBOT_CONFIG_PATH,
  PHIBOT_INSTANCE_ROOT,
  PHIBOT_PACKAGE_NAME,
  PHIBOT_REPOSITORY_URL,
  PHIBOT_SETUP_MARKER_PATH,
} from "../phibot/constants.js";

const cliPackagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json");

describe("Phi Bot package identity", () => {
  it("publishes the CLI as @phi-code-admin/phi-bot with the phibot binary", () => {
    const pkg = JSON.parse(fs.readFileSync(cliPackagePath, "utf8")) as {
      name: string;
      bin: Record<string, string>;
      repository: { url: string };
      homepage: string;
      bugs: { url: string };
    };
    expect(pkg.name).toBe(PHIBOT_PACKAGE_NAME);
    expect(pkg.bin).toEqual({ [PHIBOT_BIN_NAME]: "./dist/index.js" });
    expect(pkg.repository.url).toBe(PHIBOT_REPOSITORY_URL);
    expect(pkg.homepage).toBe(PHIBOT_REPOSITORY_URL);
    expect(pkg.bugs.url).toBe(`${PHIBOT_REPOSITORY_URL}/issues`);
  });

  it("keeps the instance under /var/lib/phibot/.paperclip/instances/default", () => {
    expect(PHIBOT_INSTANCE_ROOT).toBe("/var/lib/phibot/.paperclip/instances/default");
    expect(PHIBOT_CONFIG_PATH).toBe("/var/lib/phibot/.paperclip/instances/default/config.json");
    expect(PHIBOT_SETUP_MARKER_PATH).toBe("/var/lib/phibot/.paperclip/instances/default/.phibot-setup-complete");
  });

  it("pins Caddy 2.11.7 with its SHA-512", () => {
    expect(CADDY_VERSION).toBe("2.11.7");
    expect(CADDY_ARCHIVE_URL).toBe(
      "https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_linux_amd64.tar.gz",
    );
    expect(CADDY_ARCHIVE_SHA512).toMatch(/^[0-9a-f]{128}$/);
  });
});
