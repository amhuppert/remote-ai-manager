import { describe, expect, it } from "vitest";
import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowExecutionEventPageRow,
} from "@/lib/workflow-graph/event-schemas";
import {
  graphWorkflowEventWindowsMeet,
  graphWorkflowRecordMoveAdmitsReset,
  graphWorkflowWalkIsVouched,
  graphWorkflowWalkNeedsReread,
  graphWorkflowWalkProvenance,
  type GraphWorkflowLogEvidence,
  graphWorkflowLogIsWhole,
  graphWorkflowWalkMissedRetirement,
  mergeGraphWorkflowEventWindows,
} from "./graph-workflow-event-window";

/**
 * The records the vouching questions below are asked about. A record is read for
 * two facts only — the status it is in, and the loop generation it is running —
 * so the fixtures carry nothing else.
 */
/** A live run, as the walk was read against it. */
const running = { status: "running" as const, loopEpoch: 4 };
/** The same run a moment later: a live record moves constantly, by itself. */
const runningLater = { status: "running" as const, loopEpoch: 4 };
/**
 * The same run after somebody else paused it, reset a context and resumed —
 * leaving `running` retires a loop generation and resuming starts another, so
 * the excursion is on the record even though both ends read "running".
 */
const resumedAfterReset = { status: "running" as const, loopEpoch: 6 };
/** Parked, where a reset is admissible right now. */
const paused = { status: "paused" as const, loopEpoch: 4 };

/**
 * Two reads of one append-only log: the walked history (complete up to the walk,
 * and carrying each row's durable id) and the SSE-refreshed tail (bounded,
 * always current, id-less). What is proved here is that joining them loses
 * nothing and repeats nothing.
 */

function contextStatus(
  occurredAt: string,
  iterationCount: number,
  contextId = "context-implement",
): GraphWorkflowExecutionEvent {
  return {
    occurredAt,
    preReset: false,
    event: {
      type: "graph-workflow-context-status",
      projectName: "proj",
      sessionName: "sess",
      executionId: "execution-1",
      contextId,
      status: "running",
      remainingTaskCount: 1,
      iterationCount,
    },
  };
}

/** The same row as the paginated walk returns it, with its durable log id. */
function walked(
  entry: GraphWorkflowExecutionEvent,
  seq: number,
): GraphWorkflowExecutionEventPageRow {
  return { ...entry, seq };
}

const retirement = (entries: readonly GraphWorkflowExecutionEvent[]) =>
  entries.map((entry) => entry.preReset);

const at = (entries: readonly GraphWorkflowExecutionEvent[]) =>
  entries.map((entry) => entry.occurredAt);

describe("mergeGraphWorkflowEventWindows", () => {
  const a = contextStatus("2026-03-27T09:00:00.000Z", 1);
  const b = contextStatus("2026-03-27T10:00:00.000Z", 2);
  const c = contextStatus("2026-03-27T11:00:00.000Z", 3);
  const d = contextStatus("2026-03-27T12:00:00.000Z", 4);

  it("returns the tail alone while the history is still loading", () => {
    expect(mergeGraphWorkflowEventWindows([], [c, d])).toEqual([c, d]);
  });

  it("returns the history alone when no tail is being read", () => {
    expect(
      at(mergeGraphWorkflowEventWindows([walked(a, 1), walked(b, 2)], [])),
    ).toEqual(at([a, b]));
  });

  // The whole point: the walked history holds the old events the bounded tail
  // dropped, and the tail holds the new ones the walk happened before.
  it("keeps the history's older events and the tail's newer ones, in log order", () => {
    expect(
      at(
        mergeGraphWorkflowEventWindows(
          [walked(a, 1), walked(b, 2), walked(c, 3)],
          [b, c, d],
        ),
      ),
    ).toEqual(at([a, b, c, d]));
  });

  it("appends a tail that overlaps nothing rather than dropping it", () => {
    expect(
      at(mergeGraphWorkflowEventWindows([walked(a, 1), walked(b, 2)], [c, d])),
    ).toEqual(at([a, b, c, d]));
  });

  // Identical events at the same instant are indistinguishable, so the join
  // counts them rather than matching them: two in the log stay two.
  it("counts repeated identical events instead of collapsing them", () => {
    const repeated = mergeGraphWorkflowEventWindows(
      [walked(a, 1), walked(a, 2)],
      [a, a, b],
    );
    expect(repeated).toHaveLength(3);
    expect(at(repeated)).toEqual(at([a, a, b]));
  });

  // The server rewrites `preReset` on rows already written, so a walk taken
  // before that and a tail read after it disagree about the same row. The tail
  // is the fresher read, so its copy is the one kept.
  it("takes the tail's retirement flag over the copy the walk read earlier", () => {
    const retired: GraphWorkflowExecutionEvent = { ...b, preReset: true };

    const merged = mergeGraphWorkflowEventWindows(
      [walked(a, 1), walked(b, 2)],
      [retired, c],
    );

    expect(at(merged)).toEqual(at([a, b, c]));
    expect(retirement(merged)).toEqual([false, true, false]);
  });
});

