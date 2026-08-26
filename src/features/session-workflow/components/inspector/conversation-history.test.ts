import { describe, expect, it } from "vitest";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowValidationSpecialistEntry,
} from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
  GraphWorkflowValidationRound,
} from "@/lib/workflow-graph/schemas";
import {
  contextIterationReader,
  deriveConversationHistory,
  isWorkflowConversationLive,
  type ConversationHistoryEvent,
  type ConversationHistoryRow,
} from "./conversation-history";

/**
 * The canonical fixture's three-conversation history (README §3.3): a rotation
 * inside iteration 1, a returning validation that opens iteration 2 inside the
 * conversation that was already live, and a later conversation carrying
 * iteration 2 that is still running.
 *
 * The fixture narrates the first rotation as a context-limit one; the execution
 * records no such provenance, so the model links the transition and says
 * nothing about its cause.
 */

const CONTEXT_ID = "context-implement";

function contextStatus(
  occurredAt: string,
  iterationCount: number,
  status: "running" | "completed" = "running",
): GraphWorkflowExecutionEvent {
  return {
    occurredAt,
    preReset: false,
    event: {
      type: "graph-workflow-context-status",
      projectName: "proj",
      sessionName: "sess",
      executionId: "execution-1",
      contextId: CONTEXT_ID,
      status,
      remainingTaskCount: 2,
      iterationCount,
    },
  };
}

function taskCompleted(
  occurredAt: string,
  conversationId: string,
  taskId = "task-implement-1",
): GraphWorkflowExecutionEvent {
  return {
    occurredAt,
    preReset: false,
    event: {
      type: "graph-workflow-task-status",
      projectName: "proj",
      sessionName: "sess",
      executionId: "execution-1",
      taskId,
      contextId: CONTEXT_ID,
      status: "completed",
      source: "user",
      order: 1,
      lastConversationId: conversationId,
      completedAt: occurredAt,
    },
  };
}

function specialist(
  overrides: Partial<GraphWorkflowValidationSpecialistEntry> = {},
): GraphWorkflowValidationSpecialistEntry {
  return {
    assignmentId: "security",
    profile: { tier: "project", id: "security-reviewer", revision: 1 },
    resolvedInstructionHash: `sha256:${"c".repeat(64)}`,
    pass: false,
    summary: "risk rules bypass the audit log on the timeout path",
    issues: [],
    advisories: [],
    sessionRef: {
      backend: "claude",
      ref: "claude-session-sec",
      lane: "context_validator",
      refKind: "conversation",
      workflowConversationId: "conv_val_sec",
    },
    reviewArtifact: null,
    usage: null,
    ...overrides,
  };
}

function validationResult(
  occurredAt: string,
  overrides: {
    pass?: boolean;
    roundSeq?: number;
    reopenTaskIds?: string[];
    specialists?: GraphWorkflowValidationSpecialistEntry[];
  } = {},
): GraphWorkflowExecutionEvent {
  return {
    occurredAt,
    preReset: false,
    event: {
      type: "graph-workflow-validation-result",
      projectName: "proj",
      sessionName: "sess",
      executionId: "execution-1",
      contextId: CONTEXT_ID,
      validatorType: "context",
      kind: "context_validation",
      pass: overrides.pass ?? false,
      summary: "cohort rejected",
      reopenTaskIds: overrides.reopenTaskIds ?? [],
      issues: [],
      rejectedOutput: null,
      gateRepairAttempts: null,
      gateRepairBudget: null,
      roundSeq: overrides.roundSeq ?? 1,
      specialists: overrides.specialists ?? [specialist()],
    },
  };
}

function seatReported(
  occurredAt: string,
  overrides: {
    roundSeq?: number;
    specialist?: Partial<GraphWorkflowValidationSpecialistEntry>;
  } = {},
): GraphWorkflowExecutionEvent {
  return {
    occurredAt,
    preReset: false,
    event: {
      type: "graph-workflow-validation-specialist-result",
      projectName: "proj",
      sessionName: "sess",
      executionId: "execution-1",
      contextId: CONTEXT_ID,
      roundSeq: overrides.roundSeq ?? 1,
      specialist: specialist(overrides.specialist ?? {}),
    },
  };
}

