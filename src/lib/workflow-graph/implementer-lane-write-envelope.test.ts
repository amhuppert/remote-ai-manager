/**
 * The server-derived write envelope an implementer context runs under (R6, D6).
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
import { ownedPathSchema } from "./definition-schemas";
import { composeImplementerLaneWriteEnvelope } from "./implementer-lane-write-envelope";

let fixtureRoot: string;
let worktreePath: string;
let scratchRootDir: string;

function compose(
  overrides: {
    contextId?: string;
    executionId?: string;
    worktreePath?: string;
    ownedPaths?: readonly string[];
  } = {},
) {
  return composeImplementerLaneWriteEnvelope(
    {
      executionId: overrides.executionId ?? "exec-1",
      contextId: overrides.contextId ?? "context-build",
      worktreePath: overrides.worktreePath ?? worktreePath,
      ownedPaths: overrides.ownedPaths ?? [],
    },
    { scratchRootDir },
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

/**
 * The whole claim R6 makes about two concurrent siblings: distinct private
 * directories is the weaker half, and the half that matters is that NEITHER
 * envelope's allowlist reaches the other's — otherwise a context stays inside
 * its own apparent policy while mutating its sibling's scratch or payload.
 */
function expectMechanicallyIsolated(
  first: ReturnType<typeof compose>,
  second: ReturnType<typeof compose>,
): void {
  expect(first.contextScratchDir).not.toBe(second.contextScratchDir);
  expect(first.contextTmpDir).not.toBe(second.contextTmpDir);
  expect(first.payloadDir).not.toBe(second.payloadDir);

  for (const [mine, theirs] of [
    [first, second],
    [second, first],
  ] as const) {
    for (const priv of [
      theirs.contextScratchDir,
      theirs.contextTmpDir,
      theirs.payloadDir,
    ]) {
      expect(
        mine.policy.allowWrite.filter((allowed) => coversPath(allowed, priv)),
      ).toEqual([]);
    }
  }
}

/** The three directories the composer derives per context and nothing else. */
const PRIVATE_DIRS = [
  "contextScratchDir",
  "contextTmpDir",
  "payloadDir",
] as const;

