import type {
  ExecOptions,
  ExecResult,
  PhibotLogger,
  PhibotPrompter,
  PhibotSystem,
} from "../../phibot/system.js";

export interface RecordedExec {
  line: string;
  command: string;
  args: string[];
  options?: ExecOptions;
}

type ExecResponder = ExecResult | ((call: RecordedExec) => ExecResult);

interface FakeFile {
  contents: string | Uint8Array;
  mode: number;
  mtimeMs: number;
}

/** In-memory PhibotSystem: a Linux root by default, every command succeeds unless a rule says otherwise. */
export class FakeSystem implements PhibotSystem {
  platform: NodeJS.Platform = "linux";
  arch = "x64";
  uid: number | null = 0;
  nodeVersion = "24.11.0";
  execPath = "/usr/bin/node";
  env: NodeJS.ProcessEnv = {};
  memoryBytes = 8 * 1024 ** 3;
  freeDisk = 50 * 1024 ** 3;
  clock = new Date("2026-10-08T12:00:00.000Z");
  readonly files = new Map<string, FakeFile>();
  readonly dirs = new Set<string>();
  readonly calls: RecordedExec[] = [];
  readonly sleeps: number[] = [];
  private readonly rules: Array<{ prefix: string; respond: ExecResponder }> = [];
  fetchHandler: (url: string, init?: RequestInit) => Promise<Response> = async (url) => {
    throw new Error(`unexpected fetch ${url}`);
  };

  /** Later rules win over earlier ones for the same command line prefix. */
  onExec(prefix: string, respond: ExecResponder): this {
    this.rules.unshift({ prefix, respond });
    return this;
  }

  addFile(target: string, contents: string | Uint8Array, mode = 0o644, mtimeMs = this.clock.getTime()): this {
    this.files.set(target, { contents, mode, mtimeMs });
    return this;
  }

  addDir(target: string): this {
    this.dirs.add(target);
    return this;
  }

  lines(): string[] {
    return this.calls.map((call) => call.line);
  }

  async exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
    const call: RecordedExec = { line: [command, ...args].join(" "), command, args, options };
    this.calls.push(call);
    const rule = this.rules.find((candidate) => call.line.startsWith(candidate.prefix));
    if (!rule) return { code: 0, stdout: "", stderr: "" };
    return typeof rule.respond === "function" ? rule.respond(call) : rule.respond;
  }

  /** A folder also exists when a file or folder was added below it. */
  exists(target: string): boolean {
    if (this.files.has(target) || this.dirs.has(target)) return true;
    const prefix = `${target}/`;
    return [...this.files.keys(), ...this.dirs].some((key) => key.startsWith(prefix));
  }

  readFile(target: string): string {
    const file = this.files.get(target);
    if (!file) throw new Error(`ENOENT: ${target}`);
    return typeof file.contents === "string" ? file.contents : Buffer.from(file.contents).toString("utf8");
  }

  writeFile(target: string, contents: string | Uint8Array, mode: number): void {
    this.files.set(target, { contents, mode, mtimeMs: this.clock.getTime() });
  }

  makeDir(target: string): void {
    this.dirs.add(target);
  }

  remove(target: string): void {
    for (const key of [...this.files.keys()]) if (key === target || key.startsWith(`${target}/`)) this.files.delete(key);
    for (const key of [...this.dirs]) if (key === target || key.startsWith(`${target}/`)) this.dirs.delete(key);
  }

  listDir(target: string): string[] {
    const prefix = `${target}/`;
    const names = new Set<string>();
    for (const key of [...this.files.keys(), ...this.dirs]) {
      if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]);
    }
    return [...names].sort();
  }

  realpath(target: string): string {
    return target;
  }

  fileMode(target: string): number | null {
    if (this.files.has(target)) return this.files.get(target)?.mode ?? null;
    return this.dirs.has(target) ? 0o700 : null;
  }

  modifiedAtMs(target: string): number | null {
    return this.files.get(target)?.mtimeMs ?? null;
  }

  totalMemoryBytes(): number {
    return this.memoryBytes;
  }

  freeDiskBytes(): number {
    return this.freeDisk;
  }

  fetch(url: string, init?: RequestInit): Promise<Response> {
    return this.fetchHandler(url, init);
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.clock = new Date(this.clock.getTime() + ms);
  }

  now(): Date {
    return new Date(this.clock.getTime());
  }
}

export class MemoryLogger implements PhibotLogger {
  readonly entries: Array<{ level: string; message: string }> = [];
  step(message: string): void {
    this.entries.push({ level: "step", message });
  }
  info(message: string): void {
    this.entries.push({ level: "info", message });
  }
  success(message: string): void {
    this.entries.push({ level: "success", message });
  }
  warn(message: string): void {
    this.entries.push({ level: "warn", message });
  }
  error(message: string): void {
    this.entries.push({ level: "error", message });
  }
  text(): string {
    return this.entries.map((entry) => `${entry.level}: ${entry.message}`).join("\n");
  }
}

/** Answers prompts from a queue, in order; fails the test when a prompt is not expected. */
export class ScriptedPrompter implements PhibotPrompter {
  readonly asked: string[] = [];
  constructor(
    private readonly answers: Array<string | boolean>,
    readonly interactive = true,
  ) {}
  private next(message: string): string | boolean {
    this.asked.push(message);
    if (this.answers.length === 0) throw new Error(`unexpected prompt: ${message}`);
    return this.answers.shift() as string | boolean;
  }
  async text(input: { message: string; validate?: (value: string) => string | undefined }): Promise<string> {
    const value = String(this.next(input.message));
    const problem = input.validate?.(value);
    if (problem) throw new Error(`invalid answer for "${input.message}": ${problem}`);
    return value;
  }
  async password(input: { message: string; validate?: (value: string) => string | undefined }): Promise<string> {
    return this.text(input);
  }
  async confirm(input: { message: string }): Promise<boolean> {
    return Boolean(this.next(input.message));
  }
}
