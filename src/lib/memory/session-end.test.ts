import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { PublishFn } from "@/lib/events/publication";
import { sessionStateSchema, type SessionState } from "@/lib/sessions/schemas";
import {
  createMemoryRepo,
  type MemoryRepo,
} from "@/lib/state-store/memory-repo";
import { createMemoryTelemetryRepo } from "@/lib/state-store/memory-telemetry-repo";
import { createProjectsRepo } from "@/lib/state-store/projects-repo";
import {
  createSessionsRepo,
  type SessionsRepo,
} from "@/lib/state-store/sessions-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import {
  createMemoryFreshnessEngine,
  type MemoryFreshnessEngine,
} from "./freshness";
import {
  memoryReviewQueueEntrySchema,
  type CreateMemoryNoteRequest,
  type MemoryActor,
  type MemoryChangedEvent,
  type MemoryNote,
} from "./schemas";
import { createSessionMemoryFinalizer } from "./session-end";
import {
  createMemoryTelemetryService,
  type MemoryTelemetryService,
} from "./telemetry";
import {
  createMemoryService,
  type MemoryError,
  type MemoryResult,
  type MemoryService,
} from "./service";
import { openMemoryContributionGate } from "./testing/contribution-gate";
import {
  createMemorySessionLifecycleReader,
  type MemorySessionLifecycleReader,
} from "./session-lifecycle";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/command-center";
const SESSION_NAME = "memory-spike";
const SESSION_CREATED_AT = "2026-09-01T08:00:00.000Z";
const INCARNATION = {
  sessionName: SESSION_NAME,
  sessionCreatedAt: SESSION_CREATED_AT,
};
/**
 * The same incarnation named from OUTSIDE its project. The queue filter and the
 * candidate count take this form, because a name and a created-at are unique
 * only within a project (R10).
 */
const PROJECT_INCARNATION = { projectPath: PROJECT_PATH, ...INCARNATION };

/** The session conversation's own actor: it sees its incarnation and its project. */
const AGENT_IN_SESSION: MemoryActor = {
  kind: "agent",
  conversationId: "conv-session",
  visibility: { projectPath: PROJECT_PATH, session: INCARNATION },
};
/** The Library acting on a session note: the human states the incarnation. */
const USER_IN_SESSION: MemoryActor = {
  kind: "user",
  visibility: { projectPath: PROJECT_PATH, session: INCARNATION },
};
/** A later project conversation: it never sees the finished session's notes. */
const USER_IN_PROJECT: MemoryActor = {
  kind: "user",
  visibility: { projectPath: PROJECT_PATH, session: null },
};

const BASE_TIME = Date.UTC(2026, 8, 1, 10, 0, 0);

let db: Db;
let repo: MemoryRepo;
let sessions: SessionsRepo;
let service: MemoryService;
let engine: MemoryFreshnessEngine;
let telemetry: MemoryTelemetryService;
let sessionLifecycle: MemorySessionLifecycleReader;
let published: SSEEvent[];
let clock: number;
let idSeq: number;

const publish: PublishFn = (event) => {
  published.push(event);
  return { delivered: true };
};

function now(): string {
  return new Date(BASE_TIME + clock).toISOString();
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  const queue = createWriteQueue();
  repo = createMemoryRepo(db, queue);
  sessions = createSessionsRepo(db);
  telemetry = createMemoryTelemetryService({
    repo: createMemoryTelemetryRepo(db, queue),
    now,
  });
  createProjectsRepo(db).upsert({ rootPath: PROJECT_PATH });
  published = [];
  clock = 0;
  idSeq = 0;

  sessionLifecycle = createMemorySessionLifecycleReader({
    async findSession(projectPath, sessionName) {
      return sessions.findByKey(projectPath, sessionName);
    },
  });
  service = createMemoryService({
    repo,
    publish,
    contributionGate: openMemoryContributionGate(),
    sessions: sessionLifecycle,
    now,
    generateId: () => {
      idSeq += 1;
      return `generated-${idSeq}`;
    },
  });
  engine = createMemoryFreshnessEngine({
    repo,
    sessions: sessionLifecycle,
    now,
  });
  seedSession();
});

afterEach(() => {
  db.close();
});

