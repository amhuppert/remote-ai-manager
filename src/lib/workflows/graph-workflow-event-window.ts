import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowExecutionEventPageRow,
} from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";

/**
 * The complete event stream of an execution, from the two windows the client
 * actually holds.
 *
 * Neither read answers on its own. The tail query returns a bounded window of
 * the latest rows and is the only one SSE invalidates, so it is current but
 * forgets the beginning of a long run. The paginated walk returns every row
 * ever written but is deliberately NOT invalidated — an SSE refresh must not
 * throw away a walked history — so it goes stale the moment the run continues.
 * A surface that must not lose an old conversation OR a new verdict needs both.
 *
 * The two are windows of one append-only log in one order, so the join is a
 * concatenation with the overlap removed. The overlap is matched by occurrence
 * rather than by row identity: an event carries no client-visible row id in the
 * tail shape, and two structurally identical events at the same instant are
 * indistinguishable to every reader downstream, so consuming one occurrence per
 * copy the history already holds is exact for every case that can be told apart.
 *
 * Where both windows hold a row, the TAIL's copy is the one kept — it is the
 * fresher read of the same logged row, so it carries the newer answer for any
 * field the server has rewritten since the walk froze.
 *
 * The join answers what the two windows hold, never whether they hold
 * everything — `graphWorkflowEventWindowsMeet` is that question, and a caller
 * that presents this stream as the whole log must ask it.
 */
export function mergeGraphWorkflowEventWindows(
  history: readonly GraphWorkflowExecutionEventPageRow[],
  tail: readonly GraphWorkflowExecutionEvent[],
): GraphWorkflowExecutionEvent[] {
  if (history.length === 0) return [...tail];

  const heldSlots = new Map<string, number[]>();
  history.forEach((entry, index) => {
    const key = windowKey(entry);
    const slots = heldSlots.get(key);
    if (slots === undefined) heldSlots.set(key, [index]);
    else slots.push(index);
  });

  const joined: GraphWorkflowExecutionEvent[] = [...history];
  for (const entry of tail) {
    const slot = heldSlots.get(windowKey(entry))?.shift();
    if (slot === undefined) joined.push(entry);
    else joined[slot] = entry;
  }
  return joined;
}

/**
 * Whether the walked history reaches the oldest row the tail holds.
 *
 * A COMPLETE walk covers the log from its first row up to the moment it ran, and
 * the tail covers a bounded number of rows up to now. Joined they are the whole
 * log only if they touch. They stop touching when a run appends more rows than
 * the tail holds after the walk froze, which leaves a span of the log in neither
 * window — and a surface that lists what an execution recorded would then be
 * quietly listing less than it recorded.
 *
 * Touching is decided on the oldest tail row: both windows are contiguous runs
 * of one log, so if the walk holds that row it holds everything before it. An
 * empty tail asks nothing of the walk. A tail whose oldest row is exactly one
 * past the walk's newest reads as a gap here — the windows carry no shared id to
 * prove adjacency — which costs a re-walk and never a false claim of coverage.
 */
export function graphWorkflowEventWindowsMeet(
  history: readonly GraphWorkflowExecutionEventPageRow[],
  tail: readonly GraphWorkflowExecutionEvent[],
): boolean {
  const oldest = tail[0];
  if (oldest === undefined) return true;
  const key = windowKey(oldest);
  // Timestamp first: this runs on every tail refresh over the whole walked log,
  // and only the rows sharing the instant can possibly share the key.
  return history.some(
    (entry) =>
      entry.occurredAt === oldest.occurredAt && windowKey(entry) === key,
  );
}

/**
 * Whether the walk was taken before a retirement the tail has already read.
 *
 * A context reset is the one thing that rewrites rows already written: it marks
 * every row its context ever wrote as retired, however far back. The tail is
 * re-read on the SSE that follows, the walk is deliberately not — so a row the
 * walk holds as live and the tail returns as retired is the two windows
 * disagreeing about the same logged row, and the tail is the read that happened
 * after.
 *
 * It matters because it is the client's FIRST evidence of a reset: it arrives
 * with the tail, without waiting for the execution record to be read again. A
 * caller presenting the walk as the current attempt's history has to stop doing
 * so from that moment, because the rows it is presenting have already been
 * retired underneath it.
 *
 * One-directional on purpose. The opposite disagreement — the walk retired, the
 * tail live — is a walk taken after a tail, which says nothing is stale about
 * the walk, and the merge already prefers the tail per row for freshness alone.
 */
