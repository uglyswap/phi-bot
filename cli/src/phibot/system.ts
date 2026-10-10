import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import * as p from "@clack/prompts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Complete environment of the child process; defaults to the current environment. */
  env?: NodeJS.ProcessEnv;
  /** Text written to stdin before it is closed. */
  input?: string;
  /** Streams stdin, stdout and stderr to the terminal instead of capturing them. */
  inherit?: boolean;
  /** Working directory of the child process. */
  cwd?: string;
  timeoutMs?: number;
}

/** Every interaction of the Phi Bot commands with the host goes through this interface. */
export interface PhibotSystem {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly uid: number | null;
  readonly nodeVersion: string;
  readonly execPath: string;
  readonly env: NodeJS.ProcessEnv;
  /** Never throws on a non-zero exit code; a missing command returns code 127. */
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  exists(target: string): boolean;
  readFile(target: string): string;
  writeFile(target: string, contents: string | Uint8Array, mode: number): void;
  makeDir(target: string, mode: number): void;
  remove(target: string): void;
  listDir(target: string): string[];
  realpath(target: string): string;
  /** Permission bits (for example 0o600), or null when the path does not exist. */
  fileMode(target: string): number | null;
  modifiedAtMs(target: string): number | null;
  totalMemoryBytes(): number;
  freeDiskBytes(target: string): number;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

export interface PhibotLogger {
  step(message: string): void;
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PhibotPrompter {
  readonly interactive: boolean;
  text(input: { message: string; initialValue?: string; validate?: (value: string) => string | undefined }): Promise<string>;
  password(input: { message: string; validate?: (value: string) => string | undefined }): Promise<string>;
  confirm(input: { message: string; initialValue?: boolean }): Promise<boolean>;
}

/** Failure of a named step, with the correction the operator should apply. */
export class PhibotStepError extends Error {
  constructor(
    readonly step: string,
    readonly problem: string,
    readonly fix: string,
  ) {
    super(`Étape « ${step} » : ${problem}\nCorrection : ${fix}`);
    this.name = "PhibotStepError";
  }
}

export function tailLines(text: string, count: number): string {
  return text.trimEnd().split(/\r?\n/).slice(-count).join("\n");
}

/** Runs a command and throws a PhibotStepError (with the end of its output) when it fails. */
export async function execOrThrow(
  sys: PhibotSystem,
  command: string,
  args: string[],
  failure: { step: string; fix: string },
  options?: ExecOptions,
): Promise<ExecResult> {
  const result = await sys.exec(command, args, options);
  if (result.code !== 0) {
    const output = tailLines([result.stdout, result.stderr].filter((text) => text.trim()).join("\n"), 20);
    throw new PhibotStepError(
      failure.step,
      `la commande « ${[command, ...args].join(" ")} » a échoué (code ${result.code}).${output ? `\n${output}` : ""}`,
      failure.fix,
    );
  }
  return result;
}

function runProcess(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const stdin = options.input !== undefined ? "pipe" : options.inherit ? "inherit" : "ignore";
    const output = options.inherit ? "inherit" : "pipe";
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: [stdin, output, output],
      windowsHide: true,
    });
    const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : null;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      finish({ code: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      finish({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

export function createNodeSystem(): PhibotSystem {
  return {
    platform: process.platform,
    arch: process.arch,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    nodeVersion: process.versions.node,
    execPath: process.execPath,
    env: process.env,
    exec: runProcess,
    exists: (target) => fs.existsSync(target),
    readFile: (target) => fs.readFileSync(target, "utf8"),
    writeFile: (target, contents, mode) => {
      fs.writeFileSync(target, contents, { mode });
      fs.chmodSync(target, mode);
    },
    makeDir: (target, mode) => {
      fs.mkdirSync(target, { recursive: true, mode });
    },
    remove: (target) => fs.rmSync(target, { recursive: true, force: true }),
    listDir: (target) => (fs.existsSync(target) ? fs.readdirSync(target) : []),
    realpath: (target) => fs.realpathSync(target),
    fileMode: (target) => (fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : null),
    modifiedAtMs: (target) => (fs.existsSync(target) ? fs.statSync(target).mtimeMs : null),
    totalMemoryBytes: () => os.totalmem(),
    freeDiskBytes: (target) => {
      const stats = fs.statfsSync(target);
      return stats.bavail * stats.bsize;
    },
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
  };
}

export function createClackLogger(): PhibotLogger {
  return {
    step: (message) => p.log.step(message),
    info: (message) => p.log.info(message),
    success: (message) => p.log.success(message),
    warn: (message) => p.log.warn(message),
    error: (message) => p.log.error(message),
  };
}

function unlessCancelled<T>(value: T | symbol): T {
  if (p.isCancel(value)) throw new Error("Opération annulée.");
  return value as T;
}

export function createClackPrompter(): PhibotPrompter {
  return {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    text: async (input) =>
      unlessCancelled(
        await p.text({
          message: input.message,
          initialValue: input.initialValue,
          validate: input.validate ? (value) => input.validate?.(value ?? "") : undefined,
        }),
      ),
    password: async (input) =>
      unlessCancelled(
        await p.password({
          message: input.message,
          validate: input.validate ? (value) => input.validate?.(value ?? "") : undefined,
        }),
      ),
    confirm: async (input) =>
      unlessCancelled(await p.confirm({ message: input.message, initialValue: input.initialValue ?? false })),
  };
}
