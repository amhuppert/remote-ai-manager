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
import { _createTestDb } from "../src/lib/state-store/state-db";
import { parseDumpStateArgs, runDumpState } from "./dump-state";

type Db = InstanceType<typeof Database>;

let db: Db;
let lines: string[];
const out = (line: string) => lines.push(line);

const PROJECT_PATH = "/repo/example";
const SESSION_NAME = "feature-x";
const CONVERSATION_ID = "conv-1";

function seed(): void {
  db.prepare(
    `INSERT INTO schema_migrations (version, description, applied_at)
     VALUES (?, ?, ?)`,
  ).run(1, "initial schema", "2026-05-01T00:00:00Z");

  db.prepare(`INSERT INTO projects (root_path) VALUES (?)`).run(PROJECT_PATH);

  db.prepare(
    `INSERT INTO sessions
       (project_path, session_name, worktree_path, branch_name,
        created_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    SESSION_NAME,
    "/wt/feature-x",
    "csm/feature-x",
    "2026-04-01T00:00:00Z",
    "2026-05-05T12:00:00Z",
  );

  db.prepare(
    `INSERT INTO conversations
       (id, project_path, session_name, status, created_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    CONVERSATION_ID,
    PROJECT_PATH,
    SESSION_NAME,
    "running",
    "2026-05-04T00:00:00Z",
    "2026-05-05T11:00:00Z",
  );

  db.prepare(
    `INSERT INTO job_records
       (job_id, job_type, status, project_name, session_name, branch_name, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "job-running",
    "merge",
    "running",
    "example",
    SESSION_NAME,
    "csm/feature-x",
    "2026-05-05T12:00:00Z",
  );

  db.prepare(
    `INSERT INTO job_records
       (job_id, job_type, status, project_name, session_name, branch_name, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "job-completed",
    "merge",
    "completed",
    "example",
    SESSION_NAME,
    "csm/feature-x",
    "2026-05-05T11:30:00Z",
  );
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  lines = [];
  seed();
});

afterEach(() => {
  db.close();
});

describe("parseDumpStateArgs", () => {
  it("parses --project, --session, --conversation, --json", () => {
    const opts = parseDumpStateArgs([
      "--project",
      "/some/repo",
      "--session",
      "abc",
      "--conversation",
      "c-99",
      "--json",
    ]);
    expect(opts.project).toBe("/some/repo");
    expect(opts.session).toBe("abc");
    expect(opts.conversation).toBe("c-99");
    expect(opts.json).toBe(true);
  });

  it("defaults json to false and other fields to undefined", () => {
    const opts = parseDumpStateArgs([]);
    expect(opts.json).toBe(false);
    expect(opts.project).toBeUndefined();
    expect(opts.session).toBeUndefined();
    expect(opts.conversation).toBeUndefined();
  });
});

describe("runDumpState — default mode", () => {
  it("prints project list with session counts", () => {
    runDumpState({ db, out }, {});
    const output = lines.join("\n");
    expect(output).toContain("Projects");
    expect(output).toContain(PROJECT_PATH);
    expect(output).toMatch(/sessions:\s*1/i);
  });

  it("prints recent activity section with the most recent session", () => {
    runDumpState({ db, out }, {});
    const output = lines.join("\n");
    expect(output).toContain("Recent activity");
    expect(output).toContain(SESSION_NAME);
    expect(output).toContain("2026-05-05T12:00:00Z");
  });

  it("prints in-flight job summary with counts by status", () => {
    runDumpState({ db, out }, {});
    const output = lines.join("\n");
    expect(output).toContain("Jobs");
    expect(output).toMatch(/running:\s*1/);
    expect(output).toMatch(/completed:\s*1/);
  });

  it("prints schema migrations section listing every row", () => {
    runDumpState({ db, out }, {});
    const output = lines.join("\n");
    expect(output).toContain("Schema migrations");
    expect(output).toContain("initial schema");
    expect(output).toContain("2026-05-01T00:00:00Z");
    expect(output).toMatch(/\b1\b/);
  });
});

describe("runDumpState — scoped flags", () => {
  it("--project scopes output to one project's sessions", () => {
    runDumpState({ db, out }, { project: PROJECT_PATH });
    const output = lines.join("\n");
    expect(output).toContain(PROJECT_PATH);
    expect(output).toContain(SESSION_NAME);
  });

  it("--project --session scopes to one session's conversations", () => {
    runDumpState({ db, out }, { project: PROJECT_PATH, session: SESSION_NAME });
    const output = lines.join("\n");
    expect(output).toContain(SESSION_NAME);
    expect(output).toContain(CONVERSATION_ID);
  });

  it("--conversation dumps a single conversation row", () => {
    runDumpState({ db, out }, { conversation: CONVERSATION_ID });
    const output = lines.join("\n");
    expect(output).toContain(CONVERSATION_ID);
    expect(output).toContain("running");
  });
});

describe("runDumpState — --json mode", () => {
  it("emits raw row JSON in default scope using original column names", () => {
    runDumpState({ db, out }, { json: true });
    const output = lines.join("\n");
    const parsed = JSON.parse(output) as {
      projects: Array<Record<string, unknown>>;
      sessions: Array<Record<string, unknown>>;
      job_records: Array<Record<string, unknown>>;
      schema_migrations: Array<Record<string, unknown>>;
    };
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0]).toMatchObject({
      root_path: PROJECT_PATH,
      archived: 0,
      pinned: 0,
    });
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0]).toMatchObject({
      project_path: PROJECT_PATH,
      session_name: SESSION_NAME,
      last_activity_at: "2026-05-05T12:00:00Z",
    });
    expect(parsed.job_records).toHaveLength(2);
    expect(parsed.job_records.map((r) => r["status"]).sort()).toEqual([
      "completed",
      "running",
    ]);
    expect(parsed.schema_migrations).toEqual([
      {
        version: 1,
        description: "initial schema",
        applied_at: "2026-05-01T00:00:00Z",
      },
    ]);
  });

  it("emits raw row JSON for a single conversation", () => {
    runDumpState({ db, out }, { conversation: CONVERSATION_ID, json: true });
    const output = lines.join("\n");
    const parsed = JSON.parse(output) as { id: string; status: string };
    expect(parsed.id).toBe(CONVERSATION_ID);
    expect(parsed.status).toBe("running");
  });
});
