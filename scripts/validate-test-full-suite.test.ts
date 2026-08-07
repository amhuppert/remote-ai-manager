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
 * The registered `test` command scopes itself to the diff against the target
 * branch, so a green run proves the changed files pass — not that the branch
 * passes. `test-full-suite` is the unscoped counterpart: it must select every
 * unit test file regardless of merge base, and must not stop at the launcher's
 * default bail threshold, because its whole purpose is a complete failure list.
 *
 * This runs the real script against a throwaway repository that *has* a merge
 * base and a small diff — the exact situation in which `test` would narrow —
 * with `node` stubbed, and asserts on the arguments the launcher actually saw.
 */

const scriptPath = resolve(
  process.cwd(),
  "scripts/validate/test-full-suite.sh",
);

interface Invocation {
  args: string[];
  bail: string;
}

let invocations: Invocation[] = [];
let workdir: string;
let exitCode: number | null = null;
let output = "";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** Records the argv and bail setting the launcher was invoked with. */
function writeNodeStub(binDir: string): void {
  const stub = join(binDir, "node");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\t%s\\n' "$*" "\${CC_TEST_BAIL:-<unset>}" >> "$FULL_SUITE_TEST_LOG"`,
      "exit 0",
    ].join("\n"),
    "utf8",
  );
  chmodSync(stub, 0o755);
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

  invocations = readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [args = "", bail = ""] = line.split("\t");
      return { args: args.split(" ").filter(Boolean), bail };
    });
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

  it("disables the launcher bail threshold so every failure is reported", () => {
    expect(invocations.at(0)?.bail).toBe("0");
  });

  it("is registered in CommandCenter.json with an executable script", () => {
    const config: unknown = JSON.parse(
      readFileSync(resolve(process.cwd(), "CommandCenter.json"), "utf8"),
    );
    const validation = repoValidationConfigSchema.parse(
      (config as { validation: unknown }).validation,
    );

    const command = validation.commands["test-full-suite"];
    expect(command).toBeDefined();
    // Forwarded paths would narrow the run, contradicting the command's name.
    expect(command?.scopeArgs).toBe("forbid");

    const registeredScript = resolve(process.cwd(), command?.command ?? "");
    expect(registeredScript).toBe(scriptPath);
    expect(() => accessSync(registeredScript, constants.X_OK)).not.toThrow();
  });
});
