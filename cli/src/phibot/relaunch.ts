import path from "node:path";
import {
  PHIBOT_HOME_DIR,
  PHIBOT_INSTANCE_ID,
  PHIBOT_PAPERCLIP_HOME,
  PHIBOT_SYSTEM_USER,
  PHIBOT_UNIT_PATH,
} from "./constants.js";
import type { ExecOptions, ExecResult, PhibotSystem } from "./system.js";
import { parsePhibotUnitExecStart, type PhibotUnitPaths } from "./units.js";

/**
 * Never relaunched automatically (spec 6.8, review M4): root commands, mixed commands that start
 * their phibot part themselves (doctor relaunches its checks), and internal:db-restore, which refuses root.
 */
export const ROOT_COMMANDS: ReadonlySet<string> = new Set([
  "setup",
  "update",
  "upgrade",
  "service",
  "uninstall",
  "db:restore",
  "install",
  "doctor",
  "internal:db-restore",
]);

/** Variables also kept by the clean `env -i` environment when set (proxies and CA bundles). */
const PASS_THROUGH_ENV = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

export interface CommandLine {
  command: string;
  args: string[];
}

export function shouldRelaunchAsPhibot(input: { platform: NodeJS.Platform; uid: number | null; unitExists: boolean; topCommand: string }): boolean {
  return input.platform === "linux" && input.uid === 0 && input.unitExists && !ROOT_COMMANDS.has(input.topCommand);
}

/**
 * Review m11: root commands of a Phi Bot server (and `setup`, before the unit exists) resolve
 * the instance under /var/lib/phibot before any upstream function reads PAPERCLIP_HOME.
 */
export function applyPhibotRootEnvironment(input: {
  platform: NodeJS.Platform;
  uid: number | null;
  unitExists: boolean;
  topCommand: string;
  env: NodeJS.ProcessEnv;
}): boolean {
  if (input.platform !== "linux" || input.uid !== 0 || !ROOT_COMMANDS.has(input.topCommand)) return false;
  if (!input.unitExists && input.topCommand !== "setup") return false;
  input.env.PAPERCLIP_HOME = PHIBOT_PAPERCLIP_HOME;
  input.env.PAPERCLIP_INSTANCE_ID = PHIBOT_INSTANCE_ID;
  return true;
}

/** Spec 6.8: `runuser -u phibot -- env HOME=... PAPERCLIP_HOME=... PAPERCLIP_INSTANCE_ID=default <NODE> <PHIBOT_JS> <args>`. */
export function buildPhibotCommand(paths: PhibotUnitPaths, args: string[]): CommandLine {
  return {
    command: "runuser",
    args: [
      "-u",
      PHIBOT_SYSTEM_USER,
      "--",
      "env",
      `HOME=${PHIBOT_HOME_DIR}`,
      `PAPERCLIP_HOME=${PHIBOT_PAPERCLIP_HOME}`,
      `PAPERCLIP_INSTANCE_ID=${PHIBOT_INSTANCE_ID}`,
      paths.nodePath,
      paths.phibotJsPath,
      ...args,
    ],
  };
}

/**
 * Spec 6.2: every command that `setup` runs as phibot gets `env -i` with HOME, PAPERCLIP_HOME,
 * PAPERCLIP_INSTANCE_ID and PATH, so neither CI nor PHI_SKIP_POSTINSTALL (set by the npx command)
 * reach phi's install scripts.
 */
export function buildCleanPhibotCommand(nodePath: string, args: string[], env: NodeJS.ProcessEnv): CommandLine {
  const kept = PASS_THROUGH_ENV.filter((key) => env[key]).map((key) => `${key}=${env[key]}`);
  return {
    command: "runuser",
    args: [
      "-u",
      PHIBOT_SYSTEM_USER,
      "--",
      "env",
      "-i",
      `HOME=${PHIBOT_HOME_DIR}`,
      `PAPERCLIP_HOME=${PHIBOT_PAPERCLIP_HOME}`,
      `PAPERCLIP_INSTANCE_ID=${PHIBOT_INSTANCE_ID}`,
      `PATH=${path.posix.dirname(nodePath)}:/usr/bin:/bin`,
      ...kept,
      nodePath,
      ...args,
    ],
  };
}

/** NODE and PHIBOT_JS of the installed service: what root commands relaunch. */
export function readUnitPaths(sys: PhibotSystem): PhibotUnitPaths | null {
  if (!sys.exists(PHIBOT_UNIT_PATH)) return null;
  return parsePhibotUnitExecStart(sys.readFile(PHIBOT_UNIT_PATH));
}

/** Runs a command line as phibot from its home directory (review m14: root's cwd is unreadable). */
export function execAsPhibot(sys: PhibotSystem, line: CommandLine, options: ExecOptions = {}): Promise<ExecResult> {
  return sys.exec(line.command, line.args, { cwd: PHIBOT_HOME_DIR, ...options });
}

/**
 * Called before every command action: on a Phi Bot server, a command that reads the instance and
 * is started by root runs again as phibot, then this process exits with the same code.
 */
export async function relaunchAsPhibotIfNeeded(input: {
  sys: PhibotSystem;
  topCommand: string;
  argv: string[];
  exit: (code: number) => never;
}): Promise<void> {
  const unitExists = input.sys.exists(PHIBOT_UNIT_PATH);
  applyPhibotRootEnvironment({ platform: input.sys.platform, uid: input.sys.uid, unitExists, topCommand: input.topCommand, env: input.sys.env });
  if (!shouldRelaunchAsPhibot({ platform: input.sys.platform, uid: input.sys.uid, unitExists, topCommand: input.topCommand })) return;
  const paths = readUnitPaths(input.sys) ?? {
    nodePath: input.sys.realpath(input.sys.execPath),
    phibotJsPath: input.sys.realpath(input.argv[1] ?? ""),
  };
  const result = await execAsPhibot(input.sys, buildPhibotCommand(paths, input.argv.slice(2)), { inherit: true });
  input.exit(result.code);
}
