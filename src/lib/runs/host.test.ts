import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createControlPermits,
  type ControlPermits,
} from "@/lib/control/permits";
import {
  createContextHost,
  type ContextHost,
} from "@/lib/execution-context/host";
import {
  DEFAULT_CONTEXT_POLICY,
  contextContractSchema,
  type ContextStartRequest,
} from "@/lib/execution-context/schemas";
import { createIntentLedger, type IntentLedger } from "@/lib/intents/ledger";
import {
  createReconcileScheduler,
  type ReconcileScheduler,
} from "@/lib/intents/reconcile-scheduler";
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
import { createRunsRepo } from "@/lib/state-store/runs-repo";
import { createRunHost, type RunHost } from "./host";
import type { RunBoundary } from "./schemas";

const now = "2026-10-03T10:00:00.000Z";
const silent = { info: () => {}, warn: () => {}, error: () => {} };

let fixture: PersistenceFixture;
let permits: ControlPermits;
let intents: IntentLedger;
let scheduler: ReconcileScheduler;
let conversation: FakeExecutor;
let workspace: FakeExecutor;
let requests: FakeExecutor;
let contexts: ContextHost;
let runs: RunHost;
let notified: RunBoundary[];
/** Lets a test make delivery fail or stall; the default delivers at once. */
let deliver: (boundary: RunBoundary) => Promise<void>;
/** Drops Context submissions, as a crash between recording a start and submitting it would. */
let dropContextSubmits: boolean;
/** Runs as each Context submission begins. */
let beforeContextSubmit: () => void;
/** Makes reading a Context fail, as unreadable stored data would. */
let contextsUnreadable: boolean;

const seat = {
  profile: { tier: "builtin" as const, id: "standard-agent" },
  backend: "claude" as const,
  modelSelection: { modelId: "sonnet", parameters: {} },
};

function startRequest(
  contextId: string,
  humanApproval = false,
  title = "Fix the notice",
  outputSchema: Record<string, unknown> | null = null,
): ContextStartRequest {
  return {
    contextId,
    runId: "run-1",
    ownerConversationId: "owner-1",
    workspace: {
      kind: "session",
      projectPath: "/repo",
      sessionName: "session",
      worktreePath: "/repo/.worktrees/session",
      scope: { mode: "full" },
    },
    contract: contextContractSchema.parse({
      title,
      brief: "Make the failure notice appear once.",
      tasks: [],
      acceptanceCriteria: [],
      outputSchema,
      allowTaskAddition: false,
      implementer: { id: "implementer", ...seat },
      reviewers: [],
      checks: [],
      humanApproval,
      ownerQuestions: true,
      documents: [],
    }),
    policy: DEFAULT_CONTEXT_POLICY,
  };
}

const report = (overrides: Record<string, unknown> = {}) => ({
  status: "succeeded",
  conversationId: "conv-impl",
  finalText: "Done.",
  structuredOutput: null,
  outputIssue: null,
  openQuestionId: null,
  failure: null,
  ...overrides,
});

