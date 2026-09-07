import { changed } from "@/lib/workflow-graph/execution-mutation";
/**
 * The bound on validation rounds that conclude without a verdict, driven
 * through the production orchestrator.
 *
 * A `candidate_mismatch` conclusion charges nothing — not an iteration, not a
 * consecutive failure — and returns the context to `ready`, so the scheduler
 * re-opens a round immediately. That is correct for the drift this outcome was
 * designed for (an agent finishing a write while the tree freezes, which
 * settles in a round or two) and catastrophic for a cause that cannot settle: a
 * poisoned lane index made every diff render fail for 174 consecutive rounds in
 * 40 minutes, invisible to every existing budget, and would have spun until an
 * operator noticed.
 *
 * Three conclusions reach the budget, and the suite drives all three through
 * the real ports rather than asserting on a stubbed outcome: a candidate that
 * moved under the post-script probe, shared inputs rendered from another tree
 * (the incident above, caught at `diff_render`), and a validator result
 * rejected for an earlier round — where nothing moved at all, which is exactly
 * why the halt has to tell that case apart from the other two. `roster_drift`
 * is the counterpart: it settles something, so it clears the count.
 */

import { describe, expect, it } from "vitest";
import {
  createCohortExecution,
  createHarness,
  metadata,
  NOW,
  passResult,
  TREE_A,
  type Harness,
} from "@/lib/workflow-graph/testing/cohort-engine-harness";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createGraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import { isResumableHalt } from "@/lib/workflow-graph/lifecycle-classifier";
import { CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET } from "@/lib/workflow-graph/constants";
import type { ValidationCandidateTreeResolution } from "@/lib/workflow-graph/validation-round";

const PROJECT_PATH = "/repo";
const SESSION_NAME = "session-1";

/** The tree a round freezes on when the worktree has already moved under it. */
const TREE_MOVED: ValidationCandidateTreeResolution = {
  kind: "resolved",
  identityScope: "wholeTree",
  headSha: "head-1",
  candidateTreeHash: "tree-moved",
};

interface DriftSubject {
  harness: Harness;
  /** Stop moving the candidate, so the next round can reach a verdict. */
  settle(): void;
  /** Move it again, after a round that settled something. */
  resumeDrift(): void;
  /**
   * Drop a seat from the CONFIGURED cohort during the next round's script
   * phase — after the roster froze and before it is reconciled, which is the
   * only window in which a live edit produces roster drift.
   */
  dropSeatDuringNextRound(): void;
}

/**
 * A context whose worktree moves between the freeze and the post-script probe
 * of every round — the shape of the incident, reproduced through the real probe
 * port rather than by asserting on a stubbed outcome.
 *
 * Each drifting round spends exactly two probes (freeze, then post-script), so
 * the parity of the probe counter is what decides which tree a probe reads.
 */
function driftingSubject(): DriftSubject {
  let probes = 0;
  let drifting = true;
  let dropSeat = false;
  const harness = createHarness({
    execution: createCohortExecution({
      assignmentIds: ["general", "security-reviewer"],
    }),
    productionSignalHalt: true,
    runContextValidator: async (input) => ({
      result: passResult("general"),
      metadata: metadata(),
      roundToken: input.roundToken ?? null,
    }),
    scriptValidatorOutcome: async () => {
      if (dropSeat) {
        dropSeat = false;
        await harness.repository
          .mutateActive(PROJECT_PATH, SESSION_NAME, (latest) => {
            const next = structuredClone(latest);
            const context = next.workingDefinition.executionContexts.find(
              (entry) => entry.id === "context-plan",
            );
            if (context === undefined) {
              throw new Error("context-plan is not defined");
            }
            context.contextValidator = {
              ...context.contextValidator,
              assignments: context.contextValidator.assignments.slice(0, -1),
            };
            return changed(next);
          })
          .then((mutation) => mutation.execution);
      }
      return {
        kind: "pass",
        treeState: { headSha: "head-1", dirty: true },
        command: "bun run pre-merge",
      };
    },
    resolveCandidateTree: () => {
      probes += 1;
      return drifting && probes % 2 === 0 ? TREE_MOVED : TREE_A;
    },
  });
  return {
    harness,
    settle() {
      drifting = false;
    },
    resumeDrift() {
      drifting = true;
    },
    dropSeatDuringNextRound() {
      dropSeat = true;
    },
  };
}