export function graphWorkflowWalkMissedRetirement(
  history: readonly GraphWorkflowExecutionEventPageRow[],
  tail: readonly GraphWorkflowExecutionEvent[],
): boolean {
  if (history.length === 0 || tail.length === 0) return false;

  // Occurrence-matched exactly as the merge matches, so the row compared here
  // is the row the merge would have replaced.
  const heldSlots = new Map<string, boolean[]>();
  for (const entry of history) {
    const key = windowKey(entry);
    const held = heldSlots.get(key);
    if (held === undefined) heldSlots.set(key, [entry.preReset]);
    else held.push(entry.preReset);
  }

  for (const entry of tail) {
    const walkedRow = heldSlots.get(windowKey(entry))?.shift();
    if (walkedRow === false && entry.preReset) return true;
  }
  return false;
}

/** The part of an execution record that says what a move of it can have been. */
export interface GraphWorkflowResetWitness {
  status: GraphWorkflowStatus;
  loopEpoch: number;
}

/** The statuses a context reset is accepted in; every other one refuses it. */
const RESET_ADMITTING_STATUSES: ReadonlySet<GraphWorkflowStatus> = new Set([
  "paused",
  "halted",
]);

/**
 * Whether a context reset can have happened BETWEEN two readings of one
 * execution's record.
 *
 * The question a stale walk actually turns on, and the reason the run's status
 * now is not it. A reset is an event in the past; asking "could this run be
 * reset at this moment?" of the record on screen misses every reset that has
 * already been resumed past — and a client reading a record it invalidated can
 * easily be handed only the far side of somebody else's pause, reset and
 * resume, with both ends reading "running".
 *
 * So the two records are compared instead, on the two facts that make the
 * excursion visible whether or not anyone watched it:
 *
 * STATUS, because a reset is refused unless the run is parked. If the status is
 * the same at both ends and is not itself a parked one, the run must have gone
 * into a park and come out again to have been reset at all.
 *
 * LOOP GENERATION, because that round trip cannot be made without moving it:
 * leaving `running` retires the generation that was running, and resuming
 * starts a new one. It is a fence token the engine already maintains for its
 * own reasons, and it moves for no reason a live run advances by itself.
 *
 * A parked record is watched on every move it makes, since a reset there needs
 * no transition at all — it can land between two reads and leave the run
 * exactly as parked as it found it.
 *
 * Everything else is an ordinary live update: a task settling, a lane
 * reporting, the machine snapshot advancing. Those arrive constantly, and
 * reading them as possible retirements would re-walk the entire event log every
 * few seconds for the whole life of a run.
 *
 * A missing record on one side and not the other is not a move this can read,
 * so it is reported as one that admits anything.
 */
export function graphWorkflowRecordMoveAdmitsReset(
  before: GraphWorkflowResetWitness | null,
  after: GraphWorkflowResetWitness | null,
): boolean {
  if (before === after) return false;
  if (before === null || after === null) return true;
  if (before.status !== after.status) return true;
  if (before.loopEpoch !== after.loopEpoch) return true;
  return (
    RESET_ADMITTING_STATUSES.has(before.status) ||
    RESET_ADMITTING_STATUSES.has(after.status)
  );
}

/** A walk in hand, and what the holder knows about where it came from. */
export interface GraphWorkflowWalkProvenance<TRecord> {
  /** The walk's own read stamp, under its own execution's query key. */
  readAt: number;
  /** How many pages the walk held at that stamp. */
  pageCount: number;
  /**
   * Whether every page this walk holds was read where the holder could see it.
   * A walk already in the cache when the holder first looked was read at some
   * unknown moment, against some unknown record.
   */
  proven: boolean;
  /**
   * The record standing when this walk's pages were read — or, for a walk the
   * holder inherited, when it first saw it. Either way it is the record the
   * walk has been sitting alongside, so its moving is news about the walk.
   */
  record: TRecord;
}

