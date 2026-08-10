/**
 * What an owned landing has to survive: a lane HEAD that moved under it, a
 * process that died mid-sequence, and a resume that replays it (R7.3).
 *
 * Every claim here is about what git actually did, so the tests drive real
 * repositories. The crash is injected at the git-client seam — every command
 * up to the chosen one runs for real, and the one that "crashes" throws — which
 * is the only way to observe the state a killed process would have left behind.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultGitClient, type GitClient } from "@/lib/git/client";
import { createOwnedLandingOperations } from "@/lib/git/owned-landing";
import { createLandingEvidenceProber } from "./landing-evidence";
import { landingIntentTrailer } from "./route-runtime";

const API_MESSAGE =
  "Graph workflow context context-api\n\nLanding-Intent: cc-landing:exec-1:context-api:1";
/** A client that runs everything for real until the named subcommand, then dies. */
function crashingClientAt(subcommand: string): GitClient {
  return {
    async git(args, cwd, options) {
      if (args.includes(subcommand)) {
        throw new Error(`simulated crash before "git ${subcommand}"`);
      }
      return defaultGitClient.git(args, cwd, options);
    },
  };
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await defaultGitClient.git(args, repo);
  return stdout.trim();
}

async function write(
  repo: string,
  relative: string,
  content: string,
): Promise<void> {
  const target = path.join(repo, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf-8");
}

async function leftoverIndexFiles(repo: string): Promise<string[]> {
  const gitDir = await git(repo, ["rev-parse", "--absolute-git-dir"]);
  return (await readdir(gitDir)).filter((name) => name.includes("cc-landing"));
}

describe("owned landing under interleaving and crash replay (R7.3)", () => {
  const landing = createOwnedLandingOperations();
  let lane: string;

  beforeEach(async () => {
    lane = await mkdtemp(path.join(tmpdir(), "cc-landing-replay-"));
    await git(lane, ["init", "--initial-branch=lane-shared", "."]);
    await git(lane, ["config", "user.email", "engine@command-center.test"]);
    await git(lane, ["config", "user.name", "Command Center"]);
    await write(lane, "src/api/handler.ts", "api v1\n");
    await write(lane, "src/ui/panel.tsx", "ui v1\n");
    await git(lane, ["add", "-A"]);
    await git(lane, ["commit", "-m", "lane fork point"]);
  });

  afterEach(async () => {
    await rm(lane, { recursive: true, force: true });
  });

  it("leaves no contamination when the process dies between staging into the private index and the ref update", async () => {
    await write(lane, "src/api/handler.ts", "api v2\n");
    await write(lane, "src/ui/panel.tsx", "ui v2\n");
    // The sibling has staged its work into the SHARED index and not committed.
    await git(lane, ["add", "src/ui/panel.tsx"]);
    const headBefore = await git(lane, ["rev-parse", "HEAD"]);
    const sharedIndexBefore = await git(lane, [
      "diff",
      "--cached",
      "--name-only",
      headBefore,
    ]);

    const crashed = createOwnedLandingOperations(
      crashingClientAt("update-ref"),
    );
    await expect(
      crashed.commitOwnedPaths({
        worktreePath: lane,
        message: API_MESSAGE,
        ownedPaths: ["src/api"],
      }),
    ).rejects.toThrow(/simulated crash/);

    // Nothing published: HEAD is where it was and no trailer exists anywhere.
    expect(await git(lane, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(
      await git(lane, [
        "log",
        "--all",
        "--fixed-strings",
        `--grep=${landingIntentTrailer("cc-landing:exec-1:context-api:1")}`,
        "--format=%H",
      ]),
    ).toBe("");
    // The shared index is exactly as the sibling left it.
    expect(
      await git(lane, ["diff", "--cached", "--name-only", headBefore]),
    ).toBe(sharedIndexBefore);
    expect(await git(lane, ["show", ":src/ui/panel.tsx"])).toBe("ui v2");
    // Both members' working files are untouched.
    expect(await readFile(path.join(lane, "src/api/handler.ts"), "utf-8")).toBe(
      "api v2\n",
    );
    expect(await readFile(path.join(lane, "src/ui/panel.tsx"), "utf-8")).toBe(
      "ui v2\n",
    );
    expect(await leftoverIndexFiles(lane)).toEqual([]);
  });

  it("leaves no contamination when the process dies immediately after staging, before the tree is even written", async () => {
    await write(lane, "src/api/handler.ts", "api v2\n");
    await write(lane, "src/ui/panel.tsx", "ui v2\n");
    await git(lane, ["add", "src/ui/panel.tsx"]);
    const headBefore = await git(lane, ["rev-parse", "HEAD"]);

    const crashed = createOwnedLandingOperations(
      crashingClientAt("write-tree"),
    );
    await expect(
      crashed.commitOwnedPaths({
        worktreePath: lane,
        message: API_MESSAGE,
        ownedPaths: ["src/api"],
      }),
    ).rejects.toThrow(/simulated crash/);

    expect(await git(lane, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await git(lane, ["show", ":src/ui/panel.tsx"])).toBe("ui v2");
    expect(await readFile(path.join(lane, "src/api/handler.ts"), "utf-8")).toBe(
      "api v2\n",
    );
    expect(await leftoverIndexFiles(lane)).toEqual([]);
  });

  it("replays a crashed-before-publish landing into exactly one commit", async () => {
    await write(lane, "src/api/handler.ts", "api v2\n");
    const crashed = createOwnedLandingOperations(
      crashingClientAt("update-ref"),
    );
    await expect(
      crashed.commitOwnedPaths({
        worktreePath: lane,
        message: API_MESSAGE,
        ownedPaths: ["src/api"],
      }),
    ).rejects.toThrow(/simulated crash/);

    const replay = await landing.commitOwnedPaths({
      worktreePath: lane,
      message: API_MESSAGE,
      ownedPaths: ["src/api"],
    });

    expect(replay.status).toBe("committed");
    expect(await git(lane, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(await git(lane, ["show", "HEAD:src/api/handler.ts"])).toBe("api v2");
  });

  it("replays a crash between the landing commit and the state write without duplicating or losing the commit", async () => {
    await write(lane, "src/api/handler.ts", "api v2\n");
    const first = await landing.commitOwnedPaths({
      worktreePath: lane,
      message: API_MESSAGE,
      ownedPaths: ["src/api"],
    });
    expect(first.status).toBe("committed");
    if (first.status !== "committed") return;

    // The engine died before recording the landing, so the resumed pass reads
    // the branch back through the trailer probe and classifies from it.
    const evidence = await createLandingEvidenceProber().probe([
      {
        contextId: "context-api",
        worktreePath: lane,
        token: "cc-landing:exec-1:context-api:1",
        baselineSha: await git(lane, ["rev-parse", "HEAD^"]),
      },
    ]);
    expect(evidence.get("context-api")).toEqual({
      headSha: first.hash,
      tokenCommitSha: first.hash,
      baselineReachable: true,
    });

    // And the repair path re-running the landing is a no-op: the work is
    // already on the branch, so the private tree equals HEAD's.
    const replay = await landing.commitOwnedPaths({
      worktreePath: lane,
      message: API_MESSAGE,
      ownedPaths: ["src/api"],
    });
    expect(replay).toEqual({ status: "no-changes" });
    expect(await git(lane, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(await git(lane, ["rev-parse", "HEAD"])).toBe(first.hash);
  });

  it("refuses to publish onto a HEAD that moved after the tree was built, rather than discarding the commit it did not see", async () => {
    await write(lane, "src/api/handler.ts", "api v2\n");
    // A client that lets the whole sequence run but slips a sibling commit in
    // between `write-tree` and `update-ref` — the window the compare-and-swap
    // exists for.
    const racingClient: GitClient = {
      async git(args, cwd, options) {
        if (args.includes("update-ref")) {
          await write(lane, "src/ui/panel.tsx", "ui raced\n");
          await defaultGitClient.git(["add", "src/ui/panel.tsx"], lane);
          await defaultGitClient.git(
            ["commit", "-m", "sibling raced in"],
            lane,
          );
        }
        return defaultGitClient.git(args, cwd, options);
      },
    };

    // The refusal is the compare-and-swap itself, not an incidental failure.
    await expect(
      createOwnedLandingOperations(racingClient).commitOwnedPaths({
        worktreePath: lane,
        message: API_MESSAGE,
        ownedPaths: ["src/api"],
      }),
    ).rejects.toThrow(/cannot lock ref .*but expected/s);

    // The racer's commit survives; the refused landing left nothing behind.
    expect(await git(lane, ["log", "-1", "--format=%s"])).toBe(
      "sibling raced in",
    );
    expect(await git(lane, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(await leftoverIndexFiles(lane)).toEqual([]);
  });

  it("lands a newline-containing owned path byte-exactly", async () => {
    const newlineFile = "src/api/line\nbreak.ts";
    await write(lane, newlineFile, "newline body\n");

    const result = await landing.commitOwnedPaths({
      worktreePath: lane,
      message: API_MESSAGE,
      ownedPaths: [newlineFile],
    });

    expect(result.status).toBe("committed");
    const landed = (
      await git(lane, ["show", "-z", "--name-only", "--format=", "HEAD"])
    )
      .split("\0")
      .filter((entry) => entry.length > 0);
    expect(landed).toEqual([newlineFile]);
    expect(await git(lane, ["show", `HEAD:${newlineFile}`])).toBe(
      "newline body",
    );
  });
});