function implementerLane(
  conversationId: string,
  lastUsedAt: string,
): Record<string, Record<string, GraphWorkflowAgentSessionState>> {
  return {
    [CONTEXT_ID]: {
      implementer: {
        lane: "implementer",
        contextId: CONTEXT_ID,
        backend: "claude",
        refKind: "conversation",
        workflowConversationId: conversationId,
        metrics: { rotateBeforeNextTurn: false },
        limitEvaluation: "supported",
        lastUsedAt,
      },
    },
  };
}

function runningExecution(
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  const base = createWorkflowExecution({ status: "running", ...overrides });
  return {
    ...base,
    contextStates: {
      ...base.contextStates,
      [CONTEXT_ID]: {
        ...base.contextStates[CONTEXT_ID]!,
        status: "running",
        iterationCount: 2,
        ...(overrides.contextStates?.[CONTEXT_ID] ?? {}),
      },
    },
  };
}

/** The canonical fixture's event stream, oldest first. */
function canonicalEvents(): GraphWorkflowExecutionEvent[] {
  return [
    contextStatus("2026-03-27T09:40:00.000Z", 1),
    taskCompleted("2026-03-27T10:38:00.000Z", "conv_a9c2", "task-implement-1"),
    validationResult("2026-03-27T10:42:00.000Z", {
      reopenTaskIds: ["task-implement-1"],
    }),
    contextStatus("2026-03-27T10:42:30.000Z", 2),
    taskCompleted("2026-03-27T11:04:00.000Z", "conv_b41f", "task-implement-1"),
  ];
}

function rowOf(
  rows: readonly ConversationHistoryRow[],
  conversationId: string,
): ConversationHistoryRow {
  const row = rows.find((entry) => entry.conversationId === conversationId);
  if (!row) throw new Error(`no row for ${conversationId}`);
  return row;
}

function eventOf<K extends ConversationHistoryEvent["kind"]>(
  row: ConversationHistoryRow,
  kind: K,
): Extract<ConversationHistoryEvent, { kind: K }> {
  const found = row.events.find((entry) => entry.kind === kind);
  if (!found) throw new Error(`no ${kind} event on ${row.conversationId}`);
  return found as Extract<ConversationHistoryEvent, { kind: K }>;
}