describe("graphWorkflowEventWindowsMeet", () => {
  const a = contextStatus("2026-03-27T09:00:00.000Z", 1);
  const b = contextStatus("2026-03-27T10:00:00.000Z", 2);
  const c = contextStatus("2026-03-27T11:00:00.000Z", 3);
  const d = contextStatus("2026-03-27T12:00:00.000Z", 4);

  it("meets when the walk still holds the oldest row the tail kept", () => {
    expect(
      graphWorkflowEventWindowsMeet(
        [walked(a, 1), walked(b, 2), walked(c, 3)],
        [b, c, d],
      ),
    ).toBe(true);
  });

  it("meets vacuously when there is no tail to reach", () => {
    expect(graphWorkflowEventWindowsMeet([walked(a, 1)], [])).toBe(true);
  });

  // The run appended more rows than the tail holds since the walk froze, so the
  // span between them is in neither window. Presenting the join as the whole log
  // here would drop rows the execution did record.
  it("does not meet when the run outran the tail after the walk froze", () => {
    expect(graphWorkflowEventWindowsMeet([walked(a, 1)], [c, d])).toBe(false);
  });

  it("does not meet when the walk has read nothing yet", () => {
    expect(graphWorkflowEventWindowsMeet([], [c, d])).toBe(false);
  });
});

describe("graphWorkflowWalkMissedRetirement", () => {
  const a = contextStatus("2026-03-27T09:00:00.000Z", 1);
  const b = contextStatus("2026-03-27T10:00:00.000Z", 2);
  const c = contextStatus("2026-03-27T11:00:00.000Z", 3);

  it("is silent while the two windows agree about every shared row", () => {
    expect(
      graphWorkflowWalkMissedRetirement([walked(a, 1), walked(b, 2)], [b, c]),
    ).toBe(false);
  });

  // The reset rewrote rows the walk had already read. The tail read them after
  // that and says so, which is the client's first evidence of the reset — it
  // arrives without waiting for the execution record to be re-read.
  it("reports a row the walk holds as live that the tail reads as retired", () => {
    expect(
      graphWorkflowWalkMissedRetirement(
        [walked(a, 1), walked(b, 2)],
        [{ ...b, preReset: true }, c],
      ),
    ).toBe(true);
  });

  // The walk is the fresher read here — taken after the reset, joined to a tail
  // that has not been refreshed since. Nothing about the walk is out of date, so
  // there is nothing to re-read.
  it("says nothing when it is the tail that predates the retirement", () => {
    expect(
      graphWorkflowWalkMissedRetirement(
        [walked(a, 1), walked({ ...b, preReset: true }, 2)],
        [b, c],
      ),
    ).toBe(false);
  });

  it("asks nothing of rows only one window holds", () => {
    expect(graphWorkflowWalkMissedRetirement([walked(a, 1)], [c])).toBe(false);
  });
});

