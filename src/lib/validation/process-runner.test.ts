import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  ensureValidationSupervisorScript,
  killProcessGroup,
  ProcessGroupUndeadError,
  spawnValidation,
  SUPERVISOR_START_ABORTED_EXIT_CODE,
  validationNonceMarker,
  type SpawnValidationParams,
} from "./process-runner";

let projectDir: string;
let worktreeDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(os.tmpdir(), "cc-validation-project-"));
  worktreeDir = mkdtempSync(path.join(os.tmpdir(), "cc-validation-worktree-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(worktreeDir, { recursive: true, force: true });
});

function writeScript(relativePath: string, body: string): string {
  const scriptPath = path.join(projectDir, relativePath);
  mkdirSync(path.dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`);
  chmodSync(scriptPath, 0o755);
  return relativePath;
}

function params(
  overrides: Partial<SpawnValidationParams> = {},
): SpawnValidationParams {
  return {
    runId: "run-test",
    nonce: "nonce-test",
    commandName: "check",
    command: "scripts/check.sh",
    cost: 2,
    projectPath: projectDir,
    worktreePath: worktreeDir,
    sessionName: "session-a",
    branchName: "csm/session-a",
    targetBranch: "main",
    scopeArgs: "forbid",
    scopePaths: [],
    timeoutMs: 10_000,
    killGraceMs: 250,
    pollMs: 25,
    ...overrides,
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(
  check: () => boolean,
  timeoutMs = 3000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

describe("spawnValidation", () => {
  it("captures combined output and the exit code", async () => {
    writeScript(
      "scripts/check.sh",
      'echo "to stdout"\necho "to stderr" >&2\nexit 3',
    );

    const result = await spawnValidation(params());
    expect(result.kind).toBe("spawned");
    if (result.kind !== "spawned") return;
    result.handle.confirmStart();

    const outcome = await result.handle.wait();
    expect(outcome.kind).toBe("exited");
    if (outcome.kind !== "exited") return;
    expect(outcome.exitCode).toBe(3);
    expect(outcome.output).toContain("to stdout");
    expect(outcome.output).toContain("to stderr");
  });

  it("settles a clean exit promptly instead of burning the straggler-reaping budget", async () => {
    writeScript("scripts/check.sh", "echo done");

    const startedAt = Date.now();
    const result = await spawnValidation(params({ timeoutMs: 30_000 }));
    expect(result.kind).toBe("spawned");
    if (result.kind !== "spawned") return;
    result.handle.confirmStart();

    const outcome = await result.handle.wait();
    const elapsedMs = Date.now() - startedAt;

    expect(outcome.kind).toBe("exited");
    // A run that leaves nothing behind must not pay the supervisor's straggler
    // retry budget (50 x 100ms). A scan that counts the processes it forks to
    // perform the scan never observes an empty group, which spends that budget
    // on every run and pushes short-timeout commands into a false timed_out.
    expect(elapsedMs).toBeLessThan(3_000);
  }, 40_000);

  it("provides the documented env contract, resolves the script from the project root, and runs in the worktree cwd", async () => {
    writeScript(
      "scripts/check.sh",
      [
        'echo "cwd=$(pwd)"',
        'echo "PROJECT_ROOT=$PROJECT_ROOT"',
        'echo "CLAUDE_PROJECT_DIR=$CLAUDE_PROJECT_DIR"',
        'echo "WORKTREE_PATH=$WORKTREE_PATH"',
        'echo "SESSION_NAME=$SESSION_NAME"',
        'echo "BRANCH_NAME=$BRANCH_NAME"',
        'echo "TARGET_BRANCH=$TARGET_BRANCH"',
        'echo "CONTEXT_ID=$CONTEXT_ID"',
        'echo "CC_VALIDATION_RUN_ID=$CC_VALIDATION_RUN_ID"',
        'echo "CC_VALIDATION_COMMAND=$CC_VALIDATION_COMMAND"',
        'echo "CC_VALIDATION_COST=$CC_VALIDATION_COST"',
        'echo "CC_VALIDATION_NONCE=$CC_VALIDATION_NONCE"',
      ].join("\n"),
    );

    const result = await spawnValidation(params({ contextId: "ctx-api" }));
    expect(result.kind).toBe("spawned");
    if (result.kind !== "spawned") return;
    result.handle.confirmStart();
    const outcome = await result.handle.wait();
    expect(outcome.kind).toBe("exited");
    if (outcome.kind !== "exited") return;

    const lines = Object.fromEntries(
      outcome.output
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    );
    // Resolve through realpath: macOS tmpdir is a /var → /private/var symlink.
    const { realpathSync } = await import("node:fs");
    expect(realpathSync(lines.cwd ?? "")).toBe(realpathSync(worktreeDir));
    expect(lines.PROJECT_ROOT).toBe(worktreeDir);
    expect(lines.CLAUDE_PROJECT_DIR).toBe(projectDir);
    expect(lines.WORKTREE_PATH).toBe(worktreeDir);
    expect(lines.SESSION_NAME).toBe("session-a");
    expect(lines.BRANCH_NAME).toBe("csm/session-a");
    expect(lines.TARGET_BRANCH).toBe("main");
    expect(lines.CONTEXT_ID).toBe("ctx-api");
    expect(lines.CC_VALIDATION_RUN_ID).toBe("run-test");
    expect(lines.CC_VALIDATION_COMMAND).toBe("check");
    expect(lines.CC_VALIDATION_COST).toBe("2");
    expect(lines.CC_VALIDATION_NONCE).toBe("nonce-test");
  });

  it("kills the whole process group on timeout, reaping spawned descendants", async () => {
    writeScript(
      "scripts/check.sh",
      ["sleep 300 &", 'echo "$!" > child.pid', "sleep 300"].join("\n"),
    );

    // Generous timeout: under parallel suite load the shell can need
    // hundreds of ms to reach its first statement, and SIGTERM arriving
    // before child.pid is written would break the assertion below.
    const result = await spawnValidation(params({ timeoutMs: 2500 }));
    expect(result.kind).toBe("spawned");
    if (result.kind !== "spawned") return;
    result.handle.confirmStart();

    const outcome = await result.handle.wait();
    expect(outcome.kind).toBe("timed_out");

    // wait() resolves only after the group is confirmed dead, so the
    // descendant must already be gone.
    const childPid = Number(
      readFileSync(path.join(worktreeDir, "child.pid"), "utf-8").trim(),
    );
    expect(Number.isInteger(childPid)).toBe(true);
    expect(pidAlive(childPid)).toBe(false);
  }, 15_000);

  it("kills the whole process group on cancel", async () => {
    writeScript(
      "scripts/check.sh",
      ["sleep 300 &", 'echo "$!" > child.pid', "sleep 300"].join("\n"),
    );

    const result = await spawnValidation(params());
    expect(result.kind).toBe("spawned");
    if (result.kind !== "spawned") return;
    result.handle.confirmStart();

    // The redirection creates child.pid before the echo writes it, so a poll
    // that only required the file to be readable could return an empty string.
    // That parses to 0, and signal 0 to pid 0 targets the test's OWN process
    // group — the liveness check below would report "alive" for a child that
    // was never recorded. Wait for the pid itself.
    await eventually(() => {
      try {
        return (
          Number(
            readFileSync(path.join(worktreeDir, "child.pid"), "utf-8").trim(),
          ) > 0
        );
      } catch {
        return false;
      }
    });

    const outcome = await result.handle.cancel();
    expect(outcome.kind).toBe("cancelled");

    const childPid = Number(
      readFileSync(path.join(worktreeDir, "child.pid"), "utf-8").trim(),
    );
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
    expect(pidAlive(childPid)).toBe(false);

    // wait() observes the same settled outcome.
    await expect(result.handle.wait()).resolves.toEqual(outcome);
  }, 15_000);

  it("confirms group death before completing a normal exit, terminating stragglers", async () => {
    writeScript(
      "scripts/check.sh",
      ["sleep 300 &", 'echo "$!" > child.pid', "exit 0"].join("\n"),
    );

    const result = await spawnValidation(params());
    expect(result.kind).toBe("spawned");
    if (result.kind !== "spawned") return;
    result.handle.confirmStart();

    const outcome = await result.handle.wait();
    expect(outcome.kind).toBe("exited");
    if (outcome.kind !== "exited") return;
    expect(outcome.exitCode).toBe(0);

    const childPid = Number(
      readFileSync(path.join(worktreeDir, "child.pid"), "utf-8").trim(),
    );
    expect(pidAlive(childPid)).toBe(false);
  }, 15_000);

  it("rejects forwarded tokens when the command forbids scope args, spawning nothing", async () => {
    writeScript("scripts/check.sh", "echo ran > marker.txt");

    const result = await spawnValidation(
      params({ scopeArgs: "forbid", scopePaths: ["src/a.ts"] }),
    );

    expect(result.kind).toBe("scope_args_forbidden");
    expect(() =>
      readFileSync(path.join(worktreeDir, "marker.txt"), "utf-8"),
    ).toThrow();
  });

  it("rejects scope tokens that violate the foundation rules before spawn", async () => {
    writeScript("scripts/check.sh", "echo ran > marker.txt");

    const escape = await spawnValidation(
      params({ scopeArgs: "paths", scopePaths: ["../outside.ts"] }),
    );
    expect(escape).toMatchObject({
      kind: "scope_args_rejected",
      violation: "escapes_worktree",
      token: "../outside.ts",
    });

    const option = await spawnValidation(
      params({ scopeArgs: "paths", scopePaths: ["--pool=forks"] }),
    );
    expect(option).toMatchObject({
      kind: "scope_args_rejected",
      violation: "option_token",
    });
    expect(() =>
      readFileSync(path.join(worktreeDir, "marker.txt"), "utf-8"),
    ).toThrow();
  });

  it("forwards validated scope paths as arguments", async () => {
    writeScript("scripts/check.sh", 'echo "args=$@"');

    const result = await spawnValidation(
      params({
        scopeArgs: "paths",
        scopePaths: ["src/a.test.ts", "src/b.test.ts"],
      }),
    );
    expect(result.kind).toBe("spawned");
    if (result.kind !== "spawned") return;
    result.handle.confirmStart();
    const outcome = await result.handle.wait();
    expect(outcome.kind).toBe("exited");
    if (outcome.kind !== "exited") return;
    expect(outcome.output).toContain("args=src/a.test.ts src/b.test.ts");
  });

  it("reports a missing script without spawning", async () => {
    const result = await spawnValidation(
      params({ command: "scripts/absent.sh" }),
    );
    expect(result).toMatchObject({ kind: "script_not_found" });
  });

  it("surfaces a spawn error as an outcome", async () => {
    const rel = writeScript("scripts/check.sh", "echo unreachable");
    chmodSync(path.join(projectDir, rel), 0o644); // not executable → EACCES

    const result = await spawnValidation(params());
    expect(result.kind).toBe("spawn_error");
  });

  it("bounds captured output and marks truncation", async () => {
    writeScript(
      "scripts/check.sh",
      'i=0\nwhile [ $i -lt 200 ]; do echo "0123456789012345678901234567890123456789"; i=$((i+1)); done',
    );

    const result = await spawnValidation(params({ maxOutputBytes: 512 }));
    expect(result.kind).toBe("spawned");
    if (result.kind !== "spawned") return;
    result.handle.confirmStart();
    const outcome = await result.handle.wait();
    expect(outcome.kind).toBe("exited");
    if (outcome.kind !== "exited") return;
    expect(outcome.output.length).toBeLessThan(1024);
    expect(outcome.output).toContain("[output truncated]");
  });
});

describe("start barrier", () => {
  it("holds the workload unstarted until confirmStart releases it", async () => {
    writeScript("scripts/check.sh", "touch started.marker");
    const marker = path.join(worktreeDir, "started.marker");

    const result = await spawnValidation(params());
    expect(result.kind).toBe("spawned");
    if (result.kind !== "spawned") return;

    // The group exists but the workload must not have run yet.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(marker)).toBe(false);

    result.handle.confirmStart();
    const outcome = await result.handle.wait();
    expect(outcome.kind).toBe("exited");
    if (outcome.kind !== "exited") return;
    expect(outcome.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
  }, 15_000);

  it("cancelling before confirmation kills the group without ever running the workload", async () => {
    writeScript("scripts/check.sh", "touch started.marker");
    const marker = path.join(worktreeDir, "started.marker");

    const result = await spawnValidation(params());
    expect(result.kind).toBe("spawned");
    if (result.kind !== "spawned") return;

    const outcome = await result.handle.cancel();
    expect(outcome.kind).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(marker)).toBe(false);
  }, 15_000);

  it("a closed pipe with no release (server death) aborts the supervisor before the workload", async () => {
    writeScript("scripts/check.sh", "touch started.marker");
    const marker = path.join(worktreeDir, "started.marker");

    // Drive the production supervisor artifact directly: closing stdin
    // without writing the release line is exactly what a crashed parent's
    // pipe produces.
    const supervisor = ensureValidationSupervisorScript();
    const child = spawn(
      supervisor,
      [validationNonceMarker("n"), path.join(projectDir, "scripts/check.sh")],
      { cwd: worktreeDir, stdio: ["pipe", "ignore", "ignore"] },
    );
    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.stdin?.end();
    });

    expect(exitCode).toBe(SUPERVISOR_START_ABORTED_EXIT_CODE);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(marker)).toBe(false);
  }, 15_000);
});

describe("killProcessGroup confirmation contract", () => {
  // A pgid no real process group holds during the test; the injected probe
  // decides liveness, and signalGroup's real kill() gets ESRCH (swallowed).
  const UNUSED_PGID = 2 ** 24;

  it("throws rather than resolving while any group member survives SIGKILL", async () => {
    await expect(
      killProcessGroup(UNUSED_PGID, {
        killGraceMs: 20,
        pollMs: 5,
        maxGroupDeathWaitMs: 60,
        probe: () => true,
      }),
    ).rejects.toBeInstanceOf(ProcessGroupUndeadError);
  });

  it("resolves only once the probe confirms the group is dead", async () => {
    let probes = 0;
    await expect(
      killProcessGroup(UNUSED_PGID, {
        killGraceMs: 20,
        pollMs: 5,
        probe: () => {
          probes += 1;
          return probes < 4;
        },
      }),
    ).resolves.toBeUndefined();
    expect(probes).toBeGreaterThanOrEqual(4);
  });
});
