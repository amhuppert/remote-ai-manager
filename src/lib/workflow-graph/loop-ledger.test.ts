/**
 * The loop ledger read path (D4 R16.2, decision D9).
 *
 * Everything here goes through the durable pair the ledger is defined over: the
 * execution blob's loop markers and the append-only event log, both written
 * through the real repositories into SQLite and read back through the shared
 * cursor-paginated reader. A JS-object fake would prove nothing about what an
 * inspector or the CLI sees after a restart, which is the whole claim.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { deriveLoopLedger } from "./loop-ledger";
import {
  P1_JUDGE,
  P1_WORKER,
  P2_JUDGE,
  P2_WORKER,
  completeContext,
  executionFor,
  runPass,
  workerJudgeDefinition,
} from "./loop-test-fixtures";

const PROJECT_PATH = "/repo";
const SESSION_NAME = "session-1";
const PAGE_SIZE = 2;

describe("loop ledger over the paginated reader (R16.2)", () => {
  let fixture: PersistenceFixture;

  beforeEach(() => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
  });

  afterEach(() => {
    fixture.close();
  });

  const publisher = createGraphWorkflowExecutionEventPublisher({
    broadcast: () => {},
    now: () => "2026-08-04T00:00:00.000Z",
  });

  /**
   * Commit one engine step the way the mutation seam does: the reducer derives
   * the events from the repository's own previous snapshot, and both the blob
   * and its events land in the same transaction. Deriving against the persisted
   * snapshot rather than a caller-held object is what production does, and it is
   * load-bearing here — an in-place settlement mutates the object a test would
   * otherwise be holding as "previous", and every diff would vanish.
   */
  async function commit(
    next: GraphWorkflowExecution,
  ): Promise<GraphWorkflowExecution> {
    const result = await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "loop-ledger-test",
      (current) => ({
        execution: next,
        events: publisher.publishExecutionUpdate({
          projectPath: PROJECT_PATH,
          sessionName: SESSION_NAME,
          previousExecution: current,
          nextExecution: next,
        }).events,
      }),
    );
    return result.execution;
  }

  /** Read the whole log the way a ledger view does: page until exhausted. */
  async function readAllEvents(
    executionId: string,
  ): Promise<GraphWorkflowExecutionEvent[]> {
    const events: GraphWorkflowExecutionEvent[] = [];
    let cursor: number | null = null;
    let pages = 0;
    for (;;) {
      const page = await fixture.store.getGraphWorkflowEventsPage(
        PROJECT_PATH,
        SESSION_NAME,
        executionId,
        {
          limit: PAGE_SIZE,
          cursor,
        },
      );
      events.push(
        ...page.records.map(({ occurredAt, event, preReset }) => ({
          occurredAt,
          event,
          preReset,
        })),
      );
      pages += 1;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      if (pages > 200) throw new Error("pagination did not terminate");
    }
    // The bounded tail could not have served this: more pages than one.
    expect(pages).toBeGreaterThan(1);
    return events;
  }

  /** Reload the execution the way a resumed process does. */
  async function reload(): Promise<GraphWorkflowExecution> {
    const reloaded = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    if (!reloaded) throw new Error("no active execution");
    return reloaded;
  }

  /**
   * A worker+judge loop driven for real: pass 1 fails and materializes pass 2,
   * pass 2 satisfies and concludes. Every step is committed, so the log carries
   * the decisions in the order the engine made them.
   */
  async function driveTwoPasses(): Promise<GraphWorkflowExecution> {
    let execution = executionFor(workerJudgeDefinition());

    completeContext(execution, "seed");
    execution = runPass(execution).execution;
    await commit(execution);

    completeContext(execution, P1_WORKER);
    completeContext(execution, P1_JUDGE, { verdict: "fail", notes: "again" });
    execution = runPass(execution).execution;
    await commit(execution);

    completeContext(execution, P2_WORKER);
    completeContext(execution, P2_JUDGE, { verdict: "pass", notes: "good" });
    execution = runPass(execution).execution;
    await commit(execution);
    return execution;
  }

  it("reads every pass's decision back after a restart, identically", async () => {
    const live = await driveTwoPasses();
    const liveLedger = deriveLoopLedger({
      loopStates: live.loopStates,
      events: await readAllEvents(live.id),
      loopGroups: live.workingDefinition.loopGroups,
    });

    const restarted = await reload();
    const restartedLedger = deriveLoopLedger({
      loopStates: restarted.loopStates,
      events: await readAllEvents(restarted.id),
      loopGroups: restarted.workingDefinition.loopGroups,
    });

    expect(restartedLedger).toEqual(liveLedger);

    const refine = restartedLedger[0];
    expect(refine?.loopGroupId).toBe("refine");
    expect(refine?.activation).toBe("concluded");
    expect(refine?.passCount).toBe(2);
    expect(refine?.maxPasses).toBe(3);
    expect(refine?.concludingExitContextId).toBe(P2_JUDGE);
    expect(
      refine?.decisions.map((entry) => [
        entry.pass,
        entry.verdict,
        entry.outcome,
        entry.loopControlRevision,
        entry.latest,
      ]),
    ).toEqual([
      [1, "unsatisfied", "materialized", 0, true],
      [2, "satisfied", "concluded", 0, true],
    ]);
    expect(refine?.slots.map((slot) => [slot.pass, slot.state])).toEqual([
      [1, "counted"],
      [2, "counted"],
    ]);
  });

  it("keeps every decision of a pass re-decided under an amended control revision", async () => {
    const live = await driveTwoPasses();

    // The blob keeps ONE record per pass, so re-deciding pass 2 under an amended
    // control revision overwrites the marker. Only the event log can still say
    // the loop once concluded on the original terms.
    const state = live.loopStates["refine"];
    const concluding = state?.decisions["2"];
    if (!state || !concluding) throw new Error("pass 2 was never decided");
    const amended: GraphWorkflowExecution = {
      ...live,
      loopStates: {
        ...live.loopStates,
        refine: {
          ...state,
          loopControlRevision: 1,
          decisions: {
            ...state.decisions,
            "2": {
              ...concluding,
              loopControlRevision: 1,
              verdict: "unsatisfied",
              outcome: "materialized",
              nextPass: 3,
            },
          },
        },
      },
    };
    await commit(amended);

    const restarted = await reload();
    const ledger = deriveLoopLedger({
      loopStates: restarted.loopStates,
      events: await readAllEvents(restarted.id),
      loopGroups: restarted.workingDefinition.loopGroups,
    });

    const passTwo = ledger[0]?.decisions.filter((entry) => entry.pass === 2);
    expect(passTwo).toHaveLength(2);
    expect(passTwo?.[0]).toMatchObject({
      loopControlRevision: 0,
      verdict: "satisfied",
      outcome: "concluded",
      // Superseded: it happened, but it is no longer the loop's record.
      latest: false,
    });
    expect(passTwo?.[1]).toMatchObject({
      loopControlRevision: 1,
      verdict: "unsatisfied",
      outcome: "materialized",
      latest: true,
    });
  });

  it("falls back to the blob marker for a pass the read window missed", async () => {
    const live = await driveTwoPasses();
    const restarted = await reload();

    const ledger = deriveLoopLedger({
      loopStates: restarted.loopStates,
      events: [],
      loopGroups: restarted.workingDefinition.loopGroups,
    });

    // A bounded window degrades to current state rather than losing a pass.
    expect(
      ledger[0]?.decisions.map((entry) => [
        entry.pass,
        entry.latest,
        entry.markerOnly,
      ]),
    ).toEqual([
      [1, true, true],
      [2, true, true],
    ]);
    expect(live.loopStates["refine"]?.passCount).toBe(2);
  });
});
