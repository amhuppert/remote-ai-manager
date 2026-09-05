import { createLogger } from "@/lib/logging";
import type { MemoryRepo } from "@/lib/state-store/memory-repo";
import {
  MEMORY_STATE_NOTE_LEASE_MS,
  MEMORY_STATUS_NOTE_LEASE_MS,
  type MemoryAmbientDelivery,
  type MemoryKind,
  type MemoryNote,
  type MemoryProjectSessionRef,
  type MemoryReviewQueueEntry,
  type MemoryStaleness,
  type MemoryStatusNote,
  type MemoryVisibility,
} from "./schemas";
import type { MemorySessionLifecycleReader } from "./session-lifecycle";

/**
 * The freshness engine (spec R2, R8, D2, D6): two levels of staleness with
 * distinct delivery behavior, evaluated at two cadences.
 *
 * Freshness is leases and expiry alone. A claim an artifact transition could
 * falsify is a claim about that artifact's state, which agents read live and
 * never record, so nothing here compares a note against an artifact (D6).
 *
 * Levels: a stale statusNote (its lease passed) withholds only the line while
 * the hook and body keep flowing; a stale note (its own lease passed) is
 * withheld from ambient delivery entirely; an expired note is excluded
 * unconditionally. Every level stays searchable and explicitly retrievable —
 * freshness gates AMBIENT delivery only, and never touches the search or get
 * paths.
 *
 * Cadences: `check` is the lazy comparison for candidates a delivery build has
 * already selected (the per-turn hot path stays cheap); `buildReviewQueue`
 * evaluates the whole note table, so a rarely delivered note still surfaces as
 * review-due when its lease lapses.
 */

const logger = createLogger("memory.freshness");

export interface MemoryFreshnessAssessment {
  readonly memoryId: string;
  readonly revision: number;
  readonly expired: boolean;
  readonly noteReviewDue: boolean;
  readonly statusReviewDue: boolean;
  /** Every cause that applies, attributed to the level it stales. */
  readonly staleness: MemoryStaleness[];
  readonly ambient: MemoryAmbientDelivery;
  /** The status line ambient delivery carries: null when absent or withheld. */
  readonly statusNote: MemoryStatusNote | null;
}

export interface MemoryReviewQueueFilter {
  /** Explicit curation queue across completed incarnations of one project. */
  readonly projectCandidates?: string;
  /** Restrict to one actor's visible scope union; omitted scans every owner. */
  readonly visibility?: MemoryVisibility;
  /** Restrict to one session incarnation's notes (the session-filtered queue). */
  readonly session?: MemoryProjectSessionRef;
  /** Restrict to promotion candidates: the prefiltered session-end queue (R10). */
  readonly promotionCandidates?: boolean;
}

export interface MemoryFreshnessEngineDeps {
  repo: MemoryRepo;
  /** Promotion candidacy asks this whether an incarnation is over (R10). */
  sessions: MemorySessionLifecycleReader;
  now(): string;
}

export interface MemoryFreshnessEngine {
  /** The lazy delivery-time check over already-selected candidates. */
  check(
    candidates: readonly MemoryNote[],
  ): Promise<Map<string, MemoryFreshnessAssessment>>;
  /** The full-table scan: every non-archived note's lease and expiry. */
  buildReviewQueue(
    filter?: MemoryReviewQueueFilter,
  ): Promise<MemoryReviewQueueEntry[]>;
  /** How many promotion candidates one session incarnation holds (R10). */
  countPromotionCandidates(session: MemoryProjectSessionRef): Promise<number>;
}

// ============================================================
// Lease arithmetic (the one owner of "how long" and "has it passed")
// ============================================================

/**
 * The lease a review act grants a note of this kind. A state note is wholly
 * perishable and re-leases short; a durable note that leases out at all
 * re-leases for the spec's one stated review period.
 */
export function defaultMemoryReviewLeaseMs(kind: MemoryKind): number {
  return kind === "state"
    ? MEMORY_STATE_NOTE_LEASE_MS
    : MEMORY_STATUS_NOTE_LEASE_MS;
}

export function leasedUntil(from: string, leaseMs: number): string {
  return new Date(Date.parse(from) + leaseMs).toISOString();
}