function seedSession(overrides: Partial<SessionState> = {}): void {
  sessions.upsert(
    PROJECT_PATH,
    sessionStateSchema.parse({
      sessionName: SESSION_NAME,
      worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
      branchName: `csm/${SESSION_NAME}`,
      createdAt: SESSION_CREATED_AT,
      lastActivityAt: SESSION_CREATED_AT,
      ...overrides,
    }),
  );
}

/** What `setSessionFinished` writes, so the session-end path reads a real completion. */
function completeSession(): void {
  seedSession({ finished: true, archived: true });
}

function ok<T>(result: MemoryResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `expected success, got ${result.error.code}: ${result.error.message}`,
    );
  }
  return result.value;
}

function refused<T>(result: MemoryResult<T>): MemoryError {
  if (result.ok) throw new Error("expected a refusal, got success");
  return result.error;
}

function changes(): string[] {
  return published
    .filter(
      (event): event is MemoryChangedEvent => event.type === "memory-changed",
    )
    .map((event) => event.change);
}

async function capture(
  overrides: Partial<CreateMemoryNoteRequest> = {},
  actor: MemoryActor = AGENT_IN_SESSION,
): Promise<MemoryNote> {
  idSeq += 1;
  return ok(
    await service.create(
      {
        scope: "session",
        kind: "lesson",
        hook: `Lesson ${idSeq}: the join gate runs changed-scope tests`,
        body: "A green join gate speaks for the diff, not the branch.",
        ...overrides,
      },
      actor,
    ),
  ).note;
}

async function head(note: MemoryNote): Promise<MemoryNote> {
  const current = await repo.find(note.id);
  if (current === null) throw new Error(`note ${note.id} vanished`);
  return current;
}

async function candidateSlugs(): Promise<string[]> {
  const entries = await engine.buildReviewQueue({
    session: PROJECT_INCARNATION,
    promotionCandidates: true,
  });
  return entries.map((entry) => entry.note.slug);
}

describe("session completion archives state and flags candidates (R10)", () => {
  it("archives the session's state notes and leaves its durable notes active", async () => {
    const state = await capture({
      kind: "state",
      hook: "State: rebasing lane 3 onto the session branch",
      slug: "rebasing-lane-3",
    });
    const lesson = await capture({ slug: "join-gate-changed-scope" });
    completeSession();

    const outcome = ok(
      await service.finishSession({
        projectPath: PROJECT_PATH,
        session: INCARNATION,
      }),
    );

    expect(outcome.archived.map((note) => note.slug)).toEqual([
      "rebasing-lane-3",
    ]);
    expect((await head(state)).lifecycle).toBe("archived");
    expect((await head(lesson)).lifecycle).toBe("active");
    expect(changes()).toContain("archived");
  });

  it("flags the remaining durable session notes as promotion candidates the session-filtered queue lists", async () => {
    await capture({
      kind: "state",
      hook: "State: rebasing lane 3",
      slug: "rebasing-lane-3",
    });
    const lesson = await capture({ slug: "join-gate-changed-scope" });
    completeSession();

    const outcome = ok(
      await service.finishSession({
        projectPath: PROJECT_PATH,
        session: INCARNATION,
      }),
    );
    expect(outcome.promotionCandidates.map((note) => note.slug)).toEqual([
      "join-gate-changed-scope",
    ]);

    const entries = await engine.buildReviewQueue({
      session: PROJECT_INCARNATION,
    });
    const entry = entries.find((candidate) => candidate.note.id === lesson.id);
    expect(entry).toBeDefined();
    expect(entry?.promotionCandidate).toBe(true);
    // A fresh candidate is queued for promotion, not for staleness.
    expect(entry?.staleness).toEqual([]);
    expect(memoryReviewQueueEntrySchema.parse(entry)).toBeTruthy();
    // The archived state note is out of every default read.
    expect(entries.map((queued) => queued.note.slug)).not.toContain(
      "rebasing-lane-3",
    );
  });

  it("counts candidates per session, matching the prefiltered queue", async () => {
    await capture({ slug: "join-gate-changed-scope" });
    await capture({ slug: "seam-ratchet-is-shrink-only" });
    // A project note of the same project is never a session's candidate.
    await capture(
      { scope: "project", slug: "project-lesson" },
      USER_IN_PROJECT,
    );
    completeSession();
    ok(
      await service.finishSession({
        projectPath: PROJECT_PATH,
        session: INCARNATION,
      }),
    );

    expect(await engine.countPromotionCandidates(PROJECT_INCARNATION)).toBe(2);
    expect(await candidateSlugs()).toEqual([
      "join-gate-changed-scope",
      "seam-ratchet-is-shrink-only",
    ]);
  });

  it("leaves a running session's durable notes uncandidated", async () => {
    await capture({ slug: "join-gate-changed-scope" });

    expect(await engine.countPromotionCandidates(PROJECT_INCARNATION)).toBe(0);
    expect(
      await engine.buildReviewQueue({ session: PROJECT_INCARNATION }),
    ).toEqual([]);
  });

  it("resolves the incarnation from the store when the lifecycle finishes a session by name", async () => {
    const state = await capture({
      kind: "state",
      hook: "State: rebasing lane 3",
      slug: "rebasing-lane-3",
    });
    await capture({ slug: "join-gate-changed-scope" });
    completeSession();

    const finalize = createSessionMemoryFinalizer({
      service,
      telemetry,
      async findSession(projectPath, sessionName) {
        return sessions.findByKey(projectPath, sessionName);
      },
    });
    await finalize({ projectPath: PROJECT_PATH, sessionName: SESSION_NAME });

    expect((await head(state)).lifecycle).toBe("archived");
    expect(await engine.countPromotionCandidates(PROJECT_INCARNATION)).toBe(1);
  });

  // Spec R15: the promotion-candidate half of the counter pair that decides
  // whether the passive affordance is measurably missed. Recorded per note, so
  // it compares against the `promoted` counter on the SAME note.
  it("counts each durable note this completion offered for promotion", async () => {
    await capture({ kind: "state", hook: "State: rebasing", slug: "rebasing" });
    const durable = await capture({ slug: "join-gate-changed-scope" });
    completeSession();

    const finalize = createSessionMemoryFinalizer({
      service,
      telemetry,
      async findSession(projectPath, sessionName) {
        return sessions.findByKey(projectPath, sessionName);
      },
    });
    await finalize({ projectPath: PROJECT_PATH, sessionName: SESSION_NAME });

    expect(
      await telemetry.listObservations({ kind: "promotion_candidate" }),
    ).toEqual([
      expect.objectContaining({
        kind: "promotion_candidate",
        memoryId: durable.id,
        count: 1,
      }),
    ]);
  });
});

