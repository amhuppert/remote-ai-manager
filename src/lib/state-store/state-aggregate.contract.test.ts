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
import { createProjectsRepo, canonicalProjectRow } from "./projects-repo";
import { createSessionsRepo, canonicalSessionRow } from "./sessions-repo";
import {
  createConversationsRepo,
  canonicalConversationRow,
} from "./conversations-repo";
import {
  createReferenceDocumentsRepo,
  canonicalReferenceDocumentRow,
} from "./reference-documents-repo";
import {
  createStateAggregate,
  type AllRepos,
  type StateAggregate,
} from "./state-aggregate";
import { createStateStore } from "./store";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { referenceDocumentSchema } from "@/lib/reference-documents/schemas";
import { managerStateSchema, projectRowSchema } from "@/lib/projects/schemas";
import {
  sessionListItemSchema,
  sessionStateSchema,
} from "@/lib/sessions/schemas";
import { z } from "zod";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ManagerState, ProjectRow } from "@/lib/projects/schemas";
import type { ReferenceDocument } from "@/lib/reference-documents/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { PersistenceError } from "../shared/errors";

type Db = InstanceType<typeof Database>;

interface RunRecord {
  sql: string;
}

let db: Db;
let repos: AllRepos;
let aggregate: StateAggregate;
let runRecords: RunRecord[];

/**
 * Wrap the db's `prepare` so every `run()` on a statement is recorded into the
 * `runs` array. MUST be called before the repos prepare their statements so
 * those statements get the wrapped `run`.
 */
function patchPrepareToTrack(database: Db, runs: RunRecord[]): void {
  const origPrepare = database.prepare.bind(database) as (
    sql: string,
  ) => ReturnType<typeof database.prepare>;
  (database as unknown as { prepare: (sql: string) => unknown }).prepare = (
    sql: string,
  ) => {
    const stmt = origPrepare(sql);
    const origRun = stmt.run.bind(stmt) as (
      ...args: unknown[]
    ) => ReturnType<typeof stmt.run>;
    (stmt as unknown as { run: (...args: unknown[]) => unknown }).run = (
      ...args: unknown[]
    ) => {
      runs.push({ sql });
      return origRun(...args);
    };
    return stmt;
  };
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  runRecords = [];
  patchPrepareToTrack(db, runRecords);
  repos = {
    db,
    projects: createProjectsRepo(db),
    sessions: createSessionsRepo(db),
    conversations: createConversationsRepo(db),
    referenceDocuments: createReferenceDocumentsRepo(db),
  };
  aggregate = createStateAggregate(repos);
});

