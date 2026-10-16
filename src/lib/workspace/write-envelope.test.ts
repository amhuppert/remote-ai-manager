/**
 * Whole-worktree boundaries, backed by a real filesystem.
 *
 * Driven against a REAL filesystem rather than injected seams: every rule this
 * composer owns — canonicalization, longest-existing-ancestor resolution,
 * containment after symlink resolution — is a statement about what `realpath`
 * does, and a fake `realpath` proves only that the fake agrees with itself.
 * `os.tmpdir()` is itself a symlink on macOS, so the canonical root differs
 * from the path handed in on the platform CC actually runs on.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { ownedPathSchema } from "@/lib/workspace/schemas";
import { composeImplementerLaneWriteEnvelope } from "./write-envelope";
import { MAX_LANE_TMP_DIR_BYTES } from "@/lib/workspace/lane-tmp-dir";

let fixtureRoot: string;
let worktreePath: string;

function compose(
  overrides: {
    contextId?: string;
    executionId?: string;
    worktreePath?: string;
    tmpRootDir?: string;
  } = {},
) {
  return composeImplementerLaneWriteEnvelope(
    {
      executionId: overrides.executionId ?? "exec-1",
      contextId: overrides.contextId ?? "context-build",
      worktreePath: overrides.worktreePath ?? worktreePath,
    },
    {
      ...(overrides.tmpRootDir ? { tmpRootDir: overrides.tmpRootDir } : {}),
    },
  );
}

/** Whether `candidate` is `parent` or sits beneath it, by path arithmetic. */
function coversPath(parent: string, candidate: string): boolean {
  if (parent === candidate) return true;
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

/** Context payloads have distinct names; their shared worktree is writable by every seat. */
const PRIVATE_DIRS = ["contextTmpDir", "payloadDir"] as const;

/**
 * Directory identity is checked on the filesystem, not just by path arithmetic. Two directory names that differ as JavaScript
 * strings are still one directory on a case-insensitive volume — which is what
 * macOS formats by default — so `!==` on the composed paths cannot see that
 * aliasing. Writing a distinct marker into each and reading both back can:
 * if the two names resolve to one directory, the second write lands on the
 * first file and the read comes back with the wrong owner.
 */
function expectDistinctOnDisk(
  first: ReturnType<typeof compose>,
  second: ReturnType<typeof compose>,
): void {
  for (const dir of PRIVATE_DIRS) {
    const firstMarker = path.join(first[dir], "owner.txt");
    const secondMarker = path.join(second[dir], "owner.txt");
    writeFileSync(firstMarker, "first");
    writeFileSync(secondMarker, "second");

    expect(
      readFileSync(firstMarker, "utf8"),
      `both contexts' ${dir} resolved to one directory on disk`,
    ).toBe("first");
    expect(readFileSync(secondMarker, "utf8")).toBe("second");
  }
}

beforeEach(() => {
  fixtureRoot = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "cc-implementer-envelope-")),
  );
  worktreePath = path.join(fixtureRoot, "worktree");
  mkdirSync(path.join(worktreePath, "src", "lib"), { recursive: true });
  writeFileSync(path.join(worktreePath, "README.md"), "# fixture\n");
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("composeImplementerLaneWriteEnvelope", () => {
  it("allows an owned seat to create every missing ancestor and write elsewhere in its own worktree", () => {
    const envelope = compose();
    const targets = [
      "tmp",
      "tmp/run",
      "tmp/run/checks/result.txt",
      "src/other.ts",
      ".git",
    ];

    for (const target of targets) {
      const absolute = path.join(envelope.worktreeRoot, target);
      expect(
        envelope.policy.allowWrite.some((allowed) =>
          coversPath(allowed, absolute),
        ),
        `${target} must be writable within the seat's own worktree`,
      ).toBe(true);
      expect(
        envelope.policy.denyWrite.some((denied) =>
          coversPath(denied, absolute),
        ),
      ).toBe(false);
    }
    expect(envelope.policy.allowWrite[0]).toBe(envelope.worktreeRoot);
    expect(envelope.policy.allowWrite).not.toContain(fixtureRoot);
  });

  it("keeps read-only task intent out of the filesystem boundary", () => {
    const envelope = compose();
    expect(envelope.policy.allowWrite).toContain(envelope.worktreeRoot);
    expect(envelope.policy.denyWrite).toEqual([]);
  });

  it("uses the worktree as cwd and adds only its private temp outside the tree", () => {
    const envelope = compose();
    expect(envelope.policy).toEqual({
      mode: "allowlist",
      allowWrite: [realpathSync(worktreePath), envelope.contextTmpDir],
      denyWrite: [],
    });
  });

  it("puts the payload directory under the worktree's git-ignored .cc namespace and creates it", () => {
    const canonicalRoot = realpathSync(worktreePath);

    const envelope = compose({ contextId: "context-build" });

    // The id is escaped into a path segment, so the assertion is on the
    // namespace and on the id remaining legible within it, not on an exact
    // directory name.
    expect(path.dirname(envelope.payloadDir)).toBe(
      path.join(canonicalRoot, ".cc", "temp"),
    );
    expect(path.basename(envelope.payloadDir)).toContain("context-build");
    expect(realpathSync(envelope.payloadDir)).toBe(envelope.payloadDir);
  });

  // Context ids are free-form (`z.string().trim().min(1)`), and sanitizing an
  // unsafe character to `_` is lossy: "a/b" and "a?b" both reduce to "a_b". Two
  // distinct concurrent siblings collapsing onto one payload directory
  // would overwrite private inputs — they would overwrite each other's
  // payload files while both envelopes still looked correct.
  it("keeps sibling contexts disjoint even when their ids sanitize to the same segment", () => {
    const first = compose({ contextId: "a/b" });
    const second = compose({ contextId: "a?b" });

    expectDistinctOnDisk(first, second);
  });

  // Two ids can be distinct strings, encode to distinct segments, and still
  // name ONE directory: a case-insensitive volume — the macOS default — folds
  // "ctx-1" and "CTX-1" together. Isolation is a filesystem property, so the
  // encoding has to be injective under the filesystem's comparison, not only
  // under `===`.
  it("keeps sibling contexts disjoint when their ids differ only in case", () => {
    const first = compose({ contextId: "ctx-1" });
    const second = compose({ contextId: "CTX-1" });

    expectDistinctOnDisk(first, second);
  });

  // A lone surrogate is a valid JS string and a valid context id, but it has no
  // UTF-8 form: anything that encodes the id before deriving a name substitutes
  // U+FFFD for EVERY lone surrogate, collapsing ids that differ only there onto
  // one payload directory. Distinct ids must remain distinct on disk.
  it("keeps sibling contexts disjoint when their ids share a UTF-8 encoding", () => {
    const first = compose({ contextId: String.fromCharCode(0xd800) });
    const second = compose({ contextId: String.fromCharCode(0xd801) });

    expectDistinctOnDisk(first, second);
  });

  it("derives a stable directory for one context id across compositions", () => {
    // Uniqueness must not come from randomness: the same context has to find
    // its own payloads again on its next turn.
    expect(compose({ contextId: "a/b" }).payloadDir).toBe(
      compose({ contextId: "a/b" }).payloadDir,
    );
  });

  // The temp lives outside the worktree at a fixed-width digest name:
  // the run's `$TMPDIR` hosts the sandbox's AF_UNIX bridge sockets, so its
  // length must not grow with authored ids.
  it("places the context temp at a canonical fixed-width digest path outside the worktree", () => {
    const envelope = compose();

    expect(path.basename(envelope.contextTmpDir)).toMatch(/^[0-9a-f]{32}$/);
    expect(
      envelope.contextTmpDir.startsWith(`${envelope.worktreeRoot}${path.sep}`),
    ).toBe(false);
    expect(realpathSync(envelope.contextTmpDir)).toBe(envelope.contextTmpDir);
    // Uniqueness must not come from randomness: the same context has to find
    // its own temp again on its next turn.
    expect(compose().contextTmpDir).toBe(envelope.contextTmpDir);
  });

  it("refuses composition when the canonical temp entry would exceed the AF_UNIX budget", () => {
    const deepTmpRoot = path.join(fixtureRoot, "t".repeat(80));

    expect(() => compose({ tmpRootDir: deepTmpRoot })).toThrow(
      /AF_UNIX budget/i,
    );
  });

  // Incident regression (ticket #5): the Claude sandbox on Linux creates its
  // socat bridge sockets inside the run's `$TMPDIR`, which the adapters point
  // at the policy's temp entry. With the temp nested under the default scratch
  // root, a UUID execution id alone pushed the socket path past the AF_UNIX
  // 108-byte cap, so the sandbox could never initialize and every Bash call in
  // every implementer context failed closed. The claim is about the PRODUCTION
  // path shape, so this test composes with the default roots rather than the
  // fixture's.
  it("keeps the temp entry inside the AF_UNIX byte budget the sandbox's bridge sockets need", () => {
    const executionId = "00000000-0000-4000-8000-000000000000";
    const envelope = composeImplementerLaneWriteEnvelope({
      executionId,
      contextId: "context-implement-long-name",
      worktreePath,
    });
    try {
      expect(Buffer.byteLength(envelope.contextTmpDir)).toBeLessThanOrEqual(
        MAX_LANE_TMP_DIR_BYTES,
      );
      expect(envelope.policy.allowWrite.at(-1)).toBe(envelope.contextTmpDir);
    } finally {
      rmSync(envelope.contextTmpDir, { recursive: true, force: true });
    }
  });

  it("throws when the worktree root cannot be resolved", () => {
    expect(() =>
      compose({ worktreePath: path.join(fixtureRoot, "no-such-worktree") }),
    ).toThrow(/worktree write boundary/i);
  });
});