describe("deriveConversationHistory", () => {
  it("has no rows for a context that has never run", () => {
    expect(
      deriveConversationHistory({
        execution: createWorkflowExecution(),
        events: [],
        contextId: CONTEXT_ID,
      }).rows,
    ).toEqual([]);
  });

  it("reads the canonical fixture as three conversations, newest first", () => {
    const events = [
      ...canonicalEvents(),
      // The rotation that split iteration 1: the same iteration continues in a
      // second conversation, so the first is only visible through its own work.
      taskCompleted("2026-03-27T10:10:00.000Z", "conv_88d0"),
    ].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));

    const { rows } = deriveConversationHistory({
      execution: runningExecution({
        laneStates: implementerLane("conv_b41f", "2026-03-27T11:09:00.000Z"),
      }),
      events,
      contextId: CONTEXT_ID,
    });

    expect(rows.map((row) => row.conversationId)).toEqual([
      "conv_b41f",
      "conv_a9c2",
      "conv_88d0",
    ]);
    expect(rows.map((row) => row.status)).toEqual(["live", "ended", "ended"]);
  });

  it("links a rotation inside one iteration in both directions, without a cause", () => {
    const events = [
      contextStatus("2026-03-27T09:40:00.000Z", 1),
      taskCompleted("2026-03-27T10:10:00.000Z", "conv_88d0"),
      taskCompleted("2026-03-27T10:38:00.000Z", "conv_a9c2"),
    ];

    const { rows } = deriveConversationHistory({
      execution: runningExecution({
        laneStates: implementerLane("conv_a9c2", "2026-03-27T10:38:00.000Z"),
      }),
      events,
      contextId: CONTEXT_ID,
    });

    const rotated = rowOf(rows, "conv_a9c2");
    expect(eventOf(rotated, "started")).toEqual({
      kind: "started",
      at: "2026-03-27T10:38:00.000Z",
      rotatedFrom: "conv_88d0",
      iteration: 1,
    });

    const superseded = rowOf(rows, "conv_88d0");
    expect(superseded.endReason).toEqual({
      kind: "superseded",
      successorId: "conv_a9c2",
    });
    expect(eventOf(superseded, "ended").reason).toEqual(superseded.endReason);
    expect(superseded.endedAt).toBe("2026-03-27T10:38:00.000Z");
  });

  it("marks a conversation opened for a later iteration as superseding its predecessor", () => {
    const { rows } = deriveConversationHistory({
      execution: runningExecution({
        laneStates: implementerLane("conv_b41f", "2026-03-27T11:09:00.000Z"),
      }),
      events: canonicalEvents(),
      contextId: CONTEXT_ID,
    });

    expect(eventOf(rowOf(rows, "conv_b41f"), "started")).toEqual({
      kind: "started",
      at: "2026-03-27T11:04:00.000Z",
      rotatedFrom: "conv_a9c2",
      iteration: 2,
    });
    expect(rowOf(rows, "conv_a9c2").endReason).toEqual({
      kind: "superseded",
      successorId: "conv_b41f",
    });
  });

  it("keeps a returning validation inside the conversation that was live for it", () => {
    const { rows } = deriveConversationHistory({
      execution: runningExecution({
        laneStates: implementerLane("conv_b41f", "2026-03-27T11:09:00.000Z"),
      }),
      events: canonicalEvents(),
      contextId: CONTEXT_ID,
    });

    const hosting = rowOf(rows, "conv_a9c2");
    expect(hosting.events.map((entry) => entry.kind)).toEqual([
      "started",
      "task_completed",
      "verdict",
      "iteration_began",
      "ended",
    ]);
    expect(eventOf(hosting, "verdict")).toMatchObject({
      seat: "security",
      pass: false,
      summary: "risk rules bypass the audit log on the timeout path",
      transcriptConversationId: "conv_val_sec",
      iteration: 1,
      roundSeq: 1,
    });
    expect(eventOf(hosting, "iteration_began")).toMatchObject({
      iteration: 2,
      reopenedTaskIds: ["task-implement-1"],
    });
    // One iteration spanned two conversations, and this one hosted both.
    expect(hosting.iterations).toEqual([1, 2]);
    expect(eventOf(hosting, "task_completed").taskTitle).toBe("Write code");
  });

  // Production publishes a seat's verdict as soon as it reports, and the
  // aggregate only when the whole round concludes. A reader watching a
  // multi-seat round must see the seat that has already spoken.
  it("shows a seat's verdict as soon as the seat reports, before the round concludes", () => {
    const { rows } = deriveConversationHistory({
      execution: runningExecution({
        laneStates: implementerLane("conv_a9c2", "2026-03-27T10:38:00.000Z"),
      }),
      events: [
        contextStatus("2026-03-27T09:40:00.000Z", 1),
        taskCompleted("2026-03-27T10:38:00.000Z", "conv_a9c2"),
        seatReported("2026-03-27T10:41:00.000Z"),
      ],
      contextId: CONTEXT_ID,
    });

    expect(eventOf(rowOf(rows, "conv_a9c2"), "verdict")).toMatchObject({
      at: "2026-03-27T10:41:00.000Z",
      seat: "security",
      pass: false,
      summary: "risk rules bypass the audit log on the timeout path",
      roundSeq: 1,
      transcriptConversationId: "conv_val_sec",
    });
  });

  it("states a seat's verdict once, at the moment the seat reported it", () => {
    const { rows } = deriveConversationHistory({
      execution: runningExecution({
        laneStates: implementerLane("conv_a9c2", "2026-03-27T10:38:00.000Z"),
      }),
      events: [
        contextStatus("2026-03-27T09:40:00.000Z", 1),
        taskCompleted("2026-03-27T10:38:00.000Z", "conv_a9c2"),
        seatReported("2026-03-27T10:41:00.000Z"),
        // The round concludes and republishes the same seat inside its
        // aggregate; the row must not read as two rejections.
        validationResult("2026-03-27T10:42:00.000Z"),
      ],
      contextId: CONTEXT_ID,
    });

    const verdicts = rowOf(rows, "conv_a9c2").events.filter(
      (entry) => entry.kind === "verdict",
    );
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ at: "2026-03-27T10:41:00.000Z" });
  });

  // A per-assignment reset retires the seat's conversation and re-runs it
  // inside the SAME round, so the seat reports twice under one seq. The two
  // are different judgements written in different transcripts, and the second
  // one's transcript is only reachable from its own verdict event.
  it("keeps both verdicts when a reset re-ran the same seat in the same round", () => {
    const { rows } = deriveConversationHistory({
      execution: runningExecution({
        laneStates: implementerLane("conv_a9c2", "2026-03-27T10:38:00.000Z"),
      }),
      events: [
        contextStatus("2026-03-27T09:40:00.000Z", 1),
        taskCompleted("2026-03-27T10:38:00.000Z", "conv_a9c2"),
        seatReported("2026-03-27T10:41:00.000Z"),
        seatReported("2026-03-27T10:52:00.000Z", {
          specialist: {
            pass: true,
            summary: "re-reviewed after reset: the audit path is covered",
            sessionRef: {
              backend: "claude",
              ref: "conv_val_sec_2",
              lane: "context_validator",
              refKind: "conversation",
              workflowConversationId: "conv_val_sec_2",
            },
          },
        }),
      ],
      contextId: CONTEXT_ID,
    });

    const verdicts = rowOf(rows, "conv_a9c2").events.filter(
      (entry) => entry.kind === "verdict",
    );
    expect(verdicts).toHaveLength(2);
    expect(verdicts.map((entry) => entry.transcriptConversationId)).toEqual([
      "conv_val_sec",
      "conv_val_sec_2",
    ]);
  });

  it("shows the live round's seat as validating inside the live conversation", () => {
    const round: GraphWorkflowValidationRound = {
      seq: 2,
      candidate: {
        headSha: "head-2",
        candidateTreeHash: "tree-2",
        taskStateHash: "tasks-2",
        identityScope: "wholeTree",
      },
      roster: [
        {
          assignmentId: "security",
          profileRef: { tier: "project", id: "security-reviewer" },
          revision: 1,
          resolvedInstructionHash: `sha256:${"c".repeat(64)}`,
          strategy: "conversation",
        },
      ],
      specialists: {
        security: {
          state: "running",
          attempts: 1,
          summary: null,
          issues: [],
          advisories: [],
          questionToken: null,
          sessionRef: {
            backend: "claude",
            ref: "claude-session-sec-2",
            lane: "context_validator",
            refKind: "conversation",
            workflowConversationId: "conv_val_sec_2",
          },
          reviewArtifact: null,
          lastInfraFailure: null,
        },
      },
      phase: "specialists",
      outcome: null,
      startedAt: "2026-03-27T11:09:00.000Z",
    };
    const base = runningExecution({
      laneStates: implementerLane("conv_b41f", "2026-03-27T11:09:00.000Z"),
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        [CONTEXT_ID]: {
          ...base.contextStates[CONTEXT_ID]!,
          validationRound: round,
        },
      },
    };

    const { rows } = deriveConversationHistory({
      execution,
      events: canonicalEvents(),
      contextId: CONTEXT_ID,
    });

    const live = rowOf(rows, "conv_b41f");
    expect(live.status).toBe("live");
    expect(live.endedAt).toBeNull();
    expect(live.endReason).toBeNull();
    expect(eventOf(live, "validating")).toMatchObject({
      seat: "security",
      iteration: 2,
      transcriptConversationId: "conv_val_sec_2",
    });
    expect(live.events.some((entry) => entry.kind === "ended")).toBe(false);
  });

  it("closes the last conversation of a context that is no longer running", () => {
    const base = runningExecution({
      laneStates: implementerLane("conv_b41f", "2026-03-27T11:04:00.000Z"),
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      status: "completed",
      contextStates: {
        ...base.contextStates,
        [CONTEXT_ID]: {
          ...base.contextStates[CONTEXT_ID]!,
          status: "completed",
        },
      },
    };

    const { rows } = deriveConversationHistory({
      execution,
      events: canonicalEvents(),
      contextId: CONTEXT_ID,
    });

    const last = rowOf(rows, "conv_b41f");
    expect(last.status).toBe("ended");
    expect(last.endedAt).toBe("2026-03-27T11:04:00.000Z");
    expect(last.endReason).toEqual({ kind: "closed", successorId: null });
  });

  // The row's pill and the Log surface's pill answer the same question, so they
  // ask the same owner. A running task binds its conversation before the lane
  // record is written, and a row that called that conversation ended would
  // contradict the transcript header the reader opens from it.
  it("calls a row live when a running task names it before the lane records it", () => {
    const base = runningExecution({});
    const execution: GraphWorkflowExecution = {
      ...base,
      laneStates: {},
      taskStates: {
        ...base.taskStates,
        "task-implement-2": {
          taskId: "task-implement-2",
          contextId: CONTEXT_ID,
          order: 2,
          status: "running",
          summary: null,
          startedAt: "2026-03-27T11:05:00.000Z",
          completedAt: null,
          lastConversationId: "conv_b41f",
          failureMessage: null,
          failureHistory: [],
        },
      },
    };

    const { rows } = deriveConversationHistory({
      execution,
      events: canonicalEvents(),
      contextId: CONTEXT_ID,
    });

    const current = rowOf(rows, "conv_b41f");
    expect(current.status).toBe("live");
    expect(current.endedAt).toBeNull();
    expect(current.endReason).toBeNull();
    expect(current.events.some((entry) => entry.kind === "ended")).toBe(false);
  });

  // Consecutive mutations can be stamped in the same millisecond, so a
  // timestamp cannot order them and the log's own order is the only record of
  // what happened first. The verdict was written before the successor
  // conversation's first row: it belongs to the conversation that was live.
  it("places an event by its position in the log when timestamps tie", () => {
    const tied = "2026-03-27T10:42:00.000Z";
    const { rows } = deriveConversationHistory({
      execution: runningExecution({
        laneStates: implementerLane("conv_b41f", "2026-03-27T11:09:00.000Z"),
      }),
      events: [
        contextStatus("2026-03-27T09:40:00.000Z", 1),
        taskCompleted("2026-03-27T10:38:00.000Z", "conv_a9c2"),
        validationResult(tied, { reopenTaskIds: ["task-implement-1"] }),
        contextStatus(tied, 2),
        taskCompleted(tied, "conv_b41f"),
      ],
      contextId: CONTEXT_ID,
    });

    const hosting = rowOf(rows, "conv_a9c2");
    expect(hosting.events.map((entry) => entry.kind)).toEqual([
      "started",
      "task_completed",
      "verdict",
      "iteration_began",
      "ended",
    ]);
    // The verdict judged iteration 1; the mark that opened iteration 2 was
    // written after it, in the same millisecond.
    expect(eventOf(hosting, "verdict").iteration).toBe(1);
    expect(
      rowOf(rows, "conv_b41f").events.some((entry) => entry.kind === "verdict"),
    ).toBe(false);
  });

  it("ignores other contexts and the rounds a reset retired", () => {
    const foreign: GraphWorkflowExecutionEvent = {
      occurredAt: "2026-03-27T10:00:00.000Z",
      preReset: false,
      event: {
        type: "graph-workflow-task-status",
        projectName: "proj",
        sessionName: "sess",
        executionId: "execution-1",
        taskId: "task-plan-1",
        contextId: "context-plan",
        status: "completed",
        source: "user",
        order: 1,
        lastConversationId: "conv_other",
      },
    };
    const retired: GraphWorkflowExecutionEvent = {
      ...taskCompleted("2026-03-27T09:00:00.000Z", "conv_retired"),
      preReset: true,
    };

    const { rows } = deriveConversationHistory({
      execution: runningExecution({
        laneStates: implementerLane("conv_b41f", "2026-03-27T11:09:00.000Z"),
      }),
      events: [retired, foreign, ...canonicalEvents()],
      contextId: CONTEXT_ID,
    });

    expect(rows.map((row) => row.conversationId)).toEqual([
      "conv_b41f",
      "conv_a9c2",
    ]);
  });
});

