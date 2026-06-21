import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerInfo, loggerDebug, loggerWarn, loggerError } = vi.hoisted(() => ({
  loggerInfo: vi.fn(),
  loggerDebug: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: loggerInfo,
    debug: loggerDebug,
    warn: loggerWarn,
    error: loggerError,
  }),
}));

import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import {
  canonicalProjectRow,
  createProjectsRepo,
  type ProjectsRepo,
} from "./projects-repo";
import { PersistenceError } from "../shared/errors";
import type { ProjectRow } from "@/lib/projects/schemas";
type Db = InstanceType<typeof Database>;

let db: Db;
let repo: ProjectsRepo;

beforeEach(() => {
  loggerInfo.mockClear();
  loggerDebug.mockClear();
  loggerWarn.mockClear();
  loggerError.mockClear();
  db = _createTestDb({ inMemory: true });
  repo = createProjectsRepo(db);
});

afterEach(() => {
  db.close();
});

describe("rowToDomain — production parse skip", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function insertRawProject(pinOrder: number): void {
    db.prepare(
      `INSERT INTO projects (root_path, archived, pinned, pin_order, created_at, updated_at)
       VALUES (?, 0, 0, ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
    ).run("/p-raw", pinOrder);
  }

  it("throws on a schema-violating row outside production", () => {
    insertRawProject(1.5);
    expect(() => repo.findByRootPath("/p-raw")).toThrow(PersistenceError);
  });

  it("returns the row as-is without validating in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    insertRawProject(1.5);
    const project = repo.findByRootPath("/p-raw");
    expect(project).not.toBeNull();
    if (project) expect(project.pinOrder).toBe(1.5);
  });
});

function timingEvents(op: string) {
  return loggerInfo.mock.calls.filter(
    ([name]) => name === `state-store.projects.${op}.timing`,
  );
}

describe("createProjectsRepo — read accessors", () => {
  it("findByRootPath returns null when no row exists", () => {
    expect(repo.findByRootPath("/missing")).toBeNull();
  });

  it("findByRootPath returns the inserted row with archived=false, pinned=false, pinOrder=null defaults", () => {
    repo.upsert({ rootPath: "/p1" });

    const row = repo.findByRootPath("/p1");
    expect(row).not.toBeNull();
    expect(row?.rootPath).toBe("/p1");
    expect(row?.archived).toBe(false);
    expect(row?.pinned).toBe(false);
    expect(row?.pinOrder).toBeNull();
    expect(row?.mcpOverrides).toBeUndefined();
    expect(typeof row?.createdAt).toBe("string");
    expect(typeof row?.updatedAt).toBe("string");
  });

  it("findByRootPath surfaces mcpOverrides through Zod safeParse on read", () => {
    repo.upsert({
      rootPath: "/p2",
      mcpOverrides: {
        servers: {
          stripe: { enabled: false, tools: { charge: { enabled: true } } },
        },
      },
    });

    const row = repo.findByRootPath("/p2");
    expect(row?.mcpOverrides).toEqual({
      servers: {
        stripe: { enabled: false, tools: { charge: { enabled: true } } },
      },
    });
  });

  it("findByRootPath rejects rows where archived is not 0 or 1", () => {
    db.prepare(
      `INSERT INTO projects (root_path, archived, pinned, pin_order, mcp_overrides, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "/corrupt-archived",
      2,
      0,
      null,
      null,
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    );

    expect(() => repo.findByRootPath("/corrupt-archived")).toThrow(
      PersistenceError,
    );

    const failures = loggerError.mock.calls.filter(
      ([name]) => name === "state-store.projects.schema_validation_failure",
    );
    expect(failures.length).toBe(1);
    const payload = failures[0]![1] as { rootPath: string; issues: unknown };
    expect(payload.rootPath).toBe("/corrupt-archived");
  });

  it("findByRootPath rejects rows where pinned is not 0 or 1", () => {
    db.prepare(
      `INSERT INTO projects (root_path, archived, pinned, pin_order, mcp_overrides, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "/corrupt-pinned",
      0,
      "x",
      null,
      null,
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    );

    let captured: unknown;
    try {
      repo.findByRootPath("/corrupt-pinned");
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(PersistenceError);
    if (!(captured instanceof PersistenceError)) return;
    expect(captured.failure.kind).toBe("validation");

    const failures = loggerError.mock.calls.filter(
      ([name]) => name === "state-store.projects.schema_validation_failure",
    );
    expect(failures.length).toBe(1);
    const payload = failures[0]![1] as { rootPath: string; issues: unknown };
    expect(payload.rootPath).toBe("/corrupt-pinned");
  });

  it("listAll surfaces validation failure when any row has corrupt archived flag", () => {
    repo.upsert({ rootPath: "/ok" });
    db.prepare(
      `INSERT INTO projects (root_path, archived, pinned, pin_order, mcp_overrides, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "/bad",
      5,
      0,
      null,
      null,
      "2026-01-02T00:00:00Z",
      "2026-01-02T00:00:00Z",
    );

    expect(() => repo.listAll()).toThrow(PersistenceError);
  });

  it("findByRootPath logs schema_validation_failure and throws PersistenceError when row is invalid", () => {
    db.prepare(
      `INSERT INTO projects (root_path, archived, pinned, pin_order, mcp_overrides, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "/bad",
      0,
      0,
      null,
      '{"not_servers": true}',
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    );

    let captured: unknown;
    try {
      repo.findByRootPath("/bad");
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(PersistenceError);
    if (!(captured instanceof PersistenceError)) return;
    expect(captured.failure.kind).toBe("validation");
    if (captured.failure.kind !== "validation") return;
    expect(captured.failure.entity).toBe("project");
    expect(captured.failure.identifier).toBe("/bad");
    expect(Array.isArray(captured.failure.issues)).toBe(true);

    const failures = loggerError.mock.calls.filter(
      ([name]) => name === "state-store.projects.schema_validation_failure",
    );
    expect(failures.length).toBe(1);
    const payload = failures[0]![1] as { rootPath: string; issues: unknown };
    expect(payload.rootPath).toBe("/bad");
    expect(payload.issues).toBeDefined();
  });

  it("listAll returns every row ordered by created_at ascending", () => {
    db.prepare(
      `INSERT INTO projects (root_path, created_at, updated_at)
       VALUES (?, ?, ?)`,
    ).run("/p1", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    db.prepare(
      `INSERT INTO projects (root_path, created_at, updated_at)
       VALUES (?, ?, ?)`,
    ).run("/p2", "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z");
    db.prepare(
      `INSERT INTO projects (root_path, created_at, updated_at)
       VALUES (?, ?, ?)`,
    ).run("/p3", "2026-01-03T00:00:00Z", "2026-01-03T00:00:00Z");

    const all = repo.listAll();
    expect(all.map((r) => r.rootPath)).toEqual(["/p1", "/p2", "/p3"]);
  });

  it("listArchived returns only archived rows", () => {
    repo.upsert({ rootPath: "/a" });
    repo.upsert({ rootPath: "/b" });
    repo.upsert({ rootPath: "/c" });
    repo.setArchived("/a", true);
    repo.setArchived("/c", true);

    const archived = repo.listArchived().map((r) => r.rootPath);
    expect(new Set(archived)).toEqual(new Set(["/a", "/c"]));
    for (const row of repo.listArchived()) {
      expect(row.archived).toBe(true);
    }
  });

  it("listPinned orders by pin_order ASC NULLS LAST", () => {
    repo.upsert({ rootPath: "/p1" });
    repo.upsert({ rootPath: "/p2" });
    repo.upsert({ rootPath: "/p3" });
    repo.upsert({ rootPath: "/p4" });

    repo.setPinned("/p1", true);
    repo.setPinned("/p2", true);
    repo.setPinned("/p3", true);
    repo.setPinned("/p4", true);

    repo.reorderPinned(["/p2", "/p1"]);
    // /p3 and /p4 remain pinned with pin_order = NULL → sort last

    const pinned = repo.listPinned().map((r) => r.rootPath);
    expect(pinned[0]).toBe("/p2");
    expect(pinned[1]).toBe("/p1");
    expect(new Set(pinned.slice(2))).toEqual(new Set(["/p3", "/p4"]));
  });
});

describe("createProjectsRepo — writers", () => {
  it("upsert inserts a new row when none exists", () => {
    repo.upsert({ rootPath: "/new" });
    const row = repo.findByRootPath("/new");
    expect(row).not.toBeNull();
    expect(row?.rootPath).toBe("/new");
  });

  it("upsert ON CONFLICT updates mcp_overrides without resetting archived/pinned", () => {
    repo.upsert({ rootPath: "/p1" });
    repo.setArchived("/p1", true);
    repo.setPinned("/p1", true);

    repo.upsert({
      rootPath: "/p1",
      mcpOverrides: { servers: { foo: { enabled: true } } },
    });

    const row = repo.findByRootPath("/p1");
    expect(row?.archived).toBe(true);
    expect(row?.pinned).toBe(true);
    expect(row?.mcpOverrides).toEqual({ servers: { foo: { enabled: true } } });
  });

  it("setArchived flips the archived flag", () => {
    repo.upsert({ rootPath: "/p1" });
    repo.setArchived("/p1", true);
    expect(repo.findByRootPath("/p1")?.archived).toBe(true);
    repo.setArchived("/p1", false);
    expect(repo.findByRootPath("/p1")?.archived).toBe(false);
  });

  it("setPinned flips the pinned flag", () => {
    repo.upsert({ rootPath: "/p1" });
    repo.setPinned("/p1", true);
    expect(repo.findByRootPath("/p1")?.pinned).toBe(true);
    repo.setPinned("/p1", false);
    expect(repo.findByRootPath("/p1")?.pinned).toBe(false);
  });

  it("setPinned clears pin_order so re-pinning after unpin does not carry stale order", () => {
    repo.upsert({ rootPath: "/a" });
    repo.upsert({ rootPath: "/b" });
    repo.upsert({ rootPath: "/c" });
    repo.setPinned("/a", true);
    repo.setPinned("/b", true);
    repo.setPinned("/c", true);
    repo.reorderPinned(["/a", "/b", "/c"]);
    expect(repo.findByRootPath("/a")?.pinOrder).toBe(0);

    repo.setPinned("/a", false);
    expect(repo.findByRootPath("/a")?.pinned).toBe(false);
    expect(repo.findByRootPath("/a")?.pinOrder).toBeNull();

    repo.setPinned("/a", true);
    expect(repo.findByRootPath("/a")?.pinned).toBe(true);
    expect(repo.findByRootPath("/a")?.pinOrder).toBeNull();

    const order = repo.listPinned().map((r) => r.rootPath);
    expect(order[0]).toBe("/b");
    expect(order[1]).toBe("/c");
    expect(order[2]).toBe("/a");
  });

  it("reorderPinned sets pin_order in array index order inside one transaction", () => {
    repo.upsert({ rootPath: "/a" });
    repo.upsert({ rootPath: "/b" });
    repo.upsert({ rootPath: "/c" });

    repo.reorderPinned(["/b", "/c", "/a"]);

    expect(repo.findByRootPath("/b")?.pinOrder).toBe(0);
    expect(repo.findByRootPath("/c")?.pinOrder).toBe(1);
    expect(repo.findByRootPath("/a")?.pinOrder).toBe(2);
  });

  it("delete removes the row", () => {
    repo.upsert({ rootPath: "/gone" });
    repo.delete("/gone");
    expect(repo.findByRootPath("/gone")).toBeNull();
  });
});

describe("createProjectsRepo — timing logs", () => {
  it("emits state-store.projects.findByRootPath.timing on read", () => {
    repo.upsert({ rootPath: "/p1" });
    loggerInfo.mockClear();
    repo.findByRootPath("/p1");
    const events = timingEvents("findByRootPath");
    expect(events.length).toBe(1);
    const payload = events[0]![1] as { rootPath: string; durationMs: number };
    expect(payload.rootPath).toBe("/p1");
    expect(typeof payload.durationMs).toBe("number");
  });

  it("emits timing for every public writer", () => {
    repo.upsert({ rootPath: "/p1" });
    repo.setArchived("/p1", true);
    repo.setPinned("/p1", true);
    repo.reorderPinned(["/p1"]);
    repo.delete("/p1");

    expect(timingEvents("upsert").length).toBe(1);
    expect(timingEvents("setArchived").length).toBe(1);
    expect(timingEvents("setPinned").length).toBe(1);
    expect(timingEvents("reorderPinned").length).toBe(1);
    expect(timingEvents("delete").length).toBe(1);
  });

  it("emits timing for listAll, listArchived, listPinned (without rootPath)", () => {
    repo.listAll();
    repo.listArchived();
    repo.listPinned();
    expect(timingEvents("listAll").length).toBe(1);
    expect(timingEvents("listArchived").length).toBe(1);
    expect(timingEvents("listPinned").length).toBe(1);
  });
});

describe("canonicalProjectRow", () => {
  function makeRow(overrides: Partial<ProjectRow> = {}): ProjectRow {
    return {
      rootPath: "/p1",
      archived: false,
      pinned: false,
      pinOrder: null,
      mcpOverrides: undefined,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      ...overrides,
    };
  }

  it("returns the same string for two ProjectRow values that are deep-equal post-Zod-parse", () => {
    const a = makeRow();
    const b = makeRow();
    expect(canonicalProjectRow(a)).toBe(canonicalProjectRow(b));
  });

  it("is insensitive to mcpOverrides.servers key insertion order", () => {
    const a = makeRow({
      mcpOverrides: {
        servers: { alpha: { enabled: true }, beta: { enabled: false } },
      },
    });
    const b = makeRow({
      mcpOverrides: {
        servers: { beta: { enabled: false }, alpha: { enabled: true } },
      },
    });
    expect(canonicalProjectRow(a)).toBe(canonicalProjectRow(b));
  });

  it("differs when any field differs", () => {
    const base = makeRow();
    expect(canonicalProjectRow(base)).not.toBe(
      canonicalProjectRow(makeRow({ rootPath: "/other" })),
    );
    expect(canonicalProjectRow(base)).not.toBe(
      canonicalProjectRow(makeRow({ archived: true })),
    );
    expect(canonicalProjectRow(base)).not.toBe(
      canonicalProjectRow(makeRow({ pinned: true })),
    );
    expect(canonicalProjectRow(base)).not.toBe(
      canonicalProjectRow(makeRow({ pinOrder: 0 })),
    );
    expect(canonicalProjectRow(base)).not.toBe(
      canonicalProjectRow(
        makeRow({ mcpOverrides: { servers: { x: { enabled: true } } } }),
      ),
    );
    expect(canonicalProjectRow(base)).not.toBe(
      canonicalProjectRow(makeRow({ updatedAt: "2027-01-01T00:00:00Z" })),
    );
  });
});

describe("createProjectsRepo — does not import state-db.getDb", () => {
  it("operates against the injected database without calling getDb()", async () => {
    // Sanity check: importing the module does not require getDb to be set up.
    // If projects-repo silently imported getDb, opening it without a config dir
    // could crash in test envs. We verify by reading the source for the import.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("./projects-repo.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/from\s+["']\.\/state-db["']/);
    expect(src).not.toMatch(/getDb\s*\(/);
  });
});
