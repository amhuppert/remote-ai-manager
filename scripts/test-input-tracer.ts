import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isProbeRead, type RecordedRead } from "./test-inputs";

export interface ReadTracer {
  /** Begins an empty recording; instruments `fs` and `child_process` once per process. */
  start(): void;
  /** Ends the recording and returns its reads sorted by path. */
  stop(): RecordedRead[];
}

export interface ReadTracerOptions {
  /** Reads under this directory are recorded, relative to it. */
  readonly root: string;
}

type ReadKind = RecordedRead["kind"];
type RecordedKind = ReadKind | "on-disk";

interface ActiveTracer {
  readonly root: string;
  readonly reads: Map<string, RecordedRead>;
}

interface TracerState {
  readonly active: Set<ActiveTracer>;
  instrumented: boolean;
}

/**
 * Dependencies, repository metadata, and Command Center's own session scratch
 * directory are never a test's inputs.
 */
const IGNORED_PREFIXES = ["node_modules", ".git", ".cc"] as const;

/**
 * Process-global so a re-evaluated module (Vitest clears its module cache
 * between files in a reused worker) shares the one set of patched functions
 * instead of wrapping them again.
 */
const STATE_KEY = Symbol.for("command-center.test-input-tracer");

function tracerState(): TracerState {
  const existing: unknown = Reflect.get(globalThis, STATE_KEY);
  if (
    typeof existing === "object" &&
    existing !== null &&
    "active" in existing &&
    existing.active instanceof Set &&
    "instrumented" in existing &&
    typeof existing.instrumented === "boolean"
  ) {
    return { active: existing.active, instrumented: existing.instrumented };
  }
  const created: TracerState = { active: new Set(), instrumented: false };
  Reflect.set(globalThis, STATE_KEY, created);
  return created;
}

const state = tracerState();
const originalStatSync = fs.statSync;

function toAbsolutePath(target: unknown, cwd: string): string | undefined {
  // Vitest's stack and module machinery probes `node:internal/...` specifiers
  // through `existsSync`; they are not filesystem paths.
  if (typeof target === "string") {
    return target.startsWith("node:") ? undefined : path.resolve(cwd, target);
  }
  if (Buffer.isBuffer(target)) return path.resolve(cwd, target.toString());
  if (target instanceof URL) {
    return target.protocol === "file:" ? fileURLToPath(target) : undefined;
  }
  return undefined;
}

function relativeToRoot(
  root: string,
  absolutePath: string,
): string | undefined {
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}

function isIgnored(relativePath: string): boolean {
  return IGNORED_PREFIXES.some(
    (prefix) =>
      relativePath === prefix || relativePath.startsWith(`${prefix}/`),
  );
}