/**
 * The panel presents the joined windows as "this context's history so far". This
 * is the decision of whether it may — every way the two reads can be in hand and
 * still not amount to that.
 */
describe("graphWorkflowLogIsWhole", () => {
  /** Every condition met: the ordinary case, where the log is describable. */
  const whole: GraphWorkflowLogEvidence = {
    walkIsComplete: true,
    tailIsRead: true,
    windowsMeet: true,
    walkMissedRetirement: false,
    walkIsVouched: true,
    resetIsAdmissible: false,
    recordIsRead: true,
  };

  it("describes the log when both windows are in hand and they touch", () => {
    expect(graphWorkflowLogIsWhole(whole)).toBe(true);
  });

  it("withholds an unfinished or failed walk", () => {
    expect(graphWorkflowLogIsWhole({ ...whole, walkIsComplete: false })).toBe(
      false,
    );
  });

  it("withholds a tail that has not landed", () => {
    expect(graphWorkflowLogIsWhole({ ...whole, tailIsRead: false })).toBe(
      false,
    );
  });

  it("withholds windows that leave a span of the log in neither", () => {
    expect(graphWorkflowLogIsWhole({ ...whole, windowsMeet: false })).toBe(
      false,
    );
  });

  it("withholds a walk the tail has already contradicted", () => {
    expect(
      graphWorkflowLogIsWhole({ ...whole, walkMissedRetirement: true }),
    ).toBe(false);
  });

  // The re-walk that replaces an unvouched walk is started from an effect, which
  // runs only AFTER the render that used the walk has been committed — so the
  // decision cannot wait for it, or one frame of the retired round is painted as
  // current on the way past.
  it("withholds a walk it cannot vouch for", () => {
    expect(graphWorkflowLogIsWhole({ ...whole, walkIsVouched: false })).toBe(
      false,
    );
  });

  // The reported defect of attempt 6. A run reset while the reader was away can
  // be resumed, or finish, before the reader returns — and it then answers no to
  // "could a reset happen now?" while still holding the cache that reset
  // poisoned. Status must not excuse an unvouched walk.
  it("still withholds an unvouched walk where no reset can reach the run", () => {
    expect(
      graphWorkflowLogIsWhole({
        ...whole,
        resetIsAdmissible: false,
        walkIsVouched: false,
      }),
    ).toBe(false);
  });

  it("withholds the log while the record it was walked against is being read", () => {
    expect(
      graphWorkflowLogIsWhole({
        ...whole,
        resetIsAdmissible: true,
        recordIsRead: false,
      }),
    ).toBe(false);
  });

  // Where no reset can reach the run, the record's read state answers about
  // something else. A historical run is read by id and can never be reset, so
  // gating its history on that read would hide a card that has all it needs.
  it("asks nothing of the record's read state where a reset cannot reach the run", () => {
    expect(
      graphWorkflowLogIsWhole({
        ...whole,
        resetIsAdmissible: false,
        recordIsRead: false,
      }),
    ).toBe(true);
  });
});

/**
 * Which record a walk in hand was actually read against.
 *
 * The walk is cached under its OWN execution's key, and every reader of it —
 * including one that has only just mounted — can be handed a walk that was read
 * before it existed. So "the record on screen now" is never the answer. Only a
 * read the caller WATCHED land says which record a walk answers for; anything
 * else is a walk of unknown provenance, and blessing one is how a pre-reset
 * history is presented as the current attempt's.
 */