beforeEach(() => {
  fixture = createPersistenceFixture();
  const transaction = <T>(fn: () => T): T => fixture.db.transaction(fn)();
  permits = createControlPermits(createControlPermitsRepo(fixture.db));
  intents = createIntentLedger(createPendingIntentsRepo(fixture.db));
  scheduler = createReconcileScheduler();
  conversation = createFakeExecutor(permits);
  workspace = createFakeExecutor(permits);
  requests = createFakeExecutor(permits);
  notified = [];
  deliver = async () => {};
  dropContextSubmits = false;
  beforeContextSubmit = () => {};
  contextsUnreadable = false;
  contexts = createContextHost({
    transaction,
    contexts: createExecutionContextsRepo(fixture.db),
    intents,
    permits,
    executors: { conversation, workspace, requests },
    touchRun: (runId) => scheduler.touch({ kind: "run", id: runId }),
    releaseBinding: () => {},
    now: () => now,
    log: silent,
  });
  const contextHost = contexts;
  runs = createRunHost({
    transaction,
    runs: createRunsRepo(fixture.db),
    intents,
    permits,
    contexts: {
      ...contextHost,
      describe(contextId) {
        if (contextsUnreadable) throw new Error(`Context ${contextId} could not be read`);
        return contextHost.describe(contextId);
      },
      outcome(cause) {
        if (contextsUnreadable) throw new Error(`Context for ${cause} could not be read`);
        return contextHost.outcome(cause);
      },
      async submit(intent) {
        beforeContextSubmit();
        if (dropContextSubmits) return;
        await contextHost.submit(intent);
      },
    },
    touchContext: (contextId) =>
      scheduler.touch({ kind: "context", id: contextId }),
    async notifyOwner({ boundary }) {
      await deliver(boundary);
      notified.push(boundary);
    },
    now: () => now,
    log: silent,
  });
  scheduler.register("context", {
    reconcile: (id) => contexts.reconcile(id),
    onFailure: (id, error) => contexts.recordReconcileFailure(id, error),
  });
  scheduler.register("run", {
    reconcile: (id) => runs.reconcile(id),
    onFailure: (id, error) => runs.recordReconcileFailure(id, error),
  });
});
afterEach(async () => {
  await scheduler.idle();
  fixture.close();
});

/** Settles the single pending operation of `executor` and lets reconciles run. */
async function settle(
  executor: FakeExecutor,
  kind: string,
  outcome: unknown,
): Promise<void> {
  await scheduler.idle();
  const op = executor
    .submitted()
    .find(
      (i) =>
        (i.request as { kind?: string }).kind === kind &&
        executor.outcome(i.cause).kind !== "settled",
    );
  if (op === undefined) throw new Error(`No pending ${kind}`);
  executor.admit(op.cause);
  executor.settle(op.cause, outcome);
  scheduler.touch(op.requester);
  await scheduler.idle();
}

async function launch(humanApproval = false): Promise<void> {
  await runs.launch({
    runId: "run-1",
    cause: "launch-1",
    kind: "agent",
    title: "Fix the notice",
    projectPath: "/repo",
    sessionName: "session",
    owner: { conversationId: "owner-1", sessionName: "session" },
    contexts: [
      {
        key: "agent",
        dependsOn: [],
        request: startRequest("run-1.agent", humanApproval),
      },
    ],
  });
  await scheduler.idle();
}

/** api builds first; docs builds on its accepted result. */
async function launchChain(): Promise<void> {
  await runs.launch({
    runId: "run-1",
    cause: "launch-1",
    kind: "workflow",
    title: "API then docs",
    projectPath: "/repo",
    sessionName: "session",
    owner: { conversationId: "owner-1", sessionName: "session" },
    contexts: [
      {
        key: "api",
        dependsOn: [],
        request: startRequest("run-1.api", false, "Build the API"),
      },
      {
        key: "docs",
        dependsOn: ["api"],
        request: startRequest("run-1.docs", false, "Document the API"),
      },
    ],
  });
  await scheduler.idle();
}

/** Drives the single active context through bind, work, freeze and accept. */
async function succeedActiveContext(summary: string): Promise<void> {
  await settle(workspace, "bind", { kind: "bound" });
  await settle(conversation, "work", report({ finalText: summary }));
  await settle(workspace, "freeze", { kind: "frozen", evidence: `git:${summary}` });
  await settle(workspace, "accept", {
    kind: "accepted",
    receipt: `snapshot:${summary}`,
  });
}

