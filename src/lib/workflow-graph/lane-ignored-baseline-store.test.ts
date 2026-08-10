import { describe, expect, it } from "vitest";
import type { GitClient } from "@/lib/git/client";
import { createLaneIgnoredBaselineStore } from "./lane-ignored-baseline-store";

const WORKTREE = "/repo/.worktrees/session.lane-a";
const PRIVATE_GIT_DIR = "/repo/.git/worktrees/session.lane-a";

function gitClient(): GitClient {
  return {
    async git(args) {
      expect(args).toEqual(["rev-parse", "--absolute-git-dir"]);
      return { stdout: `${PRIVATE_GIT_DIR}\n`, stderr: "" };
    },
  };
}

describe("lane ignored baseline store", () => {
  it("round-trips the per-file manifest through the lane's private git metadata", async () => {
    let target = "";
    let written: unknown;
    const store = createLaneIgnoredBaselineStore({
      gitClient: gitClient(),
      async writeJson(filePath, value) {
        target = filePath;
        written = value;
      },
      async readFile(filePath) {
        expect(filePath).toBe(target);
        return JSON.stringify(written);
      },
    });
    const contents = {
      roots: ["node_modules"],
      entries: [
        {
          path: "node_modules/pkg/index.js",
          fingerprint: "file-fingerprint",
        },
      ],
    };

    await store.write(WORKTREE, contents);

    expect(target).toBe(
      `${PRIVATE_GIT_DIR}/command-center-ignored-baseline.json`,
    );
    await expect(store.read(WORKTREE)).resolves.toEqual(contents);
  });

  it("returns no baseline for a missing manifest so the classifier can fail closed", async () => {
    const store = createLaneIgnoredBaselineStore({
      gitClient: gitClient(),
      async readFile() {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    });

    await expect(store.read(WORKTREE)).resolves.toBeNull();
  });

  it("returns no baseline for malformed contents rather than trusting them", async () => {
    const store = createLaneIgnoredBaselineStore({
      gitClient: gitClient(),
      async readFile() {
        return JSON.stringify({ version: 1, roots: ["node_modules"] });
      },
    });

    await expect(store.read(WORKTREE)).resolves.toBeNull();
  });
});
