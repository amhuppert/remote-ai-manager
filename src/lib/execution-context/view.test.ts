import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_POLICY, type ContextRecord } from "./schemas";
import {
  binding,
  contract,
  harness,
  reviewer,
  seat,
  verdictReport,
  workAndFreeze,
  workReport,
} from "./testing/context-harness";
import { contextView, plannedContextView, type ContextViewInput } from "./view";

const startedAt = "2026-10-03T10:00:00.000Z";
const lastChange = "2026-10-03T10:30:00.000Z";
const none: ContextViewInput = {
  question: () => null,
  since: null,
  held: false,
  active: false,
};

/** The record a host would hold for the harness's facts. */
function recordOf(
  h: ReturnType<typeof harness>,
  occurrence = "occ-1",
): ContextRecord {
  return {
    contextId: "ctx",
    runId: "run-1",
    projectPath: "/repo",
    sessionName: "session",
    ownerConversationId: "owner-1",
    startCause: "run-1:start:ctx:0",
    workspace: binding,
    facts: h.facts,
    revision: 1,
    progress: h.progress(),
    progressOccurrence: occurrence,
    createdAt: startedAt,
    updatedAt: lastChange,
  };
}

const blocker = {
  ...reviewer("blocker", "blocking"),
  focus: "correctness",
};
const advisor = {
  ...reviewer("advisor", "advisory"),
  backend: "codex" as const,
  modelSelection: { modelId: "gpt-6", parameters: { reasoning: "xhigh" } },
};

