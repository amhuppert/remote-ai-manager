import { describe, expect, it } from "vitest";
import { advanceContext, type ContextInput } from "./advance";
import { planEffects, waitsOnPerson, type PlannedEffect } from "./effects";
import { initialContextFacts } from "./facts";
import { applyTaskCommand, type TaskCommand } from "./ledger";
import { deriveProgress } from "./progress";
import type { ConversationReport, WorkspaceReport } from "./reports";
import {
  DEFAULT_CONTEXT_POLICY,
  contextContractSchema,
  type ContextContract,
  type ContextFacts,
  type ContextPolicy,
  type ReviewerAssignment,
} from "./schemas";

const seat = {
  profile: { tier: "builtin" as const, id: "general-reviewer" },
  backend: "claude" as const,
  modelSelection: { modelId: "sonnet", parameters: {} },
};

function contract(overrides: Partial<ContextContract> = {}): ContextContract {
  return contextContractSchema.parse({
    title: "Fix the duplicate notice",
    brief: "Make the failure notice appear once.",
    tasks: [{ id: "t1", title: "Fix it" }],
    acceptanceCriteria: [{ id: "ac-1", text: "One notice per failure" }],
    outputSchema: null,
    allowTaskAddition: false,
    implementer: { id: "implementer", ...seat },
    reviewers: [],
    checks: [],
    humanApproval: false,
    ownerQuestions: true,
    documents: [],
    ...overrides,
  });
}

function reviewer(
  id: string,
  authority: "blocking" | "advisory",
): ReviewerAssignment {
  return { id, authority, ...seat };
}

function workReport(
  overrides: Partial<ConversationReport> = {},
): ConversationReport {
  return {
    status: "succeeded",
    conversationId: "conv-impl",
    finalText: "Done.",
    structuredOutput: null,
    outputIssue: null,
    openQuestionId: null,
    failure: null,
    ...overrides,
  };
}

function verdictReport(
  verdict: "pass" | "fail" | "plan_defect",
  extra: {
    findings?: unknown[];
    advisories?: unknown[];
    conversationId?: string;
  } = {},
): ConversationReport {
  return workReport({
    conversationId: extra.conversationId ?? "conv-review",
    structuredOutput: {
      verdict,
      findings: extra.findings ?? [],
      advisories: extra.advisories ?? [],
    },
  });
}

const binding = {
  kind: "session" as const,
  projectPath: "/repo",
  sessionName: "session",
  worktreePath: "/repo/.worktrees/session",
  scope: { mode: "full" as const },
};

/** A context whose workspace binding was admitted. */
function harness(
  c: ContextContract,
  policy: ContextPolicy = DEFAULT_CONTEXT_POLICY,
) {
  const h = unboundHarness(c, policy);
  expect(h.step().map((e) => e.request.kind)).toEqual(["bind"]);
  h.settle("bind", { kind: "bound" });
  return h;
}

function unboundHarness(
  c: ContextContract,
  policy: ContextPolicy = DEFAULT_CONTEXT_POLICY,
) {
  let facts: ContextFacts = initialContextFacts({
    contextId: "ctx",
    workspace: binding,
    contract: c,
    policy,
  });
  let pending: PlannedEffect[] = [];
  return {
    get facts() {
      return facts;
    },
    get pending() {
      return pending;
    },
    step(): PlannedEffect[] {
      if (pending.length > 0) return [];
      const planned = planEffects({ facts, othersPending: false });
      facts = planned.facts;
      pending = planned.effects;
      return planned.effects;
    },
    settle(
      kind: PlannedEffect["request"]["kind"],
      outcome: unknown,
      index = 0,
    ): void {
      const effect = pending.filter((e) => e.request.kind === kind)[index];
      if (effect === undefined) throw new Error(`No pending ${kind} effect`);
      facts = advanceContext(facts, {
        kind: "outcome",
        cause: effect.cause,
        request: effect.request,
        state: { kind: "settled", outcome },
      });
      pending = pending.filter((e) => e !== effect);
    },
    settleUncertain(kind: PlannedEffect["request"]["kind"]): void {
      const effect = pending.find((e) => e.request.kind === kind);
      if (effect === undefined) throw new Error(`No pending ${kind} effect`);
      facts = advanceContext(facts, {
        kind: "outcome",
        cause: effect.cause,
        request: effect.request,
        state: { kind: "uncertain", evidence: "process exited mid-turn" },
      });
      pending = pending.filter((e) => e !== effect);
    },
    input(input: ContextInput): void {
      facts = advanceContext(facts, input);
    },
    task(command: TaskCommand): void {
      const result = applyTaskCommand(facts, command);
      if (result.kind === "refused") throw new Error(result.reason);
      facts = result.facts;
    },
    progress(admitted = true) {
      return deriveProgress(
        facts,
        pending.map((e) => ({
          cause: e.cause,
          admitted,
          waitsOnPerson: waitsOnPerson(e.request),
        })),
      );
    },
  };
}

