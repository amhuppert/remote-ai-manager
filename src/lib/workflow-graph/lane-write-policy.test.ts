/**
 * The server-derived write envelope for a validator lane (R7, D6).
 *
 * These tests drive the composer with injected filesystem seams so the
 * canonicalization and containment rules are observable: the real thing is
 * exercised end-to-end by the envelope transport integration test.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { composeValidatorLaneWriteEnvelope } from "./lane-write-policy";
import { MAX_LANE_TMP_DIR_BYTES } from "./lane-tmp-dir";

const SCRATCH_ROOT = "/tmp/cc-lane-scratch";

/**
 * A realpath that collapses the two symlinks that actually matter on the
 * platform CC runs on: macOS `/tmp` -> `/private/tmp`, and a worktree reached
 * through a symlinked parent.
 */
function fakeRealpath(target: string): string {
  if (target === "/repo/worktree") return "/private/volumes/repo/worktree";
  if (target.startsWith("/tmp/")) return `/private${target}`;
  return target;
}

function composeWith(
  overrides: {
    contextId?: string;
    assignmentId?: string;
    worktreePath?: string;
  } = {},
  created: string[] = [],
) {
  return composeValidatorLaneWriteEnvelope(
    {
      executionId: "exec-1",
      contextId: overrides.contextId ?? "context-build",
      assignmentId: overrides.assignmentId ?? "security-reviewer",
      worktreePath: overrides.worktreePath ?? "/repo/worktree",
    },
    {
      scratchRootDir: SCRATCH_ROOT,
      ensureDir: (dir) => created.push(dir),
      realpath: fakeRealpath,
    },
  );
}