/**
 * A refreshed lease runs `leaseMs` from the review and never lands earlier
 * than the lease it replaces: confirming a claim early must not bring its
 * review forward.
 */
export function refreshedMemoryLease(
  existing: string,
  reviewedAt: string,
  leaseMs: number,
): string {
  const candidate = Date.parse(reviewedAt) + leaseMs;
  const existingMs = Date.parse(existing);
  return new Date(
    Number.isNaN(existingMs) ? candidate : Math.max(candidate, existingMs),
  ).toISOString();
}

/** A deadline that cannot be read never passes: an unreadable lease withholds nothing. */
function hasPassed(deadline: string, nowMs: number): boolean {
  const deadlineMs = Date.parse(deadline);
  return !Number.isNaN(deadlineMs) && deadlineMs <= nowMs;
}

// ============================================================
// The pure assessment
// ============================================================

/**
 * One note's freshness from its leases and its expiry. Pure: the two cadences
 * differ only in which notes they hand in.
 */
export function assessMemoryFreshness(input: {
  readonly note: MemoryNote;
  readonly now: string;
}): MemoryFreshnessAssessment {
  const { note } = input;
  const nowMs = Date.parse(input.now);
  const staleness: MemoryStaleness[] = [];

  const expired = note.expiresAt !== null && hasPassed(note.expiresAt, nowMs);
  if (expired) staleness.push({ cause: "expiry" });

  const noteReviewDue =
    note.reviewAfter !== null && hasPassed(note.reviewAfter, nowMs);
  if (noteReviewDue) staleness.push({ cause: "lease", target: "note" });

  const statusReviewDue =
    note.statusNote !== null && hasPassed(note.statusNote.reviewAfter, nowMs);
  if (statusReviewDue) staleness.push({ cause: "lease", target: "statusNote" });

  const ambient: MemoryAmbientDelivery =
    expired || noteReviewDue
      ? "withhold"
      : statusReviewDue
        ? "deliver-without-status"
        : "deliver";

  return {
    memoryId: note.id,
    revision: note.revision,
    expired,
    noteReviewDue,
    statusReviewDue,
    staleness,
    ambient,
    statusNote: ambient === "deliver" ? note.statusNote : null,
  };
}

// ============================================================
// The engine: two cadences over the repository
// ============================================================

/**
 * A name and a created-at identify an incarnation only WITHIN a project, and
 * the queue scan reads every scope owner, so the project path is part of the
 * comparison: without it, two projects holding same-named sessions created in
 * the same second have their candidates merged into one queue (R10).
 */
function belongsToIncarnation(
  note: MemoryNote,
  session: MemoryProjectSessionRef,
): boolean {
  return (
    note.scope === "session" &&
    note.projectPath === session.projectPath &&
    note.sessionName === session.sessionName &&
    note.sessionCreatedAt === session.sessionCreatedAt
  );
}

/**
 * The durable half of a session's library: what promotion is even about (R10).
 * A state note is wholly perishable and archives with its session instead, and
 * an inactive note is not offered. The session-end path and the queue builder
 * share this so the candidates a completion reports and the candidates the
 * queue lists can never be two different sets.
 */
export function isPromotableSessionNote(note: MemoryNote): boolean {
  return (
    note.scope === "session" &&
    note.kind !== "state" &&
    note.lifecycle === "active"
  );
}

/** The note's own incarnation, named in full; null off session scope. */
function incarnationOf(note: MemoryNote): MemoryProjectSessionRef | null {
  if (
    note.scope !== "session" ||
    note.projectPath === null ||
    note.sessionName === null ||
    note.sessionCreatedAt === null
  ) {
    return null;
  }
  return {
    projectPath: note.projectPath,
    sessionName: note.sessionName,
    sessionCreatedAt: note.sessionCreatedAt,
  };
}

