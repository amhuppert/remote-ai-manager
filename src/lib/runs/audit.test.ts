import { afterEach, expect, it } from "vitest";
import { initialContextFacts } from "@/lib/execution-context/facts";
import {
  DEFAULT_CONTEXT_POLICY,
  type ContextRecord,
} from "@/lib/execution-context/schemas";
import {
  binding,
  contract,
} from "@/lib/execution-context/testing/context-harness";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createRunsRepo } from "@/lib/state-store/runs-repo";
import { createExecutionContextsRepo } from "@/lib/state-store/execution-contexts-repo";
import { createConversationCoreRepo } from "@/lib/state-store/conversation-core-repo";
import { createWorkspaceRepo } from "@/lib/state-store/workspace-repo";
import { createConversationSubscriptionsRepo } from "@/lib/state-store/conversation-subscriptions-repo";
import { createConversationSubscriptionWaitsRepo } from "@/lib/state-store/conversation-subscription-waits-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import {
  subscriptionDeliverySchema,
  conversationSubscriptionSchema,
} from "@/lib/subscriptions/schemas";
import {
  buildRunAudit,
  RunAuditContextNotFoundError,
  type RunAuditSources,
} from "./audit";
import { runRecordSchema, type RunInvocation } from "./schemas";

const at = "2026-10-15T12:00:00.000Z";
let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());