afterEach(() => {
  db.close();
});

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return sessionStateSchema.parse({
    sessionName: "s1",
    worktreePath: "/wt/s1",
    branchName: "csm/s1",
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    // The sessions repo materializes an explicit `spawnedFrom: null` on decode,
    // so the round-trip fixture must carry it to match the loaded aggregate.
    spawnedFrom: null,
    ...overrides,
  });
}

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return conversationStateSchema.parse({
    id: "c1",
    transcriptPath: null,
    status: "idle",
    promptCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

function makeRefDoc(
  overrides: Partial<ReferenceDocument> = {},
): ReferenceDocument {
  return referenceDocumentSchema.parse({
    id: "ref1",
    filePath: "/docs/a.md",
    description: "doc",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

function seedFixture(state: ManagerState): void {
  for (const rootPath of Object.keys(state.projects)) {
    const ps = state.projects[rootPath];
    if (!ps) continue;
    repos.projects.upsert({
      rootPath,
      ...(ps.mcpOverrides !== undefined && { mcpOverrides: ps.mcpOverrides }),
    });
    if (state.archivedProjects.includes(rootPath)) {
      repos.projects.setArchived(rootPath, true);
    }
    if (state.pinnedProjects.includes(rootPath)) {
      repos.projects.setPinned(rootPath, true);
    }
    for (const session of Object.values(ps.sessions)) {
      repos.sessions.upsert(rootPath, session);
      for (const conv of session.conversations) {
        repos.conversations.upsert(rootPath, session.sessionName, conv);
      }
      for (const doc of session.referenceDocuments) {
        repos.referenceDocuments.upsert(rootPath, session.sessionName, doc);
      }
    }
  }
  if (state.pinnedProjects.length > 0) {
    repos.projects.reorderPinned([...state.pinnedProjects]);
  }
}

function buildFixture(): ManagerState {
  const conv1 = makeConversation({
    id: "conv-1",
    promptCount: 3,
    summary: "init",
  });
  const conv2 = makeConversation({
    id: "conv-2",
    status: "running",
    promptCount: 7,
  });
  const ref1 = makeRefDoc({ id: "ref-1", filePath: "/docs/a.md" });
  const ref2 = makeRefDoc({
    id: "ref-2",
    filePath: "/docs/b.md",
    createdAt: "2026-01-02T00:00:00Z",
  });
  const session1 = makeSession({
    sessionName: "alpha",
    worktreePath: "/wt/alpha",
    branchName: "csm/alpha",
    objective: "ship it",
    conversations: [conv1, conv2],
    referenceDocuments: [ref1, ref2],
  });
  const session2 = makeSession({
    sessionName: "beta",
    worktreePath: "/wt/beta",
    branchName: "csm/beta",
    archived: true,
    finished: true,
  });
  return managerStateSchema.parse({
    projects: {
      "/proj-a": {
        rootPath: "/proj-a",
        sessions: { alpha: session1, beta: session2 },
      },
      "/proj-b": {
        rootPath: "/proj-b",
        sessions: {},
      },
    },
    archivedProjects: ["/proj-b"],
    pinnedProjects: ["/proj-a"],
  });
}

describe("state-aggregate.readAll", () => {
  it("assembles a managerStateSchema-validated ManagerState matching the seeded fixture", () => {
    const fixture = buildFixture();
    seedFixture(fixture);

    const loaded = aggregate.readAll();

    expect(managerStateSchema.parse(loaded)).toEqual(loaded);
    expect(loaded).toEqual(fixture);
  });

  it("surfaces a PersistenceError(kind=validation) when assembled state fails managerStateSchema", () => {
    const fakeRepos: AllRepos = {
      db,
      projects: {
        findByRootPath: () => null,
        listAll: (): ProjectRow[] => [
          {
            rootPath: "/proj",
            archived: false,
            pinned: false,
            pinOrder: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
        listArchived: () => [],
        listPinned: () => [],
        upsert: () => {},
        setArchived: () => {},
        setPinned: () => {},
        reorderPinned: () => {},
        delete: () => {},
      },
      sessions: {
        findByKey: () => null,
        findByProject: () => [],
        findListItemsByProject: () => [],
        findAll: () => [
          {
            projectPath: "/proj",
            session: { not: "a session" } as unknown as SessionState,
          },
        ],
        upsert: () => {},
        delete: () => {},
        setSpawnedFrom: () => false,
        setActiveGraphWorkflowExecution: () => false,
        setSessionWorkflowLanes: () => false,
        setSessionWorkflowEnvelopes: () => false,
      },
      conversations: {
        findById: () => null,
        findByIdWithKey: () => null,
        findByKey: () => null,
        findBySession: () => [],
        countBySession: () => 0,
        findListItemsForProject: () => [],
        findAll: () => [],
        upsert: () => {},
        delete: () => {},
        upsertWithSessionTouch: () => {},
        updateChangedColumnsWithSessionTouch: () => {},
        setPendingPromptText: () => false,
      },
      referenceDocuments: {
        findBySession: () => [],
        findById: () => null,
        findAll: () => [],
        upsert: () => {},
        delete: () => {},
      },
    };
    const aggr = createStateAggregate(fakeRepos);
    expect(() => aggr.readAll()).toThrow(PersistenceError);
    try {
      aggr.readAll();
    } catch (err) {
      expect(err).toBeInstanceOf(PersistenceError);
      if (err instanceof PersistenceError) {
        expect(err.failure.kind).toBe("validation");
        if (err.failure.kind === "validation") {
          expect(err.failure.entity).toBe("ManagerState");
        }
      }
    }
  });
});

describe("state-aggregate.diffAndCommit", () => {
  it("emits a single session UPSERT statement when exactly one session field differs", () => {
    const fixture = buildFixture();
    seedFixture(fixture);
    const snapshot = aggregate.readAll();

    const baselineLength = runRecords.length;
    const mutated = managerStateSchema.parse(
      JSON.parse(JSON.stringify(snapshot)),
    );
    const projA = mutated.projects["/proj-a"];
    if (!projA) throw new Error("missing /proj-a");
    const alpha = projA.sessions["alpha"];
    if (!alpha) throw new Error("missing session alpha");
    alpha.objective = "different objective";

    aggregate.diffAndCommit(snapshot, mutated);

    const newRuns = runRecords.slice(baselineLength);
    const sessionUpserts = newRuns.filter((r) =>
      /INSERT INTO sessions[\s\S]*ON CONFLICT/i.test(r.sql),
    );
    expect(sessionUpserts.length).toBe(1);

    const otherWriteRuns = newRuns.filter(
      (r) =>
        /^\s*(INSERT|UPDATE|DELETE)/i.test(r.sql) &&
        !/INSERT INTO sessions[\s\S]*ON CONFLICT/i.test(r.sql),
    );
    expect(otherWriteRuns.length).toBe(0);

    const reread = aggregate.readAll();
    const rereadAlpha = reread.projects["/proj-a"]?.sessions["alpha"];
    expect(rereadAlpha?.objective).toBe("different objective");
  });

  it("performs a no-op commit when snapshot equals mutated", () => {
    const fixture = buildFixture();
    seedFixture(fixture);
    const snapshot = aggregate.readAll();

    const baselineLength = runRecords.length;
    const cloned = managerStateSchema.parse(
      JSON.parse(JSON.stringify(snapshot)),
    );

    aggregate.diffAndCommit(snapshot, cloned);

    const newRuns = runRecords.slice(baselineLength);
    const writeRuns = newRuns.filter((r) =>
      /^\s*(INSERT|UPDATE|DELETE)/i.test(r.sql),
    );
    expect(writeRuns.length).toBe(0);
  });

  it("commits multi-entity changes (session + conversation) and reads them back", () => {
    const fixture = buildFixture();
    seedFixture(fixture);
    const snapshot = aggregate.readAll();

    const mutated = managerStateSchema.parse(
      JSON.parse(JSON.stringify(snapshot)),
    );
    const projA = mutated.projects["/proj-a"];
    if (!projA) throw new Error("missing /proj-a");
    const alpha = projA.sessions["alpha"];
    if (!alpha) throw new Error("missing alpha");
    alpha.lastActivityAt = "2026-02-01T00:00:00Z";
    const conv = alpha.conversations[0];
    if (!conv) throw new Error("missing conv");
    conv.promptCount = 99;

    aggregate.diffAndCommit(snapshot, mutated);

    const reread = aggregate.readAll();
    const rereadAlpha = reread.projects["/proj-a"]?.sessions["alpha"];
    expect(rereadAlpha?.lastActivityAt).toBe("2026-02-01T00:00:00Z");
    expect(rereadAlpha?.conversations[0]?.promptCount).toBe(99);
  });

  it("validates the mutated side and rejects schema-failing input without committing", () => {
    const fixture = buildFixture();
    seedFixture(fixture);
    const snapshot = aggregate.readAll();

    const broken: ManagerState = JSON.parse(JSON.stringify(snapshot));
    const projA = broken.projects["/proj-a"];
    if (!projA) throw new Error("missing /proj-a");
    const alpha = projA.sessions["alpha"];
    if (!alpha) throw new Error("missing alpha");
    (alpha as unknown as { lastActivityAt: number }).lastActivityAt = 12345;

    expect(() => aggregate.diffAndCommit(snapshot, broken)).toThrow();

    const reread = aggregate.readAll();
    const expected =
      snapshot.projects["/proj-a"]?.sessions["alpha"]?.lastActivityAt;
    expect(reread.projects["/proj-a"]?.sessions["alpha"]?.lastActivityAt).toBe(
      expected,
    );
  });
});

describe("createStateStore.getProjectSessionListItems", () => {
  it("returns SessionListItem rows without heavy fields, with correctly derived metadata", async () => {
    repos.projects.upsert({ rootPath: "/proj-a" });
    repos.sessions.upsert(
      "/proj-a",
      sessionStateSchema.parse({
        sessionName: "alpha",
        worktreePath: "/wt/alpha",
        branchName: "csm/alpha",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        workflowEnvelopes: {
          env1: { workflowType: "collaboration", status: "running" },
        },
      }),
    );
    repos.conversations.upsert(
      "/proj-a",
      "alpha",
      conversationStateSchema.parse({
        id: "conv-running",
        transcriptPath: null,
        status: "running",
        promptCount: 3,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-02-10T00:00:00Z",
        machineSnapshot: { state: "running", context: { foo: "bar" } },
      }),
    );
    repos.conversations.upsert(
      "/proj-a",
      "alpha",
      conversationStateSchema.parse({
        id: "conv-idle",
        transcriptPath: null,
        status: "idle",
        promptCount: 7,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-02-05T00:00:00Z",
        machineSnapshot: { state: "idle", context: {} },
      }),
    );

    const store = createStateStore({ db });
    const items = await store.getProjectSessionListItems("/proj-a");

    const alpha = items.find((i) => i.sessionName === "alpha");
    expect(alpha).toBeDefined();
    if (!alpha) return;

    const keys = Object.keys(alpha);
    expect(keys).not.toContain("machineSnapshot");
    expect(keys).not.toContain("conversations");
    expect(keys).not.toContain("graphWorkflowExecution");
    expect(keys).not.toContain("workflowEnvelopes");
    expect(keys).not.toContain("workflowLanes");

    expect(alpha.derivedStatus).toBe("running");
    expect(alpha.promptCount).toBe(10);
    expect(alpha.collabContribution).toBe("running");
    expect(alpha.hasActiveGraphWorkflow).toBe(false);
    expect(alpha.derivedLastActivityAt).toBe("2026-02-10T00:00:00Z");

    expect(() => z.array(sessionListItemSchema).parse(items)).not.toThrow();
  });
});

describe("canonicalRow equivalence pinning", () => {
  it("project: deep-equal post-Zod-parse pairs share canonical strings; differing pairs do not", () => {
    const a = projectRowSchema.parse({
      rootPath: "/p",
      archived: true,
      pinned: false,
      pinOrder: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const b = projectRowSchema.parse({
      rootPath: "/p",
      archived: true,
      pinned: false,
      pinOrder: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(canonicalProjectRow(a)).toBe(canonicalProjectRow(b));
    const diff = projectRowSchema.parse({ ...a, archived: false });
    expect(canonicalProjectRow(a)).not.toBe(canonicalProjectRow(diff));
  });

  it("session: deep-equal SessionState pairs share canonical strings", () => {
    const a = makeSession({ objective: "x" });
    const b = makeSession({ objective: "x" });
    expect(canonicalSessionRow("/p", a)).toBe(canonicalSessionRow("/p", b));
    const diff = makeSession({ objective: "y" });
    expect(canonicalSessionRow("/p", a)).not.toBe(
      canonicalSessionRow("/p", diff),
    );
  });

  it("conversation: deep-equal pairs share canonical strings", () => {
    const a = makeConversation({ id: "z", summary: "abc" });
    const b = makeConversation({ id: "z", summary: "abc" });
    expect(canonicalConversationRow("/p", "s", a)).toBe(
      canonicalConversationRow("/p", "s", b),
    );
    const diff = makeConversation({ id: "z", summary: "different" });
    expect(canonicalConversationRow("/p", "s", a)).not.toBe(
      canonicalConversationRow("/p", "s", diff),
    );
  });

  it("reference document: deep-equal pairs share canonical strings", () => {
    const a = makeRefDoc({ id: "r", filePath: "/x.md" });
    const b = makeRefDoc({ id: "r", filePath: "/x.md" });
    expect(canonicalReferenceDocumentRow("/p", "s", a)).toBe(
      canonicalReferenceDocumentRow("/p", "s", b),
    );
    const diff = makeRefDoc({ id: "r", filePath: "/y.md" });
    expect(canonicalReferenceDocumentRow("/p", "s", a)).not.toBe(
      canonicalReferenceDocumentRow("/p", "s", diff),
    );
  });
});