/**
 * The same claim as {@link expectMechanicallyIsolated}, asked of the FILESYSTEM
 * rather than of path arithmetic. Two directory names that differ as JavaScript
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
  scratchRootDir = path.join(fixtureRoot, "scratch");
  mkdirSync(path.join(worktreePath, "src", "lib"), { recursive: true });
  writeFileSync(path.join(worktreePath, "README.md"), "# fixture\n");
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("composeImplementerLaneWriteEnvelope", () => {
  it("allows the owned prefixes, per-context scratch, the payload directory and tmp, and denies .git", () => {
    const canonicalRoot = realpathSync(worktreePath);

    const envelope = compose({ ownedPaths: ["src/lib", "README.md"] });

    expect(envelope.policy).toEqual({
      mode: "allowlist",
      allowWrite: [
        envelope.contextScratchDir,
        path.join(canonicalRoot, "src", "lib"),
        path.join(canonicalRoot, "README.md"),
        envelope.payloadDir,
        envelope.contextTmpDir,
      ],
      denyWrite: [path.join(canonicalRoot, ".git")],
    });
  });

  it("resolves an existing and a not-yet-existing prefix through the same model, creating neither", () => {
    const canonicalRoot = realpathSync(worktreePath);

    const envelope = compose({
      ownedPaths: ["src/lib", "docs/adr/0001-new.md"],
    });

    expect(envelope.policy.allowWrite).toContain(
      path.join(canonicalRoot, "docs", "adr", "0001-new.md"),
    );
    // A not-yet-existing owned path is a declaration, not a request to
    // provision: resolving it must leave the worktree exactly as it was.
    expect(() => realpathSync(path.join(worktreePath, "docs"))).toThrow();
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

  it("gives concurrent sibling contexts of one execution disjoint scratch directories", () => {
    const first = compose({ contextId: "context-a" });
    const second = compose({ contextId: "context-b" });

    expect(first.contextScratchDir).not.toBe(second.contextScratchDir);
    expect(first.payloadDir).not.toBe(second.payloadDir);
    expect(
      first.contextTmpDir.startsWith(`${second.contextScratchDir}${path.sep}`),
    ).toBe(false);
  });

  // Context ids are free-form (`z.string().trim().min(1)`), and sanitizing an
  // unsafe character to `_` is lossy: "a/b" and "a?b" both reduce to "a_b". Two
  // distinct concurrent siblings collapsing onto one scratch/payload directory
  // is precisely the sharing R6 forbids — they would overwrite each other's
  // payload files while both envelopes still looked correct.
  it("keeps sibling contexts disjoint even when their ids sanitize to the same segment", () => {
    const first = compose({ contextId: "a/b" });
    const second = compose({ contextId: "a?b" });

    expectMechanicallyIsolated(first, second);
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

    expectMechanicallyIsolated(first, second);
    expectDistinctOnDisk(first, second);
  });

  // A lone surrogate is a valid JS string and a valid context id, but it has no
  // UTF-8 form: anything that encodes the id before deriving a name substitutes
  // U+FFFD for EVERY lone surrogate, collapsing ids that differ only there onto
  // one scratch and one payload directory. The isolation this envelope sells is
  // mechanical, so it has to hold for ids nobody would author by hand.
  it("keeps sibling contexts disjoint when their ids share a UTF-8 encoding", () => {
    const first = compose({ contextId: String.fromCharCode(0xd800) });
    const second = compose({ contextId: String.fromCharCode(0xd801) });

    expectMechanicallyIsolated(first, second);
    expectDistinctOnDisk(first, second);
  });

  it("derives a stable directory for one context id across compositions", () => {
    // Uniqueness must not come from randomness: the same context has to find
    // its own scratch again on its next turn.
    expect(compose({ contextId: "a/b" }).contextScratchDir).toBe(
      compose({ contextId: "a/b" }).contextScratchDir,
    );
  });

  it("nests the context tmp directory beneath the context scratch directory", () => {
    const envelope = compose();

    expect(path.dirname(envelope.contextTmpDir)).toBe(
      envelope.contextScratchDir,
    );
    expect(realpathSync(envelope.contextTmpDir)).toBe(envelope.contextTmpDir);
  });

  it("composes a read-only context's envelope from scratch, payload, and tmp alone", () => {
    const envelope = compose({ ownedPaths: [] });

    expect(envelope.policy.allowWrite).toEqual([
      envelope.contextScratchDir,
      envelope.payloadDir,
      envelope.contextTmpDir,
    ]);
  });

  it("throws when the worktree root cannot be resolved", () => {
    expect(() =>
      compose({ worktreePath: path.join(fixtureRoot, "no-such-worktree") }),
    ).toThrow(/implementer write envelope/i);
  });

  it("throws when an owned prefix escapes the worktree root", () => {
    expect(() => compose({ ownedPaths: ["../outside"] })).toThrow(
      /escapes|implementer write envelope/i,
    );
  });

  it("throws when an owned prefix names repository metadata", () => {
    expect(() => compose({ ownedPaths: [".git/config"] })).toThrow(
      /implementer write envelope/i,
    );
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
      ownedPaths: ["src/lib"],
    });

    // Every allow entry must be stated in the same canonical terms enforcement
    // will compare against, not in the terms the caller happened to pass.
    expect(envelope.worktreeRoot).toBe(realpathSync(worktreePath));
    expect(envelope.policy.allowWrite).toContain(
      path.join(realpathSync(worktreePath), "src", "lib"),
    );
    for (const entry of envelope.policy.allowWrite) {
      expect(realpathSync(entry)).toBe(entry);
    }
  });

  it("refuses an owned path that is a symlink out of the worktree", () => {
    const outside = path.join(fixtureRoot, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(worktreePath, "escape-link"), "dir");

    expect(() => compose({ ownedPaths: ["escape-link"] })).toThrow(
      /outside the worktree/i,
    );
  });

  it("refuses an owned path whose PARENT is a symlink out of the worktree", () => {
    const outside = path.join(fixtureRoot, "outside-parent");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(worktreePath, "linked-dir"), "dir");

    // The leaf does not exist, so only the resolved ancestor reveals the escape.
    expect(() => compose({ ownedPaths: ["linked-dir/child.ts"] })).toThrow(
      /outside the worktree/i,
    );
  });

  it("resolves a file prefix and a directory prefix through the same model", () => {
    const canonicalRoot = realpathSync(worktreePath);

    const envelope = compose({ ownedPaths: ["README.md", "src/lib"] });

    expect(envelope.ownedPrefixes).toEqual([
      path.join(canonicalRoot, "README.md"),
      path.join(canonicalRoot, "src", "lib"),
    ]);
  });

  it("sanitizes an adversarial context id out of every generated segment", () => {
    const envelope = compose({ contextId: "../../escape/../../etc" });

    expect(
      envelope.contextScratchDir.startsWith(`${scratchRootDir}${path.sep}`),
    ).toBe(true);
    expect(
      envelope.payloadDir.startsWith(
        path.join(realpathSync(worktreePath), ".cc", "temp") + path.sep,
      ),
    ).toBe(true);
    expect(path.basename(envelope.payloadDir)).not.toContain("/");
    expect(path.basename(envelope.payloadDir)).not.toBe("..");
  });

  it("refuses an owned path that reaches .git through a differently-cased segment", () => {
    // A case-insensitive filesystem resolves `.GIT` to the same directory, so
    // the refusal has to survive resolution rather than a literal comparison.
    mkdirSync(path.join(worktreePath, ".git", "refs"), { recursive: true });

    expect(() => compose({ ownedPaths: [".git/refs"] })).toThrow(
      /repository metadata/i,
    );
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
    expect(ownedPathSchema.safeParse("src/lib/workflow-graph").success).toBe(
      true,
    );
  });
});