describe("contextIterationReader", () => {
  const events = [
    contextStatus("2026-03-27T09:40:00.000Z", 1),
    contextStatus("2026-03-27T10:42:00.000Z", 2),
  ];

  it("reads the iteration in force at a position in the log", () => {
    const read = contextIterationReader(events, CONTEXT_ID, 2);

    expect(read.atLogIndex(0)).toBe(1);
    expect(read.atLogIndex(1)).toBe(2);
  });

  // Two durable writes can land in the same millisecond, and the log's order is
  // the only record of which came first. A row read at its own position is
  // never told about the mark that follows it.
  it("does not lend an event the iteration a mark of the same millisecond began", () => {
    const tied = [
      contextStatus("2026-03-27T09:40:00.000Z", 1),
      taskCompleted("2026-03-27T10:42:00.000Z", "conv_a9c2"),
      contextStatus("2026-03-27T10:42:00.000Z", 2),
    ];

    expect(contextIterationReader(tied, CONTEXT_ID, 2).atLogIndex(1)).toBe(1);
  });

  it("reads runtime state at the iteration standing now", () => {
    expect(contextIterationReader(events, CONTEXT_ID, 2).now()).toBe(2);
  });

  it("falls back to the count the context state holds when nothing was marked", () => {
    expect(contextIterationReader([], CONTEXT_ID, 3).atLogIndex(0)).toBe(3);
    expect(contextIterationReader([], CONTEXT_ID, 0).now()).toBe(1);
  });

  // Retired rows are not part of the current attempt's timeline, so they never
  // lend it an iteration.
  it("ignores the marks a context reset retired", () => {
    const retired: GraphWorkflowExecutionEvent = {
      ...contextStatus("2026-03-27T09:40:00.000Z", 7),
      preReset: true,
    };

    expect(
      contextIterationReader([retired, ...events], CONTEXT_ID, 2).atLogIndex(1),
    ).toBe(1);
  });
});

