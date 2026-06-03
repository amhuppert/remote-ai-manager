import { describe, it, expect, vi } from "vitest";
import { createSpawnBaseResolver, createGitHeadRef } from "./spawn-base";
import type { GitClient } from "@/lib/git/client";

describe("createSpawnBaseResolver", () => {
  it("returns the committed HEAD ref from getHeadRef", async () => {
    const sha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const getHeadRef = vi.fn().mockResolvedValue(sha);
    const { resolveCommittedHeadBase } = createSpawnBaseResolver({
      getHeadRef,
    });

    const base = await resolveCommittedHeadBase("/repo");

    expect(base).toBe(sha);
    expect(getHeadRef).toHaveBeenCalledWith("/repo");
  });

  it("trims surrounding whitespace from the resolved ref", async () => {
    const getHeadRef = vi.fn().mockResolvedValue("  deadbeef\n");
    const { resolveCommittedHeadBase } = createSpawnBaseResolver({
      getHeadRef,
    });
    expect(await resolveCommittedHeadBase("/repo")).toBe("deadbeef");
  });

  it("throws when HEAD cannot be resolved (empty ref)", async () => {
    const getHeadRef = vi.fn().mockResolvedValue("   ");
    const { resolveCommittedHeadBase } = createSpawnBaseResolver({
      getHeadRef,
    });
    await expect(resolveCommittedHeadBase("/repo")).rejects.toThrow();
  });
});

describe("createGitHeadRef", () => {
  it("resolves the committed HEAD via `git rev-parse HEAD` (a commit-ish, not a working-tree ref)", async () => {
    const git = vi.fn().mockResolvedValue({ stdout: "abc123\n", stderr: "" });
    const gitClient: GitClient = { git };
    const getHeadRef = createGitHeadRef(gitClient);

    const ref = await getHeadRef("/repo");

    expect(ref).toBe("abc123");
    expect(git).toHaveBeenCalledWith(["rev-parse", "HEAD"], "/repo");
  });
});
