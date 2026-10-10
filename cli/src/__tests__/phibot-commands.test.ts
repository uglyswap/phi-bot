import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerPhibotCommands, topLevelCommandName } from "../commands/phibot-commands.js";

function phibotProgram(): Command {
  const program = new Command().name("phibot").exitOverride();
  registerPhibotCommands(program);
  return program;
}

function find(program: Command, ...names: string[]): Command {
  let current = program;
  for (const name of names) {
    const next = current.commands.find((command) => command.name() === name);
    if (!next) throw new Error(`command ${names.join(" ")} missing`);
    current = next;
  }
  return current;
}

function longOptions(command: Command): string[] {
  return command.options.map((option) => option.long ?? "");
}

describe("Phi Bot commands (spec 6.2 and 6.8)", () => {
  it("registers setup with the options of spec 6.2, --container and --tls-internal hidden", () => {
    const setup = find(phibotProgram(), "setup");
    expect(longOptions(setup)).toEqual([
      "--domain",
      "--acme-email",
      "--access",
      "--company",
      "--owner-name",
      "--owner-email",
      "--owner-password-file",
      "--yes",
      "--repair",
      "--restore",
      "--reconfigure",
      "--container",
      "--tls-internal",
    ]);
    const help = setup.helpInformation();
    expect(help).toContain("--owner-password-file <fichier>");
    expect(help).not.toContain("--container");
    expect(help).not.toContain("--tls-internal");
  });

  it("registers the operation commands of spec 6.8", () => {
    const program = phibotProgram();
    expect(longOptions(find(program, "owner", "create"))).toEqual(["--owner-name", "--owner-email", "--owner-password-file", "--company", "--yes"]);
    expect(longOptions(find(program, "phi:prepare"))).toEqual(["--company"]);
    expect(longOptions(find(program, "backup"))).toEqual(["--full", "--output"]);
    expect(longOptions(find(program, "db:restore"))).toEqual(["--yes"]);
    expect(longOptions(find(program, "user", "reset-password"))).toEqual(["--email"]);
    expect(longOptions(find(program, "internal:db-restore"))).toEqual(["--with-files"]);
    expect(program.helpInformation()).not.toContain("internal:db-restore");
  });

  it("names the top-level command that decides the relaunch", () => {
    const program = phibotProgram();
    expect(topLevelCommandName(find(program, "user", "reset-password"))).toBe("user");
    expect(topLevelCommandName(find(program, "owner", "create"))).toBe("owner");
    expect(topLevelCommandName(find(program, "db:restore"))).toBe("db:restore");
  });

  it("refuses --output without --full before touching anything", async () => {
    await expect(phibotProgram().parseAsync(["node", "phibot", "backup", "--output", "/tmp/a.tar.gz"])).rejects.toThrow("--output s'utilise avec --full");
  });
});
