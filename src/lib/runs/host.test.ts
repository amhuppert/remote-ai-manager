import { z } from "zod";
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
import { createRunsRepo, type RunsRepo } from "@/lib/state-store/runs-repo";
import { createRunSourceReader } from "@/lib/subscriptions/run-source";
import { createRunHost, type RunHost, type RunLaunchInput } from "./host";
import { runPage, runSummary } from "./page";
import type { RouteGuard, RunBoundary, RunDocument } from "./schemas";
import type { FrozenCharter } from "./charter";

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
let runsRepo: RunsRepo;
/** Runs whose owner the host asked to follow them. */
let follows: string[];
/** Makes following a run fail, as a failed subscription write would. */
let followFails: boolean;
/** Runs the host announced new boundaries for. */
let announced: string[];
/** Runs the host said changed, in order. */
let changed: string[];
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
  validationAccess: [] as string[],
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
  runsRepo = createRunsRepo(fixture.db);
  follows = [];
  followFails = false;
  announced = [];
  changed = [];
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
    changed: () => {},
    releaseBinding: () => {},
    now: () => now,
    log: silent,
  });
  const contextHost = contexts;
  runs = createRunHost({
    transaction,
    runs: runsRepo,
    intents,
    permits,
    contexts: {
      ...contextHost,
      describe(contextId) {
        if (contextsUnreadable)
          throw new Error(`Context ${contextId} could not be read`);
        return contextHost.describe(contextId);
      },
      outcome(cause) {
        if (contextsUnreadable)
          throw new Error(`Context for ${cause} could not be read`);
        return contextHost.outcome(cause);
      },
      async submit(intent) {
        beforeContextSubmit();
        if (dropContextSubmits) return;
        await contextHost.submit(intent);
      },
    },
    workspace,
    touchContext: (contextId) =>
      scheduler.touch({ kind: "context", id: contextId }),
    async followOwner(run) {
      if (followFails) throw new Error("The subscription could not be written");
      follows.push(run.runId);
    },
    boundariesRecorded(runId) {
      announced.push(runId);
    },
    changed(run) {
      changed.push(run.runId);
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

/** Every boundary recorded, in order: what the owner's follow reads. */
function recorded(): RunBoundary[] {
  const ids = z
    .array(z.string())
    .parse(
      fixture.db
        .prepare("SELECT run_id FROM runs ORDER BY rowid")
        .pluck()
        .all(),
    );
  return ids
    .flatMap((id) => runsRepo.boundaries(id))
    .sort((a, b) => a.seq - b.seq);
}

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

/** A run's facts exactly as stored. */
function factsJsonOf(runId: string): string {
  return z
    .string()
    .parse(
      fixture.db
        .prepare("SELECT facts_json FROM runs WHERE run_id = ?")
        .pluck()
        .get(runId),
    );
}

/** Every object key anywhere in a JSON value. */
function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysIn);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    key,
    ...keysIn(child),
  ]);
}

function agentLaunch(humanApproval = false): RunLaunchInput {
  return {
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
  };
}

async function launch(humanApproval = false): Promise<void> {
  await runs.launch(agentLaunch(humanApproval));
  await scheduler.idle();
}

const chainContexts = (): RunLaunchInput["contexts"] => [
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
];
const chainAuthored = {
  title: "API then docs",
  contexts: [
    {
      key: "api",
      dependsOn: [],
      title: "Build the API",
      brief: "Make the failure notice appear once.",
    },
    {
      key: "docs",
      dependsOn: ["api"],
      title: "Document the API",
      brief: "Make the failure notice appear once.",
    },
  ],
};

/** api builds first; docs builds on its accepted result. */
async function launchChain(
  documents?: RunDocument[],
  charter?: FrozenCharter,
): Promise<void> {
  await runs.launch({
    runId: "run-1",
    cause: "launch-1",
    kind: "workflow",
    title: "API then docs",
    projectPath: "/repo",
    sessionName: "session",
    owner: { conversationId: "owner-1", sessionName: "session" },
    contexts: chainContexts(),
    authored: chainAuthored,
    ...(documents !== undefined ? { documents } : {}),
    ...(charter !== undefined ? { charter } : {}),
  });
  await scheduler.idle();
}