/** Settles the pending operation of `kind` one context requested, when several contexts run. */
async function settleFor(
  contextId: string,
  executor: FakeExecutor,
  kind: string,
  outcome: unknown,
): Promise<void> {
  await scheduler.idle();
  const op = executor
    .submitted()
    .find(
      (i) =>
        i.requester.id === contextId &&
        (i.request as { kind?: string }).kind === kind &&
        executor.outcome(i.cause).kind !== "settled",
    );
  if (op === undefined) throw new Error(`No pending ${kind} for ${contextId}`);
  executor.admit(op.cause);
  executor.settle(op.cause, outcome);
  scheduler.touch(op.requester);
  await scheduler.idle();
}

/** Drives the single active context with an output schema through work, capture and acceptance. */
async function succeedWithOutput(output: Record<string, unknown>): Promise<void> {
  await settle(workspace, "bind", { kind: "bound" });
  await settle(conversation, "work", report());
  await settle(conversation, "capture_output", report({ structuredOutput: output }));
  await settle(workspace, "freeze", { kind: "frozen", evidence: `git:${JSON.stringify(output)}` });
  await settle(workspace, "accept", { kind: "accepted", receipt: "snapshot" });
}

const verdictSchema = {
  type: "object",
  properties: { approved: { type: "boolean" } },
  required: ["approved"],
};