export function createMemoryFreshnessEngine(
  deps: MemoryFreshnessEngineDeps,
): MemoryFreshnessEngine {
  function assessAll(
    notes: readonly MemoryNote[],
    now: string,
  ): Map<string, MemoryFreshnessAssessment> {
    return new Map(
      notes.map((note) => [note.id, assessMemoryFreshness({ note, now })]),
    );
  }

  /**
   * Candidacy is DERIVED from whether the incarnation is OVER rather than
   * stored: a stored flag would be a second copy of the session lifecycle,
   * free to drift from it (R10). One lookup per distinct incarnation, however
   * many notes it holds.
   */
  async function promotionCandidacy(
    notes: readonly MemoryNote[],
  ): Promise<Set<string>> {
    const candidates = new Set<string>();
    const over = new Map<string, boolean>();
    for (const note of notes) {
      if (!isPromotableSessionNote(note)) continue;
      const incarnation = incarnationOf(note);
      if (incarnation === null) continue;
      const key = JSON.stringify([
        incarnation.projectPath,
        incarnation.sessionName,
        incarnation.sessionCreatedAt,
      ]);
      let isOver = over.get(key);
      if (isOver === undefined) {
        isOver = await deps.sessions.isSessionIncarnationOver(incarnation);
        over.set(key, isOver);
      }
      if (isOver) candidates.add(note.id);
    }
    return candidates;
  }

  async function buildReviewQueue(
    filter: MemoryReviewQueueFilter = {},
  ): Promise<MemoryReviewQueueEntry[]> {
    const scanned =
      filter.projectCandidates !== undefined
        ? (await deps.repo.listAllScopes({ includeArchived: false })).filter(
            (note) =>
              note.scope === "session" &&
              note.projectPath === filter.projectCandidates,
          )
        : filter.visibility === undefined
          ? await deps.repo.listAllScopes({ includeArchived: false })
          : await deps.repo.list({
              visibility: filter.visibility,
              includeArchived: false,
            });
    const session = filter.session;
    const notes =
      session === undefined
        ? scanned
        : scanned.filter((note) => belongsToIncarnation(note, session));
    // Completeness lives here: every note's lease and expiry, not the leases
    // of whatever a delivery happened to select.
    const assessed = assessAll(notes, deps.now());

    const candidates = await promotionCandidacy(notes);

    const entries: MemoryReviewQueueEntry[] = [];
    for (const note of notes) {
      const assessment = assessed.get(note.id);
      if (assessment === undefined) continue;
      const promotionCandidate = candidates.has(note.id);
      // A note earns its place by needing review or by needing a promotion
      // decision. The prefiltered queue narrows to the second; the ordinary
      // queue holds both, because a candidate left unpromoted is work owed
      // just as a stale claim is.
      if (
        (filter.promotionCandidates === true ||
          filter.projectCandidates !== undefined) &&
        !promotionCandidate
      )
        continue;
      if (assessment.staleness.length === 0 && !promotionCandidate) continue;
      entries.push({
        note,
        staleness: assessment.staleness,
        noteReviewDue: assessment.noteReviewDue,
        statusReviewDue: assessment.statusReviewDue,
        expired: assessment.expired,
        promotionCandidate,
      });
    }
    // Longest unattended first, so the top of the queue is the oldest claim.
    entries.sort(
      (a, b) =>
        a.note.updatedAt.localeCompare(b.note.updatedAt) ||
        a.note.id.localeCompare(b.note.id),
    );

    logger.info("memory.freshness.review_queue_built", {
      projectCandidates: filter.projectCandidates ?? null,
      scanned: notes.length,
      queued: entries.length,
      // `due` stays the stale count it has always been; a promotion candidate
      // is queued work, not a stale claim, so it is counted separately.
      due: entries.filter((entry) => entry.staleness.length > 0).length,
      promotionCandidates: entries.filter((entry) => entry.promotionCandidate)
        .length,
      sessionFiltered: session !== undefined,
      visibilityFiltered: filter.visibility !== undefined,
      promotionCandidatesOnly: filter.promotionCandidates === true,
    });
    return entries;
  }

  return {
    async check(candidates) {
      if (candidates.length === 0) return new Map();
      // Only the selected candidates are evaluated: the per-turn path never
      // scans the table (D6).
      return assessAll(candidates, deps.now());
    },

    buildReviewQueue,

    /**
     * The count the Library badge and the session-completion surface read. It
     * is the prefiltered queue's length by construction, so a badge can never
     * promise a number the queue then fails to show (R10).
     */
    async countPromotionCandidates(session) {
      const entries = await buildReviewQueue({
        session,
        promotionCandidates: true,
      });
      return entries.length;
    },
  };
}
