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
  canonicalReferenceDocumentRow,
  createReferenceDocumentsRepo,
  type ReferenceDocumentsRepo,
} from "./reference-documents-repo";
import { createSessionsRepo } from "./sessions-repo";
import { referenceDocumentSchema, sessionStateSchema } from "../schemas";
import type { ReferenceDocument, SessionState } from "@/types";

type Db = InstanceType<typeof Database>;

let db: Db;
let repo: ReferenceDocumentsRepo;

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return sessionStateSchema.parse({
    sessionName: SESSION_NAME,
    worktreePath: "/wt/s1",
    branchName: "csm/s1",
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  const sessionsRepo = createSessionsRepo(db);
  sessionsRepo.upsert(PROJECT_PATH, makeSession());
  repo = createReferenceDocumentsRepo(db);
});

afterEach(() => {
  db.close();
});

function makeDoc(
  overrides: Partial<ReferenceDocument> = {},
): ReferenceDocument {
  return referenceDocumentSchema.parse({
    id: "doc-1",
    filePath: "memory-bank/focus.md",
    description: "current focus",
    createdAt: "2026-01-02T00:00:00Z",
    ...overrides,
  });
}

describe("reference-documents-repo round-trip contract", () => {
  it("upsert + findById round-trips a fixture covering every field", () => {
    const fixture = makeDoc();
    repo.upsert(PROJECT_PATH, SESSION_NAME, fixture);

    const out = repo.findById(fixture.id);
    expect(out).not.toBeNull();
    if (!out) return;

    expect(out).toEqual(fixture);
    expect(referenceDocumentSchema.parse(out)).toEqual(fixture);
  });

  it("findBySession returns docs for the session, sorted by created_at then id", () => {
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run("/other");
    createSessionsRepo(db).upsert("/other", makeSession({ sessionName: "x" }));

    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeDoc({
        id: "a",
        filePath: "a.md",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeDoc({
        id: "b",
        filePath: "b.md",
        createdAt: "2026-01-02T00:00:00Z",
      }),
    );
    repo.upsert(
      "/other",
      "x",
      makeDoc({
        id: "z",
        filePath: "z.md",
        createdAt: "2026-01-03T00:00:00Z",
      }),
    );

    const result = repo.findBySession(PROJECT_PATH, SESSION_NAME);
    expect(result.map((d) => d.id)).toEqual(["a", "b"]);
    expect(repo.findBySession("/other", "x").map((d) => d.id)).toEqual(["z"]);
  });

  it("findById returns null for unknown id", () => {
    expect(repo.findById("missing")).toBeNull();
  });

  it("delete removes only the targeted doc", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeDoc({ id: "a", filePath: "a.md" }),
    );
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeDoc({ id: "b", filePath: "b.md" }),
    );

    repo.delete("a");
    expect(repo.findById("a")).toBeNull();
    expect(repo.findById("b")).not.toBeNull();
  });
});

describe("reference-documents-repo UNIQUE (project_path, session_name, file_path)", () => {
  it("two inserts with the same (project_path, session_name, file_path) but different ids trigger an UPSERT, not two rows or a constraint failure", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeDoc({
        id: "doc-first",
        filePath: "shared.md",
        description: "v1",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeDoc({
        id: "doc-second",
        filePath: "shared.md",
        description: "v2",
        createdAt: "2026-02-01T00:00:00Z",
      }),
    );

    const rows = repo.findBySession(PROJECT_PATH, SESSION_NAME);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe("v2");
    expect(rows[0]?.id).toBe("doc-second");

    const total = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM reference_documents WHERE project_path = ? AND session_name = ? AND file_path = ?",
        )
        .get(PROJECT_PATH, SESSION_NAME, "shared.md") as { n: number }
    ).n;
    expect(total).toBe(1);
  });

  it("re-upserting the same id at the same (project_path, session_name, file_path) updates the row in place", () => {
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeDoc({ id: "doc-x", filePath: "x.md", description: "v1" }),
    );
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeDoc({ id: "doc-x", filePath: "x.md", description: "v2" }),
    );
    const rows = repo.findBySession(PROJECT_PATH, SESSION_NAME);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe("v2");
  });
});

describe("reference-documents-repo cascading-FK invariant", () => {
  it("deleting a session cascades to its reference documents", () => {
    const sessionsRepo = createSessionsRepo(db);

    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeDoc({ id: "rd-1", filePath: "a.md" }),
    );
    repo.upsert(
      PROJECT_PATH,
      SESSION_NAME,
      makeDoc({ id: "rd-2", filePath: "b.md" }),
    );

    const before = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM reference_documents WHERE project_path = ? AND session_name = ?",
        )
        .get(PROJECT_PATH, SESSION_NAME) as { n: number }
    ).n;
    expect(before).toBe(2);

    sessionsRepo.delete(PROJECT_PATH, SESSION_NAME);

    const after = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM reference_documents WHERE project_path = ? AND session_name = ?",
        )
        .get(PROJECT_PATH, SESSION_NAME) as { n: number }
    ).n;
    expect(after).toBe(0);
  });
});

describe("canonicalReferenceDocumentRow", () => {
  it("returns the same string for two ReferenceDocument values that are deep-equal post-Zod-parse", () => {
    const a = makeDoc();
    const b = makeDoc();
    expect(canonicalReferenceDocumentRow(PROJECT_PATH, SESSION_NAME, a)).toBe(
      canonicalReferenceDocumentRow(PROJECT_PATH, SESSION_NAME, b),
    );
  });

  it("differs when any field differs", () => {
    const base = makeDoc();
    expect(
      canonicalReferenceDocumentRow(PROJECT_PATH, SESSION_NAME, base),
    ).not.toBe(
      canonicalReferenceDocumentRow(
        PROJECT_PATH,
        SESSION_NAME,
        makeDoc({ description: "different" }),
      ),
    );
    expect(
      canonicalReferenceDocumentRow(PROJECT_PATH, SESSION_NAME, base),
    ).not.toBe(canonicalReferenceDocumentRow("/p2", SESSION_NAME, base));
    expect(
      canonicalReferenceDocumentRow(PROJECT_PATH, SESSION_NAME, base),
    ).not.toBe(
      canonicalReferenceDocumentRow(PROJECT_PATH, "other-session", base),
    );
  });
});