describe("routes and loops", () => {
  it("runs a loop's body again in fresh Contexts until its exit condition holds, then starts what follows with the final result", async () => {
    await runs.launch({
      runId: "run-1",
      cause: "launch-1",
      kind: "workflow",
      title: "Polish",
      projectPath: "/repo",
      sessionName: "session",
      owner: { conversationId: "owner-1", sessionName: "session" },
      contexts: [
        { key: "implement", dependsOn: [], request: startRequest("run-1.implement", false, "Implement") },
        {
          key: "review",
          dependsOn: ["implement"],
          request: startRequest("run-1.review", false, "Review", verdictSchema),
        },
        { key: "ship", dependsOn: ["review"], request: startRequest("run-1.ship", false, "Ship") },
      ],
      loops: [
        {
          key: "polish",
          body: ["implement", "review"],
          entry: "implement",
          exit: "review",
          until: { schema: { type: "object", properties: { approved: { const: true } } } },
          maxPasses: 2,
        },
      ],
    });
    await scheduler.idle();

    await succeedActiveContext("First try.");
    await succeedWithOutput({ approved: false });
    expect(contexts.observe("run-1.ship")).toBeNull();
    expect(contexts.observe("run-1.implement.pass2")?.record.facts.contract.current.inputs).toEqual([
      { key: "review", title: "Review (pass 1)", output: { approved: false } },
    ]);

    await succeedActiveContext("Second try.");
    expect(contexts.observe("run-1.review.pass2")?.record.facts.contract.current.inputs).toEqual([
      { key: "implement", title: "Implement", output: { summary: "Second try." } },
    ]);
    await succeedWithOutput({ approved: true });
    expect(contexts.observe("run-1.ship")?.record.facts.contract.current.inputs).toEqual([
      { key: "review", title: "Review", output: { approved: true } },
    ]);
    expect(runs.observe("run-1")?.record.facts.invocations.map((i) => i.startCause)).toEqual([
      "run-1:start:implement:0",
      "run-1:start:review:0",
      "run-1:start:implement:1",
      "run-1:start:review:1",
      "run-1:start:ship:0",
    ]);

    await succeedActiveContext("Shipped.");
    expect(runs.observe("run-1")?.record.progress).toEqual({ kind: "succeeded" });
    expect(notified.map((b) => [b.kind, b.detail])).toEqual([
      [
        "succeeded",
        {
          outputs: {
            implement: { summary: "Second try." },
            review: { approved: true },
            ship: { summary: "Shipped." },
          },
        },
      ],
    ]);
  });

  it("tells the owner at once when a choice takes too many routes, and once more when only the halt remains", async () => {
    const takesBoth = { schema: { type: "object", properties: { approved: { const: false } } } };
    await runs.launch({
      runId: "run-1",
      cause: "launch-1",
      kind: "workflow",
      title: "Routed",
      projectPath: "/repo",
      sessionName: "session",
      owner: { conversationId: "owner-1", sessionName: "session" },
      contexts: [
        {
          key: "triage",
          dependsOn: [],
          routing: { cardinality: "exactlyOne" },
          request: startRequest("run-1.triage", false, "Triage", verdictSchema),
        },
        { key: "fix", dependsOn: ["triage"], when: { triage: takesBoth }, request: startRequest("run-1.fix", false, "Fix") },
        { key: "ship", dependsOn: ["triage"], when: { triage: takesBoth }, request: startRequest("run-1.ship", false, "Ship") },
        { key: "docs", dependsOn: [], request: startRequest("run-1.docs", false, "Docs") },
      ],
    });
    await scheduler.idle();
    await settleFor("run-1.triage", workspace, "bind", { kind: "bound" });
    await settleFor("run-1.triage", conversation, "work", report());
    await settleFor("run-1.triage", conversation, "capture_output", report({ structuredOutput: { approved: false } }));
    await settleFor("run-1.triage", workspace, "freeze", { kind: "frozen", evidence: "git:triage" });
    await settleFor("run-1.triage", workspace, "accept", { kind: "accepted", receipt: "snapshot:triage" });

    expect(contexts.observe("run-1.fix")).toBeNull();
    expect(contexts.observe("run-1.ship")).toBeNull();
    expect(runs.observe("run-1")?.record.progress).toEqual({ kind: "running" });
    const promised = ["halted", "route:triage:cardinality", { runHalt: "route_cardinality", otherWorkRemains: true }];
    expect(notified.map((b) => [b.kind, b.occurrence, b.detail])).toEqual([promised]);

    // Work that waits on the owner is not finished: the follow-up waits for it.
    await settleFor("run-1.docs", workspace, "bind", { kind: "bound" });
    await settleFor("run-1.docs", conversation, "work", report({ openQuestionId: "q-1" }));
    expect(runs.observe("run-1")?.record.progress.kind).toBe("needs_owner");
    expect(notified.map((b) => b.kind)).toEqual(["halted", "question"]);

    await settleFor("run-1.docs", requests, "answer", { kind: "answered", question: "Which?", answer: "This." });
    await settleFor("run-1.docs", conversation, "work", report({ finalText: "Docs." }));
    await settleFor("run-1.docs", workspace, "freeze", { kind: "frozen", evidence: "git:docs" });
    await settleFor("run-1.docs", workspace, "accept", { kind: "accepted", receipt: "snapshot:docs" });

    expect(runs.observe("run-1")?.record.progress.kind).toBe("needs_owner");
    expect(notified.map((b) => [b.kind, b.occurrence, b.detail])).toEqual([
      promised,
      ["question", expect.any(String), expect.anything()],
      ["halted", "run:stalled:route:triage:cardinality", { runHalt: "stalled", otherWorkRemains: false }],
    ]);
    await runs.reconcile("run-1");
    expect(notified).toHaveLength(3);
  });
});

