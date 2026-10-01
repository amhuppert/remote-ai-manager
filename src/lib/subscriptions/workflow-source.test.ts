import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createGraphWorkflowResultDeliveriesRepo } from "@/lib/state-store/graph-workflow-result-deliveries-repo";
import { createSubscriptionSourceQueriesRepo } from "@/lib/state-store/subscription-source-queries-repo";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { createGraphWorkflowBoundaryEvent } from "@/lib/workflow-graph/boundary-event-projection";
import {
  createWorkflowSourceReader,
  createWorkflowTerminalSourceReader,
} from "./workflow-source";
import { createSubscriptionRuntime } from "./service-factory";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";

const projectPath = "/repo/workflow-source";
const sessionName = "session";
const recipient = { projectPath, conversationId: "origin" };
const source = { kind: "workflow", id: "execution" } as const;
const at = "2026-10-01T04:00:00.000Z";
let fixture: PersistenceFixture;
beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(projectPath);
  fixture.seedSession(projectPath, sessionName);
});
afterEach(() => fixture.close());
function deps() {
  return {
    workflows: fixture.graphWorkflowExecutions,
    archivedWorkflows: fixture.graphWorkflowArchivedExecutions,
    workflowEvents: fixture.graphWorkflowEvents,
    resultDeliveries: createGraphWorkflowResultDeliveriesRepo(fixture.db),
    queries: createSubscriptionSourceQueriesRepo(fixture.db),
    now: () => at,
  };
}
function boundary(recordResult: boolean) {
  const execution = createWorkflowExecution({
    id: source.id,
    ownerConversationId: "origin",
    status: "halted",
  });
  fixture.graphWorkflowExecutions.setActive(
    projectPath,
    sessionName,
    execution,
    at,
  );
  const event = createGraphWorkflowBoundaryEvent({
    projectPath,
    sessionName,
    execution,
    boundaryKind: "halt",
  });
  event.outputProjection = {
    kind: "declared_outputs",
    byContext: { planning: { decision: "boundary-time output" } },
  };
  const record = fixture.graphWorkflowEvents.append(
    projectPath,
    sessionName,
    source.id,
    at,
    { event, occurredAt: at, preReset: false },
  );
  const payload = {
    executionId: source.id,
    cursor: record.id,
    name: "Frozen workflow name",
    boundaryKind: "halt",
    status: "halted",
    pendingActions: [{ kind: "resume" }],
    outputs: event.outputProjection,
    haltReason: { type: "manual", reason: "boundary-time reason" },
    documents: [{ notepadId: "boundary-pad" }],
  };
  if (recordResult)
    deps().resultDeliveries.record({
      executionId: source.id,
      boundarySeq: record.id,
      projectPath,
      sessionName,
      originConversationId: "origin",
      payload,
      recordedAt: at,
      state: "pending",
      attemptId: null,
      attemptCount: 0,
      deliveredAt: null,
      effectsDeliveredAt: null,
    });
  return { execution, record, payload };
}
it("gives origin and another subscriber identical frozen boundary evidence after later execution changes", async () => {
  const h = boundary(true);
  fixture.graphWorkflowExecutions.setActive(
    projectPath,
    sessionName,
    { ...h.execution, status: "running", sharedDocuments: [] },
    at,
  );
  const origin = await createWorkflowSourceReader(deps())(
    recipient,
    source,
    "0",
  );
  const peer = await createWorkflowSourceReader(deps())(
    { ...recipient, conversationId: "peer" },
    source,
    "0",
  );
  expect(peer).toEqual(origin);
  expect(origin.facts[0]).toMatchObject({
    occurrenceId: String(h.record.id),
    sourceTitle: "Frozen workflow name",
    sourceText: expect.any(String),
  });
  expect(JSON.parse(origin.facts[0]?.sourceText ?? "null")).toEqual(h.payload);
});
it("preserves exact legacy boundary event evidence without reconstructing missing frozen metadata", async () => {
  const h = boundary(false);
  const read = await createWorkflowSourceReader(deps())(recipient, source, "0");
  expect(JSON.parse(read.facts[0]?.sourceText ?? "null")).toMatchObject({
    boundaryEvent: h.record.event,
    evidence: "legacy-boundary-event",
  });
  expect(read.facts[0]?.sourceText).not.toContain("Frozen workflow name");
  expect(
    await createWorkflowSourceReader(deps())(
      { ...recipient, projectPath: "/other" },
      source,
      "0",
    ),
  ).toEqual({ cursor: "0", facts: [], missing: true });
});
it("gives a terminal finite wait the same boundary occurrence and full evidence as passive delivery", async () => {
  const h = boundary(true);
  const passive = await createWorkflowSourceReader(deps())(
    recipient,
    source,
    "0",
  );
  const terminal = await createWorkflowTerminalSourceReader(deps())(
    recipient,
    source,
  );
  expect(terminal).toEqual({ kind: "terminal", fact: passive.facts[0] });
  expect(terminal).toMatchObject({
    fact: { occurrenceId: String(h.record.id) },
  });
});
it("preserves accepted inbox evidence for a surviving project recipient after source-session deletion and blocks a deleted recipient", async () => {
  const h = boundary(true);
  const projectRecipient = { projectPath, conversationId: "project-recipient" };
  const sessionRecipient = { projectPath, conversationId: "session-recipient" };
  await fixture.seedProjectConversation(
    projectPath,
    makeConversationState({ id: projectRecipient.conversationId }),
  );
  await fixture.seedConversation(
    projectPath,
    sessionName,
    makeConversationState({ id: sessionRecipient.conversationId }),
  );
  const runtime = createSubscriptionRuntime(fixture.db, createWriteQueue());
  for (const recipient of [projectRecipient, sessionRecipient])
    await runtime.service.autoFollow({
      recipient,
      source,
      reason: "Follow boundary evidence",
      initialCursor: "0",
    });
  const accepted = await runtime.service.prepareBriefing({
    recipient: projectRecipient,
    attemptId: "project-accepted",
  });
  expect(accepted.block).toContain("Frozen workflow name");
  await accepted.onInputAccepted();
  await runtime.service.reconcile(sessionRecipient);
  await fixture.store.deleteSessionRow(
    projectPath,
    sessionName,
    "test.delete-workflow-session",
  );
  expect(
    deps().resultDeliveries.findByBoundary(
      projectPath,
      sessionName,
      source.id,
      h.record.id,
    ),
  ).toBeNull();
  expect(
    await runtime.service.prepareBriefing({
      recipient: sessionRecipient,
      attemptId: "deleted-recipient",
    }),
  ).toMatchObject({ block: null });
  const restarted = createSubscriptionRuntime(fixture.db, createWriteQueue());
  const history = await restarted.service.readInbox(projectRecipient, {
    includeSettled: true,
  });
  const saved = history.items.find(
    (row) => row.fact.occurrenceId === String(h.record.id),
  );
  expect(saved).toMatchObject({ state: "accepted", attemptCount: 1 });
  if (!saved) throw Error("Expected preserved workflow snapshot");
  expect(JSON.parse(saved?.fact.sourceText ?? "null")).toEqual(h.payload);
  expect(history.items).toContainEqual(
    expect.objectContaining({
      fact: expect.objectContaining({ eventKind: "source_missing" }),
      state: "pending",
    }),
  );
  expect(
    await restarted.service.recordNotice({
      recipient: sessionRecipient,
      source,
      fact: { ...saved.fact, occurrenceId: "unreachable" },
      reason: "Deleted recipient",
    }),
  ).toBe(false);
});
