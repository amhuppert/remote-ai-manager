import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeOwnership,
  classifyLaneAdmission,
  type CanonicalOwnership,
} from "./lane-admission";

/**
 * A real directory tree, because the subject is what `realpath` answers: a fake
 * filesystem would only prove the fake resolves symlinks the way the fake was
 * told to. `realpathSync` on the mkdtemp result up front so the expectations
 * compare canonical-to-canonical (`/tmp` is a symlink on macOS).
 */
function makeWorktree(): string {
  return realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "cc-lane-admission-")),
  );
}

function owned(...canonicalPrefixes: string[]): CanonicalOwnership {
  return { mode: "owned", canonicalPrefixes };
}

describe("classifyLaneAdmission", () => {
  it("admits two owners whose canonical prefixes are disjoint", () => {
    const verdict = classifyLaneAdmission({
      candidate: owned("/w/src/api"),
      occupants: [{ contextId: "ctx-ui", ownership: owned("/w/src/ui") }],
    });
    expect(verdict).toEqual({ kind: "admit" });
  });

  it("refuses an owner whose prefix is nested inside an occupant's prefix", () => {
    const verdict = classifyLaneAdmission({
      candidate: owned("/w/src/ui/panel"),
      occupants: [{ contextId: "ctx-ui", ownership: owned("/w/src/ui") }],
    });
    expect(verdict).toEqual({
      kind: "refuse",
      reason: "ownership-collision",
      blockingContextId: "ctx-ui",
      collidingPrefixes: ["/w/src/ui/panel", "/w/src/ui"],
    });
  });

  it("does not treat a sibling sharing a name prefix as a collision", () => {
    const verdict = classifyLaneAdmission({
      candidate: owned("/w/src/libraries"),
      occupants: [{ contextId: "ctx-lib", ownership: owned("/w/src/lib") }],
    });
    expect(verdict).toEqual({ kind: "admit" });
  });

  it("admits a read-only candidate alongside a full-access occupant", () => {
    const verdict = classifyLaneAdmission({
      candidate: { mode: "readOnly", canonicalPrefixes: [] },
      occupants: [
        {
          contextId: "ctx-all",
          ownership: { mode: "full", canonicalPrefixes: [] },
        },
      ],
    });
    expect(verdict).toEqual({ kind: "admit" });
  });

  it("refuses a full-access candidate against any write-capable occupant", () => {
    const verdict = classifyLaneAdmission({
      candidate: { mode: "full", canonicalPrefixes: [] },
      occupants: [{ contextId: "ctx-ui", ownership: owned("/w/src/ui") }],
    });
    expect(verdict).toEqual({
      kind: "refuse",
      reason: "full-access-exclusive",
      blockingContextId: "ctx-ui",
      collidingPrefixes: null,
    });
  });

  it("refuses an owning candidate against a full-access occupant", () => {
    const verdict = classifyLaneAdmission({
      candidate: owned("/w/src/ui"),
      occupants: [
        {
          contextId: "ctx-all",
          ownership: { mode: "full", canonicalPrefixes: [] },
        },
      ],
    });
    expect(verdict).toEqual({
      kind: "refuse",
      reason: "full-access-exclusive",
      blockingContextId: "ctx-all",
      collidingPrefixes: null,
    });
  });

  it("admits a full-access candidate when every occupant is read-only", () => {
    const verdict = classifyLaneAdmission({
      candidate: { mode: "full", canonicalPrefixes: [] },
      occupants: [
        {
          contextId: "ctx-read",
          ownership: { mode: "readOnly", canonicalPrefixes: [] },
        },
      ],
    });
    expect(verdict).toEqual({ kind: "admit" });
  });
});