async function harness() {
  fixture = createPersistenceFixture();
  const db = fixture.db;
  const writes = createWriteQueue();
  const runs = createRunsRepo(db);
  const contexts = createExecutionContextsRepo(db);
  const core = createConversationCoreRepo(db);
  const workspace = createWorkspaceRepo(db);
  const deliveries = createConversationSubscriptionsRepo(db, writes);
  const waits = createConversationSubscriptionWaitsRepo(db, writes);
  const invocations: RunInvocation[] = [0, 1].map((pass) => ({
    key: "check",
    pass,
    contextId: `ctx-${pass}`,
    startCause: `start-${pass}`,
  }));
  function record(more: RunInvocation[] = []) {
    return runRecordSchema.parse({
      runId: "run",
      projectPath: "/repo",
      sessionName: "session",
      ownerConversationId: "owner",
      ownerSessionName: "session",
      launchCause: "launch",
      origin: null,
      revision: 1,
      progress: { kind: "running" },
      createdAt: at,
      updatedAt: at,
      facts: {
        runId: "run",
        title: "Audit run",
        kind: "workflow",
        definition: {
          revision: 1,
          contexts: ["check", "later"].map((key) => ({
            key,
            dependsOn: key === "later" ? ["check"] : [],
            request: {
              contextId: key === "check" ? "ctx-0" : "ctx-later",
              runId: "run",
              ownerConversationId: "owner",
              workspace: binding,
              contract: contract(),
              policy: DEFAULT_CONTEXT_POLICY,
            },
          })),
        },
        invocations: [...invocations, ...more],
        control: { paused: false, cancelled: false },
      },
    });
  }
  runs.insertIfAbsent(record());
  const summary = "The revised report is complete. ".repeat(200);
  function contextRecord(contextId: string): ContextRecord {
    const facts = initialContextFacts({
      contextId,
      workspace: binding,
      contract: contract(),
      policy: DEFAULT_CONTEXT_POLICY,
    });
    facts.ledger.lastSummary = summary;
    facts.seats = {
      conversations: { implementer: `${contextId}-current` },
      replacements: { implementer: 1 },
    };
    facts.candidates.items = [
      {
        id: "candidate",
        contractRevision: 1,
        taskRevision: 0,
        output: summary,
        evidence: "git:revision",
        provenance: { kind: "work" },
      },
    ];
    facts.certification.rounds = [
      {
        id: "review",
        candidateId: "candidate",
        kind: "full",
        retired: false,
        checks: [],
        seats: [
          {
            assignmentId: "reviewer",
            authority: "blocking",
            status: "pass",
            findings: [],
            advisories: [
              { title: "Clarify", description: "Clarify the report" },
            ],
          },
        ],
      },
    ];
    facts.advice.dispositions = { advice: { disposition: "addressed" } };
    facts.acceptance.receipts = [
      { candidateId: "candidate", receipt: "accepted", at },
    ];
    return {
      contextId,
      runId: "run",
      projectPath: "/repo",
      sessionName: "session",
      ownerConversationId: "owner",
      startCause: contextId,
      workspace: binding,
      facts,
      revision: 1,
      progress: { kind: "succeeded", candidateId: "candidate" },
      progressOccurrence: `${contextId}-done`,
      createdAt: at,
      updatedAt: at,
    };
  }
  for (const invocation of invocations) {
    contexts.insertIfAbsent(contextRecord(invocation.contextId));
    for (const replacement of [0, 1])
      core.insertSeat({
        conversationId: `${invocation.contextId}-${replacement === 1 ? "current" : "old"}`,
        contextId: invocation.contextId,
        assignmentId: "implementer",
        replacement,
        role: "implementer",
        projectPath: "/repo",
        sessionName: "session",
        backend: "claude",
        createdAt: at,
        updatedAt: at,
      });
  }
  runs.recordBoundary({
    runId: "run",
    occurrence: "ctx-0-halt",
    kind: "halted",
    summary: "Needs help",
    detail: {
      kind: "context_halt",
      contextId: "ctx-0",
      halt: "output",
      occurrence: "halt",
      dispositions: ["retry_capture"],
    },
    recordedAt: at,
  });
  for (const requester of [
    { kind: "run", id: "run" },
    { kind: "context", id: "ctx-0" },
    { kind: "run", id: "other" },
  ] as const)
    workspace.insertOperationIfAbsent({
      cause: `operation-${requester.id}`,
      bindingId: requester.id,
      requester,
      request: { kind: "capture", bindingId: requester.id },
      permit: null,
      state: "settled",
      outcome: { kind: "failed", detail: "Stopped before publishing" },
      createdAt: at,
      updatedAt: at,
    });
  const recipient = { projectPath: "/repo", conversationId: "owner" };
  const source = { kind: "run", id: "run" };
  const subscription = conversationSubscriptionSchema.parse({
    id: "follow",
    recipient,
    source,
    reason: "Owner",
    mode: "passive",
    wakes: true,
    eventKinds: null,
    expiresAt: null,
    status: "following",
    cursor: "0",
    createdAt: at,
    updatedAt: at,
    unfollowedAt: null,
    pausedAt: null,
    missingAt: null,
    lastError: null,
  });
  const delivery = subscriptionDeliverySchema.parse({
    id: "delivery",
    subscriptionId: "follow",
    recipient,
    source,
    fact: {
      occurrenceId: "ctx-0-halt",
      eventKind: "run-boundary:context_halt",
      category: "decision",
      sourceTitle: "Run",
      summary: "Needs help",
      sourceText: "Resume context",
      occurredAt: at,
      revision: null,
      outcome: "halted",
      retrievalHandle: "cctl run show run",
      actorConversationId: null,
    },
    state: "pending",
    recordedAt: at,
    attemptId: null,
    attemptCount: 0,
    queuedAt: null,
    acceptedAt: null,
    finishedAt: null,
    lastError: null,
  });
  await deliveries.createIfAbsent(subscription);
  await deliveries.recordDelivery(delivery);
  const batch = {
    id: "batch",
    recipient,
    waitIds: [],
    deliveryIds: [],
    followDeliveryIds: ["delivery"],
    state: "planned" as const,
    queueMessageId: "batch",
    message: "Resume context",
    causationBatchIds: [],
    createdAt: at,
    updatedAt: at,
    finishedAt: null,
    lastError: null,
  };
  if (!(await waits.reserveBatch(batch)))
    throw Error("Expected wake reservation");
  await waits.markBatchQueued(batch.id, at);
  await waits.settleBatch(batch.id, "cancelled", at, "Obsolete halt withdrawn");
  const promptReads: string[] = [];
  const sources: RunAuditSources = {
    runs: {
      observe(id) {
        const record = runs.get(id);
        return record ? { record, boundaries: runs.boundaries(id) } : null;
      },
    },
    contexts: {
      observe(id) {
        const record = contexts.get(id);
        return record ? { record, stalled: [] } : null;
      },
    },
    core: { seatBindingsOf: (id) => core.seatsOfContext(id) },
    workspace: {
      operationsOf: (owner) => workspace.operationsOf(owner),
      waitingOn: () => null,
    },
    deliveriesForRun: (projectPath, runId) =>
      deliveries.listDeliveriesForRun(projectPath, runId),
    wakeBatchesForDeliveries: (ids) => waits.listBatchesForDeliveries(ids),
    async conversationFacts() {
      return new Map([
        [
          "ctx-0-current",
          {
            title: "Implementer",
            backend: "claude",
            status: "awaiting",
            costUsd: 0.35,
            turns: 3,
          },
        ],
      ]);
    },
    async promptDispatches(id) {
      promptReads.push(id);
      return [
        {
          seq: 7,
          timestamp: at,
          phase: "format",
          promptText: "Format this report",
          outputSchema: { type: "object" },
          userPromptText: null,
          promptContext: null,
        },
      ];
    },
  };
  return {
    sources,
    summary,
    record,
    runs,
    contextRecord,
    contexts,
    promptReads,
    workspace,
    deliveries,
    waits,
  };
}

