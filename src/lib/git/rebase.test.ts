import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitClient } from "./client";
import { createRebaseOperations } from "./rebase";

const gitMock = vi.fn();
const testClient: GitClient = { git: gitMock };
const ops = createRebaseOperations(testClient);

/** Build an exec-style rejection carrying git's stderr/stdout, as the real
 *  client surfaces on non-zero exit. The exec wrapper echoes stderr into the
 *  message, so the fake does too. */
function gitError(message: string, stderr = "", stdout = ""): Error {
  const err = new Error(stderr ? `${message}\n${stderr}` : message) as Error & {
    stderr?: string;
    stdout?: string;
  };
  err.stderr = stderr;
  err.stdout = stdout;
  return err;
}

function callArgs(index: number): string[] {
  return gitMock.mock.calls[index]?.[0] as string[];
}

beforeEach(() => {
  gitMock.mockReset();
});

describe("createRebaseOperations — startRebase", () => {
  it("runs rebase with the editor disabled and reports completed on success", async () => {
    gitMock.mockResolvedValue({ stdout: "", stderr: "" });

    const result = await ops.startRebase("/wt", "abc123");

    expect(result).toEqual({ status: "completed" });
    expect(callArgs(0)).toEqual(["-c", "core.editor=true", "rebase", "abc123"]);
    expect(gitMock.mock.calls[0]?.[1]).toBe("/wt");
  });

  it("classifies a CONFLICT exit as conflicts and lists the unmerged files", async () => {
    gitMock
      .mockRejectedValueOnce(
        gitError("rebase failed", "CONFLICT (content): Merge conflict in a.ts"),
      )
      .mockResolvedValueOnce({ stdout: "a.ts\nb.ts\n", stderr: "" });

    const result = await ops.startRebase("/wt", "main");

    expect(result).toEqual({
      status: "conflicts",
      conflictFiles: ["a.ts", "b.ts"],
    });
    // second call reads the unmerged file list
    expect(callArgs(1)).toEqual(["diff", "--name-only", "--diff-filter=U"]);
  });

  it("rethrows a non-conflict, non-empty failure (e.g. invalid upstream)", async () => {
    gitMock.mockRejectedValue(
      gitError("fatal", "fatal: invalid upstream 'nope'"),
    );

    await expect(ops.startRebase("/wt", "nope")).rejects.toThrow(
      /invalid upstream/,
    );
  });
});

describe("createRebaseOperations — continueRebase", () => {
  it("reports completed when the rebase concludes", async () => {
    gitMock.mockResolvedValue({ stdout: "", stderr: "" });

    const result = await ops.continueRebase("/wt");

    expect(result).toEqual({ status: "completed" });
    expect(callArgs(0)).toEqual([
      "-c",
      "core.editor=true",
      "rebase",
      "--continue",
    ]);
  });

  it("stops at the next conflict when --continue re-conflicts", async () => {
    gitMock
      .mockRejectedValueOnce(
        gitError(
          "could not apply",
          "error: could not apply 1234\nCONFLICT in c.ts",
        ),
      )
      .mockResolvedValueOnce({ stdout: "c.ts\n", stderr: "" });

    const result = await ops.continueRebase("/wt");

    expect(result).toEqual({ status: "conflicts", conflictFiles: ["c.ts"] });
  });

  it("skips a commit that became empty after resolution, then completes", async () => {
    gitMock
      .mockRejectedValueOnce(
        gitError(
          "nothing to commit",
          "No changes - did you forget to use 'git add'?\nyou might want to skip this patch",
        ),
      )
      // git rebase --skip succeeds and the rebase finishes
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await ops.continueRebase("/wt");

    expect(result).toEqual({ status: "completed" });
    expect(callArgs(1)).toEqual(["-c", "core.editor=true", "rebase", "--skip"]);
  });
});

describe("createRebaseOperations — resolveRebaseOnto", () => {
  it("fetches a remote branch and resolves FETCH_HEAD to a stable sha", async () => {
    gitMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // fetch
      .mockResolvedValueOnce({ stdout: "deadbeef\n", stderr: "" }); // rev-parse FETCH_HEAD

    const onto = await ops.resolveRebaseOnto("/wt", {
      kind: "remote",
      remote: "origin",
      branch: "main",
    });

    expect(onto).toEqual({ ref: "deadbeef", label: "origin/main" });
    expect(callArgs(0)).toEqual(["fetch", "origin", "main"]);
    expect(callArgs(1)).toEqual(["rev-parse", "FETCH_HEAD"]);
  });

  it("verifies a local branch exists and rebases onto the branch name", async () => {
    gitMock.mockResolvedValueOnce({ stdout: "abc\n", stderr: "" }); // rev-parse --verify

    const onto = await ops.resolveRebaseOnto("/wt", {
      kind: "local",
      branch: "main",
    });

    expect(onto).toEqual({ ref: "main", label: "main" });
  });

  it("throws a clear error when the local branch does not exist", async () => {
    gitMock.mockRejectedValueOnce(gitError("exit 1"));

    await expect(
      ops.resolveRebaseOnto("/wt", { kind: "local", branch: "ghost" }),
    ).rejects.toThrow(/local branch 'ghost' does not exist/);
  });
});

describe("createRebaseOperations — worktreeHasTrackedChanges", () => {
  it("is true when a tracked file is dirty", async () => {
    gitMock.mockResolvedValue({ stdout: " M src/a.ts\n", stderr: "" });
    expect(await ops.worktreeHasTrackedChanges("/wt")).toBe(true);
  });

  it("is false when only untracked files are present", async () => {
    gitMock.mockResolvedValue({ stdout: "?? scratch.txt\n", stderr: "" });
    expect(await ops.worktreeHasTrackedChanges("/wt")).toBe(false);
  });

  it("is false when the worktree is clean", async () => {
    gitMock.mockResolvedValue({ stdout: "", stderr: "" });
    expect(await ops.worktreeHasTrackedChanges("/wt")).toBe(false);
  });
});

describe("createRebaseOperations — abortRebase", () => {
  it("aborts the in-progress rebase", async () => {
    gitMock.mockResolvedValue({ stdout: "", stderr: "" });
    await ops.abortRebase("/wt");
    expect(callArgs(0)).toEqual(["rebase", "--abort"]);
  });
});