describe("graphWorkflowWalkProvenance", () => {
  const before = { id: "record-before" };
  const after = { id: "record-after" };

  // The walk was read before this caller had anything to say about it: it may
  // have been read against this record or against the one a reset replaced, and
  // nothing in hand can tell the two apart. The record it was found beside is
  // still worth keeping — not as an attribution, but so that the record moving
  // later is visible as a move.
  it("refuses to attribute a walk whose read it did not witness", () => {
    expect(
      graphWorkflowWalkProvenance(undefined, {
        readAt: 10,
        pageCount: 2,
        record: before,
      }),
    ).toEqual({ readAt: 10, pageCount: 2, proven: false, record: before });
  });

  // An unwitnessed walk does not become witnessed by being looked at again. It
  // stays unproven until a read actually replaces it.
  it("keeps an unwitnessed walk unproven while it is the walk in hand", () => {
    expect(
      graphWorkflowWalkProvenance(
        { readAt: 10, pageCount: 2, proven: false, record: before },
        { readAt: 10, pageCount: 2, record: after },
      ),
    ).toEqual({ readAt: 10, pageCount: 2, proven: false, record: before });
  });

  // The cold path: nothing cached, so the first page read happens under this
  // caller's eyes and answers for the record standing when it landed.
  it("attributes a walk whose first page landed while it was watching", () => {
    expect(
      graphWorkflowWalkProvenance(
        { readAt: 0, pageCount: 0, proven: false, record: before },
        { readAt: 20, pageCount: 1, record: after },
      ),
    ).toEqual({ readAt: 20, pageCount: 1, proven: true, record: after });
  });

  // The reported defect. Appending the next older page moves the read stamp
  // without touching a single page already held — and those are exactly the
  // pages a reset would have retired. Finishing a walk is not re-reading it.
  it("does not let an appended page vouch for the pages already held", () => {
    expect(
      graphWorkflowWalkProvenance(
        { readAt: 10, pageCount: 1, proven: false, record: before },
        { readAt: 20, pageCount: 2, record: after },
      ),
    ).toEqual({ readAt: 20, pageCount: 2, proven: false, record: before });
  });

  // The same rule the other way up: a walk read page by page under the caller's
  // eyes was proven at its first page and does not lose that by growing.
  it("carries a witnessed walk's attribution across an append", () => {
    expect(
      graphWorkflowWalkProvenance(
        { readAt: 10, pageCount: 1, proven: true, record: before },
        { readAt: 20, pageCount: 2, record: after },
      ),
    ).toEqual({ readAt: 20, pageCount: 2, proven: true, record: before });
  });

  // A re-read replaces every page it holds rather than adding one, so the page
  // count stands still. That is the read that can settle an inherited walk.
  it("attributes an inherited walk once its own pages are read again", () => {
    expect(
      graphWorkflowWalkProvenance(
        { readAt: 10, pageCount: 2, proven: false, record: before },
        { readAt: 20, pageCount: 2, record: after },
      ),
    ).toEqual({ readAt: 20, pageCount: 2, proven: true, record: after });
  });

  // The whole point: same execution, same walk, but the record has moved on
  // underneath it. The walk keeps the record it was READ against, so the caller
  // can see the two no longer agree.
  it("keeps the record a walk was read against when the walk has not been re-read", () => {
    expect(
      graphWorkflowWalkProvenance(
        { readAt: 10, pageCount: 1, proven: true, record: before },
        { readAt: 10, pageCount: 1, record: after },
      ),
    ).toEqual({ readAt: 10, pageCount: 1, proven: true, record: before });
  });

  // A new read stamp under one execution's own key, with no page added, is a
  // genuine re-read — it answers for the record standing when it ran.
  it("re-attributes a walk that was actually read again", () => {
    expect(
      graphWorkflowWalkProvenance(
        { readAt: 10, pageCount: 1, proven: true, record: before },
        { readAt: 20, pageCount: 1, record: after },
      ),
    ).toEqual({ readAt: 20, pageCount: 1, proven: true, record: after });
  });
});

/**
 * Whether a reset can have happened between two readings of one execution's
 * record — the only question a walk's freshness actually turns on, and one the
 * run's status NOW cannot answer.
 */