/** Drives the single active context through bind, work, freeze and accept. */
async function succeedActiveContext(summary: string): Promise<void> {
  await settle(workspace, "bind", { kind: "bound" });
  await settle(conversation, "work", report({ finalText: summary }));
  await settle(workspace, "freeze", {
    kind: "frozen",
    evidence: `git:${summary}`,
  });
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
async function succeedWithOutput(
  output: Record<string, unknown>,
): Promise<void> {
  await settle(workspace, "bind", { kind: "bound" });
  await settle(conversation, "work", report());
  await settle(
    conversation,
    "capture_output",
    report({ structuredOutput: output }),
  );
  await settle(workspace, "freeze", {
    kind: "frozen",
    evidence: `git:${JSON.stringify(output)}`,
  });
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
        {
          key: "implement",
          dependsOn: [],
          request: startRequest("run-1.implement", false, "Implement"),
        },
        {
          key: "review",
          dependsOn: ["implement"],
          request: startRequest("run-1.review", false, "Review", verdictSchema),
        },
        {
          key: "ship",
          dependsOn: ["review"],
          request: startRequest("run-1.ship", false, "Ship"),
        },
      ],
      loops: [
        {
          key: "polish",
          body: ["implement", "review"],
          entry: "implement",
          exit: "review",
          until: {
            schema: {
              type: "object",
              properties: { approved: { const: true } },
            },
          },
          maxPasses: 2,
        },
      ],
    });
    await scheduler.idle();

    await succeedActiveContext("First try.");
    await succeedWithOutput({ approved: false });
    expect(contexts.observe("run-1.ship")).toBeNull();
    expect(
      contexts.observe("run-1.implement.pass2")?.record.facts.contract.current
        .inputs,
    ).toEqual([
      { key: "review", title: "Review (pass 1)", output: { approved: false } },
    ]);

    await succeedActiveContext("Second try.");
    expect(
      contexts.observe("run-1.review.pass2")?.record.facts.contract.current
        .inputs,
    ).toEqual([
      {
        key: "implement",
        title: "Implement",
        output: { summary: "Second try." },
      },
    ]);
    await succeedWithOutput({ approved: true });
    expect(
      contexts.observe("run-1.ship")?.record.facts.contract.current.inputs,
    ).toEqual([{ key: "review", title: "Review", output: { approved: true } }]);
    expect(
      runs.observe("run-1")?.record.facts.invocations.map((i) => i.startCause),
    ).toEqual([
      "run-1:start:implement:0",
      "run-1:start:review:0",
      "run-1:start:implement:1",
      "run-1:start:review:1",
      "run-1:start:ship:0",
    ]);

    await succeedActiveContext("Shipped.");
    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "succeeded",
    });
    expect(recorded().map((b) => [b.kind, b.detail])).toEqual([
      [
        "succeeded",
        {
          kind: "succeeded",
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
    const takesBoth = {
      schema: { type: "object", properties: { approved: { const: false } } },
    };
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
        {
          key: "fix",
          dependsOn: ["triage"],
          when: { triage: takesBoth },
          request: startRequest("run-1.fix", false, "Fix"),
        },
        {
          key: "ship",
          dependsOn: ["triage"],
          when: { triage: takesBoth },
          request: startRequest("run-1.ship", false, "Ship"),
        },
        {
          key: "docs",
          dependsOn: [],
          request: startRequest("run-1.docs", false, "Docs"),
        },
      ],
    });
    await scheduler.idle();
    await settleFor("run-1.triage", workspace, "bind", { kind: "bound" });
    await settleFor("run-1.triage", conversation, "work", report());
    await settleFor(
      "run-1.triage",
      conversation,
      "capture_output",
      report({ structuredOutput: { approved: false } }),
    );
    await settleFor("run-1.triage", workspace, "freeze", {
      kind: "frozen",
      evidence: "git:triage",
    });
    await settleFor("run-1.triage", workspace, "accept", {
      kind: "accepted",
      receipt: "snapshot:triage",
    });

    expect(contexts.observe("run-1.fix")).toBeNull();
    expect(contexts.observe("run-1.ship")).toBeNull();
    expect(runs.observe("run-1")?.record.progress).toEqual({ kind: "running" });
    const promised = [
      "halted",
      "route:triage:cardinality",
      {
        kind: "run_halt",
        halt: "route_cardinality",
        clearedBy: "amend",
        otherWorkRemains: true,
      },
    ];
    expect(recorded().map((b) => [b.kind, b.occurrence, b.detail])).toEqual([
      promised,
    ]);

    // Work that waits on the owner is not finished: the follow-up waits for it.
    await settleFor("run-1.docs", workspace, "bind", { kind: "bound" });
    await settleFor(
      "run-1.docs",
      conversation,
      "work",
      report({ openQuestionId: "q-1" }),
    );
    expect(runs.observe("run-1")?.record.progress.kind).toBe("needs_owner");
    expect(recorded().map((b) => b.kind)).toEqual(["halted", "question"]);

    await settleFor("run-1.docs", requests, "answer", {
      kind: "answered",
      question: "Which?",
      answer: "This.",
    });
    await settleFor(
      "run-1.docs",
      conversation,
      "work",
      report({ finalText: "Docs." }),
    );
    await settleFor("run-1.docs", workspace, "freeze", {
      kind: "frozen",
      evidence: "git:docs",
    });
    await settleFor("run-1.docs", workspace, "accept", {
      kind: "accepted",
      receipt: "snapshot:docs",
    });

    expect(runs.observe("run-1")?.record.progress.kind).toBe("needs_owner");
    expect(recorded().map((b) => [b.kind, b.occurrence, b.detail])).toEqual([
      promised,
      ["question", expect.any(String), expect.anything()],
      [
        "halted",
        "run:stalled:route:triage:cardinality",
        { kind: "stalled", clearedBy: "amend" },
      ],
    ]);
    await runs.reconcile("run-1");
    expect(recorded()).toHaveLength(3);
  });
});