describe("workflow runs", () => {
  it("starts a dependent context only after its dependency succeeded, with the accepted result as its input", async () => {
    await launchChain();
    expect(contexts.observe("run-1.docs")).toBeNull();

    await succeedActiveContext("API built.");
    const docs = contexts.observe("run-1.docs")?.record;
    expect(docs?.facts.contract.current.inputs).toEqual([
      { key: "api", title: "Build the API", output: { summary: "API built." } },
    ]);
    expect(runs.observe("run-1")?.record.progress).toEqual({ kind: "running" });
    expect(notified).toEqual([]);

    await succeedActiveContext("Docs written.");
    expect(runs.observe("run-1")?.record.progress).toEqual({ kind: "succeeded" });
    expect(notified.map((b) => [b.kind, b.detail])).toEqual([
      [
        "succeeded",
        {
          outputs: {
            api: { summary: "API built." },
            docs: { summary: "Docs written." },
          },
        },
      ],
    ]);
  });

  it("leaves dependents of a halted context unstarted and asks the owner", async () => {
    await launchChain();
    await settle(workspace, "bind", { kind: "bound" });
    await settle(
      conversation,
      "work",
      report({ status: "failed", failure: "The provider failed." }),
    );

    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "needs_owner",
      reasons: ["api: halted (turn_failed)"],
    });
    expect(contexts.observe("run-1.docs")).toBeNull();
    expect(notified.map((b) => b.kind)).toEqual(["halted"]);
  });

  it("holds a context that became eligible during a pause until resume", async () => {
    await launchChain();
    await settle(workspace, "bind", { kind: "bound" });
    await settle(conversation, "work", report({ finalText: "API built." }));
    await settle(workspace, "freeze", { kind: "frozen", evidence: "git:api" });
    const accept = workspace
      .submitted()
      .find((i) => (i.request as { kind?: string }).kind === "accept");
    if (accept === undefined) throw new Error("no accept");
    expect(workspace.admit(accept.cause)).toBe(true);
    await runs.pause("run-1", null);
    workspace.settle(accept.cause, { kind: "accepted", receipt: "snapshot:api" });
    scheduler.touch(accept.requester);
    await scheduler.idle();

    expect(contexts.observe("run-1.api")?.record.progress.kind).toBe("succeeded");
    expect(contexts.observe("run-1.docs")).toBeNull();
    expect(runs.observe("run-1")?.record.progress.kind).toBe("paused");

    await runs.resume("run-1", null);
    await scheduler.idle();
    expect(contexts.observe("run-1.docs")?.record.facts.contract.current.inputs).toEqual([
      { key: "api", title: "Build the API", output: { summary: "API built." } },
    ]);
  });

  it("restores a workflow paused after a restart and starts its waiting context only once resumed", async () => {
    await launchChain();
    await settle(workspace, "bind", { kind: "bound" });
    await settle(conversation, "work", report({ finalText: "API built." }));
    await settle(workspace, "freeze", { kind: "frozen", evidence: "git:api" });
    const accept = workspace
      .submitted()
      .find((i) => (i.request as { kind?: string }).kind === "accept");
    if (accept === undefined) throw new Error("no accept");
    expect(workspace.admit(accept.cause)).toBe(true);

    await runs.restoreAfterRestart();
    workspace.settle(accept.cause, { kind: "accepted", receipt: "snapshot:api" });
    scheduler.touch(accept.requester);
    await scheduler.idle();
    expect(contexts.observe("run-1.api")?.record.progress.kind).toBe("succeeded");
    expect(contexts.observe("run-1.docs")).toBeNull();
    expect(notified.map((b) => b.kind)).toEqual(["restored_paused"]);

    await runs.resume("run-1", null);
    await scheduler.idle();
    expect(contexts.observe("run-1.docs")?.record.facts.contract.current.inputs).toEqual([
      { key: "api", title: "Build the API", output: { summary: "API built." } },
    ]);
  });

  it("stops submitting starts once a pause lands between two of them", async () => {
    let paused = false;
    beforeContextSubmit = () => {
      if (paused) return;
      paused = true;
      void runs.pause("run-1", null);
    };
    await runs.launch({
      runId: "run-1",
      cause: "launch-1",
      kind: "workflow",
      title: "Two roots",
      projectPath: "/repo",
      sessionName: "session",
      owner: { conversationId: "owner-1", sessionName: "session" },
      contexts: [
        { key: "a", dependsOn: [], request: startRequest("run-1.a", false, "A") },
        { key: "b", dependsOn: [], request: startRequest("run-1.b", false, "B") },
      ],
    });
    await scheduler.idle();

    expect([contexts.observe("run-1.a"), contexts.observe("run-1.b")].filter((c) => c !== null)).toHaveLength(1);

    await runs.resume("run-1", null);
    await scheduler.idle();
    expect(contexts.observe("run-1.b")).not.toBeNull();
  });

  it("finishes cancelling a context whose start was recorded but never reached its host", async () => {
    dropContextSubmits = true;
    await launchChain();
    expect(contexts.observe("run-1.api")).toBeNull();
    expect(runs.observe("run-1")?.record.progress).toEqual({ kind: "running" });

    await runs.cancel("run-1", null);
    await scheduler.idle();

    expect(runs.observe("run-1")?.record.progress).toEqual({ kind: "cancelled" });
    expect(intents.pending({ kind: "run", id: "run-1" })).toEqual([]);
    expect(notified.map((b) => b.kind)).toEqual(["cancelled"]);
  });

  it("cancels what started and never starts the rest", async () => {
    await launchChain();
    await settle(workspace, "bind", { kind: "bound" });
    await runs.cancel("run-1", null);
    await scheduler.idle();

    expect(contexts.observe("run-1.api")?.record.progress.kind).toBe("cancelled");
    expect(contexts.observe("run-1.docs")).toBeNull();
    expect(runs.observe("run-1")?.record.progress).toEqual({ kind: "cancelled" });
  });
});