const frozen = (evidence: string): WorkspaceReport => ({
  kind: "frozen",
  evidence,
});

/** Runs one work turn that completes every task, then freezes the result. */
function workAndFreeze(h: ReturnType<typeof harness>, evidence = "ev-1"): void {
  expect(h.step().map((e) => e.request.kind)).toEqual(["work"]);
  for (const task of h.facts.ledger.tasks) {
    if (task.status === "open") h.task({ kind: "complete", taskId: task.id });
  }
  h.settle("work", workReport());
  expect(h.step().map((e) => e.request.kind)).toEqual(["freeze"]);
  h.settle("freeze", frozen(evidence));
}

describe("execution context acceptance chain", () => {
  it("binds its workspace before any work and gives seats only the access they need", () => {
    const h = unboundHarness(
      contract({ reviewers: [reviewer("reviewer-a", "blocking")] }),
    );
    expect(h.progress()).toEqual({
      kind: "running",
      obligation: { kind: "bind" },
    });
    const [bind] = h.step();
    expect(bind?.request).toEqual({ kind: "bind", bindingId: "ctx", binding });
    h.settle("bind", { kind: "bound" });

    const [work] = h.step();
    expect(work?.request).toMatchObject({
      workspace: { grant: { kind: "full_write" }, worktreePath: binding.worktreePath },
    });
    h.task({ kind: "complete", taskId: "t1" });
    h.settle("work", workReport());
    h.step();
    h.settle("freeze", frozen("ev-1"));
    expect(h.step()[0]?.request).toMatchObject({
      kind: "review",
      workspace: { grant: { kind: "stable_read" } },
    });
  });

  it("lets seats ask the owner only when the contract allows owner questions", () => {
    expect(harness(contract()).step()[0]?.request).toMatchObject({
      seat: { canAsk: true },
    });
    expect(
      harness(contract({ ownerQuestions: false })).step()[0]?.request,
    ).toMatchObject({
      seat: { canAsk: false },
    });
  });

  it("accepts a context with no output schema, checks or reviewers after work, freeze and acceptance", () => {
    const h = harness(contract());

    expect(h.progress()).toEqual({
      kind: "running",
      obligation: { kind: "work", reason: "initial" },
    });
    workAndFreeze(h);
    const [accept] = h.step();
    expect(accept?.request).toMatchObject({ kind: "accept", evidence: "ev-1" });
    h.settle("accept", { kind: "accepted", receipt: "snapshot-1" });

    expect(h.progress()).toEqual({
      kind: "succeeded",
      candidateId: "ctx:candidate:1",
    });
    expect(h.facts.candidates.items[0]?.output).toEqual({ summary: "Done." });
  });

  it("captures declared output before review and reviews the exact payload", () => {
    const h = harness(
      contract({
        outputSchema: {
          type: "object",
          properties: { notices: { type: "number" } },
        },
        reviewers: [reviewer("reviewer-a", "blocking")],
      }),
    );
    expect(h.step().map((e) => e.request.kind)).toEqual(["work"]);
    h.task({ kind: "complete", taskId: "t1" });
    h.settle("work", workReport());

    expect(h.step().map((e) => e.request.kind)).toEqual(["capture_output"]);
    h.settle(
      "capture_output",
      workReport({ structuredOutput: { notices: 1 } }),
    );
    h.step();
    h.settle("freeze", frozen("ev-1"));

    const [review] = h.step();
    expect(review?.request.kind).toBe("review");
    expect(
      review?.request.kind === "review" && review.request.message,
    ).toContain('"notices": 1');
    h.settle("review", verdictReport("pass"));

    h.step();
    h.settle("accept", { kind: "accepted", receipt: "snapshot-1" });
    expect(h.progress().kind).toBe("succeeded");
  });

  it("charges unfinished-task retries, halts when they run out, and resumes after a grant", () => {
    const h = harness(contract(), {
      ...DEFAULT_CONTEXT_POLICY,
      unfinishedTaskRetries: 1,
    });
    h.step();
    h.settle("work", workReport());

    const [retry] = h.step();
    expect(retry?.request).toMatchObject({
      kind: "work",
      reason: "retry",
      allowance: "unfinishedTaskRetries",
    });
    h.settle("work", workReport());

    expect(h.progress()).toMatchObject({
      kind: "halted",
      halt: "retries_exhausted",
    });
    expect(h.step()).toEqual([]);

    h.input({
      kind: "disposition",
      disposition: {
        kind: "grant",
        allowance: "unfinishedTaskRetries",
        count: 1,
        reason: "close to done",
      },
      occurrence: "occ",
      at: "t",
    });
    expect(h.step()[0]?.request).toMatchObject({
      kind: "work",
      reason: "retry",
    });
  });

  it("takes the initial work turn even when the contract lists no tasks", () => {
    const h = harness(contract({ tasks: [] }));
    expect(h.step()[0]?.request).toMatchObject({
      kind: "work",
      reason: "initial",
    });
    h.settle("work", workReport());
    expect(h.step()[0]?.request.kind).toBe("freeze");
  });

  it("gives every planned effect a cause it has never used", () => {
    const h = harness(contract(), {
      ...DEFAULT_CONTEXT_POLICY,
      unfinishedTaskRetries: 3,
    });
    const causes: string[] = [];
    for (let turn = 0; turn < 3; turn += 1) {
      const [work] = h.step();
      if (work === undefined) throw new Error("no work planned");
      causes.push(work.cause);
      h.settle("work", workReport());
    }
    expect(new Set(causes).size).toBe(3);
    expect(h.facts.effectSequence).toBe(3);
  });

  it("runs acceptance checks before any reviewer and skips reviewers when a check fails", () => {
    const h = harness(
      contract({
        checks: ["typecheck"],
        reviewers: [reviewer("reviewer-a", "blocking")],
      }),
    );
    workAndFreeze(h);

    expect(h.step().map((e) => e.request.kind)).toEqual(["check"]);
    h.settle("check", {
      kind: "checked",
      status: "failed",
      detail: "2 errors",
      wroteReviewedScope: [],
    });

    const [remediation] = h.step();
    expect(remediation?.request).toMatchObject({
      kind: "work",
      reason: "remediate",
      allowance: "validationRetries",
    });
    expect(
      remediation?.request.kind === "work" && remediation.request.message,
    ).toContain("typecheck");
  });

  it("fails a check that writes the reviewed scope and names the changed paths", () => {
    const h = harness(contract({ checks: ["test"] }));
    workAndFreeze(h);
    h.step();
    h.settle("check", {
      kind: "checked",
      status: "passed",
      wroteReviewedScope: ["src/__snapshots__/notice.snap"],
    });

    const [remediation] = h.step();
    expect(
      remediation?.request.kind === "work" && remediation.request.message,
    ).toContain("src/__snapshots__/notice.snap");
  });

  it("retires the candidate after remediation and certifies a fresh one", () => {
    const h = harness(
      contract({ reviewers: [reviewer("reviewer-a", "blocking")] }),
    );
    workAndFreeze(h);
    h.step();
    h.settle(
      "review",
      verdictReport("fail", {
        findings: [{ title: "Two notices", description: "Still duplicated" }],
      }),
    );

    h.step();
    h.settle("work", workReport());
    expect(h.facts.candidates.retired).toEqual([
      { candidateId: "ctx:candidate:1", reason: "reworked" },
    ]);

    expect(h.step().map((e) => e.request.kind)).toEqual(["freeze"]);
    h.settle("freeze", frozen("ev-2"));
    const [review] = h.step();
    expect(review?.request).toMatchObject({
      kind: "review",
      roundId: "ctx:round:2",
    });
  });

  it("halts on a plan defect and reviews again after a rereview disposition", () => {
    const h = harness(
      contract({ reviewers: [reviewer("reviewer-a", "blocking")] }),
    );
    workAndFreeze(h);
    h.step();
    h.settle(
      "review",
      verdictReport("plan_defect", {
        findings: [{ title: "Contract contradicts API", description: "x" }],
      }),
    );

    expect(h.progress()).toMatchObject({ kind: "halted", halt: "plan_defect" });
    h.input({
      kind: "disposition",
      disposition: { kind: "rereview", reason: "contract clarified" },
      occurrence: "occ",
      at: "t",
    });

    expect(h.step()[0]?.request).toMatchObject({
      kind: "review",
      roundId: "ctx:round:2",
    });
  });

  it("gives work done after an advisory response a full review again, advisory reviewers included", () => {
    const h = harness(
      contract({ reviewers: [reviewer("blocker", "blocking"), reviewer("advisor", "advisory")] }),
    );
    workAndFreeze(h);
    h.step();
    h.settle("review", verdictReport("pass"));
    h.settle("review", verdictReport("pass", { advisories: [{ title: "Rename helper", description: "Clearer" }] }));
    h.step();
    h.settle(
      "advise",
      workReport({
        structuredOutput: { dispositions: [{ advisoryId: "ctx:round:1:advisor:1", disposition: "addressed", reason: "" }] },
      }),
    );
    h.step();
    h.settle("verify", { kind: "verified", changed: true });

    // New work before the next freeze: a task reopened, then done again.
    h.task({ kind: "reopen", taskId: "t1" });
    expect(h.step()[0]?.request).toMatchObject({ kind: "work" });
    h.task({ kind: "complete", taskId: "t1" });
    h.settle("work", workReport());
    h.step();
    h.settle("freeze", frozen("ev-3"));
    expect(h.step().map((e) => (e.request.kind === "review" ? e.request.seat.assignmentId : e.request.kind))).toEqual([
      "blocker",
      "advisor",
    ]);
  });

  it("delivers fresh advice once and recertifies changed work with blocking reviewers only", () => {
    const h = harness(
      contract({
        reviewers: [
          reviewer("blocker", "blocking"),
          reviewer("advisor", "advisory"),
        ],
      }),
    );
    workAndFreeze(h);
    const reviews = h.step();
    expect(reviews.map((e) => e.request.kind)).toEqual(["review", "review"]);
    h.settle("review", verdictReport("pass"));
    h.settle(
      "review",
      verdictReport("pass", {
        advisories: [{ title: "Rename helper", description: "Clearer" }],
      }),
    );

    const [advise] = h.step();
    expect(advise?.request).toMatchObject({ kind: "advise" });
    h.settle(
      "advise",
      workReport({
        structuredOutput: {
          dispositions: [
            {
              advisoryId: "ctx:round:1:advisor:1",
              disposition: "addressed",
              reason: "",
            },
          ],
        },
      }),
    );

    expect(h.step()[0]?.request).toMatchObject({ kind: "verify" });
    h.settle("verify", { kind: "verified", changed: true });

    h.step();
    h.settle("freeze", frozen("ev-2"));
    const recertify = h.step();
    expect(recertify).toHaveLength(1);
    expect(recertify[0]?.request).toMatchObject({
      kind: "review",
      seat: { assignmentId: "blocker" },
    });
    h.settle("review", verdictReport("pass"));

    expect(h.step()[0]?.request).toMatchObject({
      kind: "accept",
      evidence: "ev-2",
    });
  });

  it("asks again for advice dispositions once, then halts as advice_invalid", () => {
    const h = harness(
      contract({ reviewers: [reviewer("advisor", "advisory")] }),
      { ...DEFAULT_CONTEXT_POLICY, adviceCorrectionLimit: 1 },
    );
    workAndFreeze(h);
    h.step();
    h.settle(
      "review",
      verdictReport("pass", {
        advisories: [{ title: "Tidy", description: "x" }],
      }),
    );

    h.step();
    h.settle("advise", workReport({ structuredOutput: { dispositions: [] } }));
    expect(h.step()[0]?.request.kind).toBe("advise");
    h.settle("advise", workReport({ structuredOutput: { dispositions: [] } }));

    expect(h.progress()).toMatchObject({
      kind: "halted",
      halt: "advice_invalid",
    });
  });

  it("runs an advisory-only cohort's round even though blocking certification is not required", () => {
    const h = harness(
      contract({ reviewers: [reviewer("advisor", "advisory")] }),
    );
    workAndFreeze(h);

    expect(h.step().map((e) => e.request.kind)).toEqual(["review"]);
    h.settle(
      "review",
      verdictReport("fail", {
        advisories: [{ title: "Consider X", description: "y" }],
      }),
    );

    expect(h.step()[0]?.request.kind).toBe("advise");
  });

  it("records a human rejection while paused and reworks on resume without touching tasks or output", () => {
    const h = harness(contract({ humanApproval: true }));
    workAndFreeze(h);
    expect(h.progress()).toEqual({
      kind: "waiting",
      obligation: { kind: "await_approval", candidateId: "ctx:candidate:1" },
    });

    h.input({ kind: "pause" });
    const tasksBefore = h.facts.ledger;
    const candidatesBefore = h.facts.candidates;
    h.input({
      kind: "decide",
      candidateId: "ctx:candidate:1",
      decision: "rejected",
      notes: "Use the shared helper",
      decidedAt: "2026-10-03T12:00:00.000Z",
    });
    expect(h.facts.ledger).toBe(tasksBefore);
    expect(h.facts.candidates).toBe(candidatesBefore);
    expect(h.progress()).toMatchObject({
      kind: "paused",
      next: { kind: "running", obligation: { kind: "work", reason: "rework" } },
    });

    h.input({ kind: "resume" });
    const [rework] = h.step();
    expect(rework?.request).toMatchObject({
      kind: "work",
      reason: "rework",
      allowance: null,
    });
    expect(rework?.request.kind === "work" && rework.request.message).toContain(
      "Use the shared helper",
    );
  });

  it("asks for a new human decision when the approved candidate changes before acceptance", () => {
    const h = harness(contract({ humanApproval: true }));
    workAndFreeze(h, "ev-1");
    h.input({
      kind: "decide",
      candidateId: "ctx:candidate:1",
      decision: "approved",
      decidedAt: "2026-10-03T12:00:00.000Z",
    });
    h.step();
    h.settle("accept", { kind: "candidate_changed" });
    h.step();
    h.settle("freeze", frozen("ev-2"));

    expect(h.progress()).toEqual({
      kind: "waiting",
      obligation: { kind: "await_approval", candidateId: "ctx:candidate:2" },
    });
    expect(h.step()).toEqual([]);
  });

  it("waits for an owner's answer and continues the interrupted work without spending an allowance", () => {
    const h = harness(contract());
    h.step();
    h.settle("work", workReport({ openQuestionId: "q-1" }));

    const [answer] = h.step();
    expect(answer?.request).toEqual({ kind: "answer", questionId: "q-1" });
    expect(h.progress()).toMatchObject({
      kind: "waiting",
      obligation: { kind: "await_answer" },
    });
    h.settle("answer", {
      kind: "answered",
      question: "Which helper?",
      answer: "notice.ts",
    });

    const [continuation] = h.step();
    expect(continuation?.request).toMatchObject({
      kind: "work",
      reason: "continue",
      allowance: null,
    });
    expect(
      continuation?.request.kind === "work" && continuation.request.message,
    ).toContain("notice.ts");
  });

  it("lets only turns that can wait for an answer ask the owner: work and review, not capture or advice", () => {
    const seatOf = (effect: PlannedEffect | undefined) =>
      effect !== undefined && "seat" in effect.request ? effect.request.seat : null;
    const capturing = harness(contract({ outputSchema: { type: "object" } }));
    const [work] = capturing.step();
    expect(seatOf(work)?.canAsk).toBe(true);
    capturing.task({ kind: "complete", taskId: "t1" });
    capturing.settle("work", workReport());
    const [capture] = capturing.step();
    expect(capture?.request.kind).toBe("capture_output");
    expect(seatOf(capture)?.canAsk).toBe(false);

    const advised = harness(contract({ reviewers: [reviewer("advisor", "advisory")] }));
    workAndFreeze(advised);
    const [review] = advised.step();
    expect(seatOf(review)?.canAsk).toBe(true);
    advised.settle("review", verdictReport("pass", { advisories: [{ title: "Rename helper", description: "Clearer" }] }));
    const [advise] = advised.step();
    expect(advise?.request.kind).toBe("advise");
    expect(seatOf(advise)?.canAsk).toBe(false);
  });

  it("drains an admitted capture during pause and plans nothing until resume", () => {
    const h = harness(contract({ outputSchema: { type: "object" } }));
    h.step();
    h.task({ kind: "complete", taskId: "t1" });
    h.settle("work", workReport());
    h.step();

    h.input({ kind: "pause" });
    expect(h.progress()).toEqual({
      kind: "paused",
      next: null,
      draining: true,
    });
    h.settle("capture_output", workReport({ structuredOutput: { ok: true } }));
    expect(h.progress()).toEqual({
      kind: "paused",
      next: { kind: "running", obligation: { kind: "freeze" } },
      draining: false,
    });
  });

  it("ignores a late verdict for a superseded round", () => {
    const h = harness(
      contract({ reviewers: [reviewer("reviewer-a", "blocking")] }),
    );
    workAndFreeze(h);
    const [review] = h.step();
    h.settle("review", verdictReport("plan_defect"));
    h.input({
      kind: "disposition",
      disposition: { kind: "rereview", reason: "clarified" },
      occurrence: "occ",
      at: "t",
    });
    const before = h.facts.certification;

    if (review === undefined) throw new Error("no review planned");
    const late = advanceContext(h.facts, {
      kind: "outcome",
      cause: review.cause,
      request: review.request,
      state: { kind: "settled", outcome: verdictReport("pass") },
    });

    expect(late.certification).toEqual(before);
  });

  it("retires a changed candidate at acceptance and halts once the changes keep coming", () => {
    const h = harness(contract(), {
      ...DEFAULT_CONTEXT_POLICY,
      instabilityLimit: 2,
    });
    workAndFreeze(h, "ev-1");
    h.step();
    h.settle("accept", { kind: "candidate_changed" });
    h.step();
    h.settle("freeze", frozen("ev-2"));
    h.step();
    h.settle("accept", { kind: "candidate_changed" });

    expect(h.progress()).toMatchObject({
      kind: "halted",
      halt: "candidate_unstable",
    });
    h.input({ kind: "disposition", disposition: { kind: "continue" }, occurrence: "occ", at: "t" });
    expect(h.step()[0]?.request.kind).toBe("freeze");
  });

  it("halts on an uncertain effect until the owner records a disposition", () => {
    const h = harness(contract());
    h.step();
    h.settleUncertain("work");

    expect(h.progress()).toMatchObject({
      kind: "halted",
      halt: "effect_uncertain",
    });
    expect(() =>
      h.input({
        kind: "disposition",
        disposition: {
          kind: "grant",
          allowance: "validationRetries",
          count: 1,
          reason: "x",
        },
        occurrence: "occ",
        at: "t",
      }),
    ).toThrow(/does not clear/);
    h.input({
      kind: "disposition",
      disposition: { kind: "confirm_effect", evidence: "files inspected" },
      occurrence: "occ",
      at: "t",
    });
    expect(h.progress().kind).toBe("running");
  });

  it("reports the last allowed retry as running while it is in flight, and exhausted only once it settles", () => {
    const h = harness(contract(), { ...DEFAULT_CONTEXT_POLICY, unfinishedTaskRetries: 1 });
    h.step();
    h.settle("work", workReport());
    expect(h.step()[0]?.request).toMatchObject({ kind: "work", reason: "retry" });

    expect(h.progress(false)).toMatchObject({ kind: "running", obligation: { kind: "work", reason: "retry" } });
    expect(h.progress(true)).toMatchObject({ kind: "running", obligation: { kind: "work", reason: "retry" } });
    h.settle("work", workReport());
    expect(h.progress()).toMatchObject({ kind: "halted", halt: "retries_exhausted" });
  });

  it("reports the last allowed remediation as running while it is in flight", () => {
    const h = harness(contract({ checks: ["test"] }), {
      ...DEFAULT_CONTEXT_POLICY,
      validationRetries: 1,
    });
    workAndFreeze(h);
    h.step();
    h.settle("check", { kind: "checked", status: "failed", wroteReviewedScope: [] });
    expect(h.step()[0]?.request).toMatchObject({ kind: "work", reason: "remediate" });

    expect(h.progress()).toMatchObject({ kind: "running", obligation: { kind: "work", reason: "remediate" } });
  });

  it("recovers a refused bind: the owner's continue starts a new bind operation, and the decision is kept", () => {
    const h = unboundHarness(contract());
    const [first] = h.step();
    h.settle("bind", { kind: "refused", detail: "The worktree is missing" });
    expect(h.progress()).toMatchObject({ kind: "halted", halt: "workspace_refused" });

    h.input({ kind: "disposition", disposition: { kind: "continue" }, occurrence: "occ-1", at: "t1" });
    const [second] = h.step();
    expect(second?.request.kind).toBe("bind");
    expect(second?.cause).not.toBe(first?.cause);
    expect(h.facts.control.dispositions).toEqual([
      { occurrence: "occ-1", halt: "workspace_refused", disposition: { kind: "continue" }, at: "t1" },
    ]);
  });

  it("runs a refused acceptance check again under a new operation once the owner continues", () => {
    const h = harness(contract({ checks: ["test"] }));
    workAndFreeze(h);
    const [check] = h.step();
    expect(check?.request.kind).toBe("check");
    h.settle("check", { kind: "refused", detail: "The validation service could not start the run" });
    expect(h.progress()).toMatchObject({ kind: "halted", halt: "workspace_refused" });

    h.input({ kind: "disposition", disposition: { kind: "continue" }, occurrence: "occ-3", at: "t3" });
    const [again] = h.step();
    expect(again?.request.kind).toBe("check");
    expect(again?.cause).not.toBe(check?.cause);
  });

  it("recovers an uncertain acceptance under a new operation, keeping the owner's confirmation", () => {
    const h = harness(contract());
    workAndFreeze(h);
    const [accept] = h.step();
    expect(accept?.request.kind).toBe("accept");
    h.settleUncertain("accept");

    const confirmation = { kind: "confirm_effect" as const, evidence: "The lane holds the landing commit" };
    h.input({ kind: "disposition", disposition: confirmation, occurrence: "occ-2", at: "t2" });
    const [again] = h.step();
    expect(again?.request.kind).toBe("accept");
    expect(again?.cause).not.toBe(accept?.cause);
    expect(h.facts.control.dispositions.map((d) => d.disposition)).toEqual([confirmation]);
  });

  it("plans nothing while a failed turn's halt stands, and works again after its disposition", () => {
    const h = harness(contract());
    h.step();
    h.settle(
      "work",
      workReport({ status: "failed", failure: "provider error" }),
    );

    expect(h.progress()).toMatchObject({ kind: "halted", halt: "turn_failed" });
    expect(h.step()).toEqual([]);
    h.input({ kind: "disposition", disposition: { kind: "continue" }, occurrence: "occ", at: "t" });
    expect(h.step()[0]?.request.kind).toBe("work");
  });

  it("plans nothing once cancelled", () => {
    const h = harness(contract());
    h.input({ kind: "cancel" });
    expect(h.step()).toEqual([]);
  });

  it("stops while an admitted effect drains, then reports cancelled", () => {
    const h = harness(contract());
    h.step();
    h.input({ kind: "cancel" });

    expect(h.progress()).toEqual({ kind: "stopping" });
    h.settle("work", workReport({ status: "cancelled" }));
    expect(h.progress()).toEqual({ kind: "cancelled" });
  });

  it("refuses task additions unless the contract allows them", () => {
    const facts = initialContextFacts({
      contextId: "ctx",
      workspace: binding,
      contract: contract(),
      policy: DEFAULT_CONTEXT_POLICY,
    });
    expect(
      applyTaskCommand(facts, { kind: "add", taskId: "t2", title: "Extra" }),
    ).toMatchObject({ kind: "refused" });

    const open = initialContextFacts({
      contextId: "ctx",
      workspace: binding,
      contract: contract({ allowTaskAddition: true }),
      policy: DEFAULT_CONTEXT_POLICY,
    });
    expect(
      applyTaskCommand(open, { kind: "add", taskId: "t2", title: "Extra" }),
    ).toMatchObject({ kind: "applied" });
  });
});