describe("promote as supersede (R10)", () => {
  async function completedLesson(
    overrides: Partial<CreateMemoryNoteRequest> = {},
  ): Promise<MemoryNote> {
    const lesson = await capture({
      slug: "join-gate-changed-scope",
      ...overrides,
    });
    completeSession();
    ok(
      await service.finishSession({
        projectPath: PROJECT_PATH,
        session: INCARNATION,
      }),
    );
    return lesson;
  }

  it("creates a project note superseding the session note, preserving both histories", async () => {
    const lesson = await completedLesson();

    const outcome = ok(await service.promote(lesson.slug, {}, USER_IN_SESSION));

    expect(outcome.promoted.scope).toBe("project");
    expect(outcome.promoted.projectPath).toBe(PROJECT_PATH);
    expect(outcome.promoted.sessionName).toBeNull();
    expect(outcome.promoted.slug).toBe("join-gate-changed-scope");
    expect(outcome.promoted.hook).toBe(lesson.hook);
    expect(outcome.promoted.body).toBe(lesson.body);
    expect(outcome.promoted.supersedesId).toBe(lesson.id);

    const retired = await head(lesson);
    expect(retired.lifecycle).toBe("archived");
    expect(retired.supersededById).toBe(outcome.promoted.id);
    expect(outcome.superseded.supersededById).toBe(outcome.promoted.id);

    // Both revision histories survive the act.
    const sessionHistory = await repo.listRevisions(lesson.id);
    expect(sessionHistory.map((revision) => revision.origin)).toEqual([
      "create",
      "archive",
    ]);
    expect(sessionHistory.at(0)?.snapshot.lifecycle).toBe("active");
    const promotedHistory = await repo.listRevisions(outcome.promoted.id);
    expect(promotedHistory.map((revision) => revision.origin)).toEqual([
      "create",
    ]);

    // The knowledge now reaches a conversation that never saw the session.
    expect(
      ok(await service.resolve("join-gate-changed-scope", USER_IN_PROJECT)).id,
    ).toBe(outcome.promoted.id);
    expect(changes()).toEqual(
      expect.arrayContaining(["promoted", "superseded"]),
    );
  });

  it("rewrites the content in the same act when the promoter states one", async () => {
    const lesson = await completedLesson({
      statusNote: "Branch unmerged as of today",
    });

    const outcome = ok(
      await service.promote(
        lesson.slug,
        {
          slug: "join-gate-scoping",
          hook: "The join gate runs changed-scope tests, so green speaks for the diff",
          body: "Run --scope full before claiming the branch passes.",
          statusNote: null,
        },
        USER_IN_SESSION,
      ),
    );

    expect(outcome.promoted.slug).toBe("join-gate-scoping");
    expect(outcome.promoted.hook).toBe(
      "The join gate runs changed-scope tests, so green speaks for the diff",
    );
    expect(outcome.promoted.body).toBe(
      "Run --scope full before claiming the branch passes.",
    );
    expect(outcome.promoted.statusNote).toBeNull();
    // The session note's history keeps what it actually said.
    const original = (await repo.listRevisions(lesson.id)).at(0);
    expect(original?.snapshot.hook).toBe(lesson.hook);
    expect(original?.snapshot.statusNote?.text).toBe(
      "Branch unmerged as of today",
    );
  });

  it("refuses a collision with an active project slug, naming it, and retires nothing", async () => {
    await capture(
      { scope: "project", slug: "join-gate-changed-scope" },
      USER_IN_PROJECT,
    );
    const lesson = await completedLesson();

    const error = refused(
      await service.promote(lesson.slug, {}, USER_IN_SESSION),
    );

    expect(error.code).toBe("slug_taken");
    expect(error.message).toContain("join-gate-changed-scope");
    if (error.code === "slug_taken") {
      expect(error.slug).toBe("join-gate-changed-scope");
      expect(error.scope).toBe("project");
    }
    // No silent suffixing and no overwrite: the session note is still promotable.
    expect((await head(lesson)).lifecycle).toBe("active");
    expect(await engine.countPromotionCandidates(PROJECT_INCARNATION)).toBe(1);
  });

  it("refuses a collision with an active project alias, naming the handle", async () => {
    await capture(
      {
        scope: "project",
        slug: "join-gate-scoping",
        aliases: ["join-gate-changed-scope"],
      },
      USER_IN_PROJECT,
    );
    const lesson = await completedLesson();

    const error = refused(
      await service.promote(lesson.slug, {}, USER_IN_SESSION),
    );

    expect(error.code).toBe("slug_taken");
    if (error.code === "slug_taken") {
      expect(error.slug).toBe("join-gate-changed-scope");
    }
    expect((await head(lesson)).lifecycle).toBe("active");
  });

  it("refuses a stale base revision, naming the current one", async () => {
    const lesson = await completedLesson();
    ok(
      await service.update(
        lesson.slug,
        { baseRevision: lesson.revision, body: "Rewritten in the session." },
        USER_IN_SESSION,
      ),
    );

    const error = refused(
      await service.promote(
        lesson.slug,
        { baseRevision: lesson.revision },
        USER_IN_SESSION,
      ),
    );

    expect(error.code).toBe("stale_revision");
    if (error.code === "stale_revision") {
      expect(error.currentRevision).toBe(lesson.revision + 1);
    }
    expect((await head(lesson)).lifecycle).toBe("active");
  });

  it("refuses promoting a state note, which dies with its session", async () => {
    const state = await capture({
      kind: "state",
      hook: "State: rebasing lane 3",
      slug: "rebasing-lane-3",
    });

    const error = refused(
      await service.promote(state.slug, {}, USER_IN_SESSION),
    );

    expect(error.code).toBe("validation_failed");
    expect(error.message).toContain("perishable");
    expect((await head(state)).lifecycle).toBe("active");
  });

  it("refuses promoting a note that is not session-scoped", async () => {
    const projectNote = await capture(
      { scope: "project", slug: "project-lesson" },
      USER_IN_PROJECT,
    );

    const error = refused(
      await service.promote(projectNote.slug, {}, USER_IN_PROJECT),
    );

    expect(error.code).toBe("validation_failed");
    expect(error.message).toContain("session");
  });

  it("drops a promoted note from its session's candidate count", async () => {
    const lesson = await completedLesson();
    expect(await engine.countPromotionCandidates(PROJECT_INCARNATION)).toBe(1);

    ok(await service.promote(lesson.slug, {}, USER_IN_SESSION));

    expect(await engine.countPromotionCandidates(PROJECT_INCARNATION)).toBe(0);
  });
});

