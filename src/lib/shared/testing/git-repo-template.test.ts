import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildChildEnv } from "../child-env";
import {
  createGitRepoTemplate,
  type GitRepoTemplate,
} from "./git-repo-template";

const execFileAsync = promisify(execFile);

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repo,
    env: buildChildEnv(),
  });
  return stdout.trim();
}

describe("createGitRepoTemplate", () => {
  let template: GitRepoTemplate | undefined;

  afterEach(async () => {
    await template?.dispose();
    template = undefined;
  });

  it("hands out independent copies of one built repository, symlinks included", async () => {
    template = await createGitRepoTemplate(
      "cc-template-test-",
      async (repo) => {
        await git(repo, ["init", "-q", "-b", "main"]);
        await git(repo, ["config", "user.email", "test@example.com"]);
        await git(repo, ["config", "user.name", "Test"]);
        await writeFile(path.join(repo, "a.txt"), "alpha\n");
        await symlink("a.txt", path.join(repo, "link.txt"));
        await git(repo, ["add", "-A"]);
        await git(repo, ["commit", "-q", "-m", "base"]);
      },
    );

    const first = await template.fresh();
    const second = await template.fresh();
    expect(first).not.toBe(second);

    await writeFile(path.join(first, "a.txt"), "changed\n");
    expect(await git(first, ["status", "--porcelain"])).toBe("M a.txt");
    expect(await git(second, ["status", "--porcelain"])).toBe("");
    expect((await lstat(path.join(second, "link.txt"))).isSymbolicLink()).toBe(
      true,
    );
    expect(await readFile(path.join(second, "link.txt"), "utf8")).toBe(
      "alpha\n",
    );
    expect(await git(second, ["log", "--format=%s"])).toBe("base");
  });

  it("removes the template and its copies on dispose", async () => {
    template = await createGitRepoTemplate(
      "cc-template-test-",
      async (repo) => {
        await git(repo, ["init", "-q"]);
      },
    );
    const copy = await template.fresh();
    await template.dispose();
    template = undefined;
    await expect(lstat(copy)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies into a fresh directory even when the caller has removed an earlier copy", async () => {
    template = await createGitRepoTemplate(
      "cc-template-test-",
      async (repo) => {
        await git(repo, ["init", "-q"]);
      },
    );
    const first = await template.fresh();
    await rm(first, { recursive: true, force: true });
    const second = await template.fresh();
    expect(await lstat(path.join(second, ".git"))).toBeTruthy();
    const scratch = await mkdtemp(path.join(tmpdir(), "cc-template-scratch-"));
    await rm(scratch, { recursive: true, force: true });
  });
});