describe("composeValidatorLaneWriteEnvelope", () => {
  it("allows only the lane's scratch and lane-temp directories and denies the candidate worktree", () => {
    const envelope = composeWith();

    expect(envelope.policy).toEqual({
      mode: "allowlist",
      allowWrite: [envelope.laneScratchDir, envelope.laneTmpDir],
      denyWrite: ["/private/volumes/repo/worktree"],
    });
  });

  // The temp lives OUTSIDE the scratch directory at a fixed-width digest name:
  // the run's `$TMPDIR` hosts the sandbox's AF_UNIX bridge sockets, so its
  // length must not grow with authored ids the way the scratch path does.
  it("places the lane temp at a stable fixed-width digest path outside the scratch directory", () => {
    const envelope = composeWith();

    expect(path.basename(envelope.laneTmpDir)).toMatch(/^[0-9a-f]{32}$/);
    expect(
      envelope.laneTmpDir.startsWith(`${envelope.laneScratchDir}${path.sep}`),
    ).toBe(false);
    expect(envelope.laneScratchDir.startsWith(`/private${SCRATCH_ROOT}/`)).toBe(
      true,
    );
    // Uniqueness must not come from randomness: the same assignment has to
    // find its own temp again on a later turn, and a different assignment must
    // never land on it.
    expect(composeWith().laneTmpDir).toBe(envelope.laneTmpDir);
    expect(composeWith({ assignmentId: "perf-reviewer" }).laneTmpDir).not.toBe(
      envelope.laneTmpDir,
    );
  });

  it("refuses composition when the canonical temp entry would exceed the AF_UNIX budget", () => {
    expect(() =>
      composeValidatorLaneWriteEnvelope(
        {
          executionId: "exec-1",
          contextId: "context-build",
          assignmentId: "reviewer",
          worktreePath: "/repo/worktree",
        },
        {
          scratchRootDir: SCRATCH_ROOT,
          tmpRootDir: `/tmp/${"t".repeat(80)}`,
          ensureDir: () => {},
          realpath: fakeRealpath,
        },
      ),
    ).toThrow(/AF_UNIX budget/i);
  });

  // Incident regression (ticket #5): the run's `$TMPDIR` is the policy's temp
  // entry and hosts the Claude sandbox's AF_UNIX bridge sockets on Linux, so
  // its byte length must stay inside the socket budget however long the
  // authored ids are — a validator lane's scratch path grows with THREE ids.
  it("keeps the temp entry inside the AF_UNIX byte budget whatever the ids' length", () => {
    const envelope = composeWith({
      contextId: "context-".concat("c".repeat(52)),
      assignmentId: "adversarial-security-reviewer",
    });

    expect(Buffer.byteLength(envelope.laneTmpDir)).toBeLessThanOrEqual(
      MAX_LANE_TMP_DIR_BYTES,
    );
    expect(envelope.policy.allowWrite.at(-1)).toBe(envelope.laneTmpDir);
  });

  it("gives each cohort member in one context a disjoint scratch directory", () => {
    const first = composeWith({ assignmentId: "security-reviewer" });
    const second = composeWith({ assignmentId: "perf-reviewer" });

    expect(first.laneScratchDir).not.toBe(second.laneScratchDir);
    expect(
      first.laneTmpDir.startsWith(`${second.laneScratchDir}${path.sep}`),
    ).toBe(false);
  });

  it("creates both writable directories before canonicalizing them", () => {
    // realpath resolves nothing for a path that does not exist, so an envelope
    // whose directories were only named — never made — would hand the backend a
    // non-canonical allowlist.
    const created: string[] = [];
    const envelope = composeWith({}, created);

    expect(created).toHaveLength(2);
    // Each id contributes exactly one segment, in order. These ids are already
    // path-safe, so the segment mapping is the identity on them and the lane's
    // directory still reads as the lane it belongs to.
    expect(created[0]).toBe(
      `${SCRATCH_ROOT}/exec-1/context-build/security-reviewer`,
    );
    expect(created[1]).toMatch(/^\/tmp\/cc-lane-tmp\/[0-9a-f]{32}$/);
    expect(envelope.laneScratchDir).toBe(`/private${created[0]}`);
  });

  it("canonicalizes every path in the policy", () => {
    const envelope = composeWith();

    for (const entry of [
      ...envelope.policy.allowWrite,
      ...envelope.policy.denyWrite,
    ]) {
      expect(entry.startsWith("/private/")).toBe(true);
      expect(path.isAbsolute(entry)).toBe(true);
    }
  });

  it("keeps an author-controlled context id from placing the writable directory outside the scratch root", () => {
    // Context ids are free-form authored strings; a traversal segment must not
    // be able to relocate the one directory the validator may write to.
    const envelope = composeWith({ contextId: "../../../../etc" });

    expect(envelope.laneScratchDir.startsWith(`/private${SCRATCH_ROOT}/`)).toBe(
      true,
    );
    expect(envelope.laneScratchDir.split(path.sep)).not.toContain("..");
  });

  it("fails closed when a writable path cannot be canonicalized", () => {
    // A lexical path is not a canonical one. Substituting `path.resolve` here
    // would hand the backend an allowlist entry that its canonical-path
    // comparison may never match — an envelope that looks established and
    // enforces nothing.
    expect(() =>
      composeValidatorLaneWriteEnvelope(
        {
          executionId: "exec-1",
          contextId: "context-build",
          assignmentId: "reviewer",
          worktreePath: "/repo/worktree",
        },
        {
          scratchRootDir: SCRATCH_ROOT,
          ensureDir: () => {},
          realpath: (target) => {
            if (target.startsWith(SCRATCH_ROOT)) throw new Error("ELOOP");
            return fakeRealpath(target);
          },
        },
      ),
    ).toThrow(/write envelope/i);
  });

  it("fails closed when the denied worktree cannot be canonicalized", () => {
    // The deny entry is the whole point of the envelope. An uncanonicalizable
    // candidate worktree may still be reachable through a symlink the backend
    // resolves differently, so there is no safe lexical stand-in.
    expect(() =>
      composeValidatorLaneWriteEnvelope(
        {
          executionId: "exec-1",
          contextId: "context-build",
          assignmentId: "reviewer",
          worktreePath: "/repo/worktree",
        },
        {
          scratchRootDir: SCRATCH_ROOT,
          ensureDir: () => {},
          realpath: (target) => {
            if (target === "/repo/worktree") throw new Error("ENOENT");
            return fakeRealpath(target);
          },
        },
      ),
    ).toThrow(/write envelope/i);
  });

  it("fails loudly when the writable directories cannot be established", () => {
    // Fail-closed: a lane with no writable scratch cannot establish its
    // envelope, and the caller turns the throw into an infrastructure outcome
    // rather than running the validator unrestricted.
    expect(() =>
      composeValidatorLaneWriteEnvelope(
        {
          executionId: "exec-1",
          contextId: "context-build",
          assignmentId: "reviewer",
          worktreePath: "/repo/worktree",
        },
        {
          scratchRootDir: SCRATCH_ROOT,
          ensureDir: () => {
            throw new Error("EACCES");
          },
          realpath: fakeRealpath,
        },
      ),
    ).toThrow(/write envelope/i);
  });
});
