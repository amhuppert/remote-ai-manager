import { describe, expect, it } from "vitest";

import { createLandingEvidenceProber } from "@/lib/workflow-graph/landing-evidence";
import type { LandingProbeTarget } from "@/lib/workflow-graph/route-runtime";

const TARGET: LandingProbeTarget = {
  contextId: "fix",
  token: "cc-landing:execution-1:fix:1",
  worktreePath: "/tmp/lane-1",
  baselineSha: "aaa",
};

interface FakeGitOptions {
  head?: string;
  tokenCommit?: string;
  ancestor?: boolean;
  missingPaths?: readonly string[];
  failing?: readonly string[];
}

function fakeGit(options: FakeGitOptions = {}) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const prober = createLandingEvidenceProber({
    async pathExists(path) {
      return !(options.missingPaths ?? []).includes(path);
    },
    async git(args, cwd) {
      calls.push({ args, cwd });
      const command = args[0] ?? "";
      if ((options.failing ?? []).includes(command)) {
        throw new Error(`git ${command} failed`);
      }
      if (command === "rev-parse") {
        return { stdout: `${options.head ?? "ccc"}\n`, stderr: "" };
      }
      if (command === "log") {
        return {
          stdout: options.tokenCommit ? `${options.tokenCommit}\n` : "",
          stderr: "",
        };
      }
      if (command === "merge-base") {
        if (options.ancestor === false) throw new Error("not an ancestor");
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected git command: ${command}`);
    },
  });
  return { prober, calls };
}

describe("createLandingEvidenceProber (decision D8)", () => {
  it("reports the token commit it found on the branch", async () => {
    const { prober, calls } = fakeGit({ head: "ccc", tokenCommit: "ccc" });

    const evidence = await prober.probe([TARGET]);

    expect(evidence.get("fix")).toEqual({
      headSha: "ccc",
      tokenCommitSha: "ccc",
      baselineReachable: true,
    });
    // The trailer is searched literally, so a token containing regex
    // metacharacters cannot silently widen the match.
    const log = calls.find((call) => call.args[0] === "log");
    expect(log?.cwd).toBe("/tmp/lane-1");
    expect(log?.args).toContain("--fixed-strings");
    expect(log?.args).toContain(
      "--grep=Landing-Intent: cc-landing:execution-1:fix:1",
    );
  });

  it("reports an unreachable baseline rather than assuming the range holds", async () => {
    const { prober } = fakeGit({ head: "ccc", ancestor: false });

    expect(await prober.probe([TARGET])).toEqual(
      new Map([
        [
          "fix",
          { headSha: "ccc", tokenCommitSha: null, baselineReachable: false },
        ],
      ]),
    );
  });

  it("does not claim reachability for an intent that recorded no baseline", async () => {
    const { prober, calls } = fakeGit({ head: "ccc" });

    const evidence = await prober.probe([{ ...TARGET, baselineSha: null }]);

    expect(evidence.get("fix")?.baselineReachable).toBe(false);
    expect(calls.some((call) => call.args[0] === "merge-base")).toBe(false);
  });

  it("reports nothing for a worktree that is gone", async () => {
    const { prober, calls } = fakeGit({ missingPaths: ["/tmp/lane-1"] });

    expect(await prober.probe([TARGET])).toEqual(new Map());
    expect(calls).toEqual([]);
  });

  it("degrades to no evidence when the branch cannot be read", async () => {
    const { prober } = fakeGit({ failing: ["rev-parse", "log", "merge-base"] });

    // A probe failure must never be reported as a landing — and must never
    // throw either, or one unreadable worktree would abort the whole restart.
    expect(await prober.probe([TARGET])).toEqual(
      new Map([
        [
          "fix",
          { headSha: null, tokenCommitSha: null, baselineReachable: false },
        ],
      ]),
    );
  });
});
