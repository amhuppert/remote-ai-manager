import { describe, expect, it } from "vitest";
import type { FsWritePolicy } from "../task";
import {
  CLAUDE_FS_RESTRICTED_MUTATION_TOOLS,
  buildClaudeFsWriteEnvelope,
} from "./fs-write-envelope";

const SCRATCH = "/private/tmp/cc-validator-lanes/exec/ctx/reviewer";
const LANE_TMP = `${SCRATCH}/tmp`;
const WORKTREE = "/private/volumes/repo/worktree";

function policy(overrides?: Partial<FsWritePolicy>): FsWritePolicy {
  return {
    mode: "allowlist",
    allowWrite: [SCRATCH, LANE_TMP],
    denyWrite: [WORKTREE],
    ...overrides,
  };
}

function envelopeOf(input: FsWritePolicy) {
  const result = buildClaudeFsWriteEnvelope(input);
  if (result.kind !== "envelope") {
    throw new Error(`expected an envelope, got: ${result.reason}`);
  }
  return result.envelope;
}

describe("buildClaudeFsWriteEnvelope", () => {
  it("enables the sandbox as a hard gate rather than a best effort", () => {
    expect(envelopeOf(policy()).sandbox).toMatchObject({
      enabled: true,
      // A sandbox that silently degrades is a sandbox the lane cannot rely on:
      // the run must fail instead of proceeding unsandboxed.
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
    });
  });

  it("carries the policy onto the sandbox filesystem allowlist with an explicit deny", () => {
    // `allowWrite` is additive over the sandbox's own defaults, so the candidate
    // worktree being absent from it is not the same as it being unwritable.
    expect(envelopeOf(policy()).sandbox.filesystem).toEqual({
      allowWrite: [SCRATCH, LANE_TMP],
      denyWrite: [WORKTREE],
    });
  });

  it("puts the run's working root at the head of the allowlist, never the worktree", () => {
    // The sandbox's default writable set is the working directory AND its
    // subdirectories, so the working root is part of the envelope rather than
    // the caller's choice: a run whose cwd is the confined worktree can write
    // anywhere in it however narrow the allowlist is.
    const envelope = envelopeOf(policy());

    expect(envelope.workingDirectory).toBe(SCRATCH);
    expect(envelope.workingDirectory).not.toBe(WORKTREE);
  });

  it("denies anything not pre-approved instead of prompting or bypassing", () => {
    const envelope = envelopeOf(policy());

    expect(envelope.permissionMode).toBe("dontAsk");
    expect(envelope.permissions.defaultMode).toBe("dontAsk");
    expect(envelope.permissionMode).not.toBe("bypassPermissions");
  });

  it("scopes every file-mutation tool to the allowlist and to nothing else", () => {
    const { allow } = envelopeOf(policy()).permissions;

    for (const tool of CLAUDE_FS_RESTRICTED_MUTATION_TOOLS) {
      expect(allow).toContain(`${tool}(//${SCRATCH}/**)`);
      expect(allow).toContain(`${tool}(//${LANE_TMP}/**)`);
      // An unscoped rule would re-open the whole filesystem to that tool.
      expect(allow).not.toContain(tool);
      expect(allow).not.toContain(`${tool}(*)`);
    }
  });

  it("denies every file-mutation tool inside the candidate worktree", () => {
    const { deny } = envelopeOf(policy()).permissions;

    for (const tool of CLAUDE_FS_RESTRICTED_MUTATION_TOOLS) {
      expect(deny).toContain(`${tool}(//${WORKTREE}/**)`);
    }
  });

  it("keeps the read and inspection tools a reviewer needs", () => {
    const { allow } = envelopeOf(policy()).permissions;

    expect(allow).toEqual(
      expect.arrayContaining(["Read", "Grep", "Glob", "Bash"]),
    );
  });

  describe("fail-closed establishment", () => {
    it("refuses an empty allowlist rather than emitting a sandbox with no writable path", () => {
      expect(buildClaudeFsWriteEnvelope(policy({ allowWrite: [] })).kind).toBe(
        "unestablishable",
      );
    });

    it("refuses a relative allowlist entry, which a permission rule cannot anchor", () => {
      expect(
        buildClaudeFsWriteEnvelope(policy({ allowWrite: ["scratch"] })).kind,
      ).toBe("unestablishable");
    });

    it("refuses an allowlist entry inside a denied path", () => {
      expect(
        buildClaudeFsWriteEnvelope(
          policy({ allowWrite: [`${WORKTREE}/reports`] }),
        ).kind,
      ).toBe("unestablishable");
    });

    it("refuses a path containing a glob character, which would widen the rule it is pasted into", () => {
      // Rule content is a glob, so an unsanitized `*` in a path is a wildcard.
      expect(
        buildClaudeFsWriteEnvelope(policy({ allowWrite: ["/tmp/lane*"] })).kind,
      ).toBe("unestablishable");
    });
  });
});
