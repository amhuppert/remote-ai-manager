import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { PublishFn } from "@/lib/events/publication";
import {
  createMemoryRepo,
  type MemoryRepo,
} from "@/lib/state-store/memory-repo";
import { createProjectsRepo } from "@/lib/state-store/projects-repo";
import {
  createSessionsRepo,
  type SessionsRepo,
} from "@/lib/state-store/sessions-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import {
  createTicketsRepo,
  type TicketsRepo,
} from "@/lib/state-store/tickets-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { Ticket } from "@/lib/tickets/schemas";

import {
  assessMemoryFreshness,
  createMemoryFreshnessEngine,
  type MemoryFreshnessAssessment,
  type MemoryFreshnessEngine,
} from "./freshness";
import { renderMemoryStatusLine } from "./age";
import {
  MEMORY_STATE_NOTE_LEASE_MS,
  MEMORY_STATUS_NOTE_LEASE_MS,
  type CreateMemoryNoteRequest,
  type MemoryActor,
  type MemoryArtifactRef,
  type MemoryChangedEvent,
  type MemoryNote,
} from "./schemas";
import {
  createMemoryService,
  type MemoryError,
  type MemoryResult,
  type MemoryService,
} from "./service";
import { openMemoryContributionGate } from "./testing/contribution-gate";
import { createMemorySessionLifecycleReader } from "./session-lifecycle";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/command-center";
const OTHER_PROJECT = "/repos/other";
const SESSION_NAME = "memory-spike";
const SESSION_CREATED_AT = "2026-09-01T08:00:00.000Z";
const INCARNATION = {
  sessionName: SESSION_NAME,
  sessionCreatedAt: SESSION_CREATED_AT,
};
/** The same incarnation named from outside its project: the queue filter (R10). */
const PROJECT_INCARNATION = { projectPath: PROJECT_PATH, ...INCARNATION };
const USER: MemoryActor = {
  kind: "user",
  visibility: { projectPath: PROJECT_PATH, session: INCARNATION },
};
const USER_ELSEWHERE: MemoryActor = {
  kind: "user",
  visibility: { projectPath: OTHER_PROJECT, session: null },
};

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_TIME = Date.UTC(2026, 8, 1, 10, 0, 0);

let db: Db;
let repo: MemoryRepo;
let tickets: TicketsRepo;
let sessions: SessionsRepo;
let service: MemoryService;
let engine: MemoryFreshnessEngine;
let published: SSEEvent[];
let clock: number;
let idSeq: number;

const publish: PublishFn = (event) => {
  published.push(event);
  return { delivered: true };
};

/** The controlled clock every dependency reads; nothing auto-advances. */
function now(): string {
  return new Date(BASE_TIME + clock).toISOString();
}

/** An instant relative to the current clock. */
function at(offsetMs: number): string {
  return new Date(BASE_TIME + clock + offsetMs).toISOString();
}

