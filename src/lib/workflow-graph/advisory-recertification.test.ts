/**
 * What happens AFTER the advisory-response turn, through the real engine (R8/D8).
 *
 * The whole subject here is one question: does the candidate the round certified
 * still exist? The hash answers it, and nothing else is allowed to — an
 * implementer that declines every advisory and edits the tree anyway must be
 * re-certified, and one that addresses everything in words while touching
 * nothing must not be. Both directions are asserted on run RECORDS (script
 * executions, validator dispatches, the round's roster) rather than on the
 * engine's own reporting, because the claim is about work that did or did not
 * happen.
 */

import { describe, expect, it } from "vitest";
import { AgentTurnFailedError } from "@/lib/workflow-graph/errors";
import type {
  GraphWorkflowAdvisoryResponseInput,
  GraphWorkflowAdvisoryResponseOutcome,
} from "@/lib/workflow-graph/advisory-response-runner";
import { makeSeededValidatorAssignment } from "@/lib/workflow-graph/test-fixtures";
import type { ValidationCandidateTreeResolution } from "@/lib/workflow-graph/validation-round";
import type { ValidatorRunResult } from "@/lib/workflow-graph/validator-runner";
import {
  advisoryItem,
  createCohortExecution,
  createHarness,
  failResult,
  metadata,
  passResult,
  TREE_A,
  type Harness,
} from "@/lib/workflow-graph/testing/cohort-engine-harness";

/** One blocking acceptance-criteria seat plus one advisory specialist (R5). */
const MIXED_COHORT = [
  makeSeededValidatorAssignment({ id: "verifier", authority: "blocking" }),
  makeSeededValidatorAssignment({ id: "security", authority: "advisory" }),
];

/** The candidate after the implementer touched files in its response turn. */
const TREE_B: ValidationCandidateTreeResolution = {
  kind: "resolved",
  identityScope: "wholeTree",
  headSha: "head-1",
  candidateTreeHash: "tree-b",
};

interface RunRecords {
  scriptRuns: number;
  validatorDispatches: string[];
}

interface Scenario {
  harness: Harness;
  /** The whole run's records, still accumulating. */
  records: RunRecords;
  /** A snapshot taken at the moment the response turn was dispatched. */
  atResponseTurn(): RunRecords;
}

/**
 * A context whose cohort passes, whose advisory lane raises one advisory, and
 * whose response turn does whatever `respond` says.
 *
 * `verifierVerdicts` is consumed one per round, so a test can say "pass, then
 * reject the re-certification" without knowing when each round runs.
 */
