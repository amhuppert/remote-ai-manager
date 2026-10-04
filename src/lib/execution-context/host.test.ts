import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createControlPermits,
  type ControlPermits,
} from "@/lib/control/permits";
import { createIntentLedger, type IntentLedger } from "@/lib/intents/ledger";
import type { PendingIntent } from "@/lib/intents/schemas";
import {
  createFakeExecutor,
  type FakeExecutor,
} from "@/lib/intents/testing/fake-executor";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createControlPermitsRepo } from "@/lib/state-store/control-permits-repo";
import { createExecutionContextsRepo } from "@/lib/state-store/execution-contexts-repo";
import { createPendingIntentsRepo } from "@/lib/state-store/pending-intents-repo";
import { createContextHost, runControllerId, type ContextHost } from "./host";
import type { ConversationReport } from "./reports";
import { DEFAULT_CONTEXT_POLICY, contextContractSchema } from "./schemas";

const seat = {
  profile: { tier: "builtin" as const, id: "general-reviewer" },
  backend: "claude" as const,
  modelSelection: { modelId: "sonnet", parameters: {} },
};

const contract = contextContractSchema.parse({
  title: "Fix the notice",
  brief: "Make the failure notice appear once.",
  tasks: [{ id: "t1", title: "Fix it" }],
  acceptanceCriteria: [],
  outputSchema: null,
  allowTaskAddition: false,
  implementer: { id: "implementer", ...seat },
  reviewers: [],
  checks: [],
  humanApproval: false,
  ownerQuestions: true,
  documents: [],
});

const startIntent: PendingIntent = {
  id: "run-intent-1",
  requester: { kind: "run", id: "run-1" },
  executor: "context",
  cause: "run-1:start:fix:0",
  permit: null,
  request: {
    contextId: "ctx-1",
    runId: "run-1",
    ownerConversationId: "owner-1",
    workspace: {
      kind: "session",
      projectPath: "/repo",
      sessionName: "session",
      worktreePath: "/repo/.worktrees/session",
      scope: { mode: "full" },
    },
    contract,
    policy: DEFAULT_CONTEXT_POLICY,
  },
  recordedAt: "2026-10-03T10:00:00.000Z",
};

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

let fixture: PersistenceFixture;
let permits: ControlPermits;
let intents: IntentLedger;
let conversation: FakeExecutor;
let workspace: FakeExecutor;
let requests: FakeExecutor;
let touchedRuns: string[];
let released: string[];