/**
 * A context whose candidate never moves, but whose validator answers for a
 * round that is already over. The round's fate is identical — concluded on
 * nothing, re-opened at once, charged nowhere else — and the tree is provably
 * still.
 */
function staleTokenSubject(): Harness {
  return createHarness({
    execution: createCohortExecution({ assignmentIds: ["general"] }),
    productionSignalHalt: true,
    // No token at all is the same refusal as a token for another round: the
    // result cannot be shown to belong to the round that is open.
    runContextValidator: async () => ({
      result: passResult("general"),
      metadata: metadata(),
      roundToken: null,
    }),
    resolveCandidateTree: () => TREE_A,
  });
}

/**
 * The reproduced incident: the tree holds still through both probes, but the
 * cohort's shared inputs are rendered from a different one, so the round cannot
 * certify what it froze and ends before a specialist is spent.
 */
function poisonedDiffRenderSubject(): Harness {
  return createHarness({
    execution: createCohortExecution({ assignmentIds: ["general"] }),
    productionSignalHalt: true,
    runContextValidator: async () => {
      throw new Error("a poisoned diff render must spend no specialist");
    },
    resolveCandidateTree: () => TREE_A,
    renderRoundCommonSections: async () => ({
      diffScopeSection: "## Diff scope\n\n(rendered from a poisoned index)",
      candidateTreeHash: "tree-poisoned",
    }),
  });
}

async function runRounds(subject: DriftSubject, count: number): Promise<void> {
  for (let round = 0; round < count; round += 1) {
    await subject.harness.run();
  }
}