function scenario(params: {
  respond(input: GraphWorkflowAdvisoryResponseInput): Promise<void> | void;
  verifierVerdicts?: readonly ("pass" | "fail")[];
  tree(): ValidationCandidateTreeResolution;
}): Scenario {
  const records: RunRecords = { scriptRuns: 0, validatorDispatches: [] };
  let snapshot: RunRecords = { scriptRuns: 0, validatorDispatches: [] };
  const verdicts = [...(params.verifierVerdicts ?? ["pass"])];

  const harness = createHarness({
    execution: createCohortExecution({ assignments: MIXED_COHORT }),
    resolveCandidateTree: params.tree,
    async scriptValidatorOutcome() {
      records.scriptRuns += 1;
      return {
        kind: "pass",
        treeState: { headSha: "head-1", dirty: true },
        command: "bun run pre-merge",
      };
    },
    async runContextValidator(input): Promise<ValidatorRunResult> {
      const assignmentId = input.validator.id;
      records.validatorDispatches.push(assignmentId);
      if (assignmentId === "verifier") {
        const verdict = verdicts.shift() ?? "pass";
        return {
          result:
            verdict === "pass"
              ? passResult("verifier")
              : failResult("verifier", ["task-plan-1"]),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      }
      return {
        result: passResult("security", [
          advisoryItem({ title: "Widen the token scope check" }),
        ]),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      };
    },
    async advisoryResponse(
      input,
    ): Promise<GraphWorkflowAdvisoryResponseOutcome> {
      snapshot = {
        scriptRuns: records.scriptRuns,
        validatorDispatches: [...records.validatorDispatches],
      };
      await params.respond(input);
      return {
        dispositions: input.advisories.map((advisory) => ({
          identity: advisory.identity,
          disposition: "declined" as const,
          reason: "The duplication is deliberate.",
        })),
      };
    },
  });

  return { harness, records, atResponseTurn: () => snapshot };
}

describe("a response turn that leaves the candidate identical (R8.1)", () => {
  async function declineEverythingAndTouchNothing(): Promise<Scenario> {
    const subject = scenario({ respond: () => {}, tree: () => TREE_A });
    await subject.harness.run();
    return subject;
  }

  it("completes the context on the certification the round already rendered", async () => {
    const { harness } = await declineEverythingAndTouchNothing();

    expect(harness.contextState()?.status).toBe("completed");
    expect(harness.contextState()?.validationRound?.outcome).toBe("passed");
    expect(harness.contextState()?.validationRound?.seq).toBe(1);
  });

  it("runs no script validation after the turn", async () => {
    const { records, atResponseTurn } =
      await declineEverythingAndTouchNothing();

    expect(records.scriptRuns).toBe(atResponseTurn().scriptRuns);
  });

  it("dispatches no validator of any kind after the turn", async () => {
    const { records, atResponseTurn } =
      await declineEverythingAndTouchNothing();

    expect(records.validatorDispatches).toEqual(
      atResponseTurn().validatorDispatches,
    );
  });

  it("leaves the advisories disposed of and the phase cleared", async () => {
    const { harness } = await declineEverythingAndTouchNothing();

    const round = harness.contextState()?.validationRound;
    expect(round?.specialists["security"]?.advisories).toEqual([
      expect.objectContaining({
        deliveredAt: expect.any(String),
        disposition: expect.objectContaining({ outcome: "declined" }),
      }),
    ]);
    expect(harness.contextState()?.advisoryResponse ?? null).toBeNull();
  });
});

describe("a response turn that changed the candidate (R8.2)", () => {
  /**
   * The corner the criterion names: every advisory declined, and the tree edited
   * anyway. The dispositions say "no work was done"; the hash says otherwise,
   * and the hash is what the engine acts on.
   */
  function declineEverythingAndEditAnyway(
    verifierVerdicts?: readonly ("pass" | "fail")[],
  ): Scenario {
    let tree: ValidationCandidateTreeResolution = TREE_A;
    return scenario({
      respond: () => {
        tree = TREE_B;
      },
      ...(verifierVerdicts ? { verifierVerdicts } : {}),
      tree: () => tree,
    });
  }

  it("does not complete the context on the superseded certification", async () => {
    const subject = declineEverythingAndEditAnyway();

    const result = await subject.harness.run();

    expect(subject.harness.contextState()?.status).not.toBe("completed");
    expect(result.decision.kind).toBe("continue");
  });

  it("re-certifies with the script gate and the blocking lane only", async () => {
    const subject = declineEverythingAndEditAnyway();

    await subject.harness.run();
    const beforeRecertification = {
      scriptRuns: subject.records.scriptRuns,
      dispatches: subject.records.validatorDispatches.length,
    };
    await subject.harness.run();

    expect(subject.records.scriptRuns).toBe(
      beforeRecertification.scriptRuns + 1,
    );
    expect(
      subject.records.validatorDispatches.slice(
        beforeRecertification.dispatches,
      ),
    ).toEqual(["verifier"]);
  });

  it("leaves the advisory lanes structurally absent from the round's roster", async () => {
    const subject = declineEverythingAndEditAnyway();

    await subject.harness.run();
    await subject.harness.run();

    const round = subject.harness.contextState()?.validationRound;
    expect(round?.seq).toBe(2);
    expect(round?.candidate.candidateTreeHash).toBe("tree-b");
    expect(round?.roster.map((seat) => seat.assignmentId)).toEqual([
      "verifier",
    ]);
    expect(Object.keys(round?.specialists ?? {})).toEqual(["verifier"]);
  });

  it("dispatches no second response turn for advisories already disposed of", async () => {
    const subject = declineEverythingAndEditAnyway();

    await subject.harness.run();
    await subject.harness.run();

    expect(subject.harness.runAdvisoryResponse).toHaveBeenCalledTimes(1);
  });

  it("re-enters the normal iteration loop when the blocking lane rejects it", async () => {
    const subject = declineEverythingAndEditAnyway(["pass", "fail"]);

    await subject.harness.run();
    const failedRecertification = await subject.harness.run();

    expect(
      subject.harness.repository.read().taskStates["task-plan-1"]?.status,
    ).toBe("pending");
    expect(failedRecertification.decision.kind).toBe("continue");
    expect(subject.harness.contextState()?.status).toBe("running");
  });

  it("charges the breaker for the re-certification's rejection", async () => {
    const subject = declineEverythingAndEditAnyway(["pass", "fail"]);

    await subject.harness.run();
    // The certification cleared the streak, so the re-certification's rejection
    // charges the breaker from zero exactly as any other rejection does.
    const afterCertification =
      subject.harness.contextState()?.consecutiveFailureCount ?? 0;
    await subject.harness.run();

    expect(afterCertification).toBe(0);
    expect(subject.harness.contextState()?.consecutiveFailureCount).toBe(1);
  });

  it("completes the context when the re-certification passes", async () => {
    const subject = declineEverythingAndEditAnyway(["pass", "pass"]);

    await subject.harness.run();
    await subject.harness.run();

    expect(subject.harness.contextState()?.status).toBe("completed");
    expect(subject.harness.contextState()?.advisoryResponse ?? null).toBeNull();
  });
});

describe("the advisory-response phase outlives the turn that owes it", () => {
  /**
   * A response turn that dies the way any lane turn can. The engine has already
   * banked the certification and written the phase, so what comes back is a
   * context that still owes exactly one turn — not one that owes a fresh round.
   */
  function crashOnFirstTurn(): Scenario {
    let attempt = 0;
    return scenario({
      respond: () => {
        attempt += 1;
        if (attempt > 1) return;
        throw new AgentTurnFailedError("the provider dropped the turn", {
          contextId: "context-plan",
          engine: "claude",
          cause: "sdk_error",
          originalMessage: "the provider dropped the turn",
        });
      },
      tree: () => TREE_A,
    });
  }

  it("records the phase durably against the round that certified the candidate", async () => {
    const subject = crashOnFirstTurn();

    await expect(subject.harness.run()).rejects.toBeInstanceOf(
      AgentTurnFailedError,
    );

    expect(subject.harness.contextState()?.advisoryResponse).toEqual({
      roundSeq: 1,
      phase: "awaiting_response",
      enteredAt: expect.any(String),
    });
    expect(subject.harness.contextState()?.status).not.toBe("completed");
  });

  it("re-dispatches the owed turn without opening a fresh round", async () => {
    const subject = crashOnFirstTurn();

    await expect(subject.harness.run()).rejects.toBeInstanceOf(
      AgentTurnFailedError,
    );
    const afterCrash = {
      scriptRuns: subject.records.scriptRuns,
      dispatches: [...subject.records.validatorDispatches],
    };
    await subject.harness.run();

    expect(subject.harness.runAdvisoryResponse).toHaveBeenCalledTimes(2);
    expect(subject.records.scriptRuns).toBe(afterCrash.scriptRuns);
    expect(subject.records.validatorDispatches).toEqual(afterCrash.dispatches);
    expect(subject.harness.contextState()?.validationRound?.seq).toBe(1);
    expect(subject.harness.contextState()?.status).toBe("completed");
  });

  it("is held by the same pause gate as any other lane turn", async () => {
    const subject = crashOnFirstTurn();

    await expect(subject.harness.run()).rejects.toBeInstanceOf(
      AgentTurnFailedError,
    );
    await subject.harness.pause();

    // A paused execution runs no iteration at all, so the owed turn waits
    // behind the gate every lane turn waits behind — nothing about the phase is
    // special-cased, and nothing about it is lost while it waits.
    await expect(subject.harness.run()).rejects.toThrow(
      "Only running graph workflow executions can run iterations",
    );
    expect(subject.harness.runAdvisoryResponse).toHaveBeenCalledTimes(1);
    expect(subject.harness.contextState()?.advisoryResponse?.phase).toBe(
      "awaiting_response",
    );
  });
});

describe("an advisory-only cohort's re-certification", () => {
  it("publishes the recaptured handoff after an advisory response with no remaining certification gate", async () => {
    let tree = TREE_A;
    let captures = 0;
    const execution = createCohortExecution({
      assignments: [
        makeSeededValidatorAssignment({
          id: "security",
          authority: "advisory",
        }),
      ],
    });
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-plan",
    )!;
    context.scriptValidator = { commands: [] };
    context.outputSchema = {
      type: "object",
      properties: { revision: { type: "integer" } },
      required: ["revision"],
    };
    const harness = createHarness({
      execution,
      resolveCandidateTree: () => tree,
      outputCaptureService: {
        captureContextOutput: async () => ({
          kind: "captured",
          value: { revision: ++captures },
          parse: { source: "native" },
        }),
      },
      runContextValidator: async (input) => ({
        result: passResult("security", [advisoryItem()]),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
      advisoryResponse: async (input) => {
        tree = TREE_B;
        return {
          dispositions: input.advisories.map((advisory) => ({
            identity: advisory.identity,
            disposition: "addressed" as const,
            reason: null,
          })),
        };
      },
    });
    await harness.run();
    await harness.run();
    expect(
      harness.repository.read().contextOutputs["context-plan"]?.value,
    ).toEqual({ revision: 2 });
    expect(harness.contextState()?.status).toBe("completed");
    expect(harness.runContextValidator).toHaveBeenCalledTimes(1);
  });

  it("is the script gate alone, with no lane of any authority dispatched", async () => {
    let tree: ValidationCandidateTreeResolution = TREE_A;
    const records = { scriptRuns: 0, validatorDispatches: [] as string[] };
    const harness = createHarness({
      execution: createCohortExecution({
        assignments: [
          makeSeededValidatorAssignment({
            id: "security",
            authority: "advisory",
          }),
        ],
      }),
      resolveCandidateTree: () => tree,
      async scriptValidatorOutcome() {
        records.scriptRuns += 1;
        return {
          kind: "pass",
          treeState: { headSha: "head-1", dirty: true },
          command: "bun run pre-merge",
        };
      },
      async runContextValidator(input): Promise<ValidatorRunResult> {
        records.validatorDispatches.push(input.validator.id);
        return {
          result: passResult("security", [
            advisoryItem({ title: "Widen the token scope check" }),
          ]),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
      async advisoryResponse(input) {
        tree = TREE_B;
        return {
          dispositions: input.advisories.map((advisory) => ({
            identity: advisory.identity,
            disposition: "addressed" as const,
            reason: null,
          })),
        };
      },
    });

    await harness.run();
    await harness.run();

    expect(records.scriptRuns).toBe(2);
    expect(records.validatorDispatches).toEqual(["security"]);
    expect(harness.contextState()?.validationRound?.seq).toBe(2);
    expect(harness.contextState()?.validationRound?.roster).toEqual([]);
    expect(harness.contextState()?.status).toBe("completed");
  });
});