describe("candidacy outlives the session row (R10)", () => {
  async function completedDurableNote(): Promise<MemoryNote> {
    const lesson = await capture({ slug: "join-gate-changed-scope" });
    completeSession();
    ok(
      await service.finishSession({
        projectPath: PROJECT_PATH,
        session: INCARNATION,
      }),
    );
    return lesson;
  }

  it("keeps candidates when a later session reuses the name", async () => {
    await completedDurableNote();
    expect(await engine.countPromotionCandidates(PROJECT_INCARNATION)).toBe(1);

    // The name is reused: a NEW incarnation now holds the row. The earlier
    // incarnation's durable notes are still owed a promotion decision.
    seedSession({ createdAt: "2026-09-02T09:00:00.000Z", finished: false });

    expect(await engine.countPromotionCandidates(PROJECT_INCARNATION)).toBe(1);
    expect(await candidateSlugs()).toEqual(["join-gate-changed-scope"]);
  });

  it("keeps candidates when the session row is gone entirely", async () => {
    await completedDurableNote();

    db.prepare("DELETE FROM sessions").run();

    expect(await engine.countPromotionCandidates(PROJECT_INCARNATION)).toBe(1);
    expect(await candidateSlugs()).toEqual(["join-gate-changed-scope"]);
  });

  it("still withholds candidacy from a session that is genuinely running", async () => {
    await capture({ slug: "join-gate-changed-scope" });

    expect(await engine.countPromotionCandidates(PROJECT_INCARNATION)).toBe(0);
  });
});