function existsOnDisk(absolutePath: string): boolean {
  try {
    originalStatSync(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function kindOnDisk(absolutePath: string): ReadKind {
  try {
    return originalStatSync(absolutePath).isDirectory() ? "directory" : "file";
  } catch {
    return "file";
  }
}

const TEST_RUNNER_MODULE = /\/node_modules\/(?:vite-node|vitest|@vitest)\//;

/**
 * Vitest resolves every imported module with an `existsSync` probe and reads
 * its own snapshot files; both come from its runtime modules, never from the
 * test, and import-graph selection already covers the modules. Only the
 * wrapper's direct caller is inspected: every call made inside a test body
 * has runner frames deeper in the stack.
 */
function calledByTestRunner(wrapper: (...args: unknown[]) => unknown): boolean {
  const holder: { stack?: string } = {};
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 1;
  Error.captureStackTrace(holder, wrapper);
  Error.stackTraceLimit = limit;
  return TEST_RUNNER_MODULE.test(holder.stack ?? "");
}

function record(
  target: unknown,
  kind: RecordedKind,
  via: string,
  cwd = process.cwd(),
  recursive = false,
): void {
  if (state.active.size === 0) return;
  const absolutePath = toAbsolutePath(target, cwd);
  if (absolutePath === undefined) return;
  const resolvedKind = kind === "on-disk" ? kindOnDisk(absolutePath) : kind;
  for (const tracer of state.active) {
    const relativePath = relativeToRoot(tracer.root, absolutePath);
    if (relativePath === undefined || isIgnored(relativePath)) continue;
    const key = `${resolvedKind}:${relativePath}`;
    const existing = tracer.reads.get(key);
    // A content read outranks an earlier probe of the same path: the probe
    // could pass as part of a directory walk, the content read cannot. A
    // recursive listing outranks a shallow one for the same reason.
    if (
      existing === undefined ||
      (isProbeRead(existing.via) && !isProbeRead(via)) ||
      (recursive && existing.recursive !== true)
    ) {
      tracer.reads.set(key, {
        path: relativePath,
        kind: resolvedKind,
        via,
        ...(recursive ? { recursive } : {}),
      });
    }
  }
}

function isRecursiveListing(options: unknown): boolean {
  return (
    typeof options === "object" &&
    options !== null &&
    "recursive" in options &&
    options.recursive === true
  );
}

/** `open` with a write-only flag creates or truncates; it reads nothing. */
function opensForReading(flags: unknown): boolean {
  return (
    flags === undefined || (typeof flags === "string" && flags.startsWith("r"))
  );
}

const FS_READERS: ReadonlyArray<readonly [name: string, kind: RecordedKind]> = [
  ["readFileSync", "file"],
  ["openSync", "file"],
  ["createReadStream", "file"],
  ["readFile", "file"],
  ["open", "file"],
  ["readdirSync", "directory"],
  ["opendirSync", "directory"],
  ["readdir", "directory"],
  ["opendir", "directory"],
  ["statSync", "on-disk"],
  ["lstatSync", "on-disk"],
  ["existsSync", "on-disk"],
  ["accessSync", "on-disk"],
  ["stat", "on-disk"],
  ["lstat", "on-disk"],
  ["access", "on-disk"],
];

const FS_PROMISE_READERS: ReadonlyArray<
  readonly [name: string, kind: RecordedKind]
> = [
  ["readFile", "file"],
  ["open", "file"],
  ["readdir", "directory"],
  ["opendir", "directory"],
  ["stat", "on-disk"],
  ["lstat", "on-disk"],
  ["access", "on-disk"],
];

/**
 * The wrapper must keep the original's own properties: `util.promisify`
 * dispatches on a symbol-keyed custom implementation (`exec` and `execFile`
 * resolve to `{ stdout, stderr }` only through it), and `realpathSync.native`
 * is reached as a property of the function. The promisify hook is installed by
 * the spawn wrapper itself so the promisified path is traced too.
 */
function inheritOwnProperties(wrapped: object, original: object): void {
  const intrinsic = new Set([
    "length",
    "name",
    "prototype",
    "arguments",
    "caller",
  ]);
  for (const key of Reflect.ownKeys(original)) {
    if (typeof key === "string" && intrinsic.has(key)) continue;
    if (key === promisify.custom) continue;
    const descriptor = Object.getOwnPropertyDescriptor(original, key);
    if (descriptor) Object.defineProperty(wrapped, key, descriptor);
  }
}

function wrapReader(target: object, name: string, kind: RecordedKind): void {
  const original: unknown = Reflect.get(target, name);
  if (typeof original !== "function") return;
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    if (state.active.size > 0 && !calledByTestRunner(wrapped)) {
      const [target0, options] = args;
      const isOpen = name === "open" || name === "openSync";
      if (!isOpen || opensForReading(options)) {
        record(
          target0,
          kind,
          name,
          process.cwd(),
          kind === "directory" && isRecursiveListing(options),
        );
      }
    }
    return Reflect.apply(original, this, args);
  };
  inheritOwnProperties(wrapped, original);
  Reflect.set(target, name, wrapped);
}

/**
 * A child process reads whatever its command line names; the process itself is
 * opaque, so every argument that resolves to an existing repository path is
 * recorded and the test declares the rest of what the child reads.
 */
function recordSpawn(name: string, args: readonly unknown[]): void {
  if (state.active.size === 0) return;
  const [first, second, third] = args;
  if (typeof first !== "string") return;
  const shellCommand = name === "exec" || name === "execSync";
  const tokens = shellCommand
    ? first.split(/\s+/).filter(Boolean)
    : [first, ...(Array.isArray(second) ? second.filter(isString) : [])];
  const options: unknown =
    shellCommand || !Array.isArray(second) ? second : third;
  const cwd = spawnCwd(options);
  const command = path.basename(tokens[0] ?? first);
  for (const token of tokens) {
    if (token.startsWith("-")) continue;
    const absolutePath = path.resolve(cwd, token);
    if (existsOnDisk(absolutePath)) {
      record(absolutePath, "on-disk", `spawn:${command}`, cwd);
    }
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function spawnCwd(options: unknown): string {
  if (typeof options === "object" && options !== null && "cwd" in options) {
    const resolved = toAbsolutePath(options.cwd, process.cwd());
    if (resolved !== undefined) return resolved;
  }
  return process.cwd();
}

const SPAWNERS = [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
] as const;

function wrapSpawner(name: (typeof SPAWNERS)[number]): void {
  const original: unknown = Reflect.get(childProcess, name);
  if (typeof original !== "function") return;
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    recordSpawn(name, args);
    return Reflect.apply(original, this, args);
  };
  inheritOwnProperties(wrapped, original);
  // `util.promisify(execFile)` calls the custom implementation, not the
  // function itself, so the promisified path records through its own hook.
  const customPromisify: unknown = Reflect.get(original, promisify.custom);
  if (typeof customPromisify === "function") {
    Object.defineProperty(wrapped, promisify.custom, {
      configurable: true,
      enumerable: false,
      value: (...args: unknown[]): unknown => {
        recordSpawn(name, args);
        return Reflect.apply(customPromisify, original, args);
      },
    });
  }
  Reflect.set(childProcess, name, wrapped);
}

function instrument(): void {
  if (state.instrumented) return;
  state.instrumented = true;
  Reflect.set(globalThis, STATE_KEY, state);
  for (const [name, kind] of FS_READERS) wrapReader(fs, name, kind);
  for (const [name, kind] of FS_PROMISE_READERS) {
    wrapReader(fs.promises, name, kind);
  }
  for (const name of SPAWNERS) wrapSpawner(name);
  // Named ESM imports of builtins are live bindings only after this call.
  syncBuiltinESMExports();
}

export function createReadTracer({ root }: ReadTracerOptions): ReadTracer {
  const tracer: ActiveTracer = { root: path.resolve(root), reads: new Map() };
  return {
    start() {
      instrument();
      tracer.reads.clear();
      state.active.add(tracer);
    },
    stop() {
      state.active.delete(tracer);
      return [...tracer.reads.values()].sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      );
    },
  };
}