function advance(ms: number): void {
  clock += ms;
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  const queue = createWriteQueue();
  repo = createMemoryRepo(db, queue);
  tickets = createTicketsRepo(db, queue);
  sessions = createSessionsRepo(db);
  const projects = createProjectsRepo(db);
  projects.upsert({ rootPath: PROJECT_PATH });
  projects.upsert({ rootPath: OTHER_PROJECT });
  published = [];
  clock = 0;
  idSeq = 0;

  const sessionLifecycle = createMemorySessionLifecycleReader({
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
});

afterEach(() => {
  db.close();
});

function changes(): string[] {
  return published
    .filter(
      (event): event is MemoryChangedEvent => event.type === "memory-changed",
    )
    .map((event) => event.change);
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

async function capture(
  overrides: Partial<CreateMemoryNoteRequest> = {},
  actor: MemoryActor = USER,
): Promise<MemoryNote> {
  idSeq += 1;
  return ok(
    await service.create(
      {
        scope: "project",
        kind: "lesson",
        hook: `Lesson ${idSeq}: the FTS5 index is derived state`,
        body: "A rebuild repopulates the index from the note rows.",
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

/** The lazy delivery-time check over the note's current head. */
async function assess(note: MemoryNote): Promise<MemoryFreshnessAssessment> {
  const current = await head(note);
  const assessed = (await engine.check([current])).get(current.id);
  if (assessed === undefined) throw new Error("check returned no assessment");
  return assessed;
}

async function seedTicket(status: Ticket["status"]): Promise<Ticket> {
  idSeq += 1;
  return tickets.create({
    id: `ticket-${idSeq}`,
    projectPath: PROJECT_PATH,
    title: `Ticket ${idSeq}`,
    description: "",
    workType: "feature",
    status,
    createdAt: now(),
    updatedAt: now(),
  });
}

async function setTicketStatus(
  ticket: Ticket,
  status: Ticket["status"],
): Promise<void> {
  await tickets.update({
    projectPath: PROJECT_PATH,
    number: ticket.number,
    status,
    updatedAt: now(),
  });
}

function ticketRef(ticket: Ticket): MemoryArtifactRef {
  return { kind: "ticket", ticketId: ticket.id };
}

describe("two-level withholding (R2, D2)", () => {
  it("delivers a fresh note whole, status line included", async () => {
    const note = await capture({ statusNote: "Merged; live test pending" });

    const assessed = await assess(note);
    expect(assessed).toEqual({
      memoryId: note.id,
      revision: note.revision,
      expired: false,
      noteReviewDue: false,
      statusReviewDue: false,
      staleness: [],
      ambient: "deliver",
      statusNote: note.statusNote,
    });
    expect(await engine.buildReviewQueue()).toEqual([]);
  });

  it("a lapsed statusNote lease withholds only the line and queues the note attributed to its status", async () => {
    const note = await capture({ statusNote: "Merged; live test pending" });
    advance(MEMORY_STATUS_NOTE_LEASE_MS + DAY_MS);

    const assessed = await assess(note);
    expect(assessed.ambient).toBe("deliver-without-status");
    expect(assessed.statusNote).toBeNull();
    expect(assessed.noteReviewDue).toBe(false);
    expect(assessed.statusReviewDue).toBe(true);
    expect(assessed.staleness).toEqual([
      { cause: "lease", target: "statusNote" },
    ]);

    const queue = await engine.buildReviewQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      note: { id: note.id },
      noteReviewDue: false,
      statusReviewDue: true,
      expired: false,
      staleness: [{ cause: "lease", target: "statusNote" }],
    });
  });

  it("a lapsed note lease withholds the note entirely while it stays searchable and retrievable", async () => {
    const note = await capture({
      statusNote: "Merged; live test pending",
      reviewAfter: at(DAY_MS),
    });
    advance(2 * DAY_MS);

    const assessed = await assess(note);
    expect(assessed.ambient).toBe("withhold");
    expect(assessed.noteReviewDue).toBe(true);
    expect(assessed.statusReviewDue).toBe(false);
    expect(assessed.staleness).toEqual([{ cause: "lease", target: "note" }]);

    // Withheld from ambient delivery only: search and get are untouched.
    const hits = await repo.search("derived", {
      visibility: USER.visibility,
      includeArchived: false,
    });
    expect(hits.map((hit) => hit.note.id)).toContain(note.id);
    expect(ok(await service.get(note.slug, USER)).note.id).toBe(note.id);

    const queue = await engine.buildReviewQueue();
    expect(queue.map((entry) => entry.note.id)).toEqual([note.id]);
    expect(queue[0]?.noteReviewDue).toBe(true);
  });

  it("expiry excludes a note unconditionally, even when every lease is fresh", async () => {
    const note = await capture({
      statusNote: "Merged; live test pending",
      expiresAt: at(DAY_MS),
    });
    expect((await assess(note)).ambient).toBe("deliver");

    advance(DAY_MS);
    const assessed = await assess(note);
    expect(assessed.ambient).toBe("withhold");
    expect(assessed.expired).toBe(true);
    expect(assessed.noteReviewDue).toBe(false);
    expect(assessed.statusReviewDue).toBe(false);
    expect(assessed.staleness).toEqual([{ cause: "expiry" }]);
    expect(
      (await engine.buildReviewQueue()).map((entry) => entry.note.id),
    ).toEqual([note.id]);
  });

  it("a state note takes the short default lease at capture; a lesson takes none", async () => {
    const state = await capture({
      scope: "session",
      kind: "state",
      hook: "Working state: freshness engine half done",
    });
    expect(state.reviewAfter).toBe(at(MEMORY_STATE_NOTE_LEASE_MS));

    const explicit = await capture({
      scope: "session",
      kind: "state",
      hook: "Working state with its own lease",
      reviewAfter: at(10 * DAY_MS),
    });
    expect(explicit.reviewAfter).toBe(at(10 * DAY_MS));

    const lesson = await capture();
    expect(lesson.reviewAfter).toBeNull();

    advance(MEMORY_STATE_NOTE_LEASE_MS);
    expect((await assess(state)).ambient).toBe("withhold");
    expect((await assess(explicit)).ambient).toBe("deliver");
    expect((await assess(lesson)).ambient).toBe("deliver");
  });

  it("renders the status line with its age wherever the line is delivered", () => {
    const statusNote = {
      text: "Merged; live test pending",
      updatedAt: "2026-09-01T10:00:00.000Z",
      reviewAfter: "2026-09-15T10:00:00.000Z",
    };
    expect(renderMemoryStatusLine(statusNote, "2026-09-13T11:00:00.000Z")).toBe(
      "Merged; live test pending (status as of 12 days ago)",
    );
    expect(renderMemoryStatusLine(statusNote, "2026-09-02T10:00:00.000Z")).toBe(
      "Merged; live test pending (status as of 1 day ago)",
    );
    expect(renderMemoryStatusLine(statusNote, "2026-09-01T13:30:00.000Z")).toBe(
      "Merged; live test pending (status as of 3 hours ago)",
    );
    expect(renderMemoryStatusLine(statusNote, "2026-09-01T10:00:30.000Z")).toBe(
      "Merged; live test pending (status as of just now)",
    );
  });

  it("assesses a note from its own leases alone, with no artifact to consult", async () => {
    const note = await capture({ statusNote: "Merged; live test pending" });

    // The pure assessment takes the note and the clock and nothing else: there
    // is no artifact input a transition could reach (D6).
    expect(
      assessMemoryFreshness({ note: await head(note), now: now() }),
    ).toEqual(await assess(note));
  });
});

describe("review queue full scan (R8, D6)", () => {
  it("a note never selected for delivery surfaces when its own lease lapses", async () => {
    const ticket = await seedTicket("in_progress");
    const leased = await capture({
      hook: "Ticket-bound lesson about #74",
      reviewAfter: at(DAY_MS),
    });
    // An about link is a relevance cue and nothing more: moving the artifact
    // the note is linked to is not a staleness input (D6).
    ok(
      await service.link(
        leased.slug,
        { kind: "about", artifact: ticketRef(ticket) },
        USER,
      ),
    );
    await capture({ hook: "An untroubled lesson" });

    await setTicketStatus(ticket, "closed");
    advance(2 * DAY_MS);

    // No check() call ever selected the note; the scan finds it anyway, and
    // the only cause it cites is the lapsed lease.
    const queue = await engine.buildReviewQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      note: { id: leased.id },
      noteReviewDue: true,
      statusReviewDue: false,
      expired: false,
      staleness: [{ cause: "lease", target: "note" }],
    });
  });

  it("evaluates leases over the full table, oldest first, and filters by session incarnation", async () => {
    const projectStale = await capture({ reviewAfter: at(DAY_MS) });
    advance(1000);
    const sessionStale = await capture({
      scope: "session",
      kind: "state",
      hook: "Working state that will lapse",
    });
    await capture({ hook: "A fresh lesson" });
    advance(4 * DAY_MS);

    const all = await engine.buildReviewQueue();
    expect(all.map((entry) => entry.note.id)).toEqual([
      projectStale.id,
      sessionStale.id,
    ]);

    const sessionOnly = await engine.buildReviewQueue({
      session: PROJECT_INCARNATION,
    });
    expect(sessionOnly.map((entry) => entry.note.id)).toEqual([
      sessionStale.id,
    ]);
  });

  it("scans every scope owner unless narrowed to a visibility, and skips archived notes", async () => {
    const here = await capture({ reviewAfter: at(DAY_MS) });
    const elsewhere = await capture(
      { reviewAfter: at(DAY_MS), hook: "A lesson in the other project" },
      USER_ELSEWHERE,
    );
    const archived = await capture({ reviewAfter: at(DAY_MS) });
    ok(await service.archive(archived.slug, {}, USER));
    advance(2 * DAY_MS);

    const everywhere = await engine.buildReviewQueue();
    expect(everywhere.map((entry) => entry.note.id).sort()).toEqual(
      [here.id, elsewhere.id].sort(),
    );

    const narrowed = await engine.buildReviewQueue({
      visibility: USER_ELSEWHERE.visibility,
    });
    expect(narrowed.map((entry) => entry.note.id)).toEqual([elsewhere.id]);
  });
});

describe("mark-reviewed targeting (R2, R8)", () => {
  it("marking the note reviewed refreshes its lease, restoring delivery, and leaves the status level alone", async () => {
    const note = await capture({
      statusNote: "Merged; live test pending",
      reviewAfter: at(DAY_MS),
    });

    advance(MEMORY_STATUS_NOTE_LEASE_MS + DAY_MS);

    const before = await assess(note);
    expect(before.ambient).toBe("withhold");
    expect(before.staleness).toEqual([
      { cause: "lease", target: "note" },
      { cause: "lease", target: "statusNote" },
    ]);

    const reviewed = ok(
      await service.markReviewed(
        note.slug,
        { target: "note", baseRevision: note.revision },
        USER,
      ),
    );
    expect(reviewed.note.revision).toBe(note.revision + 1);
    expect(reviewed.note.reviewAfter).toBe(at(MEMORY_STATUS_NOTE_LEASE_MS));
    // The status line is untouched by a note-level review.
    expect(reviewed.note.statusNote).toEqual(note.statusNote);
    expect(changes()).toContain("reviewed");

    const after = await assess(note);
    expect(after.ambient).toBe("deliver-without-status");
    expect(after.noteReviewDue).toBe(false);
    expect(after.statusReviewDue).toBe(true);
    expect(after.staleness).toEqual([{ cause: "lease", target: "statusNote" }]);
  });

  it("marking the status reviewed refreshes the status lease, restoring the line with its age intact", async () => {
    const note = await capture({ statusNote: "Blocked on #74 landing" });
    const writtenAt = now();

    advance(MEMORY_STATUS_NOTE_LEASE_MS + DAY_MS);
    const before = await assess(note);
    expect(before.ambient).toBe("deliver-without-status");
    expect(before.staleness).toEqual([
      { cause: "lease", target: "statusNote" },
    ]);

    const reviewed = ok(
      await service.markReviewed(
        note.slug,
        { target: "statusNote", baseRevision: note.revision },
        USER,
      ),
    );
    expect(reviewed.note.revision).toBe(note.revision + 1);
    expect(reviewed.note.statusNote).toEqual({
      text: "Blocked on #74 landing",
      // The claim's own age is when it was written, not when it was confirmed.
      updatedAt: writtenAt,
      reviewAfter: at(MEMORY_STATUS_NOTE_LEASE_MS),
    });
    expect(reviewed.note.reviewAfter).toBeNull();

    const after = await assess(note);
    expect(after.ambient).toBe("deliver");
    expect(after.statusNote).toEqual(reviewed.note.statusNote);
    expect(after.staleness).toEqual([]);
  });

  it("a status re-lease reports the claim it re-asserts; a note review reports none", async () => {
    // R2.2/D8: the act that restores a claim to every conversation's ambient
    // block must state the claim, how old it is, and how long it now holds —
    // the evaluation found a human re-lease putting a false status line back
    // into delivery with nothing on either surface naming what was re-asserted.
    const note = await capture({ statusNote: "Never live-tested" });
    const writtenAt = now();
    advance(MEMORY_STATUS_NOTE_LEASE_MS + DAY_MS);

    const reLeased = ok(
      await service.markReviewed(
        note.slug,
        { target: "statusNote", baseRevision: note.revision },
        USER,
      ),
    );
    expect(reLeased.statusReLease).toEqual({
      text: "Never live-tested",
      updatedAt: writtenAt,
      reviewAfter: at(MEMORY_STATUS_NOTE_LEASE_MS),
    });

    const noteReview = ok(
      await service.markReviewed(
        note.slug,
        { target: "note", baseRevision: reLeased.note.revision },
        USER,
      ),
    );
    expect(noteReview.statusReLease).toBeNull();
  });

  it("a review never shortens a lease, and a note without one stays unleased", async () => {
    const farOut = await capture({ reviewAfter: at(60 * DAY_MS) });
    const reviewedFarOut = ok(
      await service.markReviewed(farOut.slug, { target: "note" }, USER),
    );
    expect(reviewedFarOut.note.reviewAfter).toBe(at(60 * DAY_MS));

    const unleased = await capture();
    const reviewedUnleased = ok(
      await service.markReviewed(unleased.slug, { target: "note" }, USER),
    );
    expect(reviewedUnleased.note.reviewAfter).toBeNull();
    expect(reviewedUnleased.note.revision).toBe(unleased.revision + 1);
  });

  it("a stale base revision refuses the review and refreshes nothing", async () => {
    const note = await capture({ reviewAfter: at(DAY_MS) });
    advance(2 * DAY_MS);
    const publishedBefore = changes().length;

    const error = refused(
      await service.markReviewed(
        note.slug,
        { target: "note", baseRevision: note.revision + 1 },
        USER,
      ),
    );
    expect(error).toMatchObject({
      code: "stale_revision",
      currentRevision: note.revision,
      baseRevision: note.revision + 1,
    });
    expect((await head(note)).reviewAfter).toBe(note.reviewAfter);
    expect(changes()).toHaveLength(publishedBefore);
    expect((await assess(note)).ambient).toBe("withhold");
  });

  it("a status review on a note without a status line is refused", async () => {
    const note = await capture();
    const error = refused(
      await service.markReviewed(note.slug, { target: "statusNote" }, USER),
    );
    expect(error.code).toBe("no_status_note");
    expect((await head(note)).revision).toBe(note.revision);
  });
});
