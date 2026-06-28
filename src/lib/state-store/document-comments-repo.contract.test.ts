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
  createDocumentCommentsRepo,
  type DocumentCommentsRepo,
} from "./document-comments-repo";
import { createSessionsRepo } from "./sessions-repo";
import {
  documentCommentSchema,
  type DocumentComment,
} from "@/lib/document-comments/schemas";
import { sessionStateSchema, type SessionState } from "@/lib/sessions/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
type Db = InstanceType<typeof Database>;

let db: Db;
let repo: DocumentCommentsRepo;

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

function makeComment(
  overrides: Partial<DocumentComment> = {},
): DocumentComment {
  return documentCommentSchema.parse({
    id: "dc-1",
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    docPath: ".kiro/specs/markdown-doc-feedback/design.md",
    anchor: {
      sectionId: "2-design",
      headingLabel: "2 › 2.1 Design",
      line: 42,
      charStart: 5,
      charEnd: 18,
      quote: "exact quoted text",
      prefix: "the words before ",
      suffix: " the words after",
      docRevision: "sha256:abcdef0123456789",
    },
    note: "Please tighten this paragraph.",
    status: "pending",
    createdAt: "2026-06-27T08:00:00.000Z",
    updatedAt: "2026-06-27T08:00:00.000Z",
    sentAt: null,
    ...overrides,
  });
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  const sessionsRepo = createSessionsRepo(db);
  sessionsRepo.upsert(PROJECT_PATH, makeSession());
  repo = createDocumentCommentsRepo(db);
});

afterEach(() => {
  db.close();
});

describe("document-comments-repo round-trip", () => {
  it("upsert + findByIdInScope round-trips every field, including a null sentAt", () => {
    const fixture = makeComment();
    repo.upsert(fixture);

    const out = repo.findByIdInScope(PROJECT_PATH, SESSION_NAME, fixture.id);
    expect(out).not.toBeNull();
    expect(out).toEqual(fixture);
    if (out) expect(documentCommentSchema.parse(out)).toEqual(fixture);
  });

  it("preserves a sent comment's status and sentAt timestamp", () => {
    const sent = makeComment({
      id: "dc-sent",
      status: "sent",
      sentAt: "2026-06-27T09:00:00.000Z",
    });
    repo.upsert(sent);
    expect(repo.findByIdInScope(PROJECT_PATH, SESSION_NAME, "dc-sent")).toEqual(
      sent,
    );
  });

  it("upsert updates an existing comment in place (note + status change)", () => {
    repo.upsert(makeComment({ id: "dc-x", note: "v1", status: "pending" }));
    repo.upsert(
      makeComment({
        id: "dc-x",
        note: "v2",
        status: "sent",
        sentAt: "2026-06-27T10:00:00.000Z",
      }),
    );
    const all = repo.findByDocument(
      PROJECT_PATH,
      SESSION_NAME,
      ".kiro/specs/markdown-doc-feedback/design.md",
    );
    expect(all).toHaveLength(1);
    expect(all[0]?.note).toBe("v2");
    expect(all[0]?.status).toBe("sent");
  });
});

