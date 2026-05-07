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
import {
  canonicalRoadmapItemRow,
  createRoadmapItemsRepo,
  type RoadmapItemsRepo,
} from "./roadmap-items-repo";
import { createProjectsRepo } from "./projects-repo";
import { roadmapItemSchema } from "../schemas";
import type { RoadmapItem } from "@/types";

type Db = InstanceType<typeof Database>;

let db: Db;
let repo: RoadmapItemsRepo;

const PROJECT_PATH = "/p1";

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  repo = createRoadmapItemsRepo(db);
});

afterEach(() => {
  db.close();
});

function makeMinimalItem(overrides: Partial<RoadmapItem> = {}): RoadmapItem {
  return roadmapItemSchema.parse({
    id: "r-1",
    title: "Minimal",
    type: "feature",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

function makeFullItem(overrides: Partial<RoadmapItem> = {}): RoadmapItem {
  return roadmapItemSchema.parse({
    id: "r-full",
    title: "Full item",
    description: "A description with details",
    type: "bug",
    status: "done",
    archived: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-02-15T08:09:10Z",
    ...overrides,
  });
}

describe("roadmap-items-repo round-trip contract", () => {
  it("upsert + findById round-trips a minimal fixture", () => {
    const fixture = makeMinimalItem();
    repo.upsert(PROJECT_PATH, fixture);

    const out = repo.findById(fixture.id);
    expect(out).not.toBeNull();
    if (!out) return;

    expect(out.id).toBe(fixture.id);
    expect(out.title).toBe("Minimal");
    expect(out.description).toBeNull();
    expect(out.type).toBe("feature");
    expect(out.status).toBe("incomplete");
    expect(out.archived).toBe(false);

    expect(roadmapItemSchema.parse(out)).toEqual(fixture);
  });

  it("upsert + findById round-trips a fully populated fixture (every field set)", () => {
    const fixture = makeFullItem();
    repo.upsert(PROJECT_PATH, fixture);

    const out = repo.findById(fixture.id);
    expect(out).not.toBeNull();
    if (!out) return;

    expect(out).toEqual(fixture);
    expect(roadmapItemSchema.parse(out)).toEqual(fixture);
  });

  it("findByProject returns items for that project, sorted by sort_order then created_at", () => {
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run("/other");

    repo.upsert(
      PROJECT_PATH,
      makeMinimalItem({ id: "a", createdAt: "2026-01-01T00:00:00Z" }),
    );
    repo.upsert(
      PROJECT_PATH,
      makeMinimalItem({ id: "b", createdAt: "2026-01-02T00:00:00Z" }),
    );
    repo.upsert(
      "/other",
      makeMinimalItem({ id: "x", createdAt: "2026-01-03T00:00:00Z" }),
    );

    const result = repo.findByProject(PROJECT_PATH);
    expect(result.map((r) => r.id)).toEqual(["a", "b"]);
    expect(repo.findByProject("/other").map((r) => r.id)).toEqual(["x"]);
  });

  it("upsert ON CONFLICT(id) updates existing row in place", () => {
    const original = makeMinimalItem({ title: "v1" });
    repo.upsert(PROJECT_PATH, original);

    const updated = makeMinimalItem({
      title: "v2",
      status: "done",
      updatedAt: "2026-03-01T00:00:00Z",
    });
    repo.upsert(PROJECT_PATH, updated);

    const out = repo.findById(original.id);
    expect(out?.title).toBe("v2");
    expect(out?.status).toBe("done");
    expect(out?.updatedAt).toBe("2026-03-01T00:00:00Z");

    const count = (
      db
        .prepare("SELECT COUNT(*) AS n FROM roadmap_items WHERE id = ?")
        .get(original.id) as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it("delete removes only the targeted item", () => {
    repo.upsert(PROJECT_PATH, makeMinimalItem({ id: "a" }));
    repo.upsert(PROJECT_PATH, makeMinimalItem({ id: "b" }));

    repo.delete("a");
    expect(repo.findById("a")).toBeNull();
    expect(repo.findById("b")).not.toBeNull();
  });

  it("findById returns null for unknown id", () => {
    expect(repo.findById("missing")).toBeNull();
  });
});

describe("roadmap-items-repo cascading-FK invariant", () => {
  it("deleting a project cascades to its roadmap items", () => {
    const projectsRepo = createProjectsRepo(db);
    projectsRepo.upsert({ rootPath: "/parent" });

    repo.upsert("/parent", makeMinimalItem({ id: "ri-1" }));
    repo.upsert("/parent", makeMinimalItem({ id: "ri-2" }));

    const beforeCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM roadmap_items WHERE project_path = ?",
        )
        .get("/parent") as { n: number }
    ).n;
    expect(beforeCount).toBe(2);

    projectsRepo.delete("/parent");

    const afterCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM roadmap_items WHERE project_path = ?",
        )
        .get("/parent") as { n: number }
    ).n;
    expect(afterCount).toBe(0);
  });
});

describe("canonicalRoadmapItemRow", () => {
  it("returns the same string for two RoadmapItem values that are deep-equal post-Zod-parse", () => {
    const a = makeFullItem();
    const b = makeFullItem();
    expect(canonicalRoadmapItemRow(PROJECT_PATH, a, 0)).toBe(
      canonicalRoadmapItemRow(PROJECT_PATH, b, 0),
    );
  });

  it("differs when any field differs", () => {
    const base = makeMinimalItem();
    expect(canonicalRoadmapItemRow(PROJECT_PATH, base, 0)).not.toBe(
      canonicalRoadmapItemRow(PROJECT_PATH, makeMinimalItem({ title: "x" }), 0),
    );
    expect(canonicalRoadmapItemRow(PROJECT_PATH, base, 0)).not.toBe(
      canonicalRoadmapItemRow("/p2", base, 0),
    );
    expect(canonicalRoadmapItemRow(PROJECT_PATH, base, 0)).not.toBe(
      canonicalRoadmapItemRow(PROJECT_PATH, base, 1),
    );
  });
});