describe("the candidate contract is per project (R10)", () => {
  const OTHER_PROJECT = "/repos/other-project";
  const OTHER_INCARNATION = {
    projectPath: OTHER_PROJECT,
    ...INCARNATION,
  };

  it("does not merge two projects' identically-named incarnations", async () => {
    createProjectsRepo(db).upsert({ rootPath: OTHER_PROJECT });
    // Same session name AND same created-at, in a different project.
    sessions.upsert(
      OTHER_PROJECT,
      sessionStateSchema.parse({
        sessionName: SESSION_NAME,
        worktreePath: `${OTHER_PROJECT}/.worktrees/${SESSION_NAME}`,
        branchName: `csm/${SESSION_NAME}`,
        createdAt: SESSION_CREATED_AT,
        lastActivityAt: SESSION_CREATED_AT,
        finished: true,
      }),
    );
    await capture({ slug: "here" });
    await capture(
      { slug: "elsewhere" },
      {
        kind: "agent",
        conversationId: "conv-other",
        visibility: { projectPath: OTHER_PROJECT, session: INCARNATION },
      },
    );
    completeSession();

    expect(await candidateSlugs()).toEqual(["here"]);
    expect(await engine.countPromotionCandidates(PROJECT_INCARNATION)).toBe(1);
    expect(await engine.countPromotionCandidates(OTHER_INCARNATION)).toBe(1);
    expect(
      (
        await engine.buildReviewQueue({
          session: OTHER_INCARNATION,
          promotionCandidates: true,
        })
      ).map((entry) => entry.note.slug),
    ).toEqual(["elsewhere"]);
  });
});