describe("amendments", () => {
  const takesBoth = {
    schema: { type: "object", properties: { approved: { const: false } } },
  };
  const routed = (shipGuard: RouteGuard) => [
    {
      key: "triage",
      dependsOn: [],
      routing: { cardinality: "exactlyOne" as const },
      request: startRequest("run-1.triage", false, "Triage", verdictSchema),
    },
    {
      key: "fix",
      dependsOn: ["triage"],
      when: { triage: takesBoth },
      request: startRequest("run-1.fix", false, "Fix"),
    },
    {
      key: "ship",
      dependsOn: ["triage"],
      when: { triage: shipGuard },
      request: startRequest("run-1.ship", false, "Ship"),
    },
  ];
  /** The definition as its owner would have written it: what an amendment compares started work by. */
  const authored = (title: string, contexts: RunLaunchInput["contexts"]) => ({
    title,
    contexts: contexts.map((c) => ({
      key: c.key,
      dependsOn: c.dependsOn,
      ...(c.when !== undefined ? { when: c.when } : {}),
      title: c.request.contract.title,
      brief: c.request.contract.brief,
    })),
  });
  const launchInput = (overrides: Partial<RunLaunchInput>): RunLaunchInput => ({
    runId: "run-1",
    cause: "launch-1",
    kind: "workflow",
    title: "Amended",
    projectPath: "/repo",
    sessionName: "session",
    owner: { conversationId: "owner-1", sessionName: "session" },
    contexts: [],
    ...overrides,
    authored: authored("Amended", overrides.contexts ?? []),
  });

  it("clears a route halt when the owner amends the routes of the result that broke them, and starts the route now taken", async () => {
    await runs.launch(launchInput({ contexts: routed(takesBoth) }));
    await scheduler.idle();
    await succeedWithOutput({ approved: false });
    expect(runs.observe("run-1")?.record.progress.kind).toBe("needs_owner");

    const rerouted = routed({ else: true });
    await runs.amend("run-1", {
      definition: {
        title: "Routed again",
        contexts: rerouted,
        authored: authored("Routed again", rerouted),
      },
      basedOn: 1,
      reason: "Ship only what triage approved",
    });
    await scheduler.idle();
    const record = runs.observe("run-1")?.record;
    expect(record?.facts.definition.revision).toBe(2);
    expect(record?.facts.title).toBe("Routed again");
    expect(record?.facts.amendments).toEqual([
      { revision: 2, at: now, reason: "Ship only what triage approved" },
    ]);
    expect(runs.inspect("run-1")?.plan.halts).toEqual([]);
    expect(contexts.observe("run-1.fix")).not.toBeNull();
    expect(contexts.observe("run-1.ship")).toBeNull();
  });

  it("runs another pass of an exhausted loop once its owner raises maxPasses", async () => {
    const polish = (maxPasses: number) => ({
      key: "polish",
      body: ["implement", "review"],
      entry: "implement",
      exit: "review",
      until: {
        schema: { type: "object", properties: { approved: { const: true } } },
      },
      maxPasses,
    });
    const contextsOfLoop = [
      {
        key: "implement",
        dependsOn: [],
        request: startRequest("run-1.implement", false, "Implement"),
      },
      {
        key: "review",
        dependsOn: ["implement"],
        request: startRequest("run-1.review", false, "Review", verdictSchema),
      },
    ];
    await runs.launch(
      launchInput({ contexts: contextsOfLoop, loops: [polish(1)] }),
    );
    await scheduler.idle();
    await succeedActiveContext("First try.");
    await succeedWithOutput({ approved: false });
    expect(runs.inspect("run-1")?.plan.halts.map((halt) => halt.kind)).toEqual([
      "loop_exhausted",
    ]);

    await runs.amend("run-1", {
      definition: {
        title: "Polish",
        contexts: contextsOfLoop,
        loops: [polish(2)],
        authored: authored("Polish", contextsOfLoop),
      },
      basedOn: null,
    });
    await scheduler.idle();
    expect(contexts.observe("run-1.implement.pass2")).not.toBeNull();
  });

  it("keeps a template run's origin through an amendment, and never writes it into the run's facts", async () => {
    const origin = {
      kind: "template" as const,
      tier: "project" as const,
      id: "release-checklist",
      revision: 2,
      name: "Release checklist",
    };
    const chain = chainContexts();
    await runs.launch({ ...launchInput({ contexts: chain }), origin });
    await scheduler.idle();

    await runs.amend("run-1", {
      definition: {
        title: "Amended again",
        contexts: chain,
        authored: authored("Amended again", chain),
      },
      basedOn: 1,
      reason: "A clearer title",
    });
    await scheduler.idle();

    const reloaded = createRunsRepo(fixture.db).get("run-1");
    expect(reloaded?.facts.definition.revision).toBe(2);
    expect(reloaded?.origin).toEqual(origin);
    const facts = factsJsonOf("run-1");
    expect(keysIn(JSON.parse(facts))).not.toContain("origin");
    expect(facts).not.toContain(origin.id);
    expect(facts).not.toContain(origin.name);
  });

  it("refuses an amendment that changes started work, or one based on an older revision, and leaves the run as it was", async () => {
    await launchChain();
    const before = runs.observe("run-1")?.record;
    const changed = [
      {
        key: "api",
        dependsOn: [],
        request: startRequest("run-1.api", false, "Build another API"),
      },
      {
        key: "docs",
        dependsOn: ["api"],
        request: startRequest("run-1.docs", false, "Document the API"),
      },
    ];
    await expect(
      runs.amend("run-1", {
        definition: {
          title: "API then docs",
          contexts: changed,
          authored: authored("API then docs", changed),
        },
        basedOn: null,
      }),
    ).rejects.toThrow(/"api" has started/);
    await expect(
      runs.amend("run-1", {
        definition: {
          title: "API then docs",
          contexts: changed.slice(1),
          authored: authored("API then docs", changed.slice(1)),
        },
        basedOn: 3,
      }),
    ).rejects.toThrow(/revision 1/);
    expect(runs.observe("run-1")?.record).toEqual(before);
  });
});

/** api works in lane "api"; integrate, in the session, needs its code. */
async function launchLane(): Promise<void> {
  await runs.launch(laneLaunch());
  await scheduler.idle();
}

function laneLaunch(): RunLaunchInput {
  const inLane = startRequest("run-1.api", false, "Build the API");
  return {
    runId: "run-1",
    cause: "launch-1",
    kind: "workflow",
    title: "Lane then integrate",
    projectPath: "/repo",
    sessionName: "session",
    owner: { conversationId: "owner-1", sessionName: "session" },
    contexts: [
      {
        key: "api",
        dependsOn: [],
        lane: "api",
        request: {
          ...inLane,
          workspace: {
            kind: "lane",
            projectPath: "/repo",
            sessionName: "session",
            worktreePath: "/repo/.worktrees/session.1-api",
            branch: "csm/session-1-api",
            scope: { mode: "full" },
          },
        },
      },
      {
        key: "integrate",
        dependsOn: ["api"],
        request: startRequest("run-1.integrate", false, "Integrate"),
      },
    ],
    lanes: [
      {
        key: "api",
        laneId: "1-api",
        worktreePath: "/repo/.worktrees/session.1-api",
        branch: "csm/session-1-api",
        target: {
          worktreePath: "/repo/.worktrees/session",
          branch: "csm/session",
        },
        checks: ["typecheck"],
      },
    ],
  };
}

