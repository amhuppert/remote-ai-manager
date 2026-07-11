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
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { _createTestDb } from "./state-db";
import { createSessionsRepo } from "./sessions-repo";
import {
  createSessionMarkdownDocumentsRepo,
  type SessionMarkdownDocumentsRepo,
} from "./session-markdown-documents-repo";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/project";
const SESSION_NAME = "session";

let db: Db;
let repo: SessionMarkdownDocumentsRepo;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  createSessionsRepo(db).upsert(
    PROJECT_PATH,
    sessionStateSchema.parse({
      sessionName: SESSION_NAME,
      worktreePath: "/worktree",
      branchName: "csm/session",
      createdAt: "2026-07-11T09:00:00.000Z",
      lastActivityAt: "2026-07-11T09:00:00.000Z",
    }),
  );
  repo = createSessionMarkdownDocumentsRepo(db);
});

afterEach(() => db.close());

describe("session Markdown documents repository", () => {
  it("upserts by session and path while preserving firstSeenAt", () => {
    repo.upsertMany(PROJECT_PATH, SESSION_NAME, [
      {
        docPath: "docs/plan.md",
        origin: "read",
        firstSeenAt: "2026-07-11T10:00:00.000Z",
        lastSeenAt: "2026-07-11T10:00:00.000Z",
      },
    ]);
    repo.upsertMany(PROJECT_PATH, SESSION_NAME, [
      {
        docPath: "docs/plan.md",
        origin: "edit",
        firstSeenAt: "2026-07-11T11:00:00.000Z",
        lastSeenAt: "2026-07-11T11:00:00.000Z",
      },
    ]);

    expect(repo.findBySession(PROJECT_PATH, SESSION_NAME)).toEqual([
      {
        docPath: "docs/plan.md",
        origin: "edit",
        firstSeenAt: "2026-07-11T10:00:00.000Z",
        lastSeenAt: "2026-07-11T11:00:00.000Z",
      },
    ]);
  });

  it("orders newest activity first with path as a stable tie-breaker", () => {
    repo.upsertMany(PROJECT_PATH, SESSION_NAME, [
      {
        docPath: "z.md",
        origin: "write",
        firstSeenAt: "2026-07-11T10:00:00.000Z",
        lastSeenAt: "2026-07-11T10:00:00.000Z",
      },
      {
        docPath: "a.md",
        origin: "read",
        firstSeenAt: "2026-07-11T10:00:00.000Z",
        lastSeenAt: "2026-07-11T10:00:00.000Z",
      },
      {
        docPath: "new.md",
        origin: "edit",
        firstSeenAt: "2026-07-11T11:00:00.000Z",
        lastSeenAt: "2026-07-11T11:00:00.000Z",
      },
    ]);

    expect(
      repo.findBySession(PROJECT_PATH, SESSION_NAME).map((doc) => doc.docPath),
    ).toEqual(["new.md", "a.md", "z.md"]);
  });

  it("looks up exact session membership", () => {
    repo.upsertMany(PROJECT_PATH, SESSION_NAME, [
      {
        docPath: "/shared/runbook.md",
        origin: "registered",
        firstSeenAt: "2026-07-11T10:00:00.000Z",
        lastSeenAt: "2026-07-11T10:00:00.000Z",
      },
    ]);

    expect(repo.exists(PROJECT_PATH, SESSION_NAME, "/shared/runbook.md")).toBe(
      true,
    );
    expect(repo.exists(PROJECT_PATH, SESSION_NAME, "/shared/other.md")).toBe(
      false,
    );
  });

  it("cascades rows when the owning session is deleted", () => {
    repo.upsertMany(PROJECT_PATH, SESSION_NAME, [
      {
        docPath: "notes.md",
        origin: "read",
        firstSeenAt: "2026-07-11T10:00:00.000Z",
        lastSeenAt: "2026-07-11T10:00:00.000Z",
      },
    ]);

    createSessionsRepo(db).delete(PROJECT_PATH, SESSION_NAME);
    expect(repo.findBySession(PROJECT_PATH, SESSION_NAME)).toEqual([]);
  });
});