describe("graphWorkflowRecordMoveAdmitsReset", () => {
  it("asks nothing of a record that has not moved", () => {
    expect(graphWorkflowRecordMoveAdmitsReset(running, running)).toBe(false);
  });

  // A live run's record is rewritten constantly — a task settles, a lane
  // reports, the machine snapshot advances. Reading any of that as a possible
  // retirement would re-walk the whole log every few seconds for the life of
  // the run, and none of those moves can be a reset: a reset is refused unless
  // the run is parked, and leaving a park is not something a run does to
  // itself.
  it("reads an ordinary live update as no reset", () => {
    expect(graphWorkflowRecordMoveAdmitsReset(running, runningLater)).toBe(
      false,
    );
  });

  // The reported defect. Another client can pause, reset and resume between two
  // of this client's reads, and both ends then read "running" — but the round
  // trip through a park is on the record whatever this client saw, because
  // leaving `running` retires a loop generation and resuming starts a new one.
  it("reads a moved loop generation as a reset it may have missed", () => {
    expect(graphWorkflowRecordMoveAdmitsReset(running, resumedAfterReset)).toBe(
      true,
    );
  });

  // The other exit from a park is a terminal one, which starts no new
  // generation. It moves the status instead, and every reset is preceded by a
  // status the run had to reach to be resettable at all.
  it("reads a status change as a reset it may have missed", () => {
    expect(graphWorkflowRecordMoveAdmitsReset(running, paused)).toBe(true);
    expect(
      graphWorkflowRecordMoveAdmitsReset(paused, {
        status: "aborted",
        loopEpoch: 4,
      }),
    ).toBe(true);
  });

  // While the run is parked a reset needs no transition at all: it can happen
  // between any two reads and leave the run exactly as parked as it found it.
  // So every move of a parked record is treated as one.
  it("watches every move of a record a reset can reach where it stands", () => {
    expect(
      graphWorkflowRecordMoveAdmitsReset(paused, {
        status: "paused",
        loopEpoch: 4,
      }),
    ).toBe(true);
  });

  // A settled run is not resettable and never becomes so again, so its record —
  // which barely moves — is not evidence of anything.
  it("reads a settled run's record as beyond reset", () => {
    expect(
      graphWorkflowRecordMoveAdmitsReset(
        { status: "completed", loopEpoch: 7 },
        { status: "completed", loopEpoch: 7 },
      ),
    ).toBe(false);
  });

  // Arriving at, or losing, the record is not a move this can read.
  it("refuses to read a record it does not have on both sides", () => {
    expect(graphWorkflowRecordMoveAdmitsReset(null, running)).toBe(true);
    expect(graphWorkflowRecordMoveAdmitsReset(running, null)).toBe(true);
    expect(graphWorkflowRecordMoveAdmitsReset(null, null)).toBe(false);
  });
});

/**
 * The two questions a holder asks about the walk it has: whether it may show it,
 * and whether it must read it again. They are deliberately not each other's
 * negation.
 */
