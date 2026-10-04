import type { WorkspaceBindingRequest } from "./schemas";
import { describe, expect, it } from "vitest";
import {
  bindingScopesOverlap,
  createWorkspaceAdmission,
  grantsConflict,
  turnWorkspaceAccess,
  type GrantRequest,
} from "./admission";

const wt = "/repo/.worktrees/session";
const grant = (
  kind: GrantRequest["kind"],
  paths?: string[],
  worktree = wt,
): GrantRequest => ({
  worktree,
  kind,
  ...(paths !== undefined ? { paths } : {}),
  holder: kind,
});

describe("workspace conflict relation", () => {
  it("never blocks interactive turns on supervised work or reviews, only on Git operations", () => {
    for (const other of [
      grant("interactive_write"),
      grant("scoped_write", ["src/a"]),
      grant("full_write"),
      grant("stable_read"),
    ]) {
      expect(grantsConflict(grant("interactive_write"), other)).toBe(false);
    }
    expect(grantsConflict(grant("interactive_write"), grant("git"))).toBe(true);
  });

  it("lets scoped writers overlap only when their scopes are disjoint", () => {
    expect(
      grantsConflict(
        grant("scoped_write", ["src/api"]),
        grant("scoped_write", ["src/ui"]),
      ),
    ).toBe(false);
    expect(
      grantsConflict(
        grant("scoped_write", ["src/api"]),
        grant("scoped_write", ["src/api/routes"]),
      ),
    ).toBe(true);
    expect(
      grantsConflict(grant("scoped_write", ["src/api"]), grant("full_write")),
    ).toBe(true);
  });

  it("protects a stable read from supervised writes inside its scope", () => {
    expect(
      grantsConflict(grant("stable_read"), grant("scoped_write", ["src/api"])),
    ).toBe(true);
    expect(
      grantsConflict(
        grant("stable_read", ["src/ui"]),
        grant("scoped_write", ["src/api"]),
      ),
    ).toBe(false);
    expect(grantsConflict(grant("stable_read"), grant("stable_read"))).toBe(
      false,
    );
    expect(grantsConflict(grant("stable_read"), grant("full_write"))).toBe(
      true,
    );
  });

  it("serializes Git operations against every write and stable read, and nothing across worktrees", () => {
    expect(grantsConflict(grant("git"), grant("stable_read"))).toBe(true);
    expect(grantsConflict(grant("git"), grant("observe"))).toBe(false);
    expect(
      grantsConflict(
        grant("git"),
        grant("full_write", undefined, "/repo/.worktrees/other"),
      ),
    ).toBe(false);
  });
});

describe("supervised binding overlap", () => {
  const full = { mode: "full" } as const;
  const readOnly = { mode: "readOnly" } as const;
  const owned = (...paths: string[]) => ({ mode: "owned", paths }) as const;

  it("keeps a read-only binding apart from every writer, whose changes would enter its whole-tree evidence", () => {
    expect(bindingScopesOverlap(readOnly, full)).toBe(true);
    expect(bindingScopesOverlap(owned("src/api"), readOnly)).toBe(true);
    expect(bindingScopesOverlap(readOnly, readOnly)).toBe(false);
  });

  it("separates writers by scope: full overlaps everything, owned scopes only when one contains the other", () => {
    expect(bindingScopesOverlap(full, owned("docs"))).toBe(true);
    expect(bindingScopesOverlap(owned("src/lib"), owned("src/lib/runs"))).toBe(true);
    expect(bindingScopesOverlap(owned("src/api"), owned("src/ui"))).toBe(false);
    expect(bindingScopesOverlap(owned("src/api"), owned("src/apiary"))).toBe(false);
    // A case-insensitive disk would give both spellings the same files.
    expect(bindingScopesOverlap(owned("src/API"), owned("src/api/routes"))).toBe(true);
  });
});

describe("a supervised turn's workspace access", () => {
  const placement = (scope: WorkspaceBindingRequest["scope"]): WorkspaceBindingRequest => ({
    kind: "session",
    projectPath: "/repo",
    sessionName: "session",
    worktreePath: wt,
    scope,
  });
  const access = (scope: WorkspaceBindingRequest["scope"], need: "write" | "stable_read" | "observe", role: "implementer" | "reviewer") => {
    const { grant, writes } = turnWorkspaceAccess({ binding: placement(scope), need, role });
    return { grant, writes };
  };

  it("lets an implementer's writing turn hold a write grant over its scope and write only there", () => {
    expect(access({ mode: "owned", paths: ["src/api"] }, "write", "implementer")).toEqual({
      grant: { kind: "scoped_write", paths: ["src/api"] },
      writes: { mode: "paths", paths: ["src/api"] },
    });
    expect(access({ mode: "full" }, "write", "implementer")).toEqual({
      grant: { kind: "full_write" },
      writes: { mode: "all" },
    });
  });

  it("keeps an owned or read-only implementer's limits on turns that take no grant", () => {
    expect(access({ mode: "owned", paths: ["src/api"] }, "observe", "implementer")).toEqual({
      grant: null,
      writes: { mode: "paths", paths: ["src/api"] },
    });
    expect(access({ mode: "readOnly" }, "write", "implementer")).toEqual({ grant: null, writes: { mode: "none" } });
  });

  it("gives a review a whole-tree stable read, with reviewers unconfined by decision", () => {
    expect(access({ mode: "owned", paths: ["src/api"] }, "stable_read", "reviewer")).toEqual({
      grant: { kind: "stable_read" },
      writes: { mode: "all" },
    });
  });
});

describe("workspace admission", () => {
  it("grants compatible requests at once and waits for conflicting ones in arrival order", async () => {
    const admission = createWorkspaceAdmission();
    const writer = admission.tryAcquire(grant("scoped_write", ["src/api"]));
    expect(writer).not.toBeNull();
    expect(admission.tryAcquire(grant("interactive_write"))).not.toBeNull();

    const publication = admission.acquire(grant("git"));
    // A later compatible writer must not overtake the waiting publication.
    expect(admission.tryAcquire(grant("scoped_write", ["src/ui"]))).toBeNull();
    expect(admission.blockers(grant("git")).map((g) => g.kind)).toEqual(
      expect.arrayContaining(["scoped_write", "interactive_write"]),
    );

    let granted = false;
    void publication.then(() => {
      granted = true;
    });
    if (writer === null) throw new Error("writer not granted");
    admission.release(writer);
    await Promise.resolve();
    expect(granted).toBe(false);
    for (const held of admission.held()) admission.release(held);
    await publication;
    expect(granted).toBe(true);
  });
});

describe("workspace admission change signal", () => {
  it("wakes a waiter when a grant is released", async () => {
    const admission = createWorkspaceAdmission();
    const held = admission.tryAcquire(grant("full_write"));
    let woke = false;
    const waiting = admission.waitForChange().then(() => {
      woke = true;
    });
    await Promise.resolve();
    expect(woke).toBe(false);
    if (held === null) throw new Error("not granted");
    admission.release(held);
    await waiting;
    expect(woke).toBe(true);
  });
});