describe("a dropped completion is reconciled, not lost (R10)", () => {
  it("archives a stranded incarnation's state notes at the next completion in the project", async () => {
    // Incarnation A completes, but its memory step never ran (a thrown
    // finalizer, a crash between the finished row and the memory write).
    const stranded = await capture({
      kind: "state",
      hook: "State: rebasing lane 3",
      slug: "rebasing-lane-3",
    });
    completeSession();
    expect((await head(stranded)).lifecycle).toBe("active");

    // A later incarnation of the same project completes normally.
    const laterIncarnation = {
      sessionName: "later-session",
      sessionCreatedAt: "2026-09-02T09:00:00.000Z",
    };
    sessions.upsert(
      PROJECT_PATH,
      sessionStateSchema.parse({
        sessionName: laterIncarnation.sessionName,
        worktreePath: `${PROJECT_PATH}/.worktrees/later-session`,
        branchName: "csm/later-session",
        createdAt: laterIncarnation.sessionCreatedAt,
        lastActivityAt: laterIncarnation.sessionCreatedAt,
        finished: true,
      }),
    );

    const outcome = ok(
      await service.finishSession({
        projectPath: PROJECT_PATH,
        session: laterIncarnation,
      }),
    );

    // The stranded state note is healed by the later completion.
    expect((await head(stranded)).lifecycle).toBe("archived");
    expect(outcome.reconciled.map((note) => note.slug)).toEqual([
      "rebasing-lane-3",
    ]);
  });

  it("never archives the state notes of a session that is still running", async () => {
    const running = await capture({
      kind: "state",
      hook: "State: rebasing lane 3",
      slug: "rebasing-lane-3",
    });

    ok(
      await service.finishSession({
        projectPath: PROJECT_PATH,
        session: INCARNATION,
      }),
    );

    expect((await head(running)).lifecycle).toBe("active");
  });

  it("retries a transient failure rather than dropping the archival", async () => {
    const state = await capture({
      kind: "state",
      hook: "State: rebasing lane 3",
      slug: "rebasing-lane-3",
    });
    completeSession();

    let attempts = 0;
    const finalize = createSessionMemoryFinalizer({
      telemetry,
      service: {
        ...service,
        async finishSession(input) {
          attempts += 1;
          if (attempts === 1) throw new Error("database is locked");
          return service.finishSession(input);
        },
      },
      async findSession(projectPath, sessionName) {
        return sessions.findByKey(projectPath, sessionName);
      },
    });
    await finalize({ projectPath: PROJECT_PATH, sessionName: SESSION_NAME });

    expect(attempts).toBe(2);
    expect((await head(state)).lifecycle).toBe("archived");
  });
});

describe("promotion's collision refusal is decided in the write (R10)", () => {
  async function completedLesson(): Promise<MemoryNote> {
    const lesson = await capture({ slug: "join-gate-changed-scope" });
    completeSession();
    ok(
      await service.finishSession({
        projectPath: PROJECT_PATH,
        session: INCARNATION,
      }),
    );
    return lesson;
  }

  /**
   * A promotion whose handle is claimed AFTER the service's precheck and
   * before the insert. The wrapper runs inside the act, in the one window a
   * precheck cannot cover, so the refusal has to come from the transaction.
   */
  function serviceRacing(claim: () => Promise<void>): MemoryService {
    let raced = false;
    return createMemoryService({
      contributionGate: openMemoryContributionGate(),
      repo: {
        ...repo,
        async create(input) {
          if (!raced) {
            raced = true;
            await claim();
          }
          return repo.create(input);
        },
      },
      publish,
      sessions: sessionLifecycle,
      now,
      generateId: () => {
        idSeq += 1;
        return `raced-${idSeq}`;
      },
    });
  }

  it("refuses when a project ALIAS is claimed after the precheck", async () => {
    const lesson = await completedLesson();
    const racing = serviceRacing(async () => {
      await capture(
        {
          scope: "project",
          slug: "some-other-note",
          aliases: ["join-gate-changed-scope"],
        },
        USER_IN_PROJECT,
      );
    });

    const error = refused(
      await racing.promote(lesson.slug, {}, USER_IN_SESSION),
    );

    expect(error.code).toBe("slug_taken");
    expect(error.message).toContain("join-gate-changed-scope");
    // The predecessor was not retired behind a shadowed successor.
    expect((await head(lesson)).lifecycle).toBe("active");
    expect((await head(lesson)).supersededById).toBeNull();
    expect(await engine.countPromotionCandidates(PROJECT_INCARNATION)).toBe(1);
  });

  it("refuses when a project SLUG is claimed after the precheck", async () => {
    const lesson = await completedLesson();
    const racing = serviceRacing(async () => {
      await capture(
        { scope: "project", slug: "join-gate-changed-scope" },
        USER_IN_PROJECT,
      );
    });

    const error = refused(
      await racing.promote(lesson.slug, {}, USER_IN_SESSION),
    );

    expect(error.code).toBe("slug_taken");
    expect((await head(lesson)).lifecycle).toBe("active");
  });

  it("refuses when the session note is edited after the promoter read it", async () => {
    const lesson = await completedLesson();
    const racing = serviceRacing(async () => {
      ok(
        await service.update(
          lesson.slug,
          { baseRevision: lesson.revision, body: "Edited mid-promotion." },
          USER_IN_SESSION,
        ),
      );
    });

    // No baseRevision is stated: the act still pins the revision it resolved,
    // so the edit cannot be silently dropped from the carried-forward content.
    const error = refused(
      await racing.promote(lesson.slug, {}, USER_IN_SESSION),
    );

    expect(error.code).toBe("stale_revision");
    expect((await head(lesson)).lifecycle).toBe("active");
    expect((await head(lesson)).body).toBe("Edited mid-promotion.");
  });

  it("still lets a server-initiated promotion opt out of the revision check", async () => {
    const lesson = await completedLesson();
    const racing = serviceRacing(async () => {
      ok(
        await service.update(
          lesson.slug,
          { baseRevision: lesson.revision, body: "Edited mid-promotion." },
          USER_IN_SESSION,
        ),
      );
    });

    const outcome = ok(
      await racing.promote(
        lesson.slug,
        { baseRevision: null },
        USER_IN_SESSION,
      ),
    );

    expect(outcome.promoted.scope).toBe("project");
  });
});