function newHost(): ContextHost {
  return createContextHost({
    transaction: (fn) => fixture.db.transaction(fn)(),
    contexts: createExecutionContextsRepo(fixture.db),
    intents,
    permits,
    executors: { conversation, workspace, requests },
    touchRun: (runId) => touchedRuns.push(runId),
    releaseBinding: (bindingId) => released.push(bindingId),
    now: () => "2026-10-03T10:00:00.000Z",
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

beforeEach(() => {
  fixture = createPersistenceFixture();
  permits = createControlPermits(createControlPermitsRepo(fixture.db));
  intents = createIntentLedger(createPendingIntentsRepo(fixture.db));
  conversation = createFakeExecutor(permits);
  workspace = createFakeExecutor(permits);
  requests = createFakeExecutor(permits);
  touchedRuns = [];
  released = [];
  permits.issue({
    controllerId: runControllerId("run-1"),
    parent: null,
    now: "2026-10-03T10:00:00.000Z",
  });
});
afterEach(() => fixture.close());

async function startContext(host: ContextHost): Promise<PendingIntent> {
  await host.submit(startIntent);
  await host.reconcile("ctx-1");
  const [bind] = workspace.submitted();
  if (bind === undefined) throw new Error("no bind submitted");
  workspace.admit(bind.cause);
  workspace.settle(bind.cause, { kind: "bound" });
  await host.reconcile("ctx-1");
  const [work] = conversation.submitted();
  if (work === undefined) throw new Error("no work order submitted");
  return work;
}

describe("execution context host", () => {
  it("starts a context by recording its first work order under the context permit", async () => {
    const host = newHost();
    const work = await startContext(host);

    expect(work.request).toMatchObject({ kind: "work", reason: "initial" });
    expect(work.permit).toEqual({
      controllerId: "context:ctx-1",
      generation: 1,
    });
    expect(host.outcome(startIntent.cause)).toMatchObject({ kind: "running" });
  });

  it("consumes a settled outcome once and plans the next effect", async () => {
    const host = newHost();
    const work = await startContext(host);
    conversation.admit(work.cause);
    conversation.settle(work.cause, workReport());

    await host.reconcile("ctx-1");
    await host.reconcile("ctx-1");

    expect(
      intents.pending({ kind: "context", id: "ctx-1" }).map((i) => i.executor),
    ).toEqual(["conversation"]);
    expect(
      conversation
        .submitted()
        .filter(
          (i) =>
            i.request && (i.request as { reason?: string }).reason === "retry",
        ),
    ).toHaveLength(1);
    expect(touchedRuns).toContain("run-1");
  });

  it("records task commands only from this context's implementer seat, even during its first turn", async () => {
    const host = newHost();
    const work = await startContext(host);
    conversation.admit(work.cause);

    expect(
      host.applyTaskCommand("ctx-1", null, { kind: "complete", taskId: "t1" }),
    ).toMatchObject({ kind: "refused" });
    expect(
      host.applyTaskCommand(
        "ctx-1",
        { contextId: "ctx-1", assignmentId: "reviewer-a", replacement: 0 },
        { kind: "complete", taskId: "t1" },
      ),
    ).toMatchObject({ kind: "refused" });
    expect(
      host.applyTaskCommand(
        "ctx-1",
        { contextId: "ctx-2", assignmentId: "implementer", replacement: 0 },
        { kind: "complete", taskId: "t1" },
      ),
    ).toMatchObject({ kind: "refused" });
    expect(
      host.applyTaskCommand(
        "ctx-1",
        { contextId: "ctx-1", assignmentId: "implementer", replacement: 0 },
        { kind: "complete", taskId: "t1" },
      ),
    ).toMatchObject({ kind: "applied" });
  });

  it("refuses task commands from a replaced seat and once the context has finished", async () => {
    const host = newHost();
    const work = await startContext(host);
    conversation.admit(work.cause);
    const current = {
      contextId: "ctx-1",
      assignmentId: "implementer",
      replacement: 0,
    };

    expect(
      host.applyTaskCommand(
        "ctx-1",
        { ...current, replacement: 1 },
        { kind: "complete", taskId: "t1" },
      ),
    ).toMatchObject({ kind: "refused" });
    await host.cancel("ctx-1", host.observe("ctx-1")?.record.revision ?? 0);
    conversation.settle(work.cause, workReport({ status: "cancelled" }));
    await host.reconcile("ctx-1");
    expect(host.observe("ctx-1")?.record.progress).toEqual({
      kind: "cancelled",
    });
    expect(
      host.applyTaskCommand("ctx-1", current, {
        kind: "complete",
        taskId: "t1",
      }),
    ).toMatchObject({
      kind: "refused",
    });
    expect(host.observe("ctx-1")?.record.progress).toEqual({
      kind: "cancelled",
    });
  });

  it("after a restart with the run paused, consumes settled outcomes but submits nothing until resume", async () => {
    const work = await startContext(newHost());
    conversation.admit(work.cause);
    newHost().applyTaskCommand(
      "ctx-1",
      { contextId: "ctx-1", assignmentId: "implementer", replacement: 0 },
      { kind: "complete", taskId: "t1" },
    );
    conversation.settle(work.cause, workReport());
    permits.close(runControllerId("run-1"), "2026-10-03T10:05:00.000Z");

    const restarted = newHost();
    await restarted.reconcile("ctx-1");

    expect(intents.pending({ kind: "context", id: "ctx-1" })).toEqual([]);
    expect(
      restarted.observe("ctx-1")?.record.facts.ledger.settledWorkTurns,
    ).toBe(1);
    expect(
      workspace.submitted().map((i) => (i.request as { kind: string }).kind),
    ).toEqual(["bind"]);

    permits.reopen(runControllerId("run-1"), "2026-10-03T10:06:00.000Z");
    await restarted.reconcile("ctx-1");
    expect(
      workspace.submitted().map((i) => (i.request as { kind: string }).kind),
    ).toEqual(["bind", "freeze"]);
  });

  it("shows a settled but unconsumed outcome as stalled until reconcile consumes it", async () => {
    const host = newHost();
    const work = await startContext(host);
    conversation.admit(work.cause);
    conversation.settle(work.cause, workReport());

    expect(host.observe("ctx-1")?.stalled).toEqual([work.cause]);
    await host.reconcile("ctx-1");
    expect(host.observe("ctx-1")?.stalled).toEqual([]);
  });

  it("keeps a queued work order unadmitted while paused and resubmits it under the new generation on resume", async () => {
    const host = newHost();
    const work = await startContext(host);
    const revision = host.observe("ctx-1")?.record.revision ?? 0;

    host.pause("ctx-1", revision);
    expect(conversation.admit(work.cause)).toBe(false);

    host.resume("ctx-1", host.observe("ctx-1")?.record.revision ?? 0);
    await host.reconcile("ctx-1");

    expect(conversation.operation(work.cause)?.intent.permit).toEqual({
      controllerId: "context:ctx-1",
      generation: 2,
    });
    expect(conversation.admit(work.cause)).toBe(true);
  });

  it("withdraws queued effects and interrupts admitted ones on cancel", async () => {
    const host = newHost();
    const work = await startContext(host);
    conversation.admit(work.cause);

    await host.cancel("ctx-1", host.observe("ctx-1")?.record.revision ?? 0);
    expect(conversation.interrupted).toEqual([work.cause]);
    expect(host.observe("ctx-1")?.record.progress).toEqual({
      kind: "stopping",
    });

    conversation.settle(work.cause, workReport({ status: "cancelled" }));
    await host.reconcile("ctx-1");
    expect(host.observe("ctx-1")?.record.progress).toEqual({
      kind: "cancelled",
    });
    expect(host.outcome(startIntent.cause)).toMatchObject({ kind: "settled" });
  });

  it("releases its workspace binding once, when it is cancelled", async () => {
    const host = newHost();
    const work = await startContext(host);
    conversation.admit(work.cause);
    await host.cancel("ctx-1", host.observe("ctx-1")?.record.revision ?? 0);
    expect(released).toEqual([]);

    conversation.settle(work.cause, workReport({ status: "cancelled" }));
    await host.reconcile("ctx-1");
    await host.reconcile("ctx-1");
    expect(released).toEqual(["ctx-1"]);
    expect(host.observe("ctx-1")?.record.facts.binding.released).toBe(true);
  });

  it("releases its workspace binding when it succeeds, and keeps it while halted", async () => {
    const host = newHost();
    const work = await startContext(host);
    conversation.admit(work.cause);
    conversation.settle(
      work.cause,
      workReport({ status: "failed", failure: "provider error" }),
    );
    await host.reconcile("ctx-1");
    expect(host.observe("ctx-1")?.record.progress.kind).toBe("halted");
    expect(released).toEqual([]);

    const occurrence = host.observe("ctx-1")?.record.progressOccurrence ?? "";
    host.resume("ctx-1", host.observe("ctx-1")?.record.revision ?? 0, {
      occurrence,
      disposition: { kind: "continue" },
    });
    await host.reconcile("ctx-1");
    const retry = conversation.submitted().find((i) => i.cause !== work.cause);
    if (retry === undefined) throw new Error("no continued work");
    conversation.admit(retry.cause);
    host.applyTaskCommand(
      "ctx-1",
      { contextId: "ctx-1", assignmentId: "implementer", replacement: 0 },
      { kind: "complete", taskId: "t1" },
    );
    conversation.settle(retry.cause, workReport());
    await host.reconcile("ctx-1");
    const freeze = workspace
      .submitted()
      .find((i) => (i.request as { kind: string }).kind === "freeze");
    if (freeze === undefined) throw new Error("no freeze");
    workspace.admit(freeze.cause);
    workspace.settle(freeze.cause, { kind: "frozen", evidence: "git:a:a" });
    await host.reconcile("ctx-1");
    const accept = workspace
      .submitted()
      .find((i) => (i.request as { kind: string }).kind === "accept");
    if (accept === undefined) throw new Error("no accept");
    workspace.admit(accept.cause);
    workspace.settle(accept.cause, {
      kind: "accepted",
      receipt: "snapshot:git:a:a",
    });
    await host.reconcile("ctx-1");

    expect(host.observe("ctx-1")?.record.progress.kind).toBe("succeeded");
    expect(released).toEqual(["ctx-1"]);
  });

  it("describes a context by its state rather than its records: activity, halt dispositions and the accepted result", async () => {
    const host = newHost();
    const work = await startContext(host);
    expect(host.describe("ctx-1")).toMatchObject({ active: false, accepted: null, title: "Fix the notice" });

    conversation.admit(work.cause);
    expect(host.describe("ctx-1")).toMatchObject({ active: true, progress: { kind: "running" } });

    conversation.settle(work.cause, workReport({ status: "failed", failure: "provider error" }));
    await host.reconcile("ctx-1");
    const halted = host.describe("ctx-1");
    expect(halted).toMatchObject({ active: false, progress: { kind: "halted", halt: "turn_failed" } });
    expect(halted?.dispositions).toContain("continue");
    expect(halted?.tasks).toEqual([{ id: "t1", title: "Fix it", status: "open" }]);

    host.resume("ctx-1", halted?.revision ?? 0, { occurrence: halted?.occurrence ?? "", disposition: { kind: "continue" } });
    await host.reconcile("ctx-1");
    const retry = conversation.submitted().find((i) => i.cause !== work.cause);
    if (retry === undefined) throw new Error("no continued work");
    host.applyTaskCommand("ctx-1", { contextId: "ctx-1", assignmentId: "implementer", replacement: 0 }, { kind: "complete", taskId: "t1" });
    conversation.settle(retry.cause, workReport({ finalText: "Fixed." }));
    await host.reconcile("ctx-1");
    for (const kind of ["freeze", "accept"]) {
      const op = workspace.submitted().find((i) => (i.request as { kind: string }).kind === kind);
      if (op === undefined) throw new Error(`no ${kind}`);
      workspace.settle(op.cause, kind === "freeze" ? { kind: "frozen", evidence: "git:a:a" } : { kind: "accepted", receipt: "snapshot:git:a:a" });
      await host.reconcile("ctx-1");
    }
    expect(host.describe("ctx-1")).toMatchObject({
      progress: { kind: "succeeded" },
      accepted: { output: { summary: "Fixed." } },
      dispositions: [],
      lastSummary: "Fixed.",
    });
  });

  it("does not count a question waiting on its owner as admitted activity", async () => {
    const host = newHost();
    const work = await startContext(host);
    conversation.settle(work.cause, workReport({ openQuestionId: "q-1" }));
    await host.reconcile("ctx-1");
    const answer = requests.submitted()[0];
    if (answer === undefined) throw new Error("no answer request");
    expect(requests.admit(answer.cause)).toBe(true);

    expect(host.describe("ctx-1")).toMatchObject({
      progress: { kind: "waiting", obligation: { kind: "await_answer" } },
      active: false,
    });
  });

  it("tells its Run whenever it consumes an outcome, even one that leaves its progress as it was", async () => {
    const host = newHost();
    const reviewed = contextContractSchema.parse({
      ...contract,
      reviewers: [
        { id: "reviewer-a", authority: "blocking", ...seat },
        { id: "reviewer-b", authority: "blocking", ...seat },
      ],
    });
    const request = startIntent.request as Record<string, unknown>;
    await host.submit({ ...startIntent, request: { ...request, contract: reviewed } });
    await host.reconcile("ctx-1");
    const [bind] = workspace.submitted();
    if (bind === undefined) throw new Error("no bind");
    workspace.settle(bind.cause, { kind: "bound" });
    await host.reconcile("ctx-1");
    const [work] = conversation.submitted();
    if (work === undefined) throw new Error("no work order");
    host.applyTaskCommand("ctx-1", { contextId: "ctx-1", assignmentId: "implementer", replacement: 0 }, { kind: "complete", taskId: "t1" });
    conversation.settle(work.cause, workReport());
    await host.reconcile("ctx-1");
    const freeze = workspace.submitted().find((i) => (i.request as { kind: string }).kind === "freeze");
    if (freeze === undefined) throw new Error("no freeze");
    workspace.settle(freeze.cause, { kind: "frozen", evidence: "git:a:a" });
    await host.reconcile("ctx-1");
    const reviewA = conversation.submitted().find(
      (i) => (i.request as { kind: string; seat?: { assignmentId: string } }).seat?.assignmentId === "reviewer-a",
    );
    if (reviewA === undefined) throw new Error("no review by reviewer-a");
    const occurrence = host.describe("ctx-1")?.occurrence;

    touchedRuns.length = 0;
    conversation.settle(reviewA.cause, workReport({ structuredOutput: { verdict: "pass", findings: [], advisories: [] } }));
    await host.reconcile("ctx-1");

    expect(host.describe("ctx-1")?.occurrence).toBe(occurrence);
    expect(touchedRuns).toEqual(["run-1"]);
  });

  it("asks a reviewer seat for its review once the candidate is frozen", async () => {
    const host = newHost();
    const reviewed = contextContractSchema.parse({
      ...contract,
      reviewers: [{ id: "reviewer-a", authority: "blocking", ...seat }],
    });
    const request = startIntent.request as Record<string, unknown>;
    await host.submit({ ...startIntent, request: { ...request, contract: reviewed } });
    await host.reconcile("ctx-1");
    const [bind] = workspace.submitted();
    if (bind === undefined) throw new Error("no bind");
    workspace.settle(bind.cause, { kind: "bound" });
    await host.reconcile("ctx-1");
    const [work] = conversation.submitted();
    if (work === undefined) throw new Error("no work order");
    host.applyTaskCommand(
      "ctx-1",
      { contextId: "ctx-1", assignmentId: "implementer", replacement: 0 },
      { kind: "complete", taskId: "t1" },
    );
    conversation.settle(work.cause, workReport());
    await host.reconcile("ctx-1");
    const freeze = workspace
      .submitted()
      .find((i) => (i.request as { kind: string }).kind === "freeze");
    if (freeze === undefined) throw new Error("no freeze");
    workspace.settle(freeze.cause, { kind: "frozen", evidence: "git:a:a" });
    await host.reconcile("ctx-1");

    expect(host.observe("ctx-1")?.record.progress).toMatchObject({
      kind: "running",
      obligation: { kind: "certify" },
    });
    const review = conversation
      .submitted()
      .find((i) => (i.request as { kind: string }).kind === "review");
    expect(review?.request).toMatchObject({
      seat: { assignmentId: "reviewer-a", role: "reviewer" },
    });
  });

  it("requires a disposition naming the current occurrence to resume a halted context", async () => {
    const host = newHost();
    const work = await startContext(host);
    conversation.admit(work.cause);
    conversation.settleUncertain(work.cause, "process exited mid-turn");
    await host.reconcile("ctx-1");
    const record = host.observe("ctx-1")?.record;
    if (record === undefined) throw new Error("missing context");
    expect(record.progress).toMatchObject({
      kind: "halted",
      halt: "effect_uncertain",
    });

    expect(() => host.resume("ctx-1", record.revision)).toThrow(
      /needs a disposition/,
    );
    expect(() =>
      host.resume("ctx-1", record.revision, {
        occurrence: "stale-occurrence",
        disposition: { kind: "confirm_effect", evidence: "checked" },
      }),
    ).toThrow(/names occurrence/);

    host.resume("ctx-1", record.revision, {
      occurrence: record.progressOccurrence,
      disposition: { kind: "confirm_effect", evidence: "checked the worktree" },
    });
    expect(host.observe("ctx-1")?.record.progress.kind).toBe("running");
  });

  it("halts visibly and keeps the intent open when an outcome cannot be consumed", async () => {
    const host = newHost();
    const work = await startContext(host);
    conversation.admit(work.cause);
    conversation.settle(work.cause, { malformed: true });

    await expect(host.reconcile("ctx-1")).rejects.toThrow();
    host.recordReconcileFailure("ctx-1", new Error("malformed outcome"));

    expect(host.observe("ctx-1")?.record.progress).toMatchObject({
      kind: "halted",
      halt: "reconcile_failed",
    });
    expect(
      intents.pending({ kind: "context", id: "ctx-1" }).map((i) => i.cause),
    ).toEqual([work.cause]);
  });
});