describe("context view", () => {
  it("shows a context under review: its step, stage track, seats and each verdict of the open round", () => {
    const h = harness(
      contract({
        checks: ["typecheck"],
        implementer: {
          id: "implementer",
          ...seat,
          modelSelection: { modelId: "opus", parameters: { effort: "high" } },
        },
        reviewers: [blocker, advisor],
      }),
    );
    workAndFreeze(h);
    h.setNow("2026-10-03T10:05:00.000Z");
    h.step();
    h.settle("check", {
      kind: "checked",
      status: "passed",
      wroteReviewedScope: [],
    });
    h.step();
    h.settle(
      "review",
      verdictReport("pass", {
        advisories: [{ title: "Rename helper", description: "Clearer" }],
      }),
      1,
    );

    const view = contextView(recordOf(h), none);

    expect(view.state).toEqual({
      kind: "running",
      step: {
        kind: "review",
        round: 1,
        roundKind: "full",
        reviewersDone: 1,
        reviewersTotal: 2,
      },
    });
    expect(
      view.stages.map((stage) => [stage.key, stage.state, stage.note ?? null]),
    ).toEqual([
      ["workspace", "done", null],
      ["work", "done", null],
      ["output", "done", null],
      ["review", "current", "1 of 2"],
      ["accept", "pending", null],
    ]);
    const blockerSeat = {
      assignment: "blocker",
      role: "reviewer",
      backend: "claude",
      model: "sonnet",
      effort: null,
      profile: "general-reviewer",
      authority: "blocking",
      focus: "correctness",
    };
    const advisorSeat = {
      assignment: "advisor",
      role: "reviewer",
      backend: "codex",
      model: "gpt-6",
      effort: "xhigh",
      profile: "general-reviewer",
      authority: "advisory",
    };
    expect(view.implementer).toEqual({
      assignment: "implementer",
      role: "implementer",
      backend: "claude",
      model: "opus",
      effort: "high",
      profile: "general-reviewer",
    });
    expect(view.reviewers).toEqual([blockerSeat, advisorSeat]);
    expect(view.reviews).toEqual([
      {
        number: 1,
        kind: "full",
        outcome: "running",
        at: "2026-10-03T10:05:00.000Z",
        checks: [{ command: "typecheck", status: "passed", durationMs: null }],
        seats: [
          {
            assignment: "blocker",
            seat: blockerSeat,
            status: "pending",
            findings: [],
            advisories: [],
          },
          {
            assignment: "advisor",
            seat: advisorSeat,
            status: "pass",
            findings: [],
            advisories: [
              {
                title: "Rename helper",
                description: "Clearer",
                disposition: null,
              },
            ],
          },
        ],
      },
    ]);
    expect(view.tasks).toEqual({ done: 1, total: 1 });
    expect(view.taskList).toEqual([{ id: "t1", title: "Fix it", done: true }]);
    expect(view.criteria).toEqual([
      { id: "ac-1", text: "One notice per failure" },
    ]);
    expect(view.startedAt).toBe(startedAt);
    expect(view.approval).toBeNull();
  });

  it("shows a halt with what clears it: a grant names the allowance that ran out, used against its limit", () => {
    const h = harness(contract(), {
      ...DEFAULT_CONTEXT_POLICY,
      unfinishedTaskRetries: 1,
    });
    h.step();
    h.settle("work", workReport());
    h.step();
    h.settle("work", workReport());

    const view = contextView(recordOf(h, "occ-halt"), {
      ...none,
      since: "2026-10-03T10:20:00.000Z",
    });

    expect(view.state).toEqual({
      kind: "halted",
      halt: {
        kind: "retries_exhausted",
        detail: "Tasks remain open and no unfinished-task retries are left",
        occurrence: "occ-halt",
        at: "2026-10-03T10:20:00.000Z",
        remedies: [
          {
            kind: "grant",
            allowance: "unfinishedTaskRetries",
            used: 1,
            limit: 1,
          },
        ],
      },
    });
    expect(view.stages.map((stage) => [stage.key, stage.state])).toEqual([
      ["workspace", "done"],
      ["work", "halted"],
      ["output", "pending"],
      ["review", "skipped"],
      ["accept", "pending"],
    ]);
    expect(view.configuration.policy.unfinishedTaskRetries).toEqual({
      used: 1,
      limit: 1,
    });
  });

  it("shows a result awaiting a person's decision, then paused toward rework once rejected", () => {
    const h = harness(
      contract({
        humanApproval: true,
        outputSchema: {
          type: "object",
          properties: { files: { type: "number" } },
        },
      }),
    );
    h.step();
    h.task({ kind: "complete", taskId: "t1" });
    h.settle("work", workReport());
    h.step();
    h.settle("capture_output", workReport({ structuredOutput: { files: 2 } }));
    h.step();
    h.settle("freeze", { kind: "frozen", evidence: "ev-1" });
    const since = "2026-10-03T10:12:00.000Z";

    const awaiting = contextView(recordOf(h), { ...none, since });

    expect(awaiting.state).toEqual({
      kind: "awaiting_approval",
      requestedAt: since,
    });
    expect(awaiting.approval).toEqual({
      candidateId: "ctx:candidate:1",
      requestedAt: since,
    });
    expect(awaiting.output).toEqual({
      status: "candidate",
      value: { files: 2 },
    });
    expect(awaiting.stages.map((stage) => [stage.key, stage.state])).toEqual([
      ["workspace", "done"],
      ["work", "done"],
      ["output", "done"],
      ["review", "skipped"],
      ["approval", "waiting"],
      ["accept", "pending"],
    ]);

    h.input({ kind: "pause" });
    h.input({
      kind: "decide",
      candidateId: "ctx:candidate:1",
      decision: "rejected",
      notes: "Use the shared helper",
      decidedAt: "2026-10-03T12:00:00.000Z",
    });
    const paused = contextView(recordOf(h), none);
    expect(paused.state).toEqual({
      kind: "paused",
      next: { kind: "work", reason: "rework" },
      draining: false,
    });
    expect(paused.approval).toBeNull();
    expect(paused.decisions).toEqual([
      {
        candidateId: "ctx:candidate:1",
        decision: "rejected",
        notes: "Use the shared helper",
        decidedAt: "2026-10-03T12:00:00.000Z",
      },
    ]);
  });

  it("shows a seat's open question with its text, and the work waiting on the answer", () => {
    const h = harness(contract());
    h.step();
    h.settle("work", workReport({ openQuestionId: "q-1" }));

    const view = contextView(recordOf(h), {
      ...none,
      question: (questionId) =>
        questionId === "q-1"
          ? { text: "Which file?", askedAt: "2026-10-03T10:03:00.000Z" }
          : null,
    });

    expect(view.state).toEqual({ kind: "awaiting_answer" });
    expect(view.questions).toEqual([
      {
        questionId: "q-1",
        seat: "implementer",
        question: "Which file?",
        askedAt: "2026-10-03T10:03:00.000Z",
      },
    ]);
    expect(view.stages.find((stage) => stage.key === "work")?.state).toBe(
      "waiting",
    );
  });

  it("shows an accepted result as accepted, every stage done, and where the context works", () => {
    const h = harness(
      contract({
        outputSchema: {
          type: "object",
          properties: { files: { type: "number" } },
        },
        checks: ["typecheck"],
      }),
    );
    h.step();
    h.task({ kind: "complete", taskId: "t1" });
    h.settle("work", workReport());
    h.step();
    h.settle("capture_output", workReport({ structuredOutput: { files: 2 } }));
    h.step();
    h.settle("freeze", { kind: "frozen", evidence: "ev-1" });
    h.step();
    h.settle("check", {
      kind: "checked",
      status: "passed",
      wroteReviewedScope: [],
    });
    h.step();
    h.setNow("2026-10-03T10:07:00.000Z");
    h.settle("accept", { kind: "accepted", receipt: "r-1" });
    const record = {
      ...recordOf(h),
      workspace: {
        kind: "lane" as const,
        projectPath: "/repo",
        sessionName: "session",
        worktreePath: "/repo/.worktrees/session.api",
        branch: "csm/lane-api",
        scope: { mode: "owned" as const, paths: ["src/api"] },
      },
    };

    const view = contextView(record, none);

    // When it was accepted, however often the record changed since.
    expect(view.state).toEqual({
      kind: "succeeded",
      at: "2026-10-03T10:07:00.000Z",
    });
    expect(view.output).toEqual({ status: "accepted", value: { files: 2 } });
    expect(view.stages.every((stage) => stage.state === "done")).toBe(true);
    expect(view.reviews.map((round) => round.outcome)).toEqual(["passed"]);
    expect(view.configuration).toMatchObject({
      checks: ["typecheck"],
      scope: { mode: "owned", paths: ["src/api"] },
      worktreePath: "/repo/.worktrees/session.api",
      branch: "csm/lane-api",
    });
  });

  it("shows work that has not started from its request: its brief, seats and policy, every stage ahead", () => {
    const planned = plannedContextView({
      contextId: "run-1.docs",
      runId: "run-1",
      ownerConversationId: "owner-1",
      workspace: binding,
      contract: contract({ humanApproval: true }),
      policy: DEFAULT_CONTEXT_POLICY,
    });

    expect(planned).toMatchObject({
      title: "Fix the duplicate notice",
      brief: "Make the failure notice appear once.",
      tasks: { done: 0, total: 1 },
      taskList: [{ id: "t1", title: "Fix it", done: false }],
      humanApproval: true,
      implementer: { role: "implementer", model: "sonnet" },
      configuration: {
        branch: null,
        policy: { unfinishedTaskRetries: { used: 0, limit: 2 } },
      },
    });
    expect(planned.stages.map((stage) => [stage.key, stage.state])).toEqual([
      ["workspace", "pending"],
      ["work", "pending"],
      ["output", "pending"],
      ["review", "skipped"],
      ["approval", "pending"],
      ["accept", "pending"],
    ]);
  });

  it("places a halt on the stage of the effect that halted, not where the facts would otherwise leave it", () => {
    const track = (h: ReturnType<typeof harness>) =>
      contextView(recordOf(h), none)
        .stages.filter((stage) => stage.state !== "pending")
        .map((stage) => `${stage.key}:${stage.state}`);
    const failed = workReport({ status: "failed", failure: "provider error" });

    // The implementer's response to advice fails after a passing review.
    const advised = harness(
      contract({ reviewers: [reviewer("advisor", "blocking")] }),
    );
    workAndFreeze(advised);
    advised.step();
    advised.settle(
      "review",
      verdictReport("pass", {
        advisories: [{ title: "Rename helper", description: "Clearer" }],
      }),
    );
    advised.step();
    advised.settle("advise", failed);
    expect(track(advised)).toEqual([
      "workspace:done",
      "work:done",
      "output:done",
      "review:halted",
    ]);

    // Capturing the declared output fails once the work is done.
    const captured = harness(
      contract({
        outputSchema: { type: "object", properties: {} },
      }),
    );
    captured.step();
    captured.task({ kind: "complete", taskId: "t1" });
    captured.settle("work", workReport());
    captured.step();
    captured.settle("capture_output", failed);
    expect(track(captured)).toEqual([
      "workspace:done",
      "work:done",
      "output:halted",
      "review:skipped",
    ]);

    // Rework after a person's rejection ends uncertain.
    const reworked = harness(contract({ humanApproval: true }));
    workAndFreeze(reworked);
    reworked.input({
      kind: "decide",
      candidateId: "ctx:candidate:1",
      decision: "rejected",
      notes: "Use the shared helper",
      decidedAt: "2026-10-03T12:00:00.000Z",
    });
    reworked.step();
    reworked.settleUncertain("work");
    expect(track(reworked)).toEqual([
      "workspace:done",
      "work:halted",
      "review:skipped",
    ]);

    // Remediation after a failed blocking review ends uncertain.
    const remediated = harness(
      contract({ reviewers: [reviewer("blocker", "blocking")] }),
    );
    workAndFreeze(remediated);
    remediated.step();
    remediated.settle(
      "review",
      verdictReport("fail", {
        findings: [{ title: "Two notices", description: "Still duplicated" }],
      }),
    );
    remediated.step();
    remediated.settleUncertain("work");
    expect(track(remediated)).toEqual(["workspace:done", "work:halted"]);
  });

  it("shows work its run's pause holds as paused, finishing an admitted turn or with its next step", () => {
    const h = harness(contract());
    h.step();

    const finishing = contextView(recordOf(h), {
      ...none,
      held: true,
      active: true,
    });
    expect(finishing.state).toEqual({
      kind: "paused",
      next: { kind: "work", reason: "initial" },
      draining: true,
    });
    expect(finishing.stages.find((stage) => stage.key === "work")).toEqual({
      key: "work",
      label: "Work",
      state: "current",
      note: "paused",
    });
    expect(
      contextView(recordOf(h), { ...none, held: true }).state,
    ).toMatchObject({ kind: "paused", draining: false });

    // A person's decision is not work the pause holds back.
    const awaiting = harness(contract({ humanApproval: true }));
    workAndFreeze(awaiting);
    expect(
      contextView(recordOf(awaiting), { ...none, held: true }).state.kind,
    ).toBe("awaiting_approval");
  });

  it("tells a round's verdict from whether it can still finish", () => {
    // Cancelled while its reviewer works: the round ends without a verdict.
    const cancelled = harness(
      contract({ reviewers: [reviewer("blocker", "blocking")] }),
    );
    workAndFreeze(cancelled);
    cancelled.step();
    cancelled.input({ kind: "cancel" });
    cancelled.settle("review", workReport({ status: "cancelled" }));
    const ended = contextView(recordOf(cancelled), none);
    expect(ended.state.kind).toBe("cancelled");
    expect(ended.reviews.map((round) => round.outcome)).toEqual(["retired"]);

    // One check failed while the other still runs: failed, and still running.
    const checked = harness(contract({ checks: ["typecheck", "test"] }));
    workAndFreeze(checked);
    checked.step();
    checked.settle("check", {
      kind: "checked",
      status: "failed",
      detail: "2 errors",
      wroteReviewedScope: [],
    });
    const [round] = contextView(recordOf(checked), none).reviews;
    expect(round?.outcome).toBe("failed");
    expect(round?.checks.map((check) => [check.command, check.status])).toEqual(
      [
        ["typecheck", "failed"],
        ["test", "running"],
      ],
    );

    // One blocking reviewer failed while another still reviews: no verdict yet.
    const reviewed = harness(
      contract({
        reviewers: [
          reviewer("first", "blocking"),
          reviewer("second", "blocking"),
        ],
      }),
    );
    workAndFreeze(reviewed);
    reviewed.step();
    reviewed.settle(
      "review",
      verdictReport("fail", {
        findings: [{ title: "Two notices", description: "Still duplicated" }],
      }),
    );
    expect(
      contextView(recordOf(reviewed), none).reviews.map(
        (round) => round.outcome,
      ),
    ).toEqual(["running"]);
  });
});
