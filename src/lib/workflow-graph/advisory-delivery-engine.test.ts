import { changed } from "@/lib/workflow-graph/execution-mutation";
/**
 * The two delivery paths and the exactly-once property, through the REAL engine:
 * the orchestrator's round, the production validation service, and fakes only at
 * the two dispatch boundaries (the specialist turn and the advisory-response
 * turn). Everything asserted here — identity stamping, which message carries the
 * advisories, when a response turn happens — is production behaviour.
 */

import { describe, expect, it } from "vitest";
import { ADVISORY_NON_BINDING_FRAMING } from "@/lib/workflow-graph/advisory-delivery";
import { AgentTurnFailedError } from "@/lib/workflow-graph/errors";
import type {
  GraphWorkflowAdvisoryResponseInput,
  GraphWorkflowAdvisoryResponseOutcome,
} from "@/lib/workflow-graph/advisory-response-runner";
import { makeSeededValidatorAssignment } from "@/lib/workflow-graph/test-fixtures";
import type { GraphWorkflowValidationAdvisory } from "@/lib/workflow-graph/schemas";
import type { ValidatorRunResult } from "@/lib/workflow-graph/validator-runner";
import {
  advisoryItem,
  createCohortExecution,
  createHarness,
  failResult,
  metadata,
  passResult,
  type Harness,
} from "@/lib/workflow-graph/testing/cohort-engine-harness";

/** A blocking acceptance-criteria seat plus one advisory specialist (R5). */
const MIXED_COHORT = [
  makeSeededValidatorAssignment({ id: "verifier", authority: "blocking" }),
  makeSeededValidatorAssignment({ id: "security", authority: "advisory" }),
];

function roundAdvisories(harness: Harness): GraphWorkflowValidationAdvisory[] {
  const round = harness.contextState()?.validationRound;
  if (!round) return [];
  return round.roster.flatMap(
    (seat) => round.specialists[seat.assignmentId]?.advisories ?? [],
  );
}

function failureMessages(harness: Harness): string[] {
  return Object.values(harness.repository.read().taskStates)
    .map((task) => task.failureMessage)
    .filter((message): message is string => message !== null);
}