/** The walk a caller holds right now, and the record it currently displays. */
export interface GraphWorkflowWalkSighting<TRecord> {
  readAt: number;
  pageCount: number;
  record: TRecord;
}

/**
 * What a caller knows about the walk in its hand.
 *
 * A walk is cached under its OWN execution's key and outlives every reader of
 * it. Leaving a run and returning inside the cache window re-observes the walk
 * that was already there; so does a reader mounting for the first time, since
 * the cache long predates it and other observers of the execution record keep
 * refreshing that record while it is away. In both cases the walk arrives with
 * the read stamp it was taken with and no account of when that was. So "the
 * record on screen now" is never the answer — a run reset while the reader was
 * elsewhere or not yet mounted would have its pre-reset walk blessed as current,
 * and for a quiet context there is no overlapping row left to disagree about.
 *
 * Only a read the caller WATCHED land attributes a walk. A walk in hand that has
 * never been seen to move is of unknown provenance and stays that way. What it
 * still gets is the record it was FIRST SEEN beside, which is not an attribution
 * — it vouches for nothing — but is the baseline that makes a later move of the
 * record visible as a move.
 *
 * A moved read stamp is NOT enough, because a paginated walk has two ways to
 * move it and they mean opposite things. FINISHING a walk appends the next
 * older page and leaves every page already held exactly as it was — and those
 * are precisely the pages a reset would have retired. RE-READING one replaces
 * them. The two are told apart by the page count: growth beyond what was
 * already held is an extension, which carries the earlier pages' provenance
 * forward unchanged rather than vouching for them, and anything else is a read
 * of the whole walk that answers for the record standing when it landed.
 *
 * So a walk read page by page under the caller's eyes is proven from its first
 * page and stays proven as it grows, and a walk inherited half-built stays
 * unproven however far it is carried — only a re-read can settle it.
 */
export function graphWorkflowWalkProvenance<TRecord>(
  remembered: GraphWorkflowWalkProvenance<TRecord> | undefined,
  current: GraphWorkflowWalkSighting<TRecord>,
): GraphWorkflowWalkProvenance<TRecord> {
  if (remembered === undefined) {
    return {
      readAt: current.readAt,
      pageCount: current.pageCount,
      proven: false,
      record: current.record,
    };
  }
  if (remembered.readAt === current.readAt) return remembered;
  const extended =
    remembered.pageCount > 0 && current.pageCount > remembered.pageCount;
  if (extended) {
    // The pages already held were not touched, so what was known about them is
    // still all that is known. The stamp and count advance so the NEXT append
    // is recognised as one too.
    return {
      readAt: current.readAt,
      pageCount: current.pageCount,
      proven: remembered.proven,
      record: remembered.record,
    };
  }
  return {
    readAt: current.readAt,
    pageCount: current.pageCount,
    proven: true,
    record: current.record,
  };
}

/**
 * Whether this walk may be described as the given record's own history.
 *
 * Two ways to fail, and neither of them asks what the run is doing now.
 *
 * An INHERITED walk is refused outright. It was read at an unknown moment and
 * could predate any retirement, and a reset that poisoned it is permanent: the
 * run it belongs to may since have been resumed, or have finished and become
 * historical, and the retired rows are retired still.
 *
 * A walk whose record has MOVED is refused where that move can have carried a
 * reset — see `graphWorkflowRecordMoveAdmitsReset`, which decides that from the
 * two records rather than from the run's present status, because the reset it
 * is looking for happened between them. What that spares is the ordinary live
 * update: a record that advanced without going near a park cannot have been
 * reset, and condemning the walk on each of those would re-read the whole log
 * for as long as the run lasts.
 */
export function graphWorkflowWalkIsVouched<
  TRecord extends GraphWorkflowResetWitness | null,
>(provenance: GraphWorkflowWalkProvenance<TRecord>, record: TRecord): boolean {
  if (!provenance.proven) return false;
  return !graphWorkflowRecordMoveAdmitsReset(provenance.record, record);
}