describe("reconciliation recovers a dropped completion without another session (R10)", () => {
  /** A completion whose memory step never landed: finished row, notes untouched. */
  async function strandedCompletion(): Promise<MemoryNote> {
    const state = await capture({
      kind: "state",
      hook: "State: rebasing lane 3",
      slug: "rebasing-lane-3",
    });
    completeSession();
    return state;
  }

  it("archives the state notes of the project's LAST completed session", async () => {
    const stranded = await strandedCompletion();
    // Nothing else will ever complete here, so completion-triggered
    // reconciliation can never reach this note.
    expect((await head(stranded)).lifecycle).toBe("active");

    const outcome = ok(await service.reconcileSessionMemory());

    expect(outcome.archived.map((note) => note.slug)).toEqual([
      "rebasing-lane-3",
    ]);
    expect((await head(stranded)).lifecycle).toBe("archived");
    expect(changes()).toContain("archived");
  });

  it("sweeps every project, not just one", async () => {
    const OTHER_PROJECT = "/repos/other-project";
    createProjectsRepo(db).upsert({ rootPath: OTHER_PROJECT });
    sessions.upsert(
      OTHER_PROJECT,
      sessionStateSchema.parse({
        sessionName: SESSION_NAME,
        worktreePath: `${OTHER_PROJECT}/.worktrees/${SESSION_NAME}`,
        branchName: `csm/${SESSION_NAME}`,
        createdAt: SESSION_CREATED_AT,
        lastActivityAt: SESSION_CREATED_AT,
        finished: true,
      }),
    );
    const here = await strandedCompletion();
    const elsewhere = await capture(
      { kind: "state", hook: "State: elsewhere", slug: "elsewhere-state" },
      {
        kind: "agent",
        conversationId: "conv-other",
        visibility: { projectPath: OTHER_PROJECT, session: INCARNATION },
      },
    );

    ok(await service.reconcileSessionMemory());

    expect((await head(here)).lifecycle).toBe("archived");
    expect((await head(elsewhere)).lifecycle).toBe("archived");
  });

  it("leaves a running session's state notes alone and is idempotent", async () => {
    const running = await capture({
      kind: "state",
      hook: "State: still working",
      slug: "still-working",
    });

    const first = ok(await service.reconcileSessionMemory());
    expect(first.archived).toEqual([]);
    expect((await head(running)).lifecycle).toBe("active");

    // The session then ends; the sweep picks it up, and a second sweep is a
    // no-op rather than a second archive.
    completeSession();
    expect(ok(await service.reconcileSessionMemory()).archived).toHaveLength(1);
    expect(ok(await service.reconcileSessionMemory()).archived).toEqual([]);
    expect((await head(running)).lifecycle).toBe("archived");
  });

  it("never promotes or retires a durable note", async () => {
    const lesson = await capture({ slug: "join-gate-changed-scope" });
    await strandedCompletion();

    ok(await service.reconcileSessionMemory());

    expect((await head(lesson)).lifecycle).toBe("active");
    // It stays a promotion candidate: reconciliation archives perishable
    // state, it does not decide promotions on a human's behalf.
    expect(await engine.countPromotionCandidates(PROJECT_INCARNATION)).toBe(1);
  });
});