describe("lanes", () => {
  it("provisions the lane, lands its work there, publishes it, and only then starts work that needs its code", async () => {
    await launchLane();
    expect(contexts.observe("run-1.api")).toBeNull();
    const provision = workspace
      .submitted()
      .find((i) => (i.request as { kind?: string }).kind === "provision");
    expect(provision?.request).toMatchObject({
      kind: "provision",
      lane: {
        laneId: "1-api",
        worktreePath: "/repo/.worktrees/session.1-api",
        sessionBranch: "csm/session",
      },
    });
    await settle(workspace, "provision", {
      kind: "provisioned",
      baseline: "b0",
    });
    expect(
      contexts.observe("run-1.api")?.record.facts.binding.request,
    ).toMatchObject({ kind: "lane" });

    await succeedActiveContext("API built.");
    expect(contexts.observe("run-1.integrate")).toBeNull();
    const publish = workspace
      .submitted()
      .find((i) => (i.request as { kind?: string }).kind === "publish");
    expect(publish?.cause).toBe("run-1:publish:api:1");
    expect(publish?.request).toMatchObject({ checks: ["typecheck"] });

    await settle(workspace, "publish", {
      kind: "published",
      commit: "p1",
      incorporated: "h0",
    });
    expect(runs.observe("run-1")?.record.facts.lanes?.api?.publication).toEqual(
      {
        attempt: 1,
        outcome: { kind: "published", commit: "p1", incorporated: "h0" },
      },
    );
    expect(
      contexts.observe("run-1.integrate")?.record.facts.contract.current.inputs,
    ).toEqual([
      { key: "api", title: "Build the API", output: { summary: "API built." } },
    ]);
    await succeedActiveContext("Integrated.");
    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "succeeded",
    });
  });

  it("halts on a blocked publication, tells the owner how to retry, and publishes on the new attempt", async () => {
    await launchLane();
    await settle(workspace, "provision", {
      kind: "provisioned",
      baseline: "b0",
    });
    await succeedActiveContext("API built.");
    await settle(workspace, "publish", {
      kind: "publish_blocked",
      detail:
        "Uncommitted work in the session worktree is in the way of the lane's files, so nothing was published or changed. Your local changes to the following files would be overwritten by merge: notes.md. Commit, move or remove it, then ask for a new attempt.",
    });
    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "needs_owner",
      reasons: [expect.stringContaining("notes.md")],
    });
    expect(recorded().map((b) => [b.kind, b.occurrence, b.detail])).toEqual([
      [
        "halted",
        "lane:api:publication:1",
        {
          kind: "run_halt",
          halt: "lane_publication",
          clearedBy: "retry_lane",
          lane: "api",
          otherWorkRemains: false,
        },
      ],
    ]);

    await runs.retryLane("run-1", "owner", "api");
    await scheduler.idle();
    expect(workspace.submitted().map((i) => i.cause)).toContain(
      "run-1:publish:api:2",
    );
    await settle(workspace, "publish", {
      kind: "published",
      commit: "p2",
      incorporated: "h1",
    });
    expect(contexts.observe("run-1.integrate")).not.toBeNull();
    await expect(runs.retryLane("run-1", "owner", "api")).rejects.toThrow(
      /nothing to retry/,
    );
  });
});

