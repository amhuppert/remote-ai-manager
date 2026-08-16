import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { defaultGitClient } from "./client";

describe("defaultGitClient (real git)", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "cc-git-client-"));
    await defaultGitClient.git(["init"], repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("runs git scoped to the given cwd", async () => {
    const { stdout } = await defaultGitClient.git(
      ["rev-parse", "--is-inside-work-tree"],
      repoDir,
    );
    expect(stdout.trim()).toBe("true");
  });

  it("applies env overrides on top of the sanitized child env", async () => {
    // buildChildEnv strips inherited GIT_INDEX_FILE; an explicit per-call
    // override must survive that sanitization so callers can scope a command
    // to e.g. a temporary index.
    const customIndex = join(repoDir, "custom-index");
    const { stdout } = await defaultGitClient.git(
      ["rev-parse", "--git-path", "index"],
      repoDir,
      { env: { GIT_INDEX_FILE: customIndex } },
    );
    expect(stdout.trim()).toBe(customIndex);
  });

  it("pins the child locale to C so git's own output stays parseable", async () => {
    // A `!`-prefixed alias runs through the shell, which is the only way to
    // read the environment git itself was handed.
    const { stdout } = await defaultGitClient.git(
      ["-c", "alias.readlocale=!printenv LC_ALL", "readlocale"],
      repoDir,
    );
    expect(stdout.trim()).toBe("C");
  });

  it("strips inherited git env vars when no override is given", async () => {
    const saved = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = "/tmp/should-not-leak-into-child";
    try {
      const { stdout } = await defaultGitClient.git(
        ["rev-parse", "--git-path", "index"],
        repoDir,
      );
      expect(stdout.trim()).not.toBe("/tmp/should-not-leak-into-child");
    } finally {
      if (saved === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = saved;
    }
  });
});