describe("document-comments-repo findByDocument", () => {
  it("returns the shared set for one docPath, sorted by created_at then id", () => {
    repo.upsert(
      makeComment({
        id: "a",
        docPath: "doc-A.md",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    repo.upsert(
      makeComment({
        id: "b",
        docPath: "doc-A.md",
        createdAt: "2026-01-02T00:00:00Z",
      }),
    );
    repo.upsert(
      makeComment({
        id: "c",
        docPath: "doc-B.md",
        createdAt: "2026-01-03T00:00:00Z",
      }),
    );

    const docA = repo.findByDocument(PROJECT_PATH, SESSION_NAME, "doc-A.md");
    expect(docA.map((c) => c.id)).toEqual(["a", "b"]);
    expect(
      repo
        .findByDocument(PROJECT_PATH, SESSION_NAME, "doc-B.md")
        .map((c) => c.id),
    ).toEqual(["c"]);
  });

  it("findBySession returns every comment for the session across documents", () => {
    repo.upsert(makeComment({ id: "a", docPath: "doc-A.md" }));
    repo.upsert(makeComment({ id: "b", docPath: "doc-B.md" }));
    const ids = repo.findBySession(PROJECT_PATH, SESSION_NAME).map((c) => c.id);
    expect(new Set(ids)).toEqual(new Set(["a", "b"]));
  });
});

describe("document-comments-repo findByIdInScope ownership scoping", () => {
  it("returns null for an id that belongs to a different project or session", () => {
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run("/other");
    createSessionsRepo(db).upsert("/other", makeSession({ sessionName: "s1" }));
    createSessionsRepo(db).upsert(
      PROJECT_PATH,
      makeSession({ sessionName: "other-session" }),
    );

    const c = makeComment({ id: "scoped" });
    repo.upsert(c);

    expect(repo.findByIdInScope(PROJECT_PATH, SESSION_NAME, "scoped")).toEqual(
      c,
    );
    expect(
      repo.findByIdInScope(PROJECT_PATH, "other-session", "scoped"),
    ).toBeNull();
    expect(repo.findByIdInScope("/other", SESSION_NAME, "scoped")).toBeNull();
    expect(
      repo.findByIdInScope(PROJECT_PATH, SESSION_NAME, "missing"),
    ).toBeNull();
  });
});

describe("document-comments-repo delete", () => {
  it("removes only the targeted comment", () => {
    repo.upsert(makeComment({ id: "a", docPath: "doc-A.md" }));
    repo.upsert(makeComment({ id: "b", docPath: "doc-A.md" }));
    repo.delete("a");
    expect(repo.findByIdInScope(PROJECT_PATH, SESSION_NAME, "a")).toBeNull();
    expect(
      repo.findByIdInScope(PROJECT_PATH, SESSION_NAME, "b"),
    ).not.toBeNull();
  });
});

describe("document-comments-repo cascading-FK invariant", () => {
  it("deleting a session cascades to its document comments", () => {
    const sessionsRepo = createSessionsRepo(db);
    repo.upsert(makeComment({ id: "c1", docPath: "doc-A.md" }));
    repo.upsert(makeComment({ id: "c2", docPath: "doc-B.md" }));

    expect(repo.findBySession(PROJECT_PATH, SESSION_NAME)).toHaveLength(2);
    sessionsRepo.delete(PROJECT_PATH, SESSION_NAME);
    expect(repo.findBySession(PROJECT_PATH, SESSION_NAME)).toHaveLength(0);
  });
});

/**
 * Build a comment with EVERY introspectable persisted key path populated to a
 * distinctive non-default value, so the schema-driven durability harness proves
 * no field is dropped on write or reset to its default on read. `sentAt` is set
 * to a non-null timestamp (the harness requires every key path present) and
 * `status` to "sent"; the null-sentAt round-trip is covered separately above.
 *
 * `documentCommentSchema` carries NO derived-on-read fields: staleness/reanchor
 * live on the `ResolvedComment` view type computed from current content, not on
 * the persisted shape — so there are no non-persisted policies to declare.
 */
function buildMaximalDocumentComment(): DocumentComment {
  return documentCommentSchema.parse({
    id: "dc-maximal",
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    docPath: ".kiro/steering/structure.md",
    anchor: {
      sectionId: "3-naming",
      headingLabel: "3 › Naming",
      line: 128,
      charStart: 12,
      charEnd: 64,
      quote: "Lib modules: kebab-case",
      prefix: "## Naming\n\n- ",
      suffix: " (project-resolver.ts).",
      docRevision: "sha256:0011223344556677",
    },
    note: "A maximal durability fixture for document comments.",
    status: "sent",
    createdAt: "2026-02-15T08:09:10.000Z",
    updatedAt: "2026-02-16T09:10:11.000Z",
    sentAt: "2026-02-16T09:10:11.000Z",
  });
}

describe("document-comments-repo durability contract", () => {
  it("round-trips every persisted document-comment key path through the real repo", async () => {
    await assertRoundTripDurability({
      label: "document-comments",
      schema: documentCommentSchema,
      buildMaximalFixture: buildMaximalDocumentComment,
      persist: (fixture) => {
        repo.upsert(fixture);
        return fixture;
      },
      reload: (expected) =>
        repo.findByIdInScope(
          expected.projectPath,
          expected.sessionName,
          expected.id,
        ),
      // No field policies: every schema field maps to a dedicated column written
      // from the caller-supplied value. The derived stale/reanchor fields are not
      // part of documentCommentSchema, so there is nothing to mark non-persisted.
      fieldPolicies: {},
    });
  });
});
