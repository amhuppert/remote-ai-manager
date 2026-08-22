import { describe, expect, it } from "vitest";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type {
  GraphWorkflowValidationIncidentEvent,
  GraphWorkflowValidationResultEvent,
  GraphWorkflowValidationSpecialistEntry,
} from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowValidationRound,
} from "@/lib/workflow-graph/schemas";
import type { Timestamped } from "./history-entries";
import { deriveValidationRoundRows } from "./validation-rounds-model";

const CONTEXT_ID = "context-implement";

/** Iteration 1 for the first two log rows, iteration 2 from the third on. */
const iteration = {
  atLogIndex: (logIndex: number) => (logIndex < 2 ? 1 : 2),
  now: () => 2,
};

function liveRound(
  overrides: Partial<GraphWorkflowValidationRound> = {},
): GraphWorkflowValidationRound {
  return {
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
      {
        assignmentId: "style",
        profileRef: { tier: "project", id: "style-reviewer" },
        revision: 1,
        resolvedInstructionHash: `sha256:${"d".repeat(64)}`,
        strategy: "task",
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
        sessionRef: null,
        reviewArtifact: null,
        lastInfraFailure: null,
      },
    },
    phase: "specialists",
    outcome: null,
    startedAt: "2026-03-27T11:09:00.000Z",
    ...overrides,
  };
}