/**
 * Whether this walk has to be read again before it can be described.
 *
 * Not simply the negation of vouching, and the gap between the two is on
 * purpose: a walk still arriving is neither shown nor re-read, because a read of
 * it is already under way and that read will attribute itself when it lands.
 *
 * A record that has moved somewhere a reset could have reached it is asked
 * FIRST and without that qualification. It is the case where a read already in
 * flight is not good enough — that read was issued while the old record stood
 * and may be returning the log as it was before the reset — so the in-flight
 * walk is replaced rather than waited on.
 *
 * `walkHasSettled` gates the inherited walk alone: it has no read in flight to
 * wait for and no movement to report, so the moment it stops arriving is the
 * moment it must be replaced.
 */
export function graphWorkflowWalkNeedsReread<
  TRecord extends GraphWorkflowResetWitness | null,
>(
  provenance: GraphWorkflowWalkProvenance<TRecord>,
  record: TRecord,
  walkHasSettled: boolean,
): boolean {
  if (graphWorkflowRecordMoveAdmitsReset(provenance.record, record))
    return true;
  return !provenance.proven && walkHasSettled;
}

/**
 * What a caller holds about the two windows, and about the record it read them
 * against — the whole of what `graphWorkflowLogIsWhole` decides on.
 */
export interface GraphWorkflowLogEvidence {
  /** The paginated walk has finished, and is not being re-read or failed. */
  walkIsComplete: boolean;
  /** The bounded tail has landed, and is not being re-read or failed. */
  tailIsRead: boolean;
  /** The two windows touch, so joined they cover the log with no span missing. */
  windowsMeet: boolean;
  /** The tail has already returned as retired a row the walk holds as live. */
  walkMissedRetirement: boolean;
  /**
   * The walk in hand may be described as this record's own history — it was
   * read where the caller could see it, and the record has not moved anywhere a
   * reset could have reached it since. See `graphWorkflowWalkIsVouched`.
   */
  walkIsVouched: boolean;
  /**
   * Whether a reset could be rewriting this run's rows right now. It does NOT
   * excuse an unvouched walk; it decides only whether the record's own read
   * state is evidence about anything.
   */
  resetIsAdmissible: boolean;
  /** The record that SUPPLIES the view has been read, and the read succeeded. */
  recordIsRead: boolean;
}

/**
 * Whether the joined windows may be presented as this run's history so far.
 *
 * Holding both windows is not the same as holding the whole log, and holding
 * the whole log is not the same as holding the CURRENT attempt's: a context
 * reset retires rows already written, however far back, and the walk is
 * deliberately never invalidated. So the walk is described only while it is
 * finished, meets the tail, and can be vouched for.
 *
 * Vouching is required of EVERY run, whatever it is doing now. "Could this run
 * be reset at this moment?" looks like the same question and is not: the
 * retirement that condemns a walk happened when the reset ran, and the rows stay
 * retired forever after. A run reset while the reader was away can be resumed,
 * or can finish and become historical, before the reader returns — and it then
 * answers no to a question about the present while holding a cache poisoned in
 * the past. Vouching asks instead where the record has BEEN since the walk was
 * read, which is a question the two records answer between them.
 *
 * What reset admissibility does decide is whether the RECORD's read state means
 * anything here. Where a reset can reach the run, the SSE that carries it
 * invalidates record and tail together, so a record still being read is one this
 * caller knows it may be behind on. Where it cannot, that read answers about
 * something else entirely and withholding on it would hide a card that has
 * everything it needs.
 *
 * Vouching is separate from `walkMissedRetirement` because the two see different
 * resets. The retirement disagreement is the earlier and better evidence, but it
 * needs a row both windows hold; a context quiet for longer than the tail window
 * leaves none, and only provenance is left to go on.
 */
export function graphWorkflowLogIsWhole(
  evidence: GraphWorkflowLogEvidence,
): boolean {
  if (!evidence.walkIsComplete || !evidence.tailIsRead) return false;
  if (!evidence.windowsMeet || evidence.walkMissedRetirement) return false;
  if (!evidence.walkIsVouched) return false;
  return !evidence.resetIsAdmissible || evidence.recordIsRead;
}

/**
 * Both windows decode through the same schema, so the same event serializes the
 * same way whichever query read it. `seq` is deliberately out of the key: only
 * the page rows carry it, and including it would make every tail row look new.
 */
function windowKey(entry: GraphWorkflowExecutionEvent): string {
  return `${entry.occurredAt} ${JSON.stringify(entry.event)}`;
}