describe("run host", () => {
  it("runs a standalone context to success and tells the owner once, with its result", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    await settle(conversation, "work", report());
    await settle(workspace, "freeze", { kind: "frozen", evidence: "git:a:a" });
    await settle(workspace, "accept", {
      kind: "accepted",
      receipt: "snapshot:git:a:a",
    });

    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "succeeded",
    });
    expect(notified.map((b) => b.kind)).toEqual(["succeeded"]);
    expect(notified[0]?.detail).toEqual({
      outputs: { agent: { summary: "Done." } },
    });
    await runs.reconcile("run-1");
    expect(notified).toHaveLength(1);
  });

  it("asks the owner a child's question and continues once it is answered", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    await settle(conversation, "work", report({ openQuestionId: "q-1" }));

    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "needs_owner",
      reasons: ["agent: question"],
    });
    expect(notified.map((b) => [b.kind, b.detail])).toEqual([
      ["question", { contextId: "run-1.agent", questionId: "q-1" }],
    ]);

    await settle(requests, "answer", {
      kind: "answered",
      question: "Which file?",
      answer: "notice.ts",
    });
    expect(
      conversation
        .submitted()
        .map((i) => (i.request as { reason?: string }).reason),
    ).toEqual(["initial", "continue"]);
  });

  it("reports a paused run as draining while a child's admitted turn runs, and drained once it settles", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    const work = conversation.submitted()[0];
    if (work === undefined) throw new Error("no work order");
    expect(conversation.admit(work.cause)).toBe(true);
    await runs.pause("run-1", null);
    expect(runs.observe("run-1")?.record.progress).toEqual({ kind: "paused", draining: true });

    conversation.settle(work.cause, report());
    scheduler.touch(work.requester);
    await scheduler.idle();
    expect(runs.observe("run-1")?.record.progress).toEqual({ kind: "paused", draining: false });
  });

  it("reads a run for its owner without reading its Contexts, even with a start still pending", async () => {
    dropContextSubmits = true;
    await launch();
    contextsUnreadable = true;
    expect(runs.observe("run-1")?.record.runId).toBe("run-1");
    contextsUnreadable = false;
  });

  it("records a run's fault even when its contexts cannot be read", async () => {
    await launch();
    contextsUnreadable = true;
    runs.recordReconcileFailure("run-1", new Error("Context run-1.agent could not be read"));

    const record = runs.observe("run-1")?.record;
    expect(record?.facts.control.fault?.detail).toBe("Context run-1.agent could not be read");
    expect(record?.progress).toEqual({ kind: "needs_owner", reasons: ["run: Context run-1.agent could not be read"] });
    const bind = workspace.submitted()[0];
    if (bind === undefined) throw new Error("no bind");
    expect(workspace.admit(bind.cause)).toBe(false);
    contextsUnreadable = false;
  });

  it("stops a run whose own reconcile failed, and tells its owner, until the owner resumes it", async () => {
    await launch();
    runs.recordReconcileFailure("run-1", new Error("The definition could not be read"));
    await scheduler.idle();

    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "needs_owner",
      reasons: ["run: The definition could not be read"],
    });
    expect(notified.map((b) => b.kind)).toEqual(["halted"]);
    const bind = workspace.submitted()[0];
    if (bind === undefined) throw new Error("no bind");
    expect(workspace.admit(bind.cause)).toBe(false);

    await runs.resume("run-1", null);
    await scheduler.idle();
    expect(runs.observe("run-1")?.record.progress).toEqual({ kind: "running" });
    expect(workspace.admit(bind.cause)).toBe(true);
  });

  it("admits nothing while paused and continues after resume", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    const record = runs.observe("run-1")?.record;
    if (record === undefined) throw new Error("no run");
    await runs.pause("run-1", record.revision);

    const work = conversation.submitted()[0];
    if (work === undefined) throw new Error("no work order");
    expect(conversation.admit(work.cause)).toBe(false);
    expect(runs.observe("run-1")?.record.progress.kind).toBe("paused");

    await runs.resume("run-1", runs.observe("run-1")?.record.revision ?? 0);
    await scheduler.idle();
    expect(conversation.admit(work.cause)).toBe(true);
  });

  it("restores active runs paused after a restart and tells their owners", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    await runs.restoreAfterRestart();

    expect(runs.observe("run-1")?.record.progress.kind).toBe("paused");
    expect(notified.map((b) => b.kind)).toContain("restored_paused");
    const work = conversation.submitted()[0];
    if (work === undefined) throw new Error("no work order");
    expect(conversation.admit(work.cause)).toBe(false);
  });

  it("passes a halt disposition to its context through resume", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    await settle(
      conversation,
      "work",
      report({ status: "failed", failure: "provider error" }),
    );
    const halted = notified.find((b) => b.kind === "halted");
    expect(halted?.summary).toContain("turn_failed");
    expect(conversation.submitted()).toHaveLength(1);
    const occurrence = (halted?.detail as { occurrence: string }).occurrence;

    await runs.resume("run-1", runs.observe("run-1")?.record.revision ?? 0, [
      {
        contextId: "run-1.agent",
        occurrence,
        disposition: { kind: "continue" },
      },
    ]);
    await scheduler.idle();
    expect(conversation.submitted()).toHaveLength(2);
    expect(contexts.observe("run-1.agent")?.record.progress.kind).toBe(
      "running",
    );
  });

  it("asks the owner for a human decision and accepts the approved candidate", async () => {
    await launch(true);
    await settle(workspace, "bind", { kind: "bound" });
    await settle(conversation, "work", report());
    await settle(workspace, "freeze", { kind: "frozen", evidence: "git:a:a" });

    const approval = notified.find((b) => b.kind === "approval");
    const detail = approval?.detail as {
      contextId: string;
      candidateId: string;
    };
    expect(detail.contextId).toBe("run-1.agent");
    expect(() =>
      runs.decide("run-1", "other.context", {
        candidateId: detail.candidateId,
        decision: "approved",
      }),
    ).toThrow(/does not belong/);
    runs.decide("run-1", detail.contextId, {
      candidateId: detail.candidateId,
      decision: "approved",
    });
    await settle(workspace, "accept", {
      kind: "accepted",
      receipt: "snapshot:git:a:a",
    });

    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "succeeded",
    });
  });

  it("redelivers a notice that failed, at the next boot, even after the run finished", async () => {
    deliver = async () => {
      throw new Error("owner conversation unavailable");
    };
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    await settle(conversation, "work", report());
    await settle(workspace, "freeze", { kind: "frozen", evidence: "git:a:a" });
    await settle(workspace, "accept", {
      kind: "accepted",
      receipt: "snapshot:git:a:a",
    });
    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "succeeded",
    });
    expect(notified).toEqual([]);

    deliver = async () => {};
    await runs.restoreAfterRestart();
    expect(notified.map((b) => b.kind)).toEqual(["succeeded"]);
    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "succeeded",
    });
  });

  it("delivers each boundary once when reconciles overlap", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    deliver = () => gate;
    conversation.admit(conversation.submitted()[0]?.cause ?? "");
    conversation.settle(
      conversation.submitted()[0]?.cause ?? "",
      report({ openQuestionId: "q-1" }),
    );
    await contexts.reconcile("run-1.agent");
    const first = runs.reconcile("run-1");
    const second = runs.reconcile("run-1");
    release();
    await Promise.all([first, second]);
    await scheduler.idle();

    expect(notified.map((b) => b.kind)).toEqual(["question"]);
  });

  it("restores every active run paused even when a restore notice cannot be delivered", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    deliver = async () => {
      throw new Error("owner conversation unavailable");
    };
    await runs.restoreAfterRestart();

    expect(runs.observe("run-1")?.record.progress.kind).toBe("paused");
    const work = conversation.submitted()[0];
    if (work === undefined) throw new Error("no work order");
    expect(conversation.admit(work.cause)).toBe(false);
  });

  it("refuses a stale or foreign disposition and leaves the run exactly as it was", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    await settle(
      conversation,
      "work",
      report({ status: "failed", failure: "provider error" }),
    );
    await runs.pause("run-1", null);
    const occurrence = contexts.describe("run-1.agent")?.occurrence ?? "";

    await expect(
      runs.resume("run-1", null, [
        {
          contextId: "run-1.agent",
          occurrence: "stale",
          disposition: { kind: "continue" },
        },
      ]),
    ).rejects.toThrow(/occurrence/);
    await expect(
      runs.resume("run-1", null, [
        {
          contextId: "elsewhere",
          occurrence,
          disposition: { kind: "continue" },
        },
      ]),
    ).rejects.toThrow(/does not belong/);
    await scheduler.idle();

    expect(runs.observe("run-1")?.record.progress.kind).toBe("paused");
    expect(contexts.observe("run-1.agent")?.record.progress.kind).toBe(
      "halted",
    );
    expect(conversation.submitted()).toHaveLength(1);
  });

  it("refuses to pause, resume or cancel a run that already finished", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    await settle(conversation, "work", report());
    await settle(workspace, "freeze", { kind: "frozen", evidence: "git:a:a" });
    await settle(workspace, "accept", {
      kind: "accepted",
      receipt: "snapshot:git:a:a",
    });

    await expect(runs.cancel("run-1", null)).rejects.toThrow(
      /already finished/,
    );
    await expect(runs.pause("run-1", null)).rejects.toThrow(/already finished/);
    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "succeeded",
    });
    expect(notified.map((b) => b.kind)).toEqual(["succeeded"]);
  });

  it("reports success when the last admitted effect settles while the run is paused", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    await settle(conversation, "work", report());
    await settle(workspace, "freeze", { kind: "frozen", evidence: "git:a:a" });
    const accept = workspace
      .submitted()
      .find((i) => (i.request as { kind: string }).kind === "accept");
    if (accept === undefined) throw new Error("no accept");
    workspace.admit(accept.cause);
    await runs.pause("run-1", null);
    workspace.settle(accept.cause, {
      kind: "accepted",
      receipt: "snapshot:git:a:a",
    });
    scheduler.touch(accept.requester);
    await scheduler.idle();

    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "succeeded",
    });
    expect(notified.map((b) => b.kind)).toEqual(["succeeded"]);
  });

  it("cancels its contexts and reports cancellation", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    await runs.cancel("run-1", runs.observe("run-1")?.record.revision ?? 0);
    await scheduler.idle();

    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "cancelled",
    });
    expect(notified.map((b) => b.kind)).toContain("cancelled");
  });
});