describe("the consecutive candidate-mismatch budget", () => {
  it("counts each mismatch-concluded round against the context", async () => {
    const subject = driftingSubject();

    await runRounds(subject, 3);

    expect(subject.harness.incidents()).toHaveLength(3);
    expect(
      subject.harness.contextState()?.consecutiveCandidateMismatchCount,
    ).toBe(3);
    // Nothing else is charged: an outcome no validator rendered must not feed
    // the circuit breaker or the iteration budget.
    expect(subject.harness.repository.read().pendingHaltReason).toBeNull();
  });

  it("halts with a candidate_unstable reason when the budget runs out", async () => {
    const subject = driftingSubject();

    await runRounds(subject, CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET);

    const halted = subject.harness.repository.read();
    expect(halted.pendingHaltReason).toEqual({
      type: "candidate_unstable",
      contextId: "context-plan",
      stage: "post_script",
      driftedComponents: "candidateTreeHash",
      lastIncident: "candidate_mismatch",
      consecutiveCount: CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET,
      message: expect.stringContaining(
        String(CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET),
      ) as unknown as string,
      // Nothing has spoken about this halt yet; plan repair fills it in.
      summary: null,
    });
    expect(
      halted.pendingHaltReason?.type === "candidate_unstable"
        ? halted.pendingHaltReason.message
        : "",
    ).toContain("the reviewed candidate kept moving");
    // Resumable: nothing about the reviewed work is terminal, and the remedy —
    // repairing whatever keeps moving the tree — is exactly what an operator or
    // plan repair does before resuming.
    expect(isResumableHalt(halted.pendingHaltReason!)).toBe(true);
    expect(subject.harness.contextState()?.status).toBe("halted");
  });

  // The incident the budget was earned by: the tree is provably still at both
  // probes, and the shared inputs the cohort would read came from somewhere
  // else — so the round ends before a single specialist is spent.
  it("halts on shared inputs rendered from another tree, naming the diff render", async () => {
    const harness = poisonedDiffRenderSubject();

    for (
      let round = 0;
      round < CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET;
      round++
    ) {
      await harness.run();
    }

    const halt = harness.repository.read().pendingHaltReason;
    expect(halt).toMatchObject({
      type: "candidate_unstable",
      stage: "diff_render",
      lastIncident: "candidate_mismatch",
      consecutiveCount: CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET,
    });
    expect(
      halt?.type === "candidate_unstable" ? halt.driftedComponents : "",
    ).toContain("tree-poisoned");
  });

  // Same budget, opposite diagnosis. A stale token means nothing moved, so copy
  // that names tree churn sends the operator hunting a writer that does not
  // exist — the one thing this halt must never do.
  it("halts without claiming movement when the rounds were rejected for stale tokens", async () => {
    const harness = staleTokenSubject();

    for (
      let round = 0;
      round < CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET;
      round++
    ) {
      await harness.run();
    }

    const halt = harness.repository.read().pendingHaltReason;
    expect(halt).toEqual({
      type: "candidate_unstable",
      contextId: "context-plan",
      stage: "specialist_result",
      driftedComponents: "",
      lastIncident: "stale_result_rejected",
      consecutiveCount: CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET,
      message: expect.stringContaining(
        "stale round token",
      ) as unknown as string,
      summary: null,
    });
    const message = halt?.type === "candidate_unstable" ? halt.message : "";
    expect(message).toContain("no candidate movement was observed");
    expect(message).not.toContain("kept moving");
  });

  it("re-opens the round rather than halting while the budget holds", async () => {
    const subject = driftingSubject();

    await runRounds(subject, CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET - 1);

    expect(subject.harness.repository.read().pendingHaltReason).toBeNull();
    expect(subject.harness.contextState()?.status).toBe("ready");
  });

  it("resets the count when a later round reaches a verdict", async () => {
    const subject = driftingSubject();
    await runRounds(subject, CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET - 1);

    subject.settle();
    await subject.harness.run();

    expect(
      subject.harness.contextState()?.consecutiveCandidateMismatchCount,
    ).toBe(0);
    expect(subject.harness.repository.read().pendingHaltReason).toBeNull();
  });

  // The budget is keyed on the round OUTCOME, and `roster_drift` is a different
  // outcome, so it zeroes the count the same way a verdict does. That is a
  // deliberate choice with a cost worth stating out loud: a run that alternates
  // the two never reaches the bound.
  it("resets the count when a round concludes on roster drift instead", async () => {
    const subject = driftingSubject();
    await runRounds(subject, CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET - 1);

    // The candidate holds still for this round, so the round survives to the
    // roster reconcile that the seat drop is waiting for.
    subject.settle();
    subject.dropSeatDuringNextRound();
    await subject.harness.run();

    expect(
      subject.harness.contextState()?.consecutiveCandidateMismatchCount,
      "roster drift settles a question about the roster, so it clears the mismatch count exactly as a verdict does",
    ).toBe(0);
    expect(subject.harness.repository.read().pendingHaltReason).toBeNull();

    subject.resumeDrift();
    await runRounds(subject, CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET - 1);

    expect(
      subject.harness.repository.read().pendingHaltReason,
      "the accepted cost of outcome keying: a run that alternates roster drift with mismatches never reaches the bound",
    ).toBeNull();
    expect(
      subject.harness.contextState()?.consecutiveCandidateMismatchCount,
    ).toBe(CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET - 1);
  });

  it("starts the budget fresh after an operator resumes the halt", async () => {
    const subject = driftingSubject();
    await runRounds(subject, CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET);
    await subject.harness.drainAndHalt();

    await subject.harness.resumeHalt();

    // Resume is the manual retry decision, exactly as it is for the circuit
    // breaker's counter: coming back at the bound would re-halt on the first
    // round and make the halt resumable in name only.
    expect(
      subject.harness.contextState()?.consecutiveCandidateMismatchCount,
    ).toBe(0);
  });

  it("keeps the count and the halt readable through SQLite", async () => {
    const subject = driftingSubject();
    await runRounds(subject, CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET);

    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME);
      fixture.graphWorkflowExecutions.setActive(
        PROJECT_PATH,
        SESSION_NAME,
        subject.harness.repository.read(),
        NOW,
      );

      const reloaded = createGraphWorkflowExecutionsRepo(fixture.db).getActive(
        PROJECT_PATH,
        SESSION_NAME,
      );

      expect(
        reloaded?.contextStates["context-plan"]
          ?.consecutiveCandidateMismatchCount,
      ).toBe(CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET);
      expect(reloaded?.pendingHaltReason?.type).toBe("candidate_unstable");
    } finally {
      fixture.close();
    }
  });
});
