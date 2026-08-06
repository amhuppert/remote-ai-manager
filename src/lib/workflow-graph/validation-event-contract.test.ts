/**
 * The event contract a cohort round publishes (R12.2, R6.1).
 *
 * Two things are under test and they pull in opposite directions: a cohort
 * round has to become fully attributable, and every consumer that already reads
 * these events has to keep reading them unchanged. So the aggregate grows only
 * additively, the per-specialist detail rides new event kinds no existing
 * consumer subscribes to, and the `output_schema` publication — which is not a
 * cohort round at all — is pinned whole.
 */

import { describe, expect, it } from "vitest";
import {
  graphWorkflowExecutionEventSchema,
  graphWorkflowValidationResultEventSchema,
  type GraphWorkflowValidationResultEvent,
  type GraphWorkflowValidationSpecialistEntry,
} from "@/lib/workflow-graph/event-schemas";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import {
  createWorkflowExecution,
  makeSeededValidatorAssignment,
} from "@/lib/workflow-graph/test-fixtures";
import {
  createCohortExecution,
  createHarness,
  failResult,
  INFRA_RESULT,
  metadata,
  NOW,
  passResult,
  specialistRecord,
  withOpenRound,
} from "@/lib/workflow-graph/testing/cohort-engine-harness";
import type { ValidatorRunResult } from "@/lib/workflow-graph/validator-runner";

/**
 * Three seats with genuinely distinct profile identity. The fixture cohort
 * shares one profile across every seat, which cannot tell "the entries carry
 * their own identity" from "the entries carry the first seat's identity".
 */
const DISTINCT_COHORT = [
  makeSeededValidatorAssignment({
    id: "general",
    profile: { tier: "builtin", id: "general-reviewer" },
  }),
  {
    ...makeSeededValidatorAssignment({
      id: "security",
      profile: { tier: "project", id: "security-reviewer" },
    }),
    profileSnapshot: {
      ...makeSeededValidatorAssignment({
        id: "security",
        profile: { tier: "project", id: "security-reviewer" },
      }).profileSnapshot,
      revision: 4,
      resolvedInstructionHash: `sha256:${"c".repeat(64)}`,
    },
  },
  {
    ...makeSeededValidatorAssignment({
      id: "perf",
      profile: { tier: "global", id: "perf-reviewer" },
    }),
    profileSnapshot: {
      ...makeSeededValidatorAssignment({
        id: "perf",
        profile: { tier: "global", id: "perf-reviewer" },
      }).profileSnapshot,
      revision: 7,
      resolvedInstructionHash: `sha256:${"d".repeat(64)}`,
    },
  },
];

function sessionRef(assignmentId: string) {
  return {
    backend: "claude" as const,
    ref: `conversation-${assignmentId}`,
    lane: "context_validator" as const,
    assignmentId,
    refKind: "conversation" as const,
  };
}

function reviewArtifact(assignmentId: string) {
  return {
    backend: "claude" as const,
    kind: "conversation" as const,
    ref: `conversation-${assignmentId}`,
    usage: { costUsd: 0.25, apiTurns: 3 },
  };
}

function metadataFor(assignmentId: string): ValidatorRunResult["metadata"] {
  return {
    ...metadata(),
    sessionRef: sessionRef(assignmentId),
    reviewArtifact: reviewArtifact(assignmentId),
  };
}

function specialistsOf(
  event: GraphWorkflowValidationResultEvent,
): GraphWorkflowValidationSpecialistEntry[] {
  const specialists = event.specialists;
  expect(specialists).toBeDefined();
  return specialists ?? [];
}

function aggregateOf(
  entries: readonly { event: unknown }[],
): GraphWorkflowValidationResultEvent {
  const [first] = entries;
  expect(first).toBeDefined();
  return graphWorkflowValidationResultEventSchema.parse(first!.event);
}