/**
 * The cases an envelope is actually attacked by. Each one is a path that LOOKS
 * contained by every check that runs before the filesystem is consulted.
 */
describe("composeImplementerLaneWriteEnvelope adversarial inputs", () => {
  it("resolves the worktree root through a symlinked parent so allow entries are canonical", () => {
    const linkedParent = path.join(fixtureRoot, "link-to-fixture");
    symlinkSync(fixtureRoot, linkedParent, "dir");

    const envelope = compose({
      worktreePath: path.join(linkedParent, "worktree"),
    });

    // Every allow entry must be stated in the same canonical terms enforcement
    // will compare against, not in the terms the caller happened to pass.
    expect(envelope.worktreeRoot).toBe(realpathSync(worktreePath));
    expect(envelope.policy.allowWrite).toContain(realpathSync(worktreePath));
    for (const entry of envelope.policy.allowWrite) {
      expect(realpathSync(entry)).toBe(entry);
    }
  });

  it("rejects a payload symlink outside the worktree before creating directories there", () => {
    const outside = path.join(fixtureRoot, "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(worktreePath, ".cc"), "dir");

    expect(() => compose()).toThrow(/outside the worktree/i);
    expect(() => realpathSync(path.join(outside, "temp"))).toThrow();
  });

  it("sanitizes an adversarial context id out of every generated segment", () => {
    const envelope = compose({ contextId: "../../escape/../../etc" });

    expect(
      envelope.payloadDir.startsWith(
        path.join(realpathSync(worktreePath), ".cc", "temp") + path.sep,
      ),
    ).toBe(true);
    expect(path.basename(envelope.payloadDir)).not.toContain("/");
    expect(path.basename(envelope.payloadDir)).not.toBe("..");
  });
});

describe("authored ownership refuses the engine's own namespace", () => {
  it("rejects a .cc owned path at accept time", () => {
    const result = ownedPathSchema.safeParse(".cc/temp/context-build");

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/\.cc namespace/i);
  });

  it("rejects a .cc owned path whatever its case", () => {
    expect(ownedPathSchema.safeParse(".CC/temp").success).toBe(false);
  });

  it("still accepts an ordinary repo-relative path", () => {
    expect(ownedPathSchema.safeParse("src/lib/workspace").success).toBe(true);
  });
});
