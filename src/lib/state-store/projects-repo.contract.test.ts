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
import { projectRowSchema } from "@/lib/projects/schemas";
import type { ProjectRow } from "@/lib/projects/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
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

describe("projects-repo focused override setters", () => {
  it("setMcpOverrides writes only mcp_overrides, preserving every sibling column", () => {
    repo.upsert({
      rootPath: "/p",
      agentCapabilityOverrides: {
        cascades: {
          "claude-skills": { items: { "skill:a": { enabled: false } } },
        },
      },
    });
    repo.setArchived("/p", true);
    repo.setPinned("/p", true);
    repo.reorderPinned(["/p"]);

    repo.setMcpOverrides("/p", { servers: { kagi: { enabled: false } } });

    const row = repo.findByRootPath("/p");
    expect(row).not.toBeNull();
    if (!row) return;
    expect(row.mcpOverrides).toEqual({ servers: { kagi: { enabled: false } } });
    // Siblings untouched by the focused setter.
    expect(row.agentCapabilityOverrides).toEqual({
      cascades: {
        "claude-skills": { items: { "skill:a": { enabled: false } } },
      },
    });
    expect(row.archived).toBe(true);
    expect(row.pinned).toBe(true);
    expect(row.pinOrder).toBe(0);
  });

  it("setMcpOverrides(undefined) clears the column without touching siblings", () => {
    repo.upsert({
      rootPath: "/p",
      mcpOverrides: { servers: { kagi: { enabled: false } } },
      agentCapabilityOverrides: {
        cascades: {
          "codex-skills": { items: { "codex:a": { enabled: true } } },
        },
      },
    });

    repo.setMcpOverrides("/p", undefined);

    const row = repo.findByRootPath("/p");
    expect(row?.mcpOverrides).toBeUndefined();
    expect(row?.agentCapabilityOverrides).toEqual({
      cascades: { "codex-skills": { items: { "codex:a": { enabled: true } } } },
    });
  });

  it("setAgentCapabilityOverrides writes only its column, preserving mcp_overrides and flags", () => {
    repo.upsert({
      rootPath: "/p",
      mcpOverrides: { servers: { kagi: { enabled: false } } },
    });
    repo.setArchived("/p", true);

    repo.setAgentCapabilityOverrides("/p", {
      cascades: {
        "claude-agents": { items: { "agent:a": { enabled: false } } },
      },
    });

    const row = repo.findByRootPath("/p");
    expect(row?.agentCapabilityOverrides).toEqual({
      cascades: {
        "claude-agents": { items: { "agent:a": { enabled: false } } },
      },
    });
    expect(row?.mcpOverrides).toEqual({
      servers: { kagi: { enabled: false } },
    });
    expect(row?.archived).toBe(true);
  });

  it("setAgentCapabilityOverrides(undefined) clears the column, preserving mcp_overrides", () => {
    repo.upsert({
      rootPath: "/p",
      mcpOverrides: { servers: { kagi: { enabled: false } } },
      agentCapabilityOverrides: {
        cascades: {
          "claude-skills": { items: { "skill:a": { enabled: false } } },
        },
      },
    });

    repo.setAgentCapabilityOverrides("/p", undefined);

    const row = repo.findByRootPath("/p");
    expect(row?.agentCapabilityOverrides).toBeUndefined();
    expect(row?.mcpOverrides).toEqual({
      servers: { kagi: { enabled: false } },
    });
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

/**
 * Build a project row with EVERY introspectable persisted key path populated to
 * a distinctive non-default value, so the schema-driven durability harness can
 * prove no column or JSON sub-tree is dropped on write or reset to its default
 * on read.
 *
 * Every scalar is non-default (`archived`/`pinned` true, `pinOrder` non-null),
 * and both JSON override blobs (`mcpOverrides`, `agentCapabilityOverrides`) carry
 * a representative cascade entry whose nested optional fields are all populated.
 *
 * `createdAt`/`updatedAt` are generated by the repo on write (SQLite
 * `datetime('now')` column defaults / the upsert's `updated_at` assignment), so
 * the fixture seeds placeholder timestamps to satisfy `parse`; the harness
 * `persist()` reloads after write and returns the actually-stored timestamps as
 * the `expected` value (see the `derived-on-write` policies below).
 */
function buildMaximalProject(): ProjectRow {
  return projectRowSchema.parse({
    rootPath: "/maximal-project",
    archived: true,
    pinned: true,
    pinOrder: 0,
    mcpOverrides: {
      servers: {
        stripe: {
          enabled: true,
          tools: {
            charge: { enabled: false },
          },
        },
      },
    },
    agentCapabilityOverrides: {
      cascades: {
        "codex-skills": {
          items: {
            "review-pr": { enabled: false },
          },
        },
      },
    },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
}

describe("projects-repo durability contract", () => {
  it("round-trips every persisted project key path through the real repo", async () => {
    await assertRoundTripDurability({
      label: "projects",
      schema: projectRowSchema,
      buildMaximalFixture: buildMaximalProject,
      persist: (fixture) => {
        // The projects repo splits writes across methods: `upsert` persists the
        // JSON override blobs, while `archived`/`pinned`/`pinOrder` are mutated
        // through dedicated setters. Drive all of them so every column lands at
        // its maximal non-default value.
        repo.upsert({
          rootPath: fixture.rootPath,
          mcpOverrides: fixture.mcpOverrides,
          agentCapabilityOverrides: fixture.agentCapabilityOverrides,
        });
        repo.setArchived(fixture.rootPath, fixture.archived);
        // setPinned resets pin_order to NULL, so apply it before reorderPinned.
        repo.setPinned(fixture.rootPath, fixture.pinned);
        repo.reorderPinned([fixture.rootPath]);

        // createdAt/updatedAt are generated by the write path; reload to capture
        // the actually-stored timestamps and return them as the expected value.
        const stored = repo.findByRootPath(fixture.rootPath);
        if (stored === null) {
          throw new Error(
            "project was not persisted by the maximal write path",
          );
        }
        return stored;
      },
      reload: (expected) => repo.findByRootPath(expected.rootPath),
      fieldPolicies: {
        // createdAt is generated by the SQLite column default
        // (`datetime('now')`) on insert; the repo never writes a caller-supplied
        // value. Validated against the reloaded `expected` returned by persist().
        createdAt: "derived-on-write",
        // updatedAt is set to `datetime('now')` by the upsert/setter SQL on every
        // write; likewise never caller-supplied. Validated against `expected`.
        updatedAt: "derived-on-write",
      },
    });
  });
});