describe("canonicalizeOwnership", () => {
  it("resolves owned prefixes against the lane worktree root", () => {
    const root = makeWorktree();
    mkdirSync(path.join(root, "src/api"), { recursive: true });

    const ownership = canonicalizeOwnership({
      placement: { lane: "impl", mode: "owned", ownedPaths: ["src/api"] },
      laneWorktreePath: root,
    });

    expect(ownership).toEqual({
      mode: "owned",
      canonicalPrefixes: [path.join(root, "src/api")],
    });
  });

  it("canonicalizes a prefix that does not exist yet via its longest existing ancestor", () => {
    const root = makeWorktree();
    mkdirSync(path.join(root, "src"), { recursive: true });

    const ownership = canonicalizeOwnership({
      placement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/not/created/yet"],
      },
      laneWorktreePath: root,
    });

    expect(ownership.canonicalPrefixes).toEqual([
      path.join(root, "src/not/created/yet"),
    ]);
  });

  it("makes two lexically disjoint prefixes collide when a symlink aliases them", () => {
    // The exact case definition validation cannot see: `src/mirror` and
    // `src/api` are disjoint strings, but `src/mirror` IS `src/api` on disk.
    const root = makeWorktree();
    mkdirSync(path.join(root, "src/api"), { recursive: true });
    symlinkSync(path.join(root, "src/api"), path.join(root, "src/mirror"));

    const owner = canonicalizeOwnership({
      placement: { lane: "impl", mode: "owned", ownedPaths: ["src/api"] },
      laneWorktreePath: root,
    });
    const aliased = canonicalizeOwnership({
      placement: { lane: "impl", mode: "owned", ownedPaths: ["src/mirror"] },
      laneWorktreePath: root,
    });

    expect(aliased.canonicalPrefixes).toEqual(owner.canonicalPrefixes);
    expect(
      classifyLaneAdmission({
        candidate: aliased,
        occupants: [{ contextId: "ctx-api", ownership: owner }],
      }),
    ).toMatchObject({ kind: "refuse", reason: "ownership-collision" });
  });

  it("resolves a symlink whose target does not exist yet, so the alias is visible before it materializes", () => {
    // `realpath` and `mkdir -p` both fail on a dangling link, and Git leaves
    // them behind routinely because it does not track empty directories.
    const root = makeWorktree();
    mkdirSync(path.join(root, "src"), { recursive: true });
    symlinkSync("generated", path.join(root, "src/mirror"));

    const aliased = canonicalizeOwnership({
      placement: { lane: "impl", mode: "owned", ownedPaths: ["src/mirror"] },
      laneWorktreePath: root,
    });
    const target = canonicalizeOwnership({
      placement: { lane: "impl", mode: "owned", ownedPaths: ["src/generated"] },
      laneWorktreePath: root,
    });

    expect(aliased.canonicalPrefixes).toEqual([
      path.join(root, "src/generated"),
    ]);
    expect(aliased.canonicalPrefixes).toEqual(target.canonicalPrefixes);
    expect(
      classifyLaneAdmission({
        candidate: aliased,
        occupants: [{ contextId: "ctx-generated", ownership: target }],
      }),
    ).toMatchObject({ kind: "refuse", reason: "ownership-collision" });
  });

  it("resolves a symlink whose target passes through another symlinked directory", () => {
    // Following a link is not enough: its target is itself a path, and any
    // component of it can be a link too. `src/mirror` and `src/api/handlers`
    // are one directory reached two ways.
    const root = makeWorktree();
    mkdirSync(path.join(root, "src/api/handlers"), { recursive: true });
    symlinkSync("api", path.join(root, "src/alias"));
    symlinkSync("alias/handlers", path.join(root, "src/mirror"));

    const aliased = canonicalizeOwnership({
      placement: { lane: "impl", mode: "owned", ownedPaths: ["src/mirror"] },
      laneWorktreePath: root,
    });
    const target = canonicalizeOwnership({
      placement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/api/handlers"],
      },
      laneWorktreePath: root,
    });

    expect(aliased.canonicalPrefixes).toEqual([
      path.join(root, "src/api/handlers"),
    ]);
    expect(aliased.canonicalPrefixes).toEqual(target.canonicalPrefixes);
    expect(
      classifyLaneAdmission({
        candidate: aliased,
        occupants: [{ contextId: "ctx-handlers", ownership: target }],
      }),
    ).toMatchObject({ kind: "refuse", reason: "ownership-collision" });
  });

  it("resolves a dangling symlink whose target passes through a symlinked directory", () => {
    // The two gaps combined: nothing on this path exists to `realpath`, and the
    // alias only becomes visible after resolving `alias` as well as `mirror`.
    const root = makeWorktree();
    mkdirSync(path.join(root, "src/api"), { recursive: true });
    symlinkSync("api", path.join(root, "src/alias"));
    symlinkSync("alias/generated", path.join(root, "src/mirror"));

    const aliased = canonicalizeOwnership({
      placement: { lane: "impl", mode: "owned", ownedPaths: ["src/mirror"] },
      laneWorktreePath: root,
    });
    const target = canonicalizeOwnership({
      placement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/api/generated"],
      },
      laneWorktreePath: root,
    });

    expect(aliased.canonicalPrefixes).toEqual([
      path.join(root, "src/api/generated"),
    ]);
    expect(aliased.canonicalPrefixes).toEqual(target.canonicalPrefixes);
    expect(
      classifyLaneAdmission({
        candidate: aliased,
        occupants: [{ contextId: "ctx-generated", ownership: target }],
      }),
    ).toMatchObject({ kind: "refuse", reason: "ownership-collision" });
  });

  it("refuses an owned prefix that escapes through a symlinked ancestor of a link target", () => {
    const root = makeWorktree();
    const outside = makeWorktree();
    mkdirSync(path.join(root, "src"), { recursive: true });
    symlinkSync(outside, path.join(root, "src/away"));
    symlinkSync("away/work", path.join(root, "src/escape"));

    expect(() =>
      canonicalizeOwnership({
        placement: { lane: "impl", mode: "owned", ownedPaths: ["src/escape"] },
        laneWorktreePath: root,
      }),
    ).toThrow(/escapes the lane worktree/);
  });

  it("refuses an owned prefix whose symlink leaves the lane worktree", () => {
    const root = makeWorktree();
    const outside = makeWorktree();
    mkdirSync(path.join(root, "src"), { recursive: true });
    symlinkSync(outside, path.join(root, "src/escape"));

    expect(() =>
      canonicalizeOwnership({
        placement: { lane: "impl", mode: "owned", ownedPaths: ["src/escape"] },
        laneWorktreePath: root,
      }),
    ).toThrow(/escapes the lane worktree/);
  });

  // Root bypasses the permission bits, so the unreadable directory would be
  // readable and the probe would never fail.
  const isRoot = process.getuid?.() === 0;

  it.skipIf(isRoot)(
    "fails closed when a component probe fails for a reason other than absence",
    () => {
      // An unreadable ancestor makes the probe unable to say whether the
      // component below it is a symlink. Treating that as "not a symlink"
      // freezes the authored spelling, which is the lexical fallback the
      // enforcement precedent forbids: the moment the error clears, the prefix
      // may alias one already admitted.
      const root = makeWorktree();
      const locked = path.join(root, "src/locked");
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o000);

      try {
        expect(() =>
          canonicalizeOwnership({
            placement: {
              lane: "impl",
              mode: "owned",
              ownedPaths: ["src/locked/inner"],
            },
            laneWorktreePath: root,
          }),
        ).toThrow(/EACCES|permission denied/i);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );

  it("treats a prefix under a regular file as absent rather than a probe failure", () => {
    // `ENOTDIR`, not `ENOENT`, but still genuine non-existence: nothing can be
    // created under a regular file, so this prefix aliases nothing and must not
    // fail the pass closed.
    const root = makeWorktree();
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src/config.ts"), "export {};");

    const ownership = canonicalizeOwnership({
      placement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/config.ts/nested"],
      },
      laneWorktreePath: root,
    });

    expect(ownership.canonicalPrefixes).toEqual([
      path.join(root, "src/config.ts/nested"),
    ]);
  });

  it("declares no prefixes for full-access and read-only placements", () => {
    const root = makeWorktree();
    expect(
      canonicalizeOwnership({
        placement: { lane: "impl", mode: "full" },
        laneWorktreePath: root,
      }),
    ).toEqual({ mode: "full", canonicalPrefixes: [] });
    expect(
      canonicalizeOwnership({
        placement: { lane: "session", mode: "readOnly" },
        laneWorktreePath: root,
      }),
    ).toEqual({ mode: "readOnly", canonicalPrefixes: [] });
  });
});