it("returns a bounded invocation digest and whole-run totals without reading transcript bodies", async () => {
  const h = await harness();
  const result = await buildRunAudit(h.sources, "run", { limit: 1 });
  expect(result?.contexts).toMatchObject({
    total: 3,
    returned: 1,
    offset: 0,
    nextOffset: 1,
  });
  expect(result?.contexts.items[0]).toMatchObject({
    contextId: "ctx-0",
    pass: 1,
    current: false,
  });
  expect(result?.totals).toMatchObject({
    definitions: 2,
    invocations: 2,
    passes: 2,
    conversations: 4,
    candidates: 2,
    reviewRounds: 2,
    acceptances: 2,
    boundaries: 1,
    workspaceOperations: 2,
    deliveries: 1,
    wakeBatches: 1,
  });
  expect(result?.evidence).toBeUndefined();
  expect(result?.contexts.items[0]?.detail).toBeUndefined();
  expect(h.promptReads).toEqual([]);
});

it("reveals an exact historical pass with complete report, reviewer, candidate, prompt, and wake evidence", async () => {
  const h = await harness();
  const result = await buildRunAudit(h.sources, "run", { context: "ctx-0" });
  expect(result?.contexts.items).toHaveLength(1);
  const detail = result?.contexts.items[0]?.detail;
  expect(detail?.facts?.ledger.lastSummary).toBe(h.summary);
  expect(detail?.facts?.contract).toMatchObject({
    current: { brief: "Make the failure notice appear once." },
  });
  expect(detail?.facts?.candidates.items[0]?.output).toBe(h.summary);
  expect(detail?.facts?.certification.rounds[0]?.seats[0]?.status).toBe("pass");
  expect(detail?.facts?.advice.dispositions.advice?.disposition).toBe(
    "addressed",
  );
  expect(detail?.facts?.acceptance.receipts[0]?.candidateId).toBe("candidate");
  expect(
    detail?.agents.map((agent) => [agent.conversationId, agent.current]),
  ).toEqual([
    ["ctx-0-old", false],
    ["ctx-0-current", true],
  ]);
  expect(detail?.agents[0]?.prompts.entries[0]?.promptText).toBe(
    "Format this report",
  );
  expect(detail?.agents[0]?.metadata).toBeNull();
  expect(detail?.agents[1]?.metadata).toMatchObject({
    backend: "claude",
    costUsd: 0.35,
    turns: 3,
  });
  expect(
    result?.evidence?.workspaceOperations.map((item) => item.operation.cause),
  ).toEqual(["operation-run", "operation-ctx-0"]);
  expect(result?.evidence?.deliveries[0]).toMatchObject({
    state: "superseded",
    acceptedAt: null,
  });
  expect(result?.evidence?.wakeBatches[0]).toMatchObject({
    id: "batch",
    state: "cancelled",
    lastError: "Obsolete halt withdrawn",
  });
});