function withRound(
  round: GraphWorkflowValidationRound | null,
): GraphWorkflowExecution {
  const base = createWorkflowExecution({ status: "running" });
  return {
    ...base,
    contextStates: {
      ...base.contextStates,
      [CONTEXT_ID]: {
        ...base.contextStates[CONTEXT_ID]!,
        ...(round === null ? {} : { validationRound: round }),
      },
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
    summary: "audit log bypassed on the timeout path",
    issues: [],
    advisories: [],
    sessionRef: null,
    reviewArtifact: {
      backend: "claude",
      kind: "conversation",
      ref: "conv_val_sec",
      usage: { costUsd: 0.4, apiTurns: 6 },
    },
    usage: null,
    ...overrides,
  };
}

function record(
  overrides: Partial<GraphWorkflowValidationResultEvent> & {
    occurredAt?: string;
    logIndex?: number;
  } = {},
): Timestamped<GraphWorkflowValidationResultEvent> {
  const {
    occurredAt = "2026-03-27T10:42:00.000Z",
    logIndex = 1,
    ...rest
  } = overrides;
  return {
    type: "graph-workflow-validation-result",
    projectName: "proj",
    sessionName: "sess",
    executionId: "execution-1",
    contextId: CONTEXT_ID,
    validatorType: "context",
    kind: "context_validation",
    pass: false,
    summary: "cohort rejected",
    reopenTaskIds: [],
    issues: [],
    rejectedOutput: null,
    gateRepairAttempts: null,
    gateRepairBudget: null,
    roundSeq: 1,
    specialists: [specialist()],
    occurredAt,
    logIndex,
    ...rest,
  };
}

function incident(
  overrides: Partial<GraphWorkflowValidationIncidentEvent> & {
    occurredAt?: string;
    logIndex?: number;
  } = {},
): Timestamped<GraphWorkflowValidationIncidentEvent> {
  const {
    occurredAt = "2026-03-27T10:41:00.000Z",
    logIndex = 0,
    ...rest
  } = overrides;
  return {
    type: "graph-workflow-validation-incident",
    projectName: "proj",
    sessionName: "sess",
    executionId: "execution-1",
    contextId: CONTEXT_ID,
    incident: "infra_exhausted",
    roundSeq: 1,
    stage: "specialist_result",
    assignmentId: "performance",
    attempts: 3,
    driftedComponents: "",
    message: "performance spent every attempt on infrastructure failures",
    occurredAt,
    logIndex,
    ...rest,
  };
}

function rows(
  execution: GraphWorkflowExecution,
  validationEvents: Timestamped<GraphWorkflowValidationResultEvent>[] = [],
  incidentEvents: Timestamped<GraphWorkflowValidationIncidentEvent>[] = [],
) {
  return deriveValidationRoundRows({
    execution,
    contextId: CONTEXT_ID,
    validationEvents,
    incidentEvents,
    iteration,
  });
}

describe("deriveValidationRoundRows", () => {
  it("has no rounds for a context that has never been validated", () => {
    expect(rows(withRound(null))).toEqual([]);
  });

  it("reads an open round as in flight, with the roster it froze", () => {
    const [row] = rows(withRound(liveRound()));

    expect(row).toMatchObject({
      seq: 2,
      iteration: 2,
      status: "in_flight",
      statusLabel: "in flight",
      roster: ["security", "style"],
    });
    expect(row?.live).not.toBeNull();
    expect(row?.record).toBeNull();
  });

  it("reads a concluded rejection with its artifact references and spend", () => {
    const [row] = rows(withRound(null), [record()]);

    expect(row).toMatchObject({
      seq: 1,
      iteration: 1,
      status: "rejected",
      statusLabel: "rejected",
      roster: ["security"],
      references: ["conv_val_sec"],
    });
    expect(row?.usage).toEqual({
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      costUsd: 0.4,
      apiTurns: 6,
    });
  });

  it("sums the spend of every artifact a round produced", () => {
    const [row] = rows(withRound(null), [
      record({
        specialists: [
          specialist(),
          specialist({
            assignmentId: "style",
            pass: true,
            reviewArtifact: {
              backend: "codex",
              kind: "response",
              ref: "task-run-9",
              response: "{}",
              usage: {
                inputTokens: 100,
                cachedInputTokens: 20,
                outputTokens: 30,
                costUsd: 0.1,
              },
            },
          }),
        ],
      }),
    ]);

    expect(row?.references).toEqual(["conv_val_sec", "task-run-9"]);
    expect(row?.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 30,
      costUsd: 0.5,
      apiTurns: 6,
    });
  });

  it("keeps a passing round distinguishable from one nobody judged", () => {
    expect(rows(withRound(null), [record({ pass: true })])[0]).toMatchObject({
      status: "passed",
      statusLabel: "passed",
    });
    expect(
      rows(withRound(liveRound({ outcome: "candidate_mismatch" })))[0],
    ).toMatchObject({ status: "infrastructure", statusLabel: "unsettled" });
    expect(
      rows(withRound(liveRound({ outcome: "script_failed" })))[0],
    ).toMatchObject({ status: "rejected" });
  });

  it("files one round's live record and its concluded aggregate under one row", () => {
    const result = rows(withRound(liveRound({ seq: 1, outcome: "failed" })), [
      record({ roundSeq: 1 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.live).not.toBeNull();
    expect(result[0]?.record).not.toBeNull();
  });

  it("lists rounds newest first", () => {
    const result = rows(withRound(liveRound({ seq: 3 })), [
      record({ roundSeq: 2, occurredAt: "2026-03-27T10:50:00.000Z" }),
      record({ roundSeq: 1 }),
    ]);

    expect(result.map((row) => row.seq)).toEqual([3, 2, 1]);
  });

  // A script-failed or incident-concluded round leaves nothing behind once a
  // later round takes the context-state slot. The card lists what the record
  // holds; a row built for a seq with no record would describe a round the
  // execution cannot account for.
  it("lists no round for a seq the execution retained no record of", () => {
    const result = rows(withRound(null), [
      record({ roundSeq: 3, occurredAt: "2026-03-27T10:50:00.000Z" }),
      record({ roundSeq: 1 }),
    ]);

    expect(result.map((row) => row.seq)).toEqual([3, 1]);
  });

  // The aggregate carries the lanes that reported. A seat the round froze and
  // lost to infrastructure reported nothing, so only its incident still says it
  // was on the round.
  it("names a frozen seat the round lost, from the incident that took it out", () => {
    const listed = rows(withRound(null), [record()], [incident()]);
    expect(listed[0]?.roster).toEqual(["security", "performance"]);
  });

  it("does not borrow a lost seat across rounds", () => {
    const listed = rows(
      withRound(null),
      [record({ roundSeq: 2, occurredAt: "2026-03-27T10:50:00.000Z" })],
      [incident({ roundSeq: 1 })],
    );
    expect(listed[0]?.roster).toEqual(["security"]);
  });

  // The one incident the engine writes when the round record it names is NOT
  // the record standing: a lane answered into a round the context has left. A
  // reset is exactly that — it clears the record, the attempt restarts the seq,
  // and a validator still running from before answers into the number without
  // being on the round wearing it now.
  it("adds no seat from an incident raised because the round record had moved", () => {
    const listed = rows(
      withRound(null),
      [record()],
      [
        incident({
          incident: "round_superseded",
          assignmentId: "performance",
          occurredAt: "2026-03-27T10:55:00.000Z",
          driftedComponents: "roundSeq (1 -> 2)",
        }),
      ],
    );
    expect(listed[0]?.roster).toEqual(["security"]);
  });

  // A round-level check names no seat, so there is no member to add.
  it("adds no seat for an incident that named none", () => {
    const listed = rows(
      withRound(null),
      [record()],
      [incident({ incident: "roster_drift", assignmentId: null })],
    );
    expect(listed[0]?.roster).toEqual(["security"]);
  });

  // The live round is runtime state with no place in the log, so it is read at
  // the iteration standing now rather than searched for by its start time.
  it("reads the live round at the iteration standing now", () => {
    const [row] = rows(
      withRound(liveRound({ startedAt: "2026-03-27T10:44:00.000Z" })),
    );

    expect(row?.iteration).toBe(2);
  });

  // A rejection and the status mark its own verdict produced are consecutive
  // writes that can share a millisecond. The row is read where the log put it.
  it("reads a concluded round at its own position in the log", () => {
    const [row] = rows(withRound(null), [record({ roundSeq: 3, logIndex: 5 })]);

    expect(row?.iteration).toBe(2);
  });

  it("leaves a publication that belongs to no round out of the round list", () => {
    expect(rows(withRound(null), [record({ roundSeq: null })])).toEqual([]);
  });
});
