import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import { createProjectsRepo, type ProjectsRepo } from "./projects-repo";
import { projectRowSchema } from "../schemas";
import type { ProjectRow } from "@/types";

type Db = InstanceType<typeof Database>;

let db: Db;
let repo: ProjectsRepo;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  repo = createProjectsRepo(db);
});

afterEach(() => {
  db.close();
});

describe("projects-repo round-trip contract", () => {
  it("upsert + setArchived + setPinned + reorderPinned + findByRootPath round-trips every field permutation", () => {
    const fixtures = [
      { rootPath: "/p-bare" },
      {
        rootPath: "/p-overrides",
        mcpOverrides: {
          servers: {
            stripe: { enabled: true, tools: { charge: { enabled: false } } },
            github: { enabled: false },
          },
        },
      },
    ] as const;

    for (const fix of fixtures) {
      repo.upsert(fix);
    }
    repo.setArchived("/p-bare", true);
    repo.setPinned("/p-overrides", true);
    repo.reorderPinned(["/p-overrides"]);

    const bare = repo.findByRootPath("/p-bare");
    expect(bare).not.toBeNull();
    if (!bare) return;
    expect(bare.archived).toBe(true);
    expect(bare.pinned).toBe(false);
    expect(bare.pinOrder).toBeNull();
    expect(bare.mcpOverrides).toBeUndefined();

    const overrides = repo.findByRootPath("/p-overrides");
    expect(overrides).not.toBeNull();
    if (!overrides) return;
    expect(overrides.archived).toBe(false);
    expect(overrides.pinned).toBe(true);
    expect(overrides.pinOrder).toBe(0);
    expect(overrides.mcpOverrides).toEqual({
      servers: {
        stripe: { enabled: true, tools: { charge: { enabled: false } } },
        github: { enabled: false },
      },
    });

    const reparsedBare = projectRowSchema.parse(bare);
    const reparsedOverrides = projectRowSchema.parse(overrides);
    expect(reparsedBare).toEqual(bare);
    expect(reparsedOverrides).toEqual(overrides);
  });

  it("findByRootPath output is stable across a write-then-read cycle", () => {
    repo.upsert({
      rootPath: "/stable",
      mcpOverrides: { servers: { x: { enabled: true } } },
    });
    repo.setPinned("/stable", true);
    repo.reorderPinned(["/stable"]);

    const first = repo.findByRootPath("/stable") as ProjectRow;
    repo.upsert({
      rootPath: "/stable",
      mcpOverrides: { servers: { x: { enabled: true } } },
    });
    const second = repo.findByRootPath("/stable") as ProjectRow;

    expect({ ...second, updatedAt: first.updatedAt }).toEqual(first);
  });
});

describe("projects-repo cascading-FK invariant", () => {
  it("upsert on an existing project does not delete child sessions", () => {
    repo.upsert({ rootPath: "/parent" });

    db.prepare(
      `INSERT INTO sessions
        (project_path, session_name, worktree_path, branch_name,
         created_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "/parent",
      "child-1",
      "/wt/child-1",
      "csm/child-1",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    );
    db.prepare(
      `INSERT INTO sessions
        (project_path, session_name, worktree_path, branch_name,
         created_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "/parent",
      "child-2",
      "/wt/child-2",
      "csm/child-2",
      "2026-01-02T00:00:00Z",
      "2026-01-02T00:00:00Z",
    );

    const beforeCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM sessions WHERE project_path = ?")
        .get("/parent") as { n: number }
    ).n;
    expect(beforeCount).toBe(2);

    repo.upsert({
      rootPath: "/parent",
      mcpOverrides: { servers: { foo: { enabled: true } } },
    });

    const afterCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM sessions WHERE project_path = ?")
        .get("/parent") as { n: number }
    ).n;
    expect(afterCount).toBe(2);

    const updated = repo.findByRootPath("/parent");
    expect(updated?.mcpOverrides).toEqual({
      servers: { foo: { enabled: true } },
    });
  });

  it("delete on a project cascades to its sessions (sanity)", () => {
    repo.upsert({ rootPath: "/parent" });
    db.prepare(
      `INSERT INTO sessions
        (project_path, session_name, worktree_path, branch_name,
         created_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "/parent",
      "child-1",
      "/wt/child-1",
      "csm/child-1",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    );

    repo.delete("/parent");

    const after = (
      db
        .prepare("SELECT COUNT(*) AS n FROM sessions WHERE project_path = ?")
        .get("/parent") as { n: number }
    ).n;
    expect(after).toBe(0);
  });
});