it("reports unavailable context and seat records explicitly, and rejects a guessed context identifier", async () => {
  const h = await harness();
  const record = h.record([
    { key: "check", pass: 2, contextId: "ctx-missing", startCause: "missing" },
  ]);
  h.runs.update("run", 1, {
    facts: record.facts,
    progress: record.progress,
    updatedAt: at,
  });
  const context = h.contextRecord("ctx-1");
  context.facts.seats.conversations.implementer = "missing-binding";
  context.facts.seats.replacements.implementer = 2;
  h.contexts.update("ctx-1", 1, {
    facts: context.facts,
    progress: context.progress,
    progressOccurrence: context.progressOccurrence,
    updatedAt: at,
  });
  const result = await buildRunAudit(h.sources, "run", { full: true });
  expect(result?.totals).toMatchObject({
    unavailableContexts: 1,
    missingSeatBindings: 1,
  });
  expect(
    result?.contexts.items.find((row) => row.contextId === "ctx-missing"),
  ).toMatchObject({ available: false, started: true });
  expect(
    result?.contexts.items.find((row) => row.contextId === "ctx-1")?.detail
      ?.agents,
  ).toContainEqual(
    expect.objectContaining({
      conversationId: "missing-binding",
      binding: null,
      current: true,
    }),
  );
  await expect(
    buildRunAudit(h.sources, "run", { context: "check" }),
  ).rejects.toBeInstanceOf(RunAuditContextNotFoundError);
});

it("retrieves only the requested workspace owner and run's deliveries, including prior wake memberships", async () => {
  const h = await harness();
  expect(
    h.workspace
      .operationsOf({ kind: "run", id: "run" })
      .map((row) => row.cause),
  ).toEqual(["operation-run"]);
  expect(await h.deliveries.listDeliveriesForRun("/repo", "other")).toEqual([]);
  expect(await h.deliveries.listDeliveriesForRun("/other", "run")).toEqual([]);
  expect(
    (await h.waits.listBatchesForDeliveries(["delivery"])).map((row) => row.id),
  ).toEqual(["batch"]);
  expect(await h.waits.listBatchesForDeliveries(["other"])).toEqual([]);
});

it("pages a long history by stable context ids and discloses clipped titles", async () => {
  const h = await harness();
  const record = h.record(
    Array.from({ length: 30 }, (_, index) => ({
      key: "check",
      pass: index + 2,
      contextId: `extra-${index}`,
      startCause: `extra-${index}`,
    })),
  );
  record.facts.title = "Long run ".repeat(100);
  h.runs.update("run", 1, {
    facts: record.facts,
    progress: record.progress,
    updatedAt: at,
  });
  const first = await buildRunAudit(h.sources, "run");
  expect(first?.contexts).toMatchObject({
    total: 33,
    returned: 20,
    nextOffset: 20,
  });
  expect(first?.run.title).toHaveLength(200);
  expect(first?.run.titleOmittedChars).toBe(record.facts.title.length - 200);
  const last = await buildRunAudit(h.sources, "run", { offset: 20 });
  expect(last?.contexts).toMatchObject({ returned: 13, nextOffset: null });
  const full = await buildRunAudit(h.sources, "run", { full: true });
  expect(full?.contexts.returned).toBe(33);
  expect(full?.run.title).toBe(record.facts.title);
});

it("distinguishes unavailable transcripts from legacy transcripts without prompt records", async () => {
  const h = await harness();
  const result = await buildRunAudit(
    {
      ...h.sources,
      promptDispatches: async (id) => (id.endsWith("old") ? [] : null),
    },
    "run",
    { context: "ctx-0" },
  );
  expect(
    result?.contexts.items[0]?.detail?.agents.map(
      (agent) => agent.prompts.availability,
    ),
  ).toEqual(["not_recorded", "unavailable"]);
});