describe("isWorkflowConversationLive", () => {
  function validatorSeatLane(
    conversationId: string,
  ): Record<string, Record<string, GraphWorkflowAgentSessionState>> {
    const lanes = implementerLane("conv_b41f", "2026-03-27T11:09:00.000Z");
    return {
      [CONTEXT_ID]: {
        ...lanes[CONTEXT_ID]!,
        security: {
          lane: "context_validator",
          contextId: CONTEXT_ID,
          assignmentId: "security",
          backend: "claude",
          refKind: "conversation",
          workflowConversationId: conversationId,
          metrics: { rotateBeforeNextTurn: false },
          limitEvaluation: "supported",
          lastUsedAt: "2026-03-27T11:10:00.000Z",
        },
      },
    };
  }

  it("calls the conversation a lane currently holds live", () => {
    expect(
      isWorkflowConversationLive(
        runningExecution({
          laneStates: implementerLane("conv_b41f", "2026-03-27T11:09:00.000Z"),
        }),
        CONTEXT_ID,
        "conv_b41f",
      ),
    ).toBe(true);
  });

  it("calls a rotated-out conversation ended", () => {
    expect(
      isWorkflowConversationLive(
        runningExecution({
          laneStates: implementerLane("conv_b41f", "2026-03-27T11:09:00.000Z"),
        }),
        CONTEXT_ID,
        "conv_a9c2",
      ),
    ).toBe(false);
  });

  it("calls a validator seat's own conversation live while the seat holds it", () => {
    expect(
      isWorkflowConversationLive(
        runningExecution({ laneStates: validatorSeatLane("conv_val_1") }),
        CONTEXT_ID,
        "conv_val_1",
      ),
    ).toBe(true);
  });

  // The lane record is written when the context binds a conversation, which a
  // running task can beat. `resolveBoundConversationId` resolves a running
  // task's conversation ahead of the lane for that reason, and the live/ended
  // pill must not disagree with it.
  it("calls the conversation a running task names live before the lane records it", () => {
    const execution = runningExecution({});
    const withRunningTask: GraphWorkflowExecution = {
      ...execution,
      laneStates: {},
      taskStates: {
        ...execution.taskStates,
        "task-1": {
          taskId: "task-1",
          contextId: CONTEXT_ID,
          order: 1,
          status: "running",
          summary: null,
          startedAt: "2026-03-27T11:09:00.000Z",
          completedAt: null,
          lastConversationId: "conv_b41f",
          failureMessage: null,
          failureHistory: [],
        },
      },
    };

    expect(
      isWorkflowConversationLive(withRunningTask, CONTEXT_ID, "conv_b41f"),
    ).toBe(true);
  });

  /**
   * The repair agent's turn runs against a HALTED context, so every other
   * clause here answers "ended" for it: no lane holds the conversation, no task
   * names it, and the context is halted. The open round is the one record that
   * says the turn is still being written.
   */
  it("calls the open plan-repair round's conversation live on the halted context it is repairing", () => {
    const execution = runningExecution({});
    const halted: GraphWorkflowExecution = {
      ...execution,
      status: "halted",
      haltReason: {
        type: "circuit_breaker",
        contextId: CONTEXT_ID,
        condition: "retry_exhaustion",
        failureCount: 3,
        summary: null,
      },
      laneStates: {},
      contextStates: {
        ...execution.contextStates,
        [CONTEXT_ID]: {
          ...execution.contextStates[CONTEXT_ID]!,
          status: "halted",
        },
      },
      planRepairRounds: [
        {
          seq: 1,
          contextId: CONTEXT_ID,
          haltType: "circuit_breaker",
          loopGroupId: null,
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          settledAt: null,
          outcome: null,
          planningDefect: null,
          diagnosis: null,
          operationCount: 0,
          resumed: false,
          conversationId: "__plan_repair__:execution-1:context-plan:1",
        },
      ],
    };

    expect(
      isWorkflowConversationLive(
        halted,
        CONTEXT_ID,
        "__plan_repair__:execution-1:context-plan:1",
      ),
    ).toBe(true);
    // A settled round's transcript is history, like every other ended turn.
    expect(
      isWorkflowConversationLive(
        {
          ...halted,
          planRepairRounds: [
            {
              ...halted.planRepairRounds[0]!,
              settledAt: new Date().toISOString(),
              outcome: "declined",
            },
          ],
        },
        CONTEXT_ID,
        "__plan_repair__:execution-1:context-plan:1",
      ),
    ).toBe(false);
  });

  it("calls every conversation of a settled context ended, whatever its lanes still name", () => {
    const execution = runningExecution({
      laneStates: implementerLane("conv_b41f", "2026-03-27T11:09:00.000Z"),
    });
    const settled: GraphWorkflowExecution = {
      ...execution,
      contextStates: {
        ...execution.contextStates,
        [CONTEXT_ID]: {
          ...execution.contextStates[CONTEXT_ID]!,
          status: "completed",
        },
      },
    };

    expect(isWorkflowConversationLive(settled, CONTEXT_ID, "conv_b41f")).toBe(
      false,
    );
  });

  // The lane keeps naming its conversation after a halt, so the lane alone
  // cannot answer this. A run that no longer holds the session's execution
  // lease can never take another turn, whatever its lanes still hold.
  it("calls a conversation of a lease-free halted execution ended", () => {
    const execution = runningExecution({
      laneStates: implementerLane("conv_b41f", "2026-03-27T11:09:00.000Z"),
    });

    expect(
      isWorkflowConversationLive(
        {
          ...execution,
          status: "halted",
          haltReason: { type: "recovery_error", message: "worktree vanished" },
        },
        CONTEXT_ID,
        "conv_b41f",
      ),
    ).toBe(false);

    expect(
      isWorkflowConversationLive(
        {
          ...execution,
          status: "halted",
          haltReason: {
            type: "max_iterations",
            contextId: CONTEXT_ID,
            iterationCount: 4,
            summary: null,
          },
          abandonment: {
            abandonedAt: "2026-03-27T12:00:00.000Z",
            actor: { kind: "human" },
            reason: "superseded by a fresh run",
          },
        },
        CONTEXT_ID,
        "conv_b41f",
      ),
    ).toBe(false);
  });

  it("keeps a resumable halt's conversation live: resume gives it another turn", () => {
    const execution = runningExecution({
      laneStates: implementerLane("conv_b41f", "2026-03-27T11:09:00.000Z"),
    });

    expect(
      isWorkflowConversationLive(
        {
          ...execution,
          status: "halted",
          haltReason: {
            type: "max_iterations",
            contextId: CONTEXT_ID,
            iterationCount: 4,
            summary: null,
          },
        },
        CONTEXT_ID,
        "conv_b41f",
      ),
    ).toBe(true);
  });

  it("calls every conversation of a settled execution ended", () => {
    const execution = runningExecution({
      laneStates: implementerLane("conv_b41f", "2026-03-27T11:09:00.000Z"),
    });

    expect(
      isWorkflowConversationLive(
        { ...execution, status: "completed" },
        CONTEXT_ID,
        "conv_b41f",
      ),
    ).toBe(false);
  });
});