describe("advisories on a failing round", () => {
  async function runFailingRound(): Promise<Harness> {
    const harness = createHarness({
      execution: createCohortExecution({ assignments: MIXED_COHORT }),
      async runContextValidator(input): Promise<ValidatorRunResult> {
        const assignmentId = input.validator.id;
        return {
          result:
            assignmentId === "verifier"
              ? failResult("verifier", ["task-plan-1"])
              : passResult("security", [
                  advisoryItem({ title: "Widen the token scope check" }),
                  advisoryItem({ kind: "plan", title: "Split task-plan-1" }),
                ]),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });
    await harness.run();
    return harness;
  }

  it("piggybacks the round's advisories on the reopened task's failure message", async () => {
    const harness = await runFailingRound();

    const messages = failureMessages(harness);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Widen the token scope check");
    expect(messages[0]).toContain("Split task-plan-1");
    expect(messages[0]).toContain(ADVISORY_NON_BINDING_FRAMING);
  });

  it("keeps the blocking findings and the advisories visibly apart", async () => {
    const harness = await runFailingRound();

    const [message = ""] = failureMessages(harness);
    expect(message.indexOf("verifier on task-plan-1")).toBeLessThan(
      message.indexOf("Widen the token scope check"),
    );
    expect(message).toContain("non-binding");
  });

  it("marks them delivered on the round record with engine-stamped identities", async () => {
    const harness = await runFailingRound();

    expect(roundAdvisories(harness)).toEqual([
      expect.objectContaining({
        identity: { roundSeq: 1, assignmentId: "security", ordinal: 1 },
        deliveredAt: expect.any(String),
        disposition: null,
      }),
      expect.objectContaining({
        identity: { roundSeq: 1, assignmentId: "security", ordinal: 2 },
        deliveredAt: expect.any(String),
      }),
    ]);
  });

  it("dispatches no advisory-response turn", async () => {
    const harness = await runFailingRound();

    expect(harness.runAdvisoryResponse).not.toHaveBeenCalled();
  });

  it("does not re-deliver them on the next round", async () => {
    const advisories = [advisoryItem({ title: "Widen the token scope check" })];
    let round = 0;
    const harness = createHarness({
      // Two rejections in a row, so the breaker must not trip mid-test.
      execution: createCohortExecution({
        assignments: MIXED_COHORT,
        consecutiveFailureCount: 0,
      }),
      async runContextValidator(input): Promise<ValidatorRunResult> {
        const assignmentId = input.validator.id;
        if (assignmentId === "verifier") {
          return {
            result: failResult("verifier", ["task-plan-1"]),
            metadata: metadata(),
            roundToken: input.roundToken ?? null,
          };
        }
        round += 1;
        // Only the first round's specialist has anything to say. The second
        // round must therefore carry nothing, even though the first round's
        // advisories are still on the execution's records.
        return {
          result: passResult("security", round === 1 ? advisories : []),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });

    await harness.run();
    // The reopened task is complete again, so the second iteration re-validates.
    await harness.repository
      .mutateActive("/repo", "session-1", (latest) => {
        const next = structuredClone(latest);
        const task = next.taskStates["task-plan-1"];
        if (task) {
          task.status = "completed";
          task.summary = "Redone.";
        }
        return changed(next);
      })
      .then((mutation) => mutation.execution);
    await harness.run();

    const state = harness.contextState();
    expect(state?.validationRound?.seq).toBe(2);
    expect(roundAdvisories(harness)).toEqual([]);
    const history = state
      ? (harness.repository.read().taskStates["task-plan-1"]?.failureHistory ??
        [])
      : [];
    expect(history).toHaveLength(2);
    expect(
      history.filter((entry) =>
        entry.message.includes("Widen the token scope check"),
      ),
    ).toHaveLength(1);
  });
});

/**
 * The execution-level index, through the same real engine (R9, D9). What it
 * holds is a property of the RUN, not of a round: an observation about the plan
 * or about something out of scope is no less true for the round that raised it
 * having failed, and its audience — a human now, the owning agent later — reads
 * it without opening rounds.
 */
describe("the execution-level advisory index", () => {
  it("indexes the long-lived kinds a failing round raised, and only those", async () => {
    const harness = createHarness({
      execution: createCohortExecution({ assignments: MIXED_COHORT }),
      async runContextValidator(input): Promise<ValidatorRunResult> {
        const assignmentId = input.validator.id;
        return {
          result:
            assignmentId === "verifier"
              ? failResult("verifier", ["task-plan-1"])
              : passResult("security", [
                  advisoryItem({ title: "Extract the shared helper" }),
                  advisoryItem({ kind: "plan", title: "Split task-plan-1" }),
                  advisoryItem({
                    kind: "out_of_scope",
                    title: "The auth middleware has no rate limit",
                  }),
                ]),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });

    await harness.run();

    // The implementation advisory is absent by design: it was answered inside
    // the round that raised it and has no life beyond it.
    expect(harness.repository.read().advisoryIndex).toEqual([
      {
        identity: { roundSeq: 1, assignmentId: "security", ordinal: 2 },
        kind: "plan",
        title: "Split task-plan-1",
        contextId: "context-plan",
      },
      {
        identity: { roundSeq: 1, assignmentId: "security", ordinal: 3 },
        kind: "out_of_scope",
        title: "The auth middleware has no rate limit",
        contextId: "context-plan",
      },
    ]);
  });

  it("accumulates across rounds rather than being replaced by the latest one", async () => {
    let round = 0;
    const harness = createHarness({
      execution: createCohortExecution({
        assignments: MIXED_COHORT,
        consecutiveFailureCount: 0,
      }),
      async runContextValidator(input): Promise<ValidatorRunResult> {
        if (input.validator.id === "verifier") {
          return {
            result: failResult("verifier", ["task-plan-1"]),
            metadata: metadata(),
            roundToken: input.roundToken ?? null,
          };
        }
        round += 1;
        return {
          result: passResult("security", [
            advisoryItem({
              kind: "plan",
              title: `round ${round}'s observation`,
            }),
          ]),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });

    await harness.run();
    // The reopened task is complete again, so the second iteration re-validates.
    await harness.repository
      .mutateActive("/repo", "session-1", (latest) => {
        const next = structuredClone(latest);
        const task = next.taskStates["task-plan-1"];
        if (task) {
          task.status = "completed";
          task.summary = "Redone.";
        }
        return changed(next);
      })
      .then((mutation) => mutation.execution);
    await harness.run();

    expect(
      harness.repository
        .read()
        .advisoryIndex.map((entry) => [entry.identity.roundSeq, entry.title]),
    ).toEqual([
      [1, "round 1's observation"],
      [2, "round 2's observation"],
    ]);
  });
});

describe("advisories on a passing round", () => {
  function harnessForPass(
    advisories: ReturnType<typeof advisoryItem>[],
    advisoryResponse?: (
      input: GraphWorkflowAdvisoryResponseInput,
    ) => Promise<GraphWorkflowAdvisoryResponseOutcome>,
  ): Harness {
    return createHarness({
      execution: createCohortExecution({ assignments: MIXED_COHORT }),
      async runContextValidator(input): Promise<ValidatorRunResult> {
        const assignmentId = input.validator.id;
        return {
          result:
            assignmentId === "verifier"
              ? passResult("verifier")
              : passResult("security", advisories),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
      ...(advisoryResponse ? { advisoryResponse } : {}),
    });
  }

  /** A turn that disposes of every advisory it is handed, however many. */
  function disposeAll(): (
    input: GraphWorkflowAdvisoryResponseInput,
  ) => Promise<GraphWorkflowAdvisoryResponseOutcome> {
    return async (input) => ({
      dispositions: input.advisories.map((advisory) => ({
        identity: advisory.identity,
        disposition: "deferred" as const,
        reason: null,
      })),
    });
  }

  it("dispatches exactly one advisory-response turn carrying every fresh advisory", async () => {
    const harness = harnessForPass(
      [advisoryItem({ title: "one" }), advisoryItem({ title: "two" })],
      disposeAll(),
    );

    await harness.run();

    expect(harness.runAdvisoryResponse).toHaveBeenCalledTimes(1);
    const [call] = harness.runAdvisoryResponse.mock.calls;
    expect(
      call?.[0].advisories.map((entry: { title: string }) => entry.title),
    ).toEqual(["one", "two"]);
    expect(
      call?.[0].advisories.map(
        (entry: GraphWorkflowValidationAdvisory) => entry.identity,
      ),
    ).toEqual([
      { roundSeq: 1, assignmentId: "security", ordinal: 1 },
      { roundSeq: 1, assignmentId: "security", ordinal: 2 },
    ]);
  });

  it("completes without a response turn when no advisory is fresh", async () => {
    const harness = harnessForPass([], disposeAll());

    await harness.run();

    expect(harness.runAdvisoryResponse).not.toHaveBeenCalled();
  });

  it("records each disposition alongside the advisory it answers", async () => {
    const harness = harnessForPass(
      [advisoryItem({ title: "one" }), advisoryItem({ title: "two" })],
      async () => ({
        dispositions: [
          {
            identity: { roundSeq: 1, assignmentId: "security", ordinal: 1 },
            disposition: "declined",
            reason: "The duplication is deliberate.",
          },
          {
            identity: { roundSeq: 1, assignmentId: "security", ordinal: 2 },
            disposition: "addressed",
            reason: null,
          },
        ],
      }),
    );

    await harness.run();

    expect(roundAdvisories(harness)).toEqual([
      expect.objectContaining({
        title: "one",
        deliveredAt: expect.any(String),
        disposition: {
          outcome: "declined",
          reason: "The duplication is deliberate.",
          recordedAt: expect.any(String),
        },
      }),
      expect.objectContaining({
        title: "two",
        disposition: expect.objectContaining({
          outcome: "addressed",
          reason: null,
        }),
      }),
    ]);
  });

  /**
   * The terminal state R7 forbids, driven from the one boundary that can
   * produce it. The runner's own test proves a batch it cannot get dispositions
   * for raises exactly this; here the subject is what the ENGINE does with it.
   */
  function turnThatNeverDisposes(): never {
    throw new AgentTurnFailedError(
      "The advisory-response turn returned no valid disposition set in 2 attempts",
      {
        contextId: "context-plan",
        engine: "claude",
        cause: "sdk_error",
        originalMessage: "no valid disposition set",
      },
    );
  }

  it("records no disposition the response turn did not return", async () => {
    const harness = harnessForPass(
      [advisoryItem({ title: "one" }), advisoryItem({ title: "two" })],
      async () => turnThatNeverDisposes(),
    );

    await expect(harness.run()).rejects.toBeInstanceOf(AgentTurnFailedError);

    // Neither half of the pair landed: no advisory claims to have been
    // delivered, and none carries an outcome nobody chose.
    expect(roundAdvisories(harness)).toEqual([
      expect.objectContaining({ deliveredAt: null, disposition: null }),
      expect.objectContaining({ deliveredAt: null, disposition: null }),
    ]);
  });

  it("does not complete the context over an advisory the turn never disposed of", async () => {
    const harness = harnessForPass([advisoryItem({ title: "one" })], async () =>
      turnThatNeverDisposes(),
    );

    await expect(harness.run()).rejects.toBeInstanceOf(AgentTurnFailedError);

    expect(harness.contextState()?.status).not.toBe("completed");
    // The verdict the specialists rendered is not lost with the turn: the round
    // still concludes as the pass it was.
    expect(harness.contextState()?.validationRound?.outcome).toBe("passed");
  });

  it("leaves every delivered advisory carrying the disposition the turn returned", async () => {
    const harness = harnessForPass(
      [advisoryItem({ title: "one" }), advisoryItem({ title: "two" })],
      async () => ({
        dispositions: [
          {
            identity: { roundSeq: 1, assignmentId: "security", ordinal: 1 },
            disposition: "deferred",
            reason: null,
          },
          {
            identity: { roundSeq: 1, assignmentId: "security", ordinal: 2 },
            disposition: "addressed",
            reason: null,
          },
        ],
      }),
    );

    await harness.run();

    const advisories = roundAdvisories(harness);
    expect(advisories).toHaveLength(2);
    for (const advisory of advisories) {
      expect(advisory.deliveredAt).toEqual(expect.any(String));
      expect(advisory.disposition).not.toBeNull();
    }
  });
});