describe("graphWorkflowWalkIsVouched", () => {
  it("vouches for a walk read against the record it is shown against", () => {
    expect(
      graphWorkflowWalkIsVouched(
        { readAt: 10, pageCount: 1, proven: true, record: running },
        running,
      ),
    ).toBe(true);
  });

  it("refuses a walk read against a record a reset may have replaced", () => {
    expect(
      graphWorkflowWalkIsVouched(
        { readAt: 10, pageCount: 1, proven: true, record: paused },
        { status: "paused", loopEpoch: 4 },
      ),
    ).toBe(false);
  });

  // The reported defect of attempt 7. The run being back to "running" says
  // nothing about what happened while it was not: the pause, the reset and the
  // resume can all land between two reads, and the record then arrives looking
  // like the ordinary live update it is not.
  it("refuses a walk whose record went round a park and back", () => {
    expect(
      graphWorkflowWalkIsVouched(
        { readAt: 10, pageCount: 1, proven: true, record: running },
        resumedAfterReset,
      ),
    ).toBe(false);
  });

  // The counterweight: a live record moves for every ordinary reason a run's
  // state advances, and condemning the walk on each of those would re-walk the
  // whole log for as long as the run lasts.
  it("keeps vouching across an ordinary live update", () => {
    expect(
      graphWorkflowWalkIsVouched(
        { readAt: 10, pageCount: 1, proven: true, record: running },
        runningLater,
      ),
    ).toBe(true);
  });

  // Sitting beside a record is not being read against it: an inherited walk may
  // have been taken on either side of a reset, and this cannot tell which.
  it("refuses an inherited walk however well it matches", () => {
    expect(
      graphWorkflowWalkIsVouched(
        { readAt: 10, pageCount: 1, proven: false, record: paused },
        paused,
      ),
    ).toBe(false);
  });

  // The reported defect of attempt 6, at its own level: the reset ran in the
  // past and its retirements are permanent, so a run that has since resumed or
  // finished cannot inherit a walk on the strength of no longer being
  // resettable.
  it("refuses an inherited walk even where no reset can reach the run", () => {
    expect(
      graphWorkflowWalkIsVouched(
        { readAt: 10, pageCount: 1, proven: false, record: running },
        running,
      ),
    ).toBe(false);
  });
});

describe("graphWorkflowWalkNeedsReread", () => {
  // The read already in flight was issued while the OLD record stood, so it may
  // be returning the log as it was before the reset. Waiting for it is not good
  // enough; it is replaced where it stands.
  it("replaces a walk the record moved out from under, settled or not", () => {
    expect(
      graphWorkflowWalkNeedsReread(
        { readAt: 10, pageCount: 1, proven: true, record: running },
        resumedAfterReset,
        false,
      ),
    ).toBe(true);
    expect(
      graphWorkflowWalkNeedsReread(
        { readAt: 0, pageCount: 1, proven: false, record: running },
        resumedAfterReset,
        false,
      ),
    ).toBe(true);
  });

  // A live run's record advances constantly. Re-walking the whole log on each
  // of those moves would never stop, and none of them is a retirement.
  it("ignores an ordinary live record update", () => {
    expect(
      graphWorkflowWalkNeedsReread(
        { readAt: 10, pageCount: 1, proven: true, record: running },
        runningLater,
        true,
      ),
    ).toBe(false);
  });

  // An inherited walk has no read in flight to wait for: nothing but a fresh
  // read will ever say which record it answers for.
  it("re-reads an inherited walk once it has settled", () => {
    expect(
      graphWorkflowWalkNeedsReread(
        { readAt: 10, pageCount: 1, proven: false, record: paused },
        paused,
        true,
      ),
    ).toBe(true);
  });

  // And re-reads it whatever the run is doing now — the retirement that
  // condemns it happened when the reset ran, not when this is asked.
  it("re-reads an inherited walk where no reset can reach the run", () => {
    expect(
      graphWorkflowWalkNeedsReread(
        { readAt: 10, pageCount: 1, proven: false, record: running },
        running,
        true,
      ),
    ).toBe(true);
  });

  // The gap between withholding and re-reading, and the reason it exists: a
  // read is already under way, and it will attribute itself when it lands.
  it("waits for a walk that is still arriving beside its own record", () => {
    expect(
      graphWorkflowWalkNeedsReread(
        { readAt: 0, pageCount: 1, proven: false, record: paused },
        paused,
        false,
      ),
    ).toBe(false);
  });

  it("leaves a vouched walk alone", () => {
    expect(
      graphWorkflowWalkNeedsReread(
        { readAt: 10, pageCount: 1, proven: true, record: running },
        running,
        true,
      ),
    ).toBe(false);
  });
});
