// @vitest-inputs scripts/pre-merge-validate.sh scripts/validate/**
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Pre-merge validation must never read or write the operator's live Command
 * Center state. `next build` collects route config by evaluating route modules,
 * and `src/lib/state-store/index.ts` opens `command-center.db` at module scope,
 * so an un-isolated build opens the real database; `src/app/tickets` likewise
 * parses the real `config.json`.
 *
 * Both are shared across every branch and session on the machine, so live state
 * can be ahead of the branch under validation. That is not hypothetical: one
 * session applied schema migration 3 and published the fail-closed
 * compatibility barrier, and every other branch's build then died on
 * `SchemaVersionConflictError` — a gate failure caused entirely by a neighbour.
 *
 * This runs the real script against a throwaway repository with `bun` and `npx`
 * stubbed, and asserts on what the stubs observed.
 */

const scriptPath = resolve(process.cwd(), "scripts/pre-merge-validate.sh");

/** A value no correct run may pass through to a child process. */
const SENTINEL_CONFIG_DIR = "/nonexistent/live-config-dir-sentinel";

interface Invocation {
  command: string;
  configDir: string;
  configDirExists: boolean;
}

let invocations: Invocation[] = [];
let workdir: string;
let exitCode: number | null = null;
let output = "";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/**
 * A stub that records the environment each tool actually saw. Recording
 * `CC_CONFIG_DIR` and whether it exists at call time is what lets the
 * assertions below talk about behaviour rather than script text.
 */
function writeStub(binDir: string, name: string): void {
  const stub = join(binDir, name);
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      'dir="${CC_CONFIG_DIR:-<unset>}"',
      'if [ -d "$dir" ]; then exists=yes; else exists=no; fi',
      `printf '%s\\t%s\\t%s\\n' "${name} $*" "$dir" "$exists" >> "$PREMERGE_TEST_LOG"`,
      "exit 0",
    ].join("\n"),
    "utf8",
  );
  chmodSync(stub, 0o755);
}

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "premerge-hermetic-"));
  const repo = join(workdir, "repo");
  const binDir = join(workdir, "bin");
  const logPath = join(workdir, "invocations.tsv");
  mkdirSync(repo);
  mkdirSync(binDir);
  writeFileSync(logPath, "", "utf8");

  // Every binary a phase can reach for. `node` joined the list when the test
  // phase moved behind `scripts/validate/vitest-launcher.mjs`: unstubbed, it
  // runs a real vitest against this throwaway repo and fails the run.
  for (const tool of ["bun", "npx", "node"]) writeStub(binDir, tool);
  // The typecheck wrapper runs the native compiler from the checkout under
  // validation rather than from PATH, so the sandbox repo carries that stub.
  const nativeTscDir = join(repo, "node_modules", "typescript-native", "bin");
  mkdirSync(nativeTscDir, { recursive: true });
  writeStub(nativeTscDir, "tsc");

  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "base.ts"), "export const base = 1;\n", "utf8");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "checkout", "-b", "feature");
  // A real change, so the script does not take its "nothing to validate" exit.
  writeFileSync(
    join(repo, "changed.ts"),
    "export const changed = 1;\n",
    "utf8",
  );
  git(repo, "add", ".");
  git(repo, "commit", "-m", "change");

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    PREMERGE_TEST_LOG: logPath,
    // The script must isolate even when the caller already pointed
    // CC_CONFIG_DIR at live state — as the CC server does in production.
    CC_CONFIG_DIR: SENTINEL_CONFIG_DIR,
    TARGET_BRANCH: "main",
  };
  // This suite may itself be running under scripts/validate/test.sh, whose
  // common.sh exports CC_VALIDATION_SCRATCH_CONFIG_DIR so sibling phases share
  // one scratch dir instead of each making (and deleting) their own. That
  // marker — not CC_CONFIG_DIR — is what gates the isolation block, so
  // inheriting it would tell the script under test that an outer run had
  // already isolated this environment: it would skip its own setup and leave
  // CC_CONFIG_DIR on the sentinel above, and the test would then report a leak
  // it had manufactured. Production never reaches that state, because the one
  // writer of the marker sets CC_CONFIG_DIR to the same scratch dir in the same
  // block. The caller being simulated here is a FRESH one.
  delete childEnv["CC_VALIDATION_SCRATCH_CONFIG_DIR"];

  try {
    output = execFileSync("bash", [scriptPath], {
      cwd: repo,
      encoding: "utf8",
      stdio: "pipe",
      env: childEnv,
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

  invocations = readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [command = "", configDir = "", exists = ""] = line.split("\t");
      return { command, configDir, configDirExists: exists === "yes" };
    });
}, 30_000);

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

describe("pre-merge validation is hermetic", () => {
  it("runs the validation tools at all", () => {
    expect(exitCode, `script failed:\n${output}`).toBe(0);
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations.map((i) => i.command)).toEqual(
      expect.arrayContaining([expect.stringContaining("bun run build")]),
    );
  });

  it("never lets a tool see the caller's live config dir", () => {
    const leaked = invocations.filter(
      (i) => i.configDir === SENTINEL_CONFIG_DIR,
    );
    expect(
      leaked.map((i) => i.command),
      "these commands ran against live Command Center state",
    ).toEqual([]);
  });

  it("gives every tool a config dir that exists during the run", () => {
    const unusable = invocations.filter(
      (i) => i.configDir === "<unset>" || !i.configDirExists,
    );
    expect(
      unusable.map((i) => `${i.command} -> ${i.configDir}`),
      "these commands had no usable scratch config dir",
    ).toEqual([]);
  });

  it("uses one scratch dir for the whole run and removes it afterwards", () => {
    const dirs = [...new Set(invocations.map((i) => i.configDir))];
    expect(dirs).toHaveLength(1);

    const [scratch = ""] = dirs;
    expect(scratch).not.toBe(SENTINEL_CONFIG_DIR);
    expect(existsSync(scratch)).toBe(false);
  });
});
