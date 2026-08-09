import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const wrapperPaths = {
  formatChanged: resolve(repositoryRoot, "scripts/validate/format.sh"),
  formatFull: resolve(repositoryRoot, "scripts/validate/format-full.sh"),
  lintChanged: resolve(repositoryRoot, "scripts/validate/lint.sh"),
  lintFull: resolve(repositoryRoot, "scripts/validate/lint-full.sh"),
  preMergeFull: resolve(repositoryRoot, "scripts/pre-merge-validate-full.sh"),
};

let workdir: string;
let repo: string;
let binDir: string;
let logPath: string;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

function writeStub(name: string): void {
  const stub = join(binDir, name);
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "${name} $*" >> "$VALIDATION_WRAPPER_TEST_LOG"`,
      "exit 0",
    ].join("\n"),
    "utf8",
  );
  chmodSync(stub, 0o755);
}

function runWrapper(scriptPath: string): string[] {
  writeFileSync(logPath, "", "utf8");
  execFileSync("bash", [scriptPath], {
    cwd: repo,
    stdio: "pipe",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      TARGET_BRANCH: "main",
      VALIDATION_WRAPPER_TEST_LOG: logPath,
    },
  });
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean);
}

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "validation-scope-wrappers-"));
  repo = join(workdir, "repo");
  binDir = join(workdir, "bin");
  logPath = join(workdir, "invocations.log");
  mkdirSync(repo);
  mkdirSync(binDir);
  writeFileSync(logPath, "", "utf8");
  for (const tool of ["bun", "node", "npx"]) writeStub(tool);

  git("init", "--initial-branch=main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "base.ts"), "export const base = 1;\n", "utf8");
  git("add", ".");
  git("commit", "-m", "base");
  git("checkout", "-b", "feature");
  writeFileSync(
    join(repo, "changed.ts"),
    "export const changed = 1;\n",
    "utf8",
  );
  git("add", ".");
  git("commit", "-m", "change");
});

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

describe("scope-specific validation wrappers", () => {
  it("narrows changed formatting and linting to the branch diff", () => {
    expect(runWrapper(wrapperPaths.formatChanged)).toEqual([
      "npx prettier --write --ignore-unknown --no-color changed.ts",
    ]);
    expect(runWrapper(wrapperPaths.lintChanged)).toEqual([
      "npx eslint --fix --quiet --no-color --no-warn-ignored changed.ts",
    ]);
  });

  it("runs full formatting and linting without consulting the narrow diff", () => {
    expect(runWrapper(wrapperPaths.formatFull)).toEqual([
      "npx prettier --write --no-color .",
    ]);
    expect(runWrapper(wrapperPaths.lintFull)).toEqual([
      "npx eslint . --fix --quiet --no-color --no-warn-ignored",
    ]);
  });

  it("composes only full variants for a full pre-merge run", () => {
    const invocations = runWrapper(wrapperPaths.preMergeFull);
    expect(invocations).toEqual(
      expect.arrayContaining([
        "npx prettier --write --no-color .",
        "npx eslint . --fix --quiet --no-color --no-warn-ignored",
        "npx tsc --noEmit --pretty false",
        expect.stringMatching(
          /^node .*scripts\/validate\/vitest-launcher\.mjs full both$/,
        ),
      ]),
    );
  });

  it("keeps every added wrapper directly executable", () => {
    for (const scriptPath of [
      wrapperPaths.formatFull,
      wrapperPaths.lintFull,
      wrapperPaths.preMergeFull,
    ]) {
      expect(() => accessSync(scriptPath, constants.X_OK)).not.toThrow();
    }
  });
});