describe("aggregate validation-result event stays additive (R12.2)", () => {
  it("parses a row written before cohorts existed", () => {
    const legacy = {
      type: "graph-workflow-validation-result",
      projectName: "repo",
      sessionName: "session-1",
      executionId: "execution-1",
      contextId: "context-plan",
      validatorType: "context",
      pass: false,
      summary: "The reviewer rejected the work.",
      issues: [{ taskId: "task-plan-1", title: "t", description: "d" }],
      reopenTaskIds: ["task-plan-1"],
    };

    const parsed = graphWorkflowValidationResultEventSchema.parse(legacy);

    expect(parsed.kind).toBe("context_validation");
    // Absent rather than defaulted: a row that belongs to no round must parse
    // back to the bytes it was written with, or "unchanged" is unprovable.
    expect(parsed.roundSeq).toBeUndefined();
    expect(parsed.specialists).toBeUndefined();
  });

  // The structured-output gate is not a cohort round: it has one payload, one
  // reviewer-less rejection, and one pair of refs. Nothing about cohorts may
  // reach it, so the whole publication is pinned rather than spot-checked.
  it("leaves an output_schema publication untouched", () => {
    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => NOW,
    });
    const execution = createWorkflowExecution({ status: "running" });

    const { events } = publisher.publishValidationResult({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
      validatorType: "context",
      kind: "output_schema",
      pass: false,
      summary: "$.migrationId: required property is missing",
      issues: [{ path: "$.migrationId", title: "missing", description: "d" }],
      rejectedOutput: '{"other":1}',
      gateRepair: { attempts: 2, maxAttempts: 2 },
      rejectedAgainstSchema: { type: "object" },
      sessionRef: sessionRef("general"),
      reviewArtifact: reviewArtifact("general"),
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.event).toEqual({
      type: "graph-workflow-validation-result",
      projectName: "repo",
      sessionName: "session-1",
      executionId: execution.id,
      contextId: "context-plan",
      validatorType: "context",
      kind: "output_schema",
      pass: false,
      summary: "$.migrationId: required property is missing",
      issues: [{ path: "$.migrationId", title: "missing", description: "d" }],
      reopenTaskIds: [],
      rejectedOutput: '{"other":1}',
      gateRepairAttempts: 2,
      gateRepairBudget: 2,
      rejectedAgainstSchema: { type: "object" },
      sessionRef: sessionRef("general"),
      reviewArtifact: reviewArtifact("general"),
    });
    // Pinned by absence, not by value: a gate rejection belongs to no round, so
    // the cohort fields must not appear on it at all. `toEqual` above ignores
    // undefined-valued keys, which is exactly the difference under test.
    expect(Object.keys(events[0]!.event)).not.toContain("roundSeq");
    expect(Object.keys(events[0]!.event)).not.toContain("specialists");
  });

  it("carries every specialist in cohort order, each with its own profile identity", async () => {
    const harness = createHarness({
      execution: createCohortExecution({ assignments: DISTINCT_COHORT }),
      runContextValidator: async (input) => ({
        result:
          input.validator.id === "security"
            ? failResult("security", ["task-plan-1"])
            : passResult(input.validator.id),
        metadata: metadataFor(input.validator.id),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    const aggregate = aggregateOf(harness.results());
    expect(aggregate.roundSeq).toBe(1);
    expect(
      specialistsOf(aggregate).map((entry) => [
        entry.assignmentId,
        entry.profile.tier,
        entry.profile.id,
        entry.profile.revision,
        entry.resolvedInstructionHash,
        entry.pass,
      ]),
    ).toEqual([
      [
        "general",
        "builtin",
        "general-reviewer",
        1,
        `sha256:${"b".repeat(64)}`,
        true,
      ],
      [
        "security",
        "project",
        "security-reviewer",
        4,
        `sha256:${"c".repeat(64)}`,
        false,
      ],
      ["perf", "global", "perf-reviewer", 7, `sha256:${"d".repeat(64)}`, true],
    ]);
  });

  it("puts each specialist's own refs, findings, and usage on its entry", async () => {
    const harness = createHarness({
      execution: createCohortExecution({ assignments: DISTINCT_COHORT }),
      runContextValidator: async (input) => ({
        result:
          input.validator.id === "security"
            ? failResult("security", ["task-plan-1"])
            : passResult(input.validator.id),
        metadata: metadataFor(input.validator.id),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    const aggregate = aggregateOf(harness.results());
    const security = specialistsOf(aggregate).find(
      (entry) => entry.assignmentId === "security",
    );
    expect(security?.sessionRef).toEqual(sessionRef("security"));
    expect(security?.reviewArtifact).toEqual(reviewArtifact("security"));
    expect(security?.usage).toEqual({
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      costUsd: 0.25,
      apiTurns: 3,
    });
    expect(security?.issues.map((issue) => issue.title)).toEqual([
      "security on task-plan-1",
    ]);
    // A passing specialist raised nothing; its entry says so rather than
    // inheriting the aggregate's findings.
    expect(
      specialistsOf(aggregate).find((entry) => entry.assignmentId === "general")
        ?.issues,
    ).toEqual([]);
  });

  // Top level keeps its existing types and aggregate meaning: this is what
  // every pre-cohort consumer reads.
  it("keeps the aggregate verdict at the top level and nulls the single-reviewer refs", async () => {
    const harness = createHarness({
      execution: createCohortExecution({ assignments: DISTINCT_COHORT }),
      runContextValidator: async (input) => ({
        result:
          input.validator.id === "general"
            ? passResult("general")
            : failResult(input.validator.id, ["task-plan-1"]),
        metadata: metadataFor(input.validator.id),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    const aggregate = aggregateOf(harness.results());
    expect(aggregate.pass).toBe(false);
    expect(aggregate.reopenTaskIds).toEqual(["task-plan-1"]);
    expect(aggregate.issues).toHaveLength(2);
    // Two specialists reviewed; neither one's session is "the" session, so the
    // single-ref fields carry nothing rather than an arbitrary winner.
    expect(aggregate.sessionRef).toBeNull();
    expect(aggregate.reviewArtifact).toBeNull();
  });

  it("keeps the single reviewer's refs at the top level for a cohort of one", async () => {
    const harness = createHarness({
      execution: createCohortExecution({ assignmentIds: ["general"] }),
      runContextValidator: async (input) => ({
        result: passResult(input.validator.id),
        metadata: metadataFor(input.validator.id),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    const aggregate = aggregateOf(harness.results());
    expect(aggregate.sessionRef).toEqual(sessionRef("general"));
    expect(aggregate.reviewArtifact).toEqual(reviewArtifact("general"));
    expect(aggregate.specialists).toHaveLength(1);
  });
});

describe("a resumed round keeps its retained specialists' provenance (R12.2)", () => {
  // The verdicts a resume carries forward were rendered by real sessions that
  // cost real money. Reconstructing them without their refs would make the
  // aggregate of a resumed round less attributable than the aggregate of an
  // uninterrupted one, and the spend of every retained lane unattributable.
  it("restores each retained verdict's session, artifact, and usage from the round record", async () => {
    const execution = withOpenRound(
      createCohortExecution({ assignmentIds: ["general", "perf"] }),
      {
        specialists: {
          general: specialistRecord({
            state: "verdict_pass",
            attempts: 0,
            summary: "general is satisfied.",
            sessionRef: sessionRef("general"),
            reviewArtifact: reviewArtifact("general"),
          }),
          perf: specialistRecord({ state: "running", attempts: 1 }),
        },
      },
    );

    const calls: string[] = [];
    const harness = createHarness({
      execution,
      runContextValidator: async (input) => {
        calls.push(input.validator.id);
        return {
          result: passResult(input.validator.id),
          metadata: metadataFor(input.validator.id),
          roundToken: input.roundToken ?? null,
        };
      },
    });

    await harness.run();

    // Only the unsettled lane ran again: general's verdict is the persisted one.
    expect(calls).toEqual(["perf"]);
    const aggregate = aggregateOf(harness.results());
    const general = aggregate.specialists?.find(
      (entry) => entry.assignmentId === "general",
    );
    expect(general?.sessionRef).toEqual(sessionRef("general"));
    expect(general?.reviewArtifact).toEqual(reviewArtifact("general"));
    expect(general?.usage).toEqual({
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      costUsd: 0.25,
      apiTurns: 3,
    });
  });

  it("persists each verdict's provenance as the round accepts it", async () => {
    const harness = createHarness({
      execution: createCohortExecution({ assignmentIds: ["general"] }),
      runContextValidator: async (input) => ({
        result: passResult(input.validator.id),
        metadata: metadataFor(input.validator.id),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    const specialist =
      harness.contextState()?.validationRound?.specialists["general"];
    expect(specialist?.sessionRef).toEqual(sessionRef("general"));
    expect(specialist?.reviewArtifact).toEqual(reviewArtifact("general"));
  });
});

describe("specialist-result detail events (R12.2)", () => {
  it("publishes one per verdict, carrying assignment id and profile provenance", async () => {
    const harness = createHarness({
      execution: createCohortExecution({ assignments: DISTINCT_COHORT }),
      runContextValidator: async (input) => ({
        result: passResult(input.validator.id),
        metadata: metadataFor(input.validator.id),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    const details = harness.specialistResults();
    expect(details).toHaveLength(3);
    const parsed = details.map((entry) =>
      graphWorkflowExecutionEventSchema.parse(entry),
    );
    for (const entry of parsed) {
      if (entry.event.type !== "graph-workflow-validation-specialist-result") {
        throw new Error("expected a specialist-result event");
      }
      expect(entry.event.roundSeq).toBe(1);
      expect(entry.event.specialist.profile.id).toBeTruthy();
      expect(entry.event.specialist.resolvedInstructionHash).toMatch(
        /^sha256:/,
      );
    }
    expect(
      parsed.map((entry) =>
        entry.event.type === "graph-workflow-validation-specialist-result"
          ? entry.event.specialist.assignmentId
          : null,
      ),
    ).toEqual(expect.arrayContaining(["general", "security", "perf"]));
  });

  // Published from the mutation that ACCEPTS the result, so no detail event can
  // describe a verdict the round record never committed — and the aggregate,
  // which concludes the round, is necessarily last.
  it("publishes every detail before the aggregate that concludes the round", async () => {
    const harness = createHarness({
      execution: createCohortExecution({ assignments: DISTINCT_COHORT }),
      runContextValidator: async (input) => ({
        result: passResult(input.validator.id),
        metadata: metadataFor(input.validator.id),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    const order = harness.repository.appendedEvents
      .map((entry) => entry.event.type)
      .filter(
        (type) =>
          type === "graph-workflow-validation-specialist-result" ||
          type === "graph-workflow-validation-result",
      );
    expect(order).toEqual([
      "graph-workflow-validation-specialist-result",
      "graph-workflow-validation-specialist-result",
      "graph-workflow-validation-specialist-result",
      "graph-workflow-validation-result",
    ]);
  });

  it("publishes no detail for a specialist that never rendered a verdict", async () => {
    const harness = createHarness({
      execution: createCohortExecution({ assignmentIds: ["general", "perf"] }),
      runContextValidator: async (input) => ({
        result:
          input.validator.id === "perf" ? INFRA_RESULT : passResult("general"),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    expect(
      harness
        .specialistResults()
        .map((entry) =>
          entry.event.type === "graph-workflow-validation-specialist-result"
            ? entry.event.specialist.assignmentId
            : null,
        ),
    ).toEqual(["general"]);
  });
});

describe("non-verdict rounds publish incidents, never verdicts (R6.1)", () => {
  it("files an infra_failure incident for each admitted dispatch that failed", async () => {
    let attempts = 0;
    const harness = createHarness({
      execution: createCohortExecution({ assignmentIds: ["general"] }),
      runContextValidator: async (input) => ({
        result: ++attempts === 1 ? INFRA_RESULT : passResult("general"),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    const incidents = harness.incidents().map((entry) =>
      entry.event.type === "graph-workflow-validation-incident"
        ? {
            incident: entry.event.incident,
            assignmentId: entry.event.assignmentId,
            roundSeq: entry.event.roundSeq,
          }
        : null,
    );
    expect(incidents).toEqual([
      { incident: "infra_failure", assignmentId: "general", roundSeq: 1 },
    ]);
    // The retry succeeded, so the round still concludes with one aggregate.
    expect(harness.results()).toHaveLength(1);
  });

  // A result carrying an earlier round's token is not a verdict about THIS
  // candidate — a distinct incident from "the tree moved", because nothing
  // moved: the answer simply belongs to a round that is over.
  it("files stale_result_rejected when a result carries the wrong round token", async () => {
    const harness = createHarness({
      execution: createCohortExecution({ assignmentIds: ["general"] }),
      runContextValidator: async () => ({
        result: passResult("general"),
        metadata: metadata(),
        roundToken: {
          seq: 99,
          candidate: {
            headSha: "x",
            candidateTreeHash: "y",
            taskStateHash: "z",
          },
        },
      }),
    });

    await harness.run();

    expect(
      harness
        .incidents()
        .map((entry) =>
          entry.event.type === "graph-workflow-validation-incident"
            ? entry.event.incident
            : null,
        ),
    ).toEqual(["stale_result_rejected"]);
    expect(harness.results()).toEqual([]);
  });

  /**
   * A cohort whose second lane finds the context already on another round by
   * the time it answers. Everything this round collected describes a candidate
   * the context no longer owns, so nothing it produced may be recorded.
   */
  function supersededHarness(
    resultFor: (assignmentId: string) => ValidatorRunResult["result"],
  ) {
    const harness = createHarness({
      execution: createCohortExecution({ assignmentIds: ["general", "perf"] }),
      runContextValidator: async (input) => {
        if (input.validator.id === "perf") {
          await harness.repository.mutateActive(
            "/repo",
            "session-1",
            (latest) => {
              const round =
                latest.contextStates["context-plan"]?.validationRound;
              if (round) round.seq = 2;
              return latest;
            },
          );
        }
        return {
          result: resultFor(input.validator.id),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });
    return harness;
  }

  function incidentKinds(harness: ReturnType<typeof supersededHarness>) {
    return harness
      .incidents()
      .map((entry) =>
        entry.event.type === "graph-workflow-validation-incident"
          ? entry.event.incident
          : null,
      );
  }

  /** The incident the CONCLUSION filed, as distinct from a lane's dropped write. */
  function aggregateIncidents(harness: ReturnType<typeof supersededHarness>) {
    return harness
      .incidents()
      .flatMap((entry) =>
        entry.event.type === "graph-workflow-validation-incident" &&
        entry.event.stage === "aggregate"
          ? [entry.event.incident]
          : [],
      );
  }

  it("drops a specialist write aimed at a round that was superseded", async () => {
    const harness = supersededHarness((id) => passResult(id));

    await harness.run();

    expect(incidentKinds(harness)).toContain("round_superseded");
  });

  // The incident is not enough on its own: dropping the lane write while the
  // conclusion still published would hand every verdict consumer a pass for a
  // round the context had already abandoned.
  it("publishes no aggregate pass and resets nothing when the round was superseded", async () => {
    const harness = supersededHarness((id) => passResult(id));

    await harness.run();

    expect(harness.results()).toEqual([]);
    // The pass path's whole state effect is the failure-counter reset; a
    // superseded round must not perform it.
    expect(harness.contextState()?.consecutiveFailureCount).toBe(1);
    // Filed by the conclusion itself, not merely by the dropped lane write.
    expect(aggregateIncidents(harness)).toEqual(["round_superseded"]);
  });

  it("publishes no aggregate failure, reopens nothing, and charges nothing when the round was superseded", async () => {
    const harness = supersededHarness((id) => failResult(id, ["task-plan-1"]));

    await harness.run();

    expect(harness.results()).toEqual([]);
    expect(harness.repository.read().taskStates["task-plan-1"]?.status).toBe(
      "completed",
    );
    expect(harness.contextState()?.consecutiveFailureCount).toBe(1);
    expect(aggregateIncidents(harness)).toEqual(["round_superseded"]);
  });
});

describe("specialist entry type", () => {
  it("is exported for consumers that render per-assignment detail", () => {
    const entry: GraphWorkflowValidationSpecialistEntry = {
      assignmentId: "general",
      profile: { tier: "builtin", id: "general-reviewer", revision: 1 },
      resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
      pass: true,
      summary: "ok",
      issues: [],
      sessionRef: null,
      reviewArtifact: null,
      usage: null,
    };
    expect(entry.assignmentId).toBe("general");
  });
});
