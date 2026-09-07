import { changed } from "@/lib/workflow-graph/execution-mutation";
import { describe, expect, it } from "vitest";
import {
  ADMISSION_TIMEOUT_RESULT,
  COHORT,
  createCohortExecution,
  createHarness,
  failResult,
  INFRA_RESULT,
  metadata,
  passResult,
  specialistRecord,
  withOpenRound,
  type Harness,
} from "@/lib/workflow-graph/testing/cohort-engine-harness";
import { makeSeededValidatorAssignment } from "@/lib/workflow-graph/test-fixtures";
import type { ResumeUserInputContext } from "./user-input-gate";
import { evaluatePlanRepairTrigger } from "./plan-repair/trigger";
import { isResumableHalt } from "./lifecycle-classifier";

describe("cohort dispatch: script-first, then all at once (R16.1)", () => {
  it("parks an infrastructure block without semantic remediation or failure spend", async () => {
    const execution = createCohortExecution();
    const beforeTasks = structuredClone(execution.taskStates);
    const harness = createHarness({
      execution,
      runContextValidator: async (input) => ({
        result: passResult(input.validator.id),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
      scriptValidatorOutcome: async () => ({
        kind: "infra_error",
        reason: "exception",
        message: "Figma discovery incomplete",
        readinessBlock: { commandName: "figma-ready", attempts: 3 },
      }),
    });
    await harness.run();
    const halted = harness.repository.read();
    expect(halted.haltReason).toMatchObject({
      type: "infrastructure_blocked",
      contextId: "context-plan",
      commandName: "figma-ready",
      attempts: 3,
    });
    expect(isResumableHalt(halted.haltReason!)).toBe(true);
    expect(halted.taskStates).toEqual(beforeTasks);
    expect(harness.contextState()?.consecutiveFailureCount).toBe(
      execution.contextStates["context-plan"]?.consecutiveFailureCount,
    );
    expect(harness.runContextValidator).not.toHaveBeenCalled();
  });

  it("launches zero specialists until the script validator passes", async () => {
    const harness = createHarness({
      execution: createCohortExecution(),
      runContextValidator: async (input) => ({
        result: passResult(input.validator.id),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
      scriptValidatorOutcome: async () => ({
        kind: "fail",
        summary: "typecheck failed",
        logFilePath: "/wt/.cc/workflow/execution-1/pre-merge.log",
        logRelativePath: ".cc/workflow/execution-1/pre-merge.log",
        timedOut: false,
        treeState: { headSha: "head-1", dirty: true },
        command: "bun run pre-merge",
      }),
    });

    await harness.run();

    expect(harness.runContextValidator).not.toHaveBeenCalled();
  });

  it("starts every specialist before any sibling verdict completes", async () => {
    const started: string[] = [];
    const gates = new Map<string, () => void>();

    const harness = createHarness({
      execution: createCohortExecution(),
      runContextValidator: async (input) => {
        started.push(input.validator.id);
        await new Promise<void>((resolve) =>
          gates.set(input.validator.id, resolve),
        );
        return {
          result: passResult(input.validator.id),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });

    const running = harness.run();
    // Let the round freeze and the script phase settle, then let the fan-out
    // land — without releasing a single specialist.
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();

    expect(started).toEqual([...COHORT]);
    expect(gates.size).toBe(COHORT.length);

    for (const release of gates.values()) release();
    await running;
  });

  it("an artificially slow specialist never delays a sibling's start", async () => {
    const started: string[] = [];
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const harness = createHarness({
      execution: createCohortExecution(),
      runContextValidator: async (input) => {
        started.push(input.validator.id);
        if (input.validator.id === "general") await slowGate;
        return {
          result: passResult(input.validator.id),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });

    const running = harness.run();
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();

    // The first assignment in cohort order is still blocked, and both siblings
    // have already started anyway.
    expect(started).toEqual([...COHORT]);

    releaseSlow();
    await running;
    expect(harness.contextState()?.consecutiveFailureCount).toBe(0);
  });

  it("starts specialists as budget slots free when the budget is below cohort size", async () => {
    // A budget of one: the cohort adds NO ordering of its own, so admission is
    // whatever the shared FIFO hands out, and every specialist still runs.
    const admitted: string[] = [];
    const waiting: (() => void)[] = [];
    let active = 0;
    const BUDGET = 1;

    async function acquire(): Promise<void> {
      if (active < BUDGET) {
        active += 1;
        return;
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
      active += 1;
    }
    function release(): void {
      active -= 1;
      waiting.shift()?.();
    }

    const harness = createHarness({
      execution: createCohortExecution(),
      runContextValidator: async (input) => {
        await acquire();
        admitted.push(input.validator.id);
        // Yield so a sibling could interleave if anything else were serializing.
        await Promise.resolve();
        release();
        return {
          result: passResult(input.validator.id),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });

    await harness.run();

    expect(admitted).toHaveLength(COHORT.length);
    expect([...admitted].sort()).toEqual([...COHORT].sort());
    // Never more than the budget at once — the cohort is subordinate to it.
    expect(active).toBe(0);
  });

  it("assembles the aggregate in configured cohort order, not completion order", async () => {
    // Completion order is deliberately the reverse of cohort order.
    const gates = new Map<string, () => void>();
    const order: string[] = [];

    const harness = createHarness({
      execution: createCohortExecution(),
      runContextValidator: async (input) => {
        await new Promise<void>((resolve) =>
          gates.set(input.validator.id, resolve),
        );
        order.push(input.validator.id);
        return {
          result: passResult(input.validator.id),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });

    const running = harness.run();
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
    for (const id of [...COHORT].reverse()) gates.get(id)?.();
    await running;

    expect(order).toEqual([...COHORT].reverse());
    const result = harness.results()[0]!.event as { summary: string };
    expect(result.summary).toBe(
      COHORT.map((id) => `${id}: ${id} is satisfied.`).join("\n"),
    );
  });
});

describe("cohort conclusion precedence (R5.4)", () => {
  it("concludes semantically on a rejection, with findings grouped by assignment and reopen ids deduped", async () => {
    const harness = createHarness({
      execution: createCohortExecution(),
      runContextValidator: async (input) => {
        const id = input.validator.id;
        const result =
          id === "general"
            ? passResult(id)
            : id === "security-reviewer"
              ? failResult(id, ["task-plan-1"])
              : failResult(id, ["task-plan-1"]);
        return {
          result,
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });

    await harness.run();

    const results = harness.results();
    // ONE aggregate for the round, not one per rejecting specialist.
    expect(results).toHaveLength(1);
    const event = results[0]!.event as {
      pass: boolean;
      issues: { title: string }[];
      reopenTaskIds: string[];
    };
    expect(event.pass).toBe(false);
    expect(event.issues.map((issue) => issue.title)).toEqual([
      "security-reviewer on task-plan-1",
      "perf-reviewer on task-plan-1",
    ]);
    // One reopen for a task two specialists objected to.
    expect(event.reopenTaskIds).toEqual(["task-plan-1"]);
    expect(harness.repository.read().taskStates["task-plan-1"]?.status).toBe(
      "pending",
    );
  });

  it("concludes semantically even when a sibling exhausted its attempts", async () => {
    // The infra-failed specialist simply runs again next round; remediation does
    // not need its opinion to know the work is going back.
    const harness = createHarness({
      execution: createCohortExecution(),
      runContextValidator: async (input) => ({
        result:
          input.validator.id === "perf-reviewer"
            ? INFRA_RESULT
            : input.validator.id === "security-reviewer"
              ? failResult(input.validator.id, ["task-plan-1"])
              : passResult(input.validator.id),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    expect(harness.repository.read().status).not.toBe("halted");
    const results = harness.results();
    expect(results).toHaveLength(1);
    expect(results[0]!.event).toMatchObject({ pass: false });
    expect(harness.contextState()?.consecutiveFailureCount).toBe(2);
  });

  it("attributes each aggregated finding to its specialist, and says so in the remediation", async () => {
    // The findings are worded identically and name nobody, exactly as two real
    // reviewers reaching the same conclusion would. Everything downstream —
    // the aggregate event, the reopened task's message, evidence ingestion —
    // must still be able to say which specialist raised which finding.
    const harness = createHarness({
      execution: createCohortExecution(),
      runContextValidator: async (input) => ({
        result:
          input.validator.id === "general"
            ? passResult(input.validator.id)
            : {
                kind: "fail",
                summary: `${input.validator.id} rejected the work.`,
                issues: [
                  {
                    taskId: "task-plan-1",
                    title: "Undocumented rollback",
                    description: "The rollback path is undocumented.",
                  },
                ],
                advisories: [],
                reopenTaskIds: ["task-plan-1"],
              },
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    const event = harness.results()[0]!.event as {
      issues: { assignmentId?: string; taskId?: string }[];
    };
    expect(
      event.issues.map((issue) => [issue.assignmentId, issue.taskId]),
    ).toEqual([
      ["security-reviewer", "task-plan-1"],
      ["perf-reviewer", "task-plan-1"],
    ]);

    const failureMessage =
      harness.repository.read().taskStates["task-plan-1"]?.failureMessage ?? "";
    expect(failureMessage).toContain("security-reviewer");
    expect(failureMessage).toContain("perf-reviewer");
  });

  it("resets the failure counter when every specialist passes", async () => {
    const harness = createHarness({
      execution: createCohortExecution(),
      runContextValidator: async (input) => ({
        result: passResult(input.validator.id),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    expect(harness.results()[0]!.event).toMatchObject({ pass: true });
    expect(harness.contextState()?.consecutiveFailureCount).toBe(0);
    expect(harness.contextState()?.validationRound?.outcome).toBe("passed");
  });
});

describe("circuit-breaker accounting is cohort-size invariant (R5.2)", () => {
  it("charges one consecutive failure for a three-validator round with two rejections", async () => {
    const harness = createHarness({
      execution: createCohortExecution({ consecutiveFailureCount: 1 }),
      runContextValidator: async (input) => ({
        result:
          input.validator.id === "general"
            ? passResult(input.validator.id)
            : failResult(input.validator.id, ["task-plan-1"]),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    expect(harness.contextState()?.consecutiveFailureCount).toBe(2);
  });

  it("moves the counter by exactly what a single-validator rejection moves it", async () => {
    const cohortHarness = createHarness({
      execution: createCohortExecution({ consecutiveFailureCount: 1 }),
      runContextValidator: async (input) => ({
        result:
          input.validator.id === "general"
            ? passResult(input.validator.id)
            : failResult(input.validator.id, ["task-plan-1"]),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });
    const soloHarness = createHarness({
      execution: createCohortExecution({
        assignmentIds: ["general"],
        consecutiveFailureCount: 1,
      }),
      runContextValidator: async (input) => ({
        result: failResult(input.validator.id, ["task-plan-1"]),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await cohortHarness.run();
    await soloHarness.run();

    expect(cohortHarness.contextState()?.consecutiveFailureCount).toBe(
      soloHarness.contextState()?.consecutiveFailureCount,
    );
    expect(cohortHarness.results()).toHaveLength(soloHarness.results().length);
  });

  it("trips the breaker at the same round a single validator would", async () => {
    const cohortHarness = createHarness({
      execution: createCohortExecution({ consecutiveFailureCount: 2 }),
      runContextValidator: async (input) => ({
        result:
          input.validator.id === "general"
            ? passResult(input.validator.id)
            : failResult(input.validator.id, ["task-plan-1"]),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });
    const soloHarness = createHarness({
      execution: createCohortExecution({
        assignmentIds: ["general"],
        consecutiveFailureCount: 2,
      }),
      runContextValidator: async (input) => ({
        result: failResult(input.validator.id, ["task-plan-1"]),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await cohortHarness.run();
    await soloHarness.run();

    expect(cohortHarness.repository.read().haltReason?.type).toBe(
      "circuit_breaker",
    );
    expect(cohortHarness.repository.read().haltReason).toEqual(
      soloHarness.repository.read().haltReason,
    );
  });
});

/**
 * R10.2: blocking authority is only as good as what backs it. The circuit
 * breaker and the plan-repair agent are that backing, and they reach a failing
 * blocking specialist only because its rejection walks the same failed-round
 * path the seeded acceptance-criteria verifier's does.
 *
 * Pinned by comparing the two, seat for seat, rather than by asserting a number
 * on one of them: a refactor that gave authored specialists their own accounting
 * would leave both assertions individually true and this comparison false.
 */
describe("a blocking specialist feeds the breaker as the AC verifier does (R10.2)", () => {
  // The seeded verifier authors no instructions — its mandate IS the context's
  // acceptance criteria. An authored specialist carries its own.
  const AC_VERIFIER = makeSeededValidatorAssignment({
    id: "general",
    authority: "blocking",
  });
  const AUTHORED_SPECIALIST = makeSeededValidatorAssignment({
    id: "security-reviewer",
    authority: "blocking",
    focus: "Judge the auth boundary against the threat model.",
  });

  function soloRejection(
    assignment: typeof AC_VERIFIER,
    consecutiveFailureCount: number,
  ): Harness {
    return createHarness({
      execution: createCohortExecution({
        assignments: [assignment],
        consecutiveFailureCount,
      }),
      runContextValidator: async (input) => ({
        result: failResult(input.validator.id, ["task-plan-1"]),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });
  }

  it("charges the same consecutive failure for either seat's rejection", async () => {
    const verifier = soloRejection(AC_VERIFIER, 1);
    const specialist = soloRejection(AUTHORED_SPECIALIST, 1);

    await verifier.run();
    await specialist.run();

    expect(specialist.contextState()?.consecutiveFailureCount).toBe(2);
    expect(specialist.contextState()?.consecutiveFailureCount).toBe(
      verifier.contextState()?.consecutiveFailureCount,
    );
  });

  it("trips the breaker at the same round, with the same halt reason", async () => {
    const verifier = soloRejection(AC_VERIFIER, 2);
    const specialist = soloRejection(AUTHORED_SPECIALIST, 2);

    await verifier.run();
    await specialist.run();

    expect(specialist.repository.read().haltReason).toMatchObject({
      type: "circuit_breaker",
      condition: "retry_exhaustion",
      failureCount: 3,
    });
    expect(specialist.repository.read().haltReason).toEqual(
      verifier.repository.read().haltReason,
    );
  });

  it("clears the streak the same way when either seat passes", async () => {
    const harnesses = [AC_VERIFIER, AUTHORED_SPECIALIST].map((assignment) =>
      createHarness({
        execution: createCohortExecution({
          assignments: [assignment],
          consecutiveFailureCount: 2,
        }),
        runContextValidator: async (input) => ({
          result: passResult(input.validator.id),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        }),
      }),
    );

    for (const harness of harnesses) await harness.run();

    expect(
      harnesses.map((h) => h.contextState()?.consecutiveFailureCount),
    ).toEqual([0, 0]);
  });
});

/**
 * R5.1 through the real engine: the round record and the published aggregate,
 * not just the conclusion function. What an advisory lane costs a round has to
 * be visible where an operator reads it — the lane's own record — and nowhere
 * else.
 */
describe("advisory lanes settle without gating (R5.1)", () => {
  function advisoryCohort(ids: readonly string[], blockingIds: string[] = []) {
    return createCohortExecution({
      assignments: ids.map((id) =>
        makeSeededValidatorAssignment({
          id,
          authority: blockingIds.includes(id) ? "blocking" : "advisory",
        }),
      ),
    });
  }

  it("records an exhausted advisory lane's infra failure on its lane and still concludes the round", async () => {
    const harness = createHarness({
      execution: advisoryCohort(["general", "advisor"], ["general"]),
      runContextValidator: async (input) => ({
        result:
          input.validator.id === "advisor"
            ? INFRA_RESULT
            : passResult(input.validator.id),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    // It still retried its own trouble and still spent its budget — an
    // advisory lane is not a lane that gets less care, only one whose silence
    // nobody is waiting on.
    expect(
      harness.runContextValidator.mock.calls.filter(
        (call) => call[0].validator.id === "advisor",
      ),
    ).toHaveLength(3);

    const persisted = harness.repository.read();
    expect(persisted.status).not.toBe("halted");
    expect(harness.results()[0]!.event).toMatchObject({ pass: true });

    // The failure is filed against the lane that suffered it, with the reason
    // intact, rather than vanishing because it changed nothing.
    const round = harness.contextState()?.validationRound;
    expect(round?.specialists["advisor"]).toMatchObject({
      state: "infra_failed",
      attempts: 3,
      lastInfraFailure: {
        reason: "exception",
        message: "provider unavailable",
        engine: "claude",
      },
    });
  });

  it("passes an advisory-only cohort once the script gate passes and its lanes settle", async () => {
    const harness = createHarness({
      execution: advisoryCohort(["advisor-a", "advisor-b"]),
      runContextValidator: async (input) => ({
        result:
          input.validator.id === "advisor-b"
            ? INFRA_RESULT
            : passResult(input.validator.id),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    const persisted = harness.repository.read();
    expect(persisted.status).not.toBe("halted");
    expect(harness.results()[0]!.event).toMatchObject({ pass: true });
    expect(persisted.contextStates["context-plan"]?.status).toBe("completed");
  });

  it("does not let an advisory-only cohort excuse a failing script gate", async () => {
    // "Concludes passed once the script gate passes" is a conjunction: with no
    // blocking specialist the deterministic gate is the only thing left that
    // can reject, so it must still reject.
    const harness = createHarness({
      execution: advisoryCohort(["advisor-a", "advisor-b"]),
      runContextValidator: async (input) => ({
        result: passResult(input.validator.id),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
      scriptValidatorOutcome: async () => ({
        kind: "fail",
        summary: "typecheck failed",
        logFilePath: "/wt/.cc/workflow/execution-1/pre-merge.log",
        logRelativePath: ".cc/workflow/execution-1/pre-merge.log",
        timedOut: false,
        treeState: { headSha: "head-1", dirty: true },
        command: "bun run pre-merge",
      }),
    });

    await harness.run();

    expect(harness.runContextValidator).not.toHaveBeenCalled();
    expect(harness.contextState()?.status).not.toBe("completed");
  });
});

describe("infrastructure exhaustion leaves the round unconcluded (R6)", () => {
  it("retries only the affected specialist and keeps its siblings' verdicts", async () => {
    const calls: string[] = [];
    let perfAttempts = 0;

    const harness = createHarness({
      execution: createCohortExecution(),
      runContextValidator: async (input) => {
        calls.push(input.validator.id);
        if (input.validator.id === "perf-reviewer") {
          perfAttempts += 1;
          if (perfAttempts < 3) {
            return {
              result: INFRA_RESULT,
              metadata: metadata(),
              roundToken: input.roundToken ?? null,
            };
          }
        }
        return {
          result: passResult(input.validator.id),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });

    await harness.run();

    expect(calls.filter((id) => id === "general")).toHaveLength(1);
    expect(calls.filter((id) => id === "security-reviewer")).toHaveLength(1);
    expect(calls.filter((id) => id === "perf-reviewer")).toHaveLength(3);
    expect(harness.results()[0]!.event).toMatchObject({ pass: true });
  });

  it("halts resumably with the round retained, nothing charged, and no aggregate published", async () => {
    const harness = createHarness({
      execution: createCohortExecution(),
      runContextValidator: async (input) => ({
        result:
          input.validator.id === "perf-reviewer"
            ? INFRA_RESULT
            : passResult(input.validator.id),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    const persisted = harness.repository.read();
    expect(persisted.status).toBe("halted");
    expect(persisted.haltReason).toMatchObject({
      type: "validator_infra_error",
      contextId: "context-plan",
      assignmentId: "perf-reviewer",
      attempts: 3,
      roundSeq: 1,
    });
    expect(isResumableHalt(persisted.haltReason!)).toBe(true);

    // Nothing a consumer counting failures would see, and nothing charged.
    expect(harness.results()).toHaveLength(0);
    const contextState = persisted.contextStates["context-plan"];
    expect(contextState?.consecutiveFailureCount).toBe(1);

    // The round is OPEN, not concluded — an unheard required validator means it
    // never concluded at all — and the settled verdicts are still there.
    const round = contextState?.validationRound;
    expect(round?.phase).toBe("specialists");
    expect(round?.outcome).toBeNull();
    expect(round?.specialists["general"]).toMatchObject({
      state: "verdict_pass",
    });
    expect(round?.specialists["security-reviewer"]).toMatchObject({
      state: "verdict_pass",
    });
    expect(round?.specialists["perf-reviewer"]).toMatchObject({
      state: "infra_failed",
      attempts: 3,
    });
  });

  it("records the exhaustion as a non-verdict incident, not as a validation result", async () => {
    const harness = createHarness({
      execution: createCohortExecution(),
      runContextValidator: async (input) => ({
        result:
          input.validator.id === "perf-reviewer"
            ? INFRA_RESULT
            : passResult(input.validator.id),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    // A consumer counting verdicts reads validation results; a consumer
    // diagnosing a stuck context reads incidents. Publishing this as a
    // `pass: false` result — what the pre-cohort path did — would tell the first
    // consumer a reviewer rejected the work when no reviewer spoke.
    expect(harness.results()).toHaveLength(0);
    // Every admitted-and-failed dispatch is filed as it happens, and the
    // exhaustion closes the sequence: three retries, then "this lane never
    // rendered a verdict".
    expect(
      harness
        .incidents()
        .map((entry) =>
          entry.event.type === "graph-workflow-validation-incident"
            ? entry.event.incident
            : null,
        ),
    ).toEqual([
      "infra_failure",
      "infra_failure",
      "infra_failure",
      "infra_exhausted",
    ]);
    const exhaustion = harness
      .incidents()
      .find(
        (entry) =>
          entry.event.type === "graph-workflow-validation-incident" &&
          entry.event.incident === "infra_exhausted",
      );
    expect(exhaustion?.event).toMatchObject({
      incident: "infra_exhausted",
      contextId: "context-plan",
      assignmentId: "perf-reviewer",
      attempts: 3,
      roundSeq: 1,
    });
  });

  it("is never a plan-repair trigger", async () => {
    const harness = createHarness({
      execution: createCohortExecution(),
      runContextValidator: async (input) => ({
        result:
          input.validator.id === "perf-reviewer"
            ? INFRA_RESULT
            : passResult(input.validator.id),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    // Plan repair exists to fix a PLAN the work keeps failing against. A broken
    // provider says nothing about the plan, so rewriting it would be a
    // superstition acted on at cost.
    const verdict = evaluatePlanRepairTrigger(harness.repository.read());
    expect(verdict).toEqual({ eligible: false, reason: "halt_kind" });
  });

  it("does not spend an attempt on a dispatch the queue never admitted", async () => {
    let perfCalls = 0;
    const harness = createHarness({
      execution: createCohortExecution(),
      runContextValidator: async (input) => {
        if (input.validator.id !== "perf-reviewer") {
          return {
            result: passResult(input.validator.id),
            metadata: metadata(),
            roundToken: input.roundToken ?? null,
          };
        }
        perfCalls += 1;
        // Two admission timeouts, then a real provider failure every time. If a
        // timeout consumed an attempt the lane would exhaust after one true
        // failure instead of three.
        return {
          result: perfCalls <= 2 ? ADMISSION_TIMEOUT_RESULT : INFRA_RESULT,
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });

    await harness.run();

    expect(perfCalls).toBe(5);
    expect(harness.repository.read().haltReason).toMatchObject({
      type: "validator_infra_error",
      attempts: 3,
    });
  });
});

describe("a parked specialist leaves the round unconcluded", () => {
  const QUESTIONS = [
    {
      id: "q-1",
      question: "Is the legacy token path in scope?",
      options: [
        { label: "Yes", recommended: false },
        { label: "No", recommended: false },
      ],
      multiSelect: false,
      required: true,
      allowNote: true,
    },
  ];

  function askingHarness(params: { stillAsking: () => boolean }) {
    const calls: string[] = [];
    const harness = createHarness({
      execution: createCohortExecution(),
      runContextValidator: async (input) => {
        calls.push(input.validator.id);
        if (
          input.validator.id === "security-reviewer" &&
          params.stillAsking()
        ) {
          return {
            result: {
              kind: "asked_user",
              conversationId: "conversation-security",
              questionBatchId: "batch-security",
              questions: QUESTIONS,
            },
            metadata: metadata(),
            roundToken: input.roundToken ?? null,
          };
        }
        return {
          result: passResult(input.validator.id),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });
    return { harness, calls };
  }

  /** What the loop's `consumeAnswers` does before it resumes the iteration. */
  async function consumeAnswers(
    harness: Harness,
  ): Promise<ResumeUserInputContext[]> {
    await harness.repository
      .mutateActive("/repo", "session-1", (latest) => {
        const next = structuredClone(latest);
        const contextState = next.contextStates["context-plan"]!;
        contextState.pendingUserInputs = {};
        contextState.status = "running";
        return changed(next);
      })
      .then((mutation) => mutation.execution);
    return [
      {
        laneKey: "context_validator:security-reviewer",
        lane: "context_validator",
        answers: {},
        questionBatchId: "batch-security",
        conversationId: "conversation-security",
      },
    ];
  }

  it("parks without charging anything and keeps the round open with its verdicts", async () => {
    let asking = true;
    const { harness } = askingHarness({ stillAsking: () => asking });

    await harness.run();
    asking = false;

    const round = harness.contextState()?.validationRound;
    // The round has NOT concluded: a lane that is waiting on the human has not
    // reported, so nothing may be recorded for the round yet.
    expect(round?.phase).toBe("specialists");
    expect(round?.outcome).toBeNull();
    expect(round?.specialists["security-reviewer"]).toMatchObject({
      state: "parked",
      questionToken: "batch-security",
    });
    expect(round?.specialists["general"]?.state).toBe("verdict_pass");
    expect(harness.contextState()?.status).toBe("awaiting_user_input");
    // A park is not a verdict: no aggregate, no failure charged.
    expect(harness.results()).toHaveLength(0);
    expect(harness.contextState()?.consecutiveFailureCount).toBe(1);
  });

  it("reruns only the parked lane on resume, and hands the answers to it alone", async () => {
    let asking = true;
    const { harness, calls } = askingHarness({ stillAsking: () => asking });

    await harness.run();
    const roundSeq = harness.contextState()?.validationRound?.seq ?? 0;

    asking = false;
    const resumeUserInputs = await consumeAnswers(harness);
    calls.length = 0;

    await harness.run({ resumeUserInputs });

    // The siblings judged this candidate already; re-running them would review
    // work their reviewers had signed off, and would make the answer arrive at
    // lanes that never asked anything.
    expect(calls).toEqual(["security-reviewer"]);
    expect(harness.contextState()?.validationRound?.seq).toBe(roundSeq);
    expect(harness.results()).toHaveLength(1);
    expect(harness.results()[0]!.event).toMatchObject({ pass: true });
    expect(harness.contextState()?.validationRound?.phase).toBe("concluded");
  });

  it("delivers the answer block only to the lane that parked on it", async () => {
    // Two lanes park on DIFFERENT batches, so both rerun on the resume — the
    // only arrangement where mis-routing one lane's answers to another is
    // observable, and the one invariant 9 exists to allow.
    let asking = true;
    const received: Record<string, boolean> = {};
    const harness = createHarness({
      execution: createCohortExecution(),
      runContextValidator: async (input) => {
        received[input.validator.id] = input.resumeUserInput !== undefined;
        const parking =
          input.validator.id === "security-reviewer" ||
          input.validator.id === "perf-reviewer";
        if (parking && asking) {
          return {
            result: {
              kind: "asked_user",
              conversationId: `conversation-${input.validator.id}`,
              questionBatchId:
                input.validator.id === "security-reviewer"
                  ? "batch-security"
                  : "batch-perf",
              questions: QUESTIONS,
            },
            metadata: metadata(),
            roundToken: input.roundToken ?? null,
          };
        }
        return {
          result: passResult(input.validator.id),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });

    await harness.run();
    asking = false;
    const resumeUserInputs = await consumeAnswers(harness);
    for (const key of Object.keys(received)) delete received[key];

    await harness.run({ resumeUserInputs });

    expect(received).toEqual({
      "security-reviewer": true,
      "perf-reviewer": false,
    });
  });

  // The park did not open a new round, so the budget the exhausted sibling
  // spent is still spent: attempts are per specialist per ROUND, and only an
  // operator's resume hands one back (D5).
  it("does not restore an exhausted sibling's attempts when answers arrive", async () => {
    let asking = true;
    const calls: string[] = [];
    const harness = createHarness({
      execution: createCohortExecution(),
      runContextValidator: async (input) => {
        calls.push(input.validator.id);
        if (input.validator.id === "security-reviewer" && asking) {
          return {
            result: {
              kind: "asked_user",
              conversationId: "conversation-security",
              questionBatchId: "batch-security",
              questions: QUESTIONS,
            },
            metadata: metadata(),
            roundToken: input.roundToken ?? null,
          };
        }
        return {
          result:
            input.validator.id === "perf-reviewer"
              ? INFRA_RESULT
              : passResult(input.validator.id),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });

    await harness.run();
    expect(calls.filter((id) => id === "perf-reviewer")).toHaveLength(3);
    asking = false;
    const resumeUserInputs = await consumeAnswers(harness);
    calls.length = 0;

    await harness.run({ resumeUserInputs });

    // The parked lane reruns with its answers; the exhausted one does not run
    // at all, and the round halts because nothing can conclude without it.
    expect(calls).toEqual(["security-reviewer"]);
    expect(harness.repository.read().haltReason).toMatchObject({
      type: "validator_infra_error",
      assignmentId: "perf-reviewer",
      attempts: 3,
    });
    expect(harness.results()).toEqual([]);
  });
});

describe("resuming an unconcluded round", () => {
  it("reruns only the unsettled specialist, against the same frozen candidate", async () => {
    const execution = createCohortExecution();
    let perfShouldFail = true;
    const calls: string[] = [];

    const harness = createHarness({
      execution,
      runContextValidator: async (input) => {
        calls.push(input.validator.id);
        const failing =
          input.validator.id === "perf-reviewer" && perfShouldFail;
        return {
          result: failing ? INFRA_RESULT : passResult(input.validator.id),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });

    await harness.run();
    expect(harness.repository.read().status).toBe("halted");
    const roundSeq = harness.contextState()?.validationRound?.seq ?? 0;

    // Operator resumes: the execution goes back to running, the round survives.
    await harness.resumeHalt();
    perfShouldFail = false;
    calls.length = 0;

    await harness.run();

    // Only the lane that never settled ran again — the two that already rendered
    // verdicts on this candidate are not re-reviewed.
    expect(calls).toEqual(["perf-reviewer"]);
    // Same round, not a fresh freeze: the candidate never moved.
    expect(harness.contextState()?.validationRound?.seq).toBe(roundSeq);
    expect(harness.results()).toHaveLength(1);
    expect(harness.results()[0]!.event).toMatchObject({ pass: true });
    expect(harness.contextState()?.validationRound?.phase).toBe("concluded");
  });

  it("gives the rerun specialist a fresh attempt budget", async () => {
    const execution = createCohortExecution();
    const calls: string[] = [];

    const harness = createHarness({
      execution,
      runContextValidator: async (input) => {
        calls.push(input.validator.id);
        return {
          result:
            input.validator.id === "perf-reviewer"
              ? INFRA_RESULT
              : passResult(input.validator.id),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });

    await harness.run();
    expect(calls.filter((id) => id === "perf-reviewer")).toHaveLength(3);

    await harness.resumeHalt();
    calls.length = 0;

    await harness.run();

    // The counters reset on resume: a lane that came back at the cap could never
    // run again, which would make the halt permanent rather than resumable.
    expect(calls.filter((id) => id === "perf-reviewer")).toHaveLength(3);
    expect(harness.repository.read().haltReason).toMatchObject({
      type: "validator_infra_error",
      attempts: 3,
    });
  });
});

/**
 * The bound is three admitted dispatches per specialist per round — a fact
 * about the round, not about the process that happened to be running it. A
 * crash mid-round is the case that tells the two apart: the counter lives in
 * the round record precisely so a restart cannot hand a broken provider a
 * fresh budget every time the server bounces (R6.1, D5).
 */
describe("attempt counts survive a mid-round reload", () => {
  it("spends only the attempts the round record has left", async () => {
    const execution = withOpenRound(
      createCohortExecution({ assignmentIds: ["general"] }),
      {
        specialists: {
          general: specialistRecord({
            state: "running",
            attempts: 2,
            lastInfraFailure: {
              reason: "exception",
              message: "provider unavailable",
              engine: "claude",
            },
          }),
        },
      },
    );

    const harness = createHarness({
      execution,
      runContextValidator: async (input) => ({
        result: INFRA_RESULT,
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    // Two were already spent, so exactly one is left — not three more.
    expect(harness.runContextValidator).toHaveBeenCalledTimes(1);
    expect(harness.repository.read().haltReason).toMatchObject({
      type: "validator_infra_error",
      assignmentId: "general",
      attempts: 3,
    });
  });

  it("dispatches nothing for a lane the record already shows exhausted", async () => {
    const execution = withOpenRound(
      createCohortExecution({ assignmentIds: ["general"] }),
      {
        specialists: {
          general: specialistRecord({
            state: "infra_failed",
            attempts: 3,
            lastInfraFailure: {
              reason: "schema_mismatch",
              message: "the reviewer returned an unusable shape",
              engine: "codex",
            },
          }),
        },
      },
    );

    const harness = createHarness({
      execution,
      runContextValidator: async (input) => ({
        result: passResult(input.validator.id),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    expect(harness.runContextValidator).not.toHaveBeenCalled();
    // The halt names the failure the round actually recorded, not a synthetic
    // one invented by the restart.
    expect(harness.repository.read().haltReason).toMatchObject({
      type: "validator_infra_error",
      assignmentId: "general",
      attempts: 3,
      infraReason: "schema_mismatch",
      engine: "codex",
    });
    expect(harness.results()).toEqual([]);
  });

  it("spends only the remaining attempt across the production restart path", async () => {
    // The reload above starts the engine straight from the persisted record.
    // This one takes the route a real crash takes — normalizeAfterRestart pauses
    // the still-running execution carrying NO halt reason, and the operator
    // resumes that pause. Nobody looked at the provider on that path, so it must
    // not refill the budget; if it did, a crash loop would buy three fresh
    // dispatches per bounce (R6.1, D5).
    const execution = withOpenRound(
      createCohortExecution({ assignmentIds: ["general"] }),
      {
        specialists: {
          general: specialistRecord({
            state: "running",
            attempts: 2,
            lastInfraFailure: {
              reason: "exception",
              message: "provider unavailable",
              engine: "claude",
            },
          }),
        },
      },
    );

    const harness = createHarness({
      execution,
      runContextValidator: async (input) => ({
        result: INFRA_RESULT,
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.restartAndResume();
    await harness.run();

    expect(harness.runContextValidator).toHaveBeenCalledTimes(1);
    expect(harness.repository.read().haltReason).toMatchObject({
      type: "validator_infra_error",
      assignmentId: "general",
      attempts: 3,
    });
    expect(harness.results()).toEqual([]);
  });

  it("gives the lane its full budget back once the operator resumes the halt", async () => {
    const execution = withOpenRound(
      createCohortExecution({ assignmentIds: ["general"] }),
      {
        specialists: {
          general: specialistRecord({
            state: "infra_failed",
            attempts: 3,
            lastInfraFailure: {
              reason: "exception",
              message: "provider unavailable",
              engine: "claude",
            },
          }),
        },
      },
    );

    const harness = createHarness({
      execution,
      runContextValidator: async (input) => ({
        result: passResult(input.validator.id),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();
    expect(harness.runContextValidator).not.toHaveBeenCalled();

    await harness.resumeHalt();
    await harness.run();

    expect(harness.runContextValidator).toHaveBeenCalledTimes(1);
    expect(harness.results()).toHaveLength(1);
  });
});
