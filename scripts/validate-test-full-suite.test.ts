// @vitest-inputs scripts/validate/** CommandCenter.json
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoValidationConfigSchema } from "@/lib/validation/schemas";

/**
 * The registered `test` profile has separate changed and full executables. The
 * full executable must select every unit test file regardless of merge base,
 * and must not stop at the launcher's default bail threshold, because its whole
 * purpose is a complete failure list.
 *
 * This runs the real script against a throwaway repository that *has* a merge
 * base and a small diff — the exact situation in which `test` would narrow —
 * with `node` stubbed, and asserts on the arguments the launcher actually saw.
 */

const scriptPath = resolve(
  process.cwd(),
  "scripts/validate/test-full-suite.sh",
);
const changedScriptPath = resolve(process.cwd(), "scripts/validate/test.sh");

interface Invocation {
  args: string[];
  bail: string;
  workers: string;
  heapMb: string;
  /** Vitest's own pool override, which must never reach the launcher. */
  maxForks: string;
  /** The paths handed to `related` mode, comma-joined; empty for other modes. */
  relatedPaths: string;
}

let invocations: Invocation[] = [];
let changedInvocations: Invocation[] = [];
let pathInvocations: Invocation[] = [];
let configInvocations: Invocation[] = [];
let architectureSetupInvocations: Invocation[] = [];
let jsdomSetupInvocations: Invocation[] = [];
let selectorStdin = "";
let workdir: string;
let exitCode: number | null = null;
let changedExitCode: number | null = null;
let output = "";
let changedOutput = "";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** Records the argv and fixed resource settings used by the launcher. */
function writeNodeStub(binDir: string): void {
  const stub = join(binDir, "node");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      'related=""',
      'if [ "$2" = related ] && [ -f "$4" ]; then related="$(tr \'\\n\' , < "$4")"; fi',
      `printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$*" "\${CC_TEST_BAIL:-<unset>}" "\${CC_TEST_WORKERS:-<unset>}" "\${CC_TEST_HEAP_MB:-<unset>}" "\${VITEST_MAX_FORKS:-<unset>}" "$related" >> "$FULL_SUITE_TEST_LOG"`,
      "exit 0",
    ].join("\n"),
    "utf8",
  );
  chmodSync(stub, 0o755);
}

/**
 * Stands in for the declared-input selector (`bun scripts/test-profiles.ts
 * --affected`): records the changed paths it was fed and selects nothing.
 */
function writeBunStub(binDir: string): void {
  const stub = join(binDir, "bun");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      'printf \'%s\\n\' "$*" >> "$FULL_SUITE_TEST_LOG.bun"',
      'cat >> "$FULL_SUITE_TEST_LOG.bun-stdin"',
      "exit 0",
    ].join("\n"),
    "utf8",
  );
  chmodSync(stub, 0o755);
}

function readInvocations(logPath: string): Invocation[] {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [
        args = "",
        bail = "",
        workers = "",
        heapMb = "",
        maxForks = "",
        relatedPaths = "",
      ] = line.split("\t");
      return {
        args: args.split(" ").filter(Boolean),
        bail,
        workers,
        heapMb,
        maxForks,
        relatedPaths,
      };
    });
}

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "full-suite-"));
  const repo = join(workdir, "repo");
  const binDir = join(workdir, "bin");
  const logPath = join(workdir, "invocations.tsv");
  mkdirSync(repo);
  mkdirSync(binDir);
  writeFileSync(logPath, "", "utf8");
  writeNodeStub(binDir);
  writeBunStub(binDir);

  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "base.ts"), "export const base = 1;\n", "utf8");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "checkout", "-b", "feature");
  // A merge base with a narrow diff: what `test` would scope down to, and what
  // this command must ignore.
  writeFileSync(
    join(repo, "changed.ts"),
    "export const changed = 1;\n",
    "utf8",
  );
  git(repo, "add", ".");
  git(repo, "commit", "-m", "change");

  try {
    output = execFileSync("bash", [scriptPath], {
      cwd: repo,
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        FULL_SUITE_TEST_LOG: logPath,
        TARGET_BRANCH: "main",
        // A hostile ambient value: Vitest would apply this over the pool size
        // the launcher computes, so the wrapper has to clear it.
        VITEST_MAX_FORKS: "8",
      },
    });
    exitCode = 0;
  } catch (err) {
    const failure = err as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    exitCode = failure.status ?? null;
    output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }

  invocations = readInvocations(logPath);

  writeFileSync(logPath, "", "utf8");
  try {
    changedOutput = execFileSync("bash", [changedScriptPath], {
      cwd: repo,
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        FULL_SUITE_TEST_LOG: logPath,
        TARGET_BRANCH: "main",
        // A hostile ambient value: Vitest would apply this over the pool size
        // the launcher computes, so the wrapper has to clear it.
        VITEST_MAX_FORKS: "8",
      },
    });
    changedExitCode = 0;
  } catch (err) {
    const failure = err as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    changedExitCode = failure.status ?? null;
    changedOutput = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }

  changedInvocations = readInvocations(logPath);
  selectorStdin = readFileSync(`${logPath}.bun-stdin`, "utf8");

  writeFileSync(logPath, "", "utf8");
  execFileSync("bash", [changedScriptPath, "src/example.test.ts"], {
    cwd: repo,
    encoding: "utf8",
    stdio: "pipe",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      FULL_SUITE_TEST_LOG: logPath,
      TARGET_BRANCH: "main",
    },
  });
  pathInvocations = readInvocations(logPath);

  const runChanged = (): Invocation[] => {
    writeFileSync(logPath, "", "utf8");
    execFileSync("bash", [changedScriptPath], {
      cwd: repo,
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        FULL_SUITE_TEST_LOG: logPath,
        TARGET_BRANCH: "main",
      },
    });
    return readInvocations(logPath);
  };

  writeFileSync(join(repo, "vitest.architecture.setup.ts"), "", "utf8");
  architectureSetupInvocations = runChanged();
  rmSync(join(repo, "vitest.architecture.setup.ts"));

  writeFileSync(join(repo, "vitest.jsdom.setup.ts"), "", "utf8");
  jsdomSetupInvocations = runChanged();
  rmSync(join(repo, "vitest.jsdom.setup.ts"));

  writeFileSync(join(repo, "vitest.config.ts"), "export default {};\n", "utf8");
  configInvocations = runChanged();
});

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

