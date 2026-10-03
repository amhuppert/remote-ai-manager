import { describe, expect, it } from "vitest";
import {
  createWorkspaceAdmission,
  grantsConflict,
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