describe("lanes under pause and cancel", () => {
  async function readyToPublish(): Promise<string> {
    await launchLane();
    await settle(workspace, "provision", {
      kind: "provisioned",
      baseline: "b0",
    });
    await succeedActiveContext("API built.");
    await scheduler.idle();
    return "run-1:publish:api:1";
  }

  it("withdraws a publication not yet admitted when cancelled, and is cancelled at once", async () => {
    const cause = await readyToPublish();
    expect(workspace.outcome(cause).kind).toBe("queued");
    await runs.cancel("run-1", "owner");
    await scheduler.idle();
    expect(workspace.withdrawn).toContain(cause);
    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "cancelled",
    });
    expect(
      runs.observe("run-1")?.record.facts.lanes?.api?.publication?.outcome,
    ).toEqual({ kind: "cancelled" });
  });

  it("interrupts a running publication when cancelled and keeps stopping until it settles", async () => {
    const cause = await readyToPublish();
    workspace.admit(cause);
    await runs.cancel("run-1", "owner");
    await scheduler.idle();
    expect(workspace.interrupted).toContain(cause);
    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "stopping",
    });

    workspace.settle(cause, {
      kind: "publication_failed",
      detail: "Stopped before publishing",
    });
    scheduler.touch({ kind: "run", id: "run-1" });
    await scheduler.idle();
    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "cancelled",
    });
  });

  it("refuses to pause or resume a run that is stopping, recording no act", async () => {
    const cause = await readyToPublish();
    workspace.admit(cause);
    await runs.cancel("run-1", "owner");
    await scheduler.idle();
    expect(runs.observe("run-1")?.record.progress.kind).toBe("stopping");

    await expect(runs.pause("run-1", "person")).rejects.toThrow(
      /was cancelled/,
    );
    await expect(runs.resume("run-1", "person")).rejects.toThrow(
      /was cancelled/,
    );
    expect(runs.observe("run-1")?.record.facts.acts).toEqual([
      { action: "cancel", by: "owner", at: now },
    ]);
  });

  it("withdraws a lane step a restart returned to the queue while the run was stopping, and finishes cancelling", async () => {
    const cause = await readyToPublish();
    workspace.admit(cause);
    await runs.cancel("run-1", "owner");
    await scheduler.idle();
    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "stopping",
    });

    // The restart found no publication marker, so the attempt went back to the queue.
    workspace.requeue(cause);
    await runs.restoreAfterRestart();
    scheduler.touch({ kind: "run", id: "run-1" });
    await scheduler.idle();
    expect(workspace.withdrawn).toContain(cause);
    // Finishing the cancel the last process began is not another act.
    expect(runs.observe("run-1")?.record.facts.acts).toEqual([
      { action: "cancel", by: "owner", at: now },
    ]);
    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "cancelled",
    });
    expect(
      runs.observe("run-1")?.record.facts.lanes?.api?.publication?.outcome,
    ).toEqual({ kind: "cancelled" });
  });

  it("reports a pause as draining while a lane's publication runs, and drained while it only waits", async () => {
    const cause = await readyToPublish();
    await runs.pause("run-1", "owner");
    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "paused",
      draining: false,
    });
    await runs.resume("run-1", "owner");
    await scheduler.idle();
    workspace.admit(cause);
    await runs.pause("run-1", "owner");
    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "paused",
      draining: true,
    });
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
    expect(recorded()).toEqual([]);

    await succeedActiveContext("Docs written.");
    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "succeeded",
    });
    expect(recorded().map((b) => [b.kind, b.detail])).toEqual([
      [
        "succeeded",
        {
          kind: "succeeded",
          outputs: {
            api: { summary: "API built." },
            docs: { summary: "Docs written." },
          },
        },
      ],
    ]);
  });

  it("gives each context the documents meant for it as they stand when it starts; an amendment changes them only for work not yet started", async () => {
    const declared = (plan: string): RunDocument[] => [
      {
        path: "plan.md",
        artifactId: plan,
        bytes: 7,
        description: "The plan",
        readWhen: "Before you start",
      },
      {
        path: "api-notes.md",
        artifactId: "sha256:api",
        bytes: 3,
        description: "API notes",
        appliesTo: ["api"],
      },
    ];
    await launchChain(declared("sha256:v1"));
    // Each context's copies live in a directory of its own, so the two revisions never share a file.
    const planAt = (contextId: string, artifactId: string) => ({
      artifactId,
      path: `.cc/run-docs/${contextId}/plan.md`,
      description: "The plan",
      readWhen: "Before you start",
    });
    expect(
      contexts.observe("run-1.api")?.record.facts.contract.current.documents,
    ).toEqual([
      planAt("run-1.api", "sha256:v1"),
      {
        artifactId: "sha256:api",
        path: ".cc/run-docs/run-1.api/api-notes.md",
        description: "API notes",
      },
    ]);

    await runs.amend("run-1", {
      definition: {
        title: "API then docs",
        contexts: chainContexts(),
        authored: chainAuthored,
        documents: declared("sha256:v2"),
      },
      basedOn: 1,
    });
    await scheduler.idle();
    expect(
      contexts.observe("run-1.api")?.record.facts.contract.current.documents[0],
    ).toEqual(planAt("run-1.api", "sha256:v1"));

    await succeedActiveContext("API built.");
    expect(
      contexts.observe("run-1.docs")?.record.facts.contract.current.documents,
    ).toEqual([planAt("run-1.docs", "sha256:v2")]);
    expect(
      runs
        .observe("run-1")
        ?.record.facts.documents.map((r) => [r.path, r.revision, r.source]),
    ).toEqual([
      ["plan.md", 1, "launch"],
      ["api-notes.md", 1, "launch"],
      ["plan.md", 2, "amend"],
    ]);
  });

  it("refuses an amendment written against a revision a seat has published past, or replacing a publication it did not name, and reports what it removed", async () => {
    const plan: RunDocument = {
      path: "plan.md",
      artifactId: "sha256:v1",
      bytes: 2,
      description: "The plan",
    };
    await launchChain([plan]);
    expect(
      runs.publishDocument("run-1", {
        path: "plan.md",
        artifactId: "sha256:v2",
        bytes: 2,
        by: "run-1.api",
      }),
    ).toEqual({
      revision: 2,
      unchanged: false,
    });
    expect(() =>
      runs.publishDocument("run-1", {
        path: "plan.md",
        artifactId: "sha256:v3",
        bytes: 2,
        by: "run-9.elsewhere",
      }),
    ).toThrow(/not part of run run-1/);

    await expect(
      runs.amend("run-1", {
        definition: {
          title: "API then docs",
          contexts: chainContexts(),
          authored: chainAuthored,
          documents: [{ ...plan, seen: 1 }],
        },
        basedOn: 1,
      }),
    ).rejects.toThrow(/plan.md is at revision 2 now, not 1/);
    await expect(
      runs.amend("run-1", {
        definition: {
          title: "API then docs",
          contexts: chainContexts(),
          authored: chainAuthored,
          documents: [{ ...plan, artifactId: "sha256:mine" }],
        },
        basedOn: 1,
      }),
    ).rejects.toThrow(/plan.md revision 2 was published by run-1.api/);
    expect(
      runs
        .observe("run-1")
        ?.record.facts.documents.map((r) => [r.revision, r.source]),
    ).toEqual([
      [1, "launch"],
      [2, "publish"],
    ]);

    expect(
      await runs.amend("run-1", {
        definition: {
          title: "API then docs",
          contexts: chainContexts(),
          authored: chainAuthored,
          documents: [],
        },
        basedOn: 1,
      }),
    ).toEqual({ removedDocuments: ["plan.md"] });
  });

  it("gives each context the run's charter as it stands when it starts, as a summary and as a document beside its others", async () => {
    const frozen = (mission: string): FrozenCharter => ({
      charter: {
        mission,
        invariants: [
          { id: "api-stable", statement: "Keep the API", appliesTo: ["api"] },
        ],
      },
      bundles: {
        default: `sha256:${mission}`,
        byKey: { api: `sha256:${mission}-api` },
      },
    });
    await launchChain(
      [
        {
          path: "plan.md",
          artifactId: "sha256:plan",
          bytes: 7,
          description: "The plan",
        },
      ],
      frozen("v1"),
    );

    const api = contexts.observe("run-1.api")?.record.facts.contract.current;
    expect(api?.charter).toMatchObject({
      revision: 1,
      mission: "v1",
      invariants: [{ id: "api-stable", statement: "Keep the API" }],
      documentPath: ".cc/run-docs/run-1.api/charter.md",
    });
    expect(api?.documents.map((d) => [d.path, d.artifactId])).toEqual([
      [".cc/run-docs/run-1.api/charter.md", "sha256:v1-api"],
      [".cc/run-docs/run-1.api/plan.md", "sha256:plan"],
    ]);

    await runs.amend("run-1", {
      definition: {
        title: "API then docs",
        contexts: chainContexts(),
        authored: chainAuthored,
        charter: frozen("v2"),
      },
      basedOn: 1,
      reason: "The API is settled",
    });
    await scheduler.idle();
    expect(
      contexts.observe("run-1.api")?.record.facts.contract.current.charter
        ?.mission,
    ).toBe("v1");
    await succeedActiveContext("API built.");
    const docs = contexts.observe("run-1.docs")?.record.facts.contract.current;
    expect(docs?.charter).toMatchObject({
      revision: 2,
      mission: "v2",
      invariants: [],
    });
    expect(docs?.documents.map((d) => d.artifactId)).toEqual(["sha256:v2"]);
    expect(
      runs
        .observe("run-1")
        ?.record.facts.charter.map((r) => [r.revision, r.source, r.reason]),
    ).toEqual([
      [1, "launch", null],
      [2, "amend", "The API is settled"],
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
    expect(recorded().map((b) => b.kind)).toEqual(["halted"]);
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
    await runs.pause("run-1", "owner");
    workspace.settle(accept.cause, {
      kind: "accepted",
      receipt: "snapshot:api",
    });
    scheduler.touch(accept.requester);
    await scheduler.idle();

    expect(contexts.observe("run-1.api")?.record.progress.kind).toBe(
      "succeeded",
    );
    expect(contexts.observe("run-1.docs")).toBeNull();
    expect(runs.observe("run-1")?.record.progress.kind).toBe("paused");

    await runs.resume("run-1", "owner");
    await scheduler.idle();
    expect(
      contexts.observe("run-1.docs")?.record.facts.contract.current.inputs,
    ).toEqual([
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
    workspace.settle(accept.cause, {
      kind: "accepted",
      receipt: "snapshot:api",
    });
    scheduler.touch(accept.requester);
    await scheduler.idle();
    expect(contexts.observe("run-1.api")?.record.progress.kind).toBe(
      "succeeded",
    );
    expect(contexts.observe("run-1.docs")).toBeNull();
    expect(recorded().map((b) => b.kind)).toEqual(["restored_paused"]);

    await runs.resume("run-1", "owner");
    await scheduler.idle();
    expect(
      contexts.observe("run-1.docs")?.record.facts.contract.current.inputs,
    ).toEqual([
      { key: "api", title: "Build the API", output: { summary: "API built." } },
    ]);
  });

  it("stops submitting starts once a pause lands between two of them", async () => {
    let paused = false;
    beforeContextSubmit = () => {
      if (paused) return;
      paused = true;
      void runs.pause("run-1", "owner");
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
        {
          key: "a",
          dependsOn: [],
          request: startRequest("run-1.a", false, "A"),
        },
        {
          key: "b",
          dependsOn: [],
          request: startRequest("run-1.b", false, "B"),
        },
      ],
    });
    await scheduler.idle();

    expect(
      [contexts.observe("run-1.a"), contexts.observe("run-1.b")].filter(
        (c) => c !== null,
      ),
    ).toHaveLength(1);

    await runs.resume("run-1", "owner");
    await scheduler.idle();
    expect(contexts.observe("run-1.b")).not.toBeNull();
  });

  it("finishes cancelling a context whose start was recorded but never reached its host", async () => {
    dropContextSubmits = true;
    await launchChain();
    expect(contexts.observe("run-1.api")).toBeNull();
    expect(runs.observe("run-1")?.record.progress).toEqual({ kind: "running" });

    await runs.cancel("run-1", "owner");
    await scheduler.idle();

    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "cancelled",
    });
    expect(intents.pending({ kind: "run", id: "run-1" })).toEqual([]);
    expect(recorded().map((b) => b.kind)).toEqual(["cancelled"]);
  });

  it("cancels what started and never starts the rest", async () => {
    await launchChain();
    await settle(workspace, "bind", { kind: "bound" });
    await runs.cancel("run-1", "owner");
    await scheduler.idle();

    expect(contexts.observe("run-1.api")?.record.progress.kind).toBe(
      "cancelled",
    );
    expect(contexts.observe("run-1.docs")).toBeNull();
    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "cancelled",
    });
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
    expect(recorded().map((b) => b.kind)).toEqual(["succeeded"]);
    expect(recorded()[0]?.detail).toEqual({
      kind: "succeeded",
      outputs: { agent: { summary: "Done." } },
    });
    await runs.reconcile("run-1");
    expect(recorded()).toHaveLength(1);
  });

  it("asks the owner a child's question and continues once it is answered", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    await settle(conversation, "work", report({ openQuestionId: "q-1" }));

    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "needs_owner",
      reasons: ["agent: question"],
    });
    expect(recorded().map((b) => [b.kind, b.detail])).toEqual([
      [
        "question",
        { kind: "question", contextId: "run-1.agent", questionId: "q-1" },
      ],
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

  it("tells the owner a reviewer's question at once, while another reviewer still runs", async () => {
    const request = startRequest("run-1.agent");
    const reviewer = (id: string) => ({
      id,
      authority: "blocking" as const,
      ...seat,
    });
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
          request: {
            ...request,
            contract: {
              ...request.contract,
              reviewers: [reviewer("reviewer-a"), reviewer("reviewer-b")],
            },
          },
        },
      ],
    });
    await scheduler.idle();
    await settle(workspace, "bind", { kind: "bound" });
    await settle(conversation, "work", report());
    await settle(workspace, "freeze", { kind: "frozen", evidence: "ev-1" });
    await settle(conversation, "review", report({ openQuestionId: "q-ra" }));

    expect(recorded().map((b) => [b.kind, b.detail])).toEqual([
      [
        "question",
        { kind: "question", contextId: "run-1.agent", questionId: "q-ra" },
      ],
    ]);
  });

  it("finishes cancelling after a restart a run left stopping, stopping its children again", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    await settle(conversation, "work", report({ openQuestionId: "q-1" }));
    await scheduler.idle();
    const wait = requests
      .submitted()
      .find((i) => (i.request as { kind?: string }).kind === "answer");
    if (wait === undefined) throw new Error("no answer wait");
    requests.admit(wait.cause);

    // As a restart leaves it when the process stopped before the wait was withdrawn.
    await runs.cancel("run-1", "owner");
    await scheduler.idle();
    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "stopping",
    });
    const interruptsBefore = requests.interrupted.length;

    await runs.restoreAfterRestart();
    expect(requests.interrupted.length).toBeGreaterThan(interruptsBefore);
    requests.settle(wait.cause, { kind: "withdrawn" });
    scheduler.touch({ kind: "context", id: "run-1.agent" });
    await scheduler.idle();
    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "cancelled",
    });
  });

  it("reports a paused run as draining while a child's admitted turn runs, and drained once it settles", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    const work = conversation.submitted()[0];
    if (work === undefined) throw new Error("no work order");
    expect(conversation.admit(work.cause)).toBe(true);
    await runs.pause("run-1", "owner");
    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "paused",
      draining: true,
    });

    conversation.settle(work.cause, report());
    scheduler.touch(work.requester);
    await scheduler.idle();
    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "paused",
      draining: false,
    });
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
    changed = [];
    runs.recordReconcileFailure(
      "run-1",
      new Error("Context run-1.agent could not be read"),
    );
    // A person's page and list show the fault: they must hear of it.
    expect(changed).toEqual(["run-1"]);

    const record = runs.observe("run-1")?.record;
    expect(record?.facts.control.fault?.detail).toBe(
      "Context run-1.agent could not be read",
    );
    expect(record?.progress).toEqual({
      kind: "needs_owner",
      reasons: ["run: Context run-1.agent could not be read"],
    });
    const bind = workspace.submitted()[0];
    if (bind === undefined) throw new Error("no bind");
    expect(workspace.admit(bind.cause)).toBe(false);
    contextsUnreadable = false;
  });

  it("stops a run whose own reconcile failed, and tells its owner, until the owner resumes it", async () => {
    await launch();
    runs.recordReconcileFailure(
      "run-1",
      new Error("The definition could not be read"),
    );
    await scheduler.idle();

    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "needs_owner",
      reasons: ["run: The definition could not be read"],
    });
    expect(recorded().map((b) => b.kind)).toEqual(["halted"]);
    const bind = workspace.submitted()[0];
    if (bind === undefined) throw new Error("no bind");
    expect(workspace.admit(bind.cause)).toBe(false);

    await runs.resume("run-1", "owner");
    await scheduler.idle();
    expect(runs.observe("run-1")?.record.progress).toEqual({ kind: "running" });
    expect(workspace.admit(bind.cause)).toBe(true);
  });

  it("admits nothing while paused and continues after resume", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    await runs.pause("run-1", "owner");

    const work = conversation.submitted()[0];
    if (work === undefined) throw new Error("no work order");
    expect(conversation.admit(work.cause)).toBe(false);
    expect(runs.observe("run-1")?.record.progress.kind).toBe("paused");

    await runs.resume("run-1", "owner");
    await scheduler.idle();
    expect(conversation.admit(work.cause)).toBe(true);
  });

  it("restores active runs paused after a restart and tells their owners", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    await runs.restoreAfterRestart();

    expect(runs.observe("run-1")?.record.progress.kind).toBe("paused");
    expect(recorded().map((b) => b.kind)).toContain("restored_paused");
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
    const halted = recorded().find((b) => b.kind === "halted");
    expect(halted?.summary).toContain("turn_failed");
    expect(conversation.submitted()).toHaveLength(1);
    const occurrence = (halted?.detail as { occurrence: string }).occurrence;

    await runs.resume("run-1", "owner", [
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

  it("tells clients the run changed with every projection, a person's pause included", async () => {
    await launch();
    changed = [];

    await runs.pause("run-1", "person");

    expect(changed).toEqual(["run-1"]);
  });

  it("records each control act with who asked for it, and tells the owner when a person cancelled its run", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    await settle(
      conversation,
      "work",
      report({ status: "failed", failure: "provider error" }),
    );
    const halted = recorded().find((b) => b.kind === "halted");
    const occurrence = (halted?.detail as { occurrence: string }).occurrence;

    await runs.pause("run-1", "person");
    // Pausing a paused run changes nothing, so it is no act.
    await runs.pause("run-1", "owner");
    await expect(
      runs.resume("run-1", "person", [
        {
          contextId: "run-9.agent",
          occurrence,
          disposition: { kind: "continue" },
        },
      ]),
    ).rejects.toThrow(/does not belong/);
    await runs.resume("run-1", "owner", [
      {
        contextId: "run-1.agent",
        occurrence,
        disposition: { kind: "continue" },
      },
    ]);
    await runs.cancel("run-1", "person");
    await scheduler.idle();

    expect(runs.observe("run-1")?.record.facts.acts).toEqual([
      { action: "pause", by: "person", at: now },
      {
        action: "resume",
        by: "owner",
        at: now,
        dispositions: [{ contextId: "run-1.agent", disposition: "continue" }],
      },
      { action: "cancel", by: "person", at: now },
    ]);
    expect(recorded().find((b) => b.kind === "cancelled")?.summary).toBe(
      "Fix the notice: Alex cancelled it in Command Center.",
    );
  });

  it("records only what a resume applied: a disposition someone already applied, or one naming no halt, is no act", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    await settle(
      conversation,
      "work",
      report({ status: "failed", failure: "provider error" }),
    );
    const halted = recorded().find((b) => b.kind === "halted");
    const occurrence = (halted?.detail as { occurrence: string }).occurrence;
    const continueAt = (at: string) => ({
      contextId: "run-1.agent",
      occurrence: at,
      disposition: { kind: "continue" as const },
    });
    await expect(
      runs.resume("run-1", "person", [
        continueAt(occurrence),
        { ...continueAt(occurrence), disposition: { kind: "retry" } },
      ]),
    ).rejects.toThrow(/more than once/);

    await runs.resume("run-1", "person", [continueAt(occurrence)]);
    await scheduler.idle();
    // The owner follows its notice after Alex already resolved the halt.
    await runs.resume("run-1", "owner", [continueAt(occurrence)]);
    // A disposition naming the running context's own occurrence clears nothing either.
    const running = contexts.describe("run-1.agent")?.occurrence ?? "";
    await runs.resume("run-1", "owner", [continueAt(running)]);

    expect(runs.observe("run-1")?.record.facts.acts).toEqual([
      {
        action: "resume",
        by: "person",
        at: now,
        dispositions: [{ contextId: "run-1.agent", disposition: "continue" }],
      },
    ]);
    expect(contexts.observe("run-1.agent")?.record.progress.kind).toBe(
      "running",
    );
  });

  it("leaves a run someone paused as it was across a restart, without telling its owner to resume it", async () => {
    await launch();
    await runs.pause("run-1", "person");
    await runs.restoreAfterRestart();
    await scheduler.idle();

    expect(recorded().map((b) => b.kind)).not.toContain("restored_paused");
    expect(runs.observe("run-1")?.record.progress.kind).toBe("paused");
    expect(runs.observe("run-1")?.record.facts.acts).toEqual([
      { action: "pause", by: "person", at: now },
    ]);
  });

  it("withdraws the owner's halt notice once someone resolved the halt before it was delivered", async () => {
    const contextsRepo = createExecutionContextsRepo(fixture.db);
    const read = createRunSourceReader({
      run: (runId) => {
        const run = runsRepo.get(runId);
        return run === null
          ? null
          : { runId, projectPath: run.projectPath, title: run.facts.title };
      },
      boundaries: (runId) => runsRepo.boundaries(runId),
      question: () => null,
      contextOccurrence: (contextId) =>
        contextsRepo.get(contextId)?.progressOccurrence ?? null,
    });
    const ownerFollow = { projectPath: "/repo", conversationId: "owner-1" };
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    await settle(
      conversation,
      "work",
      report({ status: "failed", failure: "provider error" }),
    );
    const halted = recorded().find((b) => b.kind === "halted");
    expect(
      (await read(ownerFollow, { id: "run-1" }, "0")).facts.map(
        (fact) => fact.occurrenceId,
      ),
    ).toEqual([halted?.occurrence]);

    await runs.resume("run-1", "person", [
      {
        contextId: "run-1.agent",
        occurrence: (halted?.detail as { occurrence: string }).occurrence,
        disposition: { kind: "continue" },
      },
    ]);
    await scheduler.idle();

    const after = await read(ownerFollow, { id: "run-1" }, "0");
    expect(after.withdrawnOccurrenceIds).toEqual([halted?.occurrence]);
    expect(after.facts).toEqual([]);
  });

  it("records a template run's origin on the run row, beside its facts and never inside them", async () => {
    const origin = {
      kind: "template" as const,
      tier: "global" as const,
      id: "release-checklist",
      revision: 3,
      name: "Release checklist",
    };
    runs.record({ ...agentLaunch(), origin });

    // An older build parses facts strictly: an origin anywhere inside them would break its reads.
    const facts = factsJsonOf("run-1");
    expect(keysIn(JSON.parse(facts))).not.toContain("origin");
    expect(facts).not.toContain(origin.id);
    expect(createRunsRepo(fixture.db).get("run-1")?.origin).toEqual(origin);

    const page = await runPage(
      {
        supervision: {
          runs,
          contexts,
          requests: { question: () => null },
          core: { seatBindingsOf: () => [] },
        },
        conversations: new Map(),
        sessionBranch: "csm/session",
        readText: async () => "",
        candidateChanges: async () =>
          ({ ok: false, reason: "unused" }) as const,
      },
      "run-1",
    );
    expect(page?.origin).toEqual(origin);
  });

  it("records no origin for a run its owner launched directly", async () => {
    await launch();

    expect(createRunsRepo(fixture.db).get("run-1")?.origin).toBeNull();
  });

  it("shows a completion no one consumed on the run page, for a resume to reconcile", async () => {
    await launch();
    // The bind settled, but nothing told the Context: its completion stalls.
    const bind = workspace.submitted()[0];
    if (bind === undefined) throw new Error("no bind");
    workspace.admit(bind.cause);
    workspace.settle(bind.cause, { kind: "bound" });

    const sources = {
      supervision: {
        runs,
        contexts,
        requests: { question: () => null },
        core: { seatBindingsOf: () => [] },
      },
      conversations: new Map(),
      sessionBranch: "csm/session",
      readText: async () => "",
      candidateChanges: async () => ({ ok: false, reason: "unused" }) as const,
    };
    const page = await runPage(sources, "run-1");
    const record = runs.observe("run-1")?.record;
    if (record === undefined) throw new Error("no run");
    // The list counts it as needing someone too.
    expect(runSummary(sources, record).attention).toBe(1);

    expect(page?.attention).toEqual([
      {
        kind: "stalled",
        contextKey: "agent",
        contextTitle: "Fix the notice",
        causes: [bind.cause],
      },
    ]);
  });

  it("asks the owner for a human decision and accepts the approved candidate", async () => {
    await launch(true);
    await settle(workspace, "bind", { kind: "bound" });
    await settle(conversation, "work", report());
    await settle(workspace, "freeze", { kind: "frozen", evidence: "git:a:a" });

    const approval = recorded().find((b) => b.kind === "approval");
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

  it("has its owner follow the run from launch, and repairs at the next restart a follow the launch could not make", async () => {
    followFails = true;
    await launch();
    expect(runs.observe("run-1")?.record.progress.kind).toBe("running");
    expect(follows).toEqual([]);

    followFails = false;
    await runs.restoreAfterRestart();
    expect(follows).toEqual(["run-1"]);
  });

  it("announces each new boundary once it is recorded, and nothing for a reconcile that records none", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    expect(announced).toEqual([]);

    await settle(conversation, "work", report({ openQuestionId: "q-1" }));
    expect(recorded().map((b) => b.kind)).toEqual(["question"]);
    expect(announced).toEqual(["run-1"]);

    await runs.reconcile("run-1");
    expect(announced).toEqual(["run-1"]);
  });

  it("refuses a stale or foreign disposition and leaves the run exactly as it was", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    await settle(
      conversation,
      "work",
      report({ status: "failed", failure: "provider error" }),
    );
    await runs.pause("run-1", "owner");
    const occurrence = contexts.describe("run-1.agent")?.occurrence ?? "";

    await expect(
      runs.resume("run-1", "owner", [
        {
          contextId: "run-1.agent",
          occurrence: "stale",
          disposition: { kind: "continue" },
        },
      ]),
    ).rejects.toThrow(/occurrence/);
    await expect(
      runs.resume("run-1", "owner", [
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

    await expect(runs.cancel("run-1", "owner")).rejects.toThrow(
      /already finished/,
    );
    await expect(runs.pause("run-1", "owner")).rejects.toThrow(
      /already finished/,
    );
    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "succeeded",
    });
    expect(recorded().map((b) => b.kind)).toEqual(["succeeded"]);
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
    await runs.pause("run-1", "owner");
    workspace.settle(accept.cause, {
      kind: "accepted",
      receipt: "snapshot:git:a:a",
    });
    scheduler.touch(accept.requester);
    await scheduler.idle();

    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "succeeded",
    });
    expect(recorded().map((b) => b.kind)).toEqual(["succeeded"]);
  });

  it("cancels its contexts and reports cancellation", async () => {
    await launch();
    await settle(workspace, "bind", { kind: "bound" });
    await runs.cancel("run-1", "owner");
    await scheduler.idle();

    expect(runs.observe("run-1")?.record.progress).toEqual({
      kind: "cancelled",
    });
    expect(recorded().map((b) => b.kind)).toContain("cancelled");
  });
});