describe("test-full-suite validation command", () => {
  it("runs the launcher over the full suite despite a narrow diff", () => {
    expect(exitCode, `script failed:\n${output}`).toBe(0);
    expect(invocations).toHaveLength(1);

    const [invocation] = invocations;
    expect(invocation?.args.at(0)).toContain("vitest-launcher.mjs");
    expect(invocation?.args.slice(1)).toEqual(["full", "both"]);
  });

  it("selects architecture tests from the diff and declared inputs, then runtime profiles by import graph", () => {
    expect(changedExitCode, `script failed:\n${changedOutput}`).toBe(0);
    expect(changedInvocations).toHaveLength(2);
    expect(
      changedInvocations.map((invocation) => invocation.args.slice(1)),
    ).toEqual([
      ["related", "architecture", expect.any(String)],
      ["changed", "runtime", expect.any(String)],
    ]);
    // The related list is the branch diff plus whatever the selector chose; the
    // stub selects nothing, so the diff alone must reach Vitest.
    expect(changedInvocations[0]?.relatedPaths).toBe("changed.ts,");
    expect(selectorStdin).toBe("changed.ts\n");
  });

  it("runs architecture fully when its own setup or tracer changes", () => {
    expect(
      architectureSetupInvocations.map((invocation) =>
        invocation.args.slice(1),
      ),
    ).toEqual([
      ["full", "architecture"],
      ["changed", "runtime", expect.any(String)],
    ]);
  });

  it("keeps architecture on declared-input selection when only the jsdom setup changes", () => {
    expect(
      jsdomSetupInvocations.map((invocation) => invocation.args.slice(1)),
    ).toEqual([
      ["full", "jsdom"],
      ["related", "architecture", expect.any(String)],
      ["changed", "pure-node", expect.any(String)],
    ]);
  });

  it("keeps explicit path selection exact instead of widening architecture", () => {
    expect(pathInvocations).toHaveLength(1);
    expect(pathInvocations[0]?.args.slice(1)).toEqual([
      "paths",
      "both",
      "src/example.test.ts",
    ]);
  });

  it("runs every profile when the Vitest config changes", () => {
    expect(configInvocations).toHaveLength(1);
    expect(configInvocations[0]?.args.slice(1)).toEqual(["full", "both"]);
  });

  it("disables the launcher bail threshold so every failure is reported", () => {
    expect(invocations.at(0)?.bail).toBe("0");
  });

  it("keeps changed and full variants on one worker and heap profile", () => {
    expect(invocations[0]).toMatchObject({ workers: "8", heapMb: "1536" });
    expect(changedInvocations[0]).toMatchObject({
      workers: "8",
      heapMb: "1536",
    });
    expect(changedInvocations[1]).toMatchObject({
      workers: "8",
      heapMb: "1536",
    });
  });

  // The worker count above is a REQUEST the launcher clamps to what the machine
  // can hold. Vitest applies VITEST_MAX_FORKS over `poolOptions.forks` after
  // config resolution, so a value reaching the launcher — exported by the
  // wrapper or inherited from the caller — silently spends the whole ceiling on
  // a box budgeted for a fraction of it. That does not fail a test: the fork
  // fleet starves the main process until a worker's `onTaskUpdate` RPC times
  // out, killing a run in which everything passed.
  it("clears Vitest's own pool override so the machine budget stays authoritative", () => {
    expect(invocations.at(0)?.maxForks).toBe("<unset>");
    expect(
      changedInvocations.every(
        (invocation) => invocation.maxForks === "<unset>",
      ),
    ).toBe(true);
  });

  it("is registered in CommandCenter.json with an executable script", () => {
    const config: unknown = JSON.parse(
      readFileSync(resolve(process.cwd(), "CommandCenter.json"), "utf8"),
    );
    const validation = repoValidationConfigSchema.parse(
      (config as { validation: unknown }).validation,
    );

    const command = validation.commands.test;
    expect(command).toBeDefined();
    expect(command?.pathArgs).toBe("paths");

    const registeredScript = resolve(
      process.cwd(),
      command?.command.full ?? "",
    );
    expect(registeredScript).toBe(scriptPath);
    expect(() => accessSync(registeredScript, constants.X_OK)).not.toThrow();
  });
});
