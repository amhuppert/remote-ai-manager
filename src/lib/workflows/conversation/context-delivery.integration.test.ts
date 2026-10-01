import { afterEach, expect, it, vi } from "vitest";
import type {
  ConversationBackendCreateInput,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
} from "@/lib/agent-backends/conversation";
import { createNotepadsRepo } from "@/lib/state-store/notepads-repo";
import { createNotepadCommentsRepo } from "@/lib/state-store/notepad-comments-repo";
import { createNotepadDeliveryWatermarksRepo } from "@/lib/state-store/notepad-delivery-watermarks-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createNotepadAcceptedContextRecorder } from "@/lib/notepads/accepted-context";
import {
  createNotepadSourceReader,
  notepadInvolvementCursor,
} from "@/lib/subscriptions/notepad-source";
import { createNotepadService } from "@/lib/notepads/service";
import { createNotepadInjectionReader } from "@/lib/notepads/injection";
import { createLifecycleFixture } from "./testing/lifecycle-fixture";
import { createMockBackendRuntime } from "./testing/actor-deps-fixture";
import { createConversationSubscriptionsRepo } from "@/lib/state-store/conversation-subscriptions-repo";
import { createSubscriptionService } from "@/lib/subscriptions/service";

const result: ConversationBackendTurnResult = {
  backendRef: { backend: "claude", ref: "receipt-backend" },
  costUsd: 0.01,
  durationMs: 1,
  numTurns: 1,
  contextTokens: 1,
  contextWindowMax: 200000,
  contentBlocks: [{ type: "text", text: "done" }],
  aborted: false,
  compacted: false,
  failure: null,
  continuationDisposition: "retain",
};
let fixture: Awaited<ReturnType<typeof createLifecycleFixture>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

it("records the rendered notepad marker once on acceptance and leaves a late comment visible", async () => {
  const accepted = Promise.withResolvers<void>();
  const dispatched = Promise.withResolvers<ConversationBackendTurnInput>();
  const backend = createMockBackendRuntime({
    sendTurn: async (input) => {
      dispatched.resolve(input);
      await accepted.promise;
      await Promise.all([
        input.onEvent({ type: "input_accepted" }),
        input.onEvent({ type: "input_accepted" }),
      ]);
      return result;
    },
  });
  const record = vi.fn(
    async (input: Parameters<typeof tracker.recordDelivered>[0]) =>
      tracker.recordDelivered(input),
  );
  fixture = await createLifecycleFixture({
    actorDeps: {
      getConversationBackendFactory: () => ({
        backend: "claude",
        createRuntime: async () => backend,
        validateModelSelection() {},
      }),
      readNotepadForInjection: (id) => reader.readForInjection(id),
      recordNotepadDeliveries: record,
    },
  });
  const writes = createWriteQueue();
  const repo = createNotepadsRepo(fixture.persistence.db, writes);
  const comments = createNotepadCommentsRepo(fixture.persistence.db, writes);
  const watermarks = createNotepadDeliveryWatermarksRepo(
    fixture.persistence.db,
    writes,
  );
  const service = createNotepadService({
    repo,
    comments,
    publish: () => ({ delivered: true }),
    deleteNotepadContent: async () => {},
    now: () => "2026-09-06T10:00:00.000Z",
    generateId: () => crypto.randomUUID(),
  });
  const reader: ReturnType<typeof createNotepadInjectionReader> =
    createNotepadInjectionReader(service, comments);
  const tracker = createNotepadAcceptedContextRecorder({
    watermarks,
    now: () => "2026-09-06T10:05:00.000Z",
  });
  const created = await service.create({
    scope: "global",
    projectPath: null,
    name: "Receipt notes",
    content: "# Notes\nRendered body",
    writeMode: "full-edit",
  });
  if (!created.ok) throw new Error(created.error.message);
  const notepadId = created.value.id;
  const turn = await fixture.manager.submitConversationTurn({
    binding: fixture.binding,
    turn: { promptText: `<notepad-ref notepad-id="${notepadId}" />` },
  });
  if (turn.kind !== "accepted") throw new Error(turn.message);
  const input = await dispatched.promise;
  expect(input.promptText).toContain("Rendered body");
  expect(await watermarks.listForConversation("c")).toEqual([]);
  await comments.create({
    id: "late-comment",
    notepadId,
    anchor: {
      sectionId: "notes",
      headingLabel: "Notes",
      line: 2,
      charStart: 0,
      charEnd: 8,
      quote: "Rendered",
      prefix: "",
      suffix: " body",
      notepadRevision: 1,
    },
    body: "Arrived after composition",
    authorKind: "user",
    authorConversationId: null,
    createdAt: "2026-09-06T10:01:00.000Z",
  });
  accepted.resolve();
  expect((await turn.turn.completed).outcome.kind).toBe("call_result");
  expect(record).toHaveBeenCalledTimes(1);
  expect((await watermarks.listForConversation("c"))[0]?.openComments).toEqual({
    count: 0,
    latestCreatedAt: null,
  });
  const seen = (await watermarks.listForConversation("c"))[0];
  if (!seen) throw new Error("Expected exact accepted source context");
  expect(seen.commentIds).toEqual([]);
  const changed = await createNotepadSourceReader({
    notepads: repo,
    comments,
    watermarks,
  })(
    { projectPath: "/lifecycle-fixture", conversationId: "c" },
    { kind: "notepad", id: notepadId },
    notepadInvolvementCursor(seen),
  );
  expect(changed.facts).toMatchObject([
    {
      occurrenceId: "notepad-comment:late-comment",
      eventKind: "notepad-comment-added",
    },
  ]);
});

async function prepareWorkflowNotice(
  active: Awaited<ReturnType<typeof createLifecycleFixture>>,
  beforeSettle?: () => void,
) {
  const repo = createConversationSubscriptionsRepo(
    active.persistence.db,
    createWriteQueue(),
  );
  const recipient = {
    projectPath: active.identity.projectPath,
    conversationId: active.identity.conversationId,
  };
  const service = createSubscriptionService({
    repo: {
      ...repo,
      async settle(...args: Parameters<typeof repo.settle>) {
        beforeSettle?.();
        return repo.settle(...args);
      },
    },
    isRecipientEligible: async () => true,
    readSource: async (_recipient, _source, cursor) => ({
      cursor,
      missing: false,
      facts: [],
    }),
    now: () => "2026-09-06T10:00:00.000Z",
  });
  await service.recordNotice({
    recipient,
    source: { kind: "workflow", id: "workflow" },
    fact: {
      occurrenceId: "1",
      eventKind: "workflow-completed",
      category: "outcome",
      sourceTitle: "Workflow",
      summary: "Completed work",
      sourceText: "Full completed work evidence",
      occurredAt: "2026-09-06T10:00:00.000Z",
      revision: null,
      outcome: "completed",
      retrievalHandle: "cctl workflow read workflow",
      actorConversationId: null,
    },
    reason: "Originated workflow",
  });
  return { repo, service, recipient };
}

it("repairs a required subscription receipt without dispatching workflow evidence twice", async () => {
  let fail = true;
  let dispatches = 0;
  let recorded = 0;
  const backend = createMockBackendRuntime({
    sendTurn: async (input) => {
      dispatches++;
      expect(input.promptText).toContain("Completed work");
      expect(input.promptText).not.toContain("<workflow-results>");
      await input.onEvent({ type: "input_accepted" });
      return result;
    },
  });
  fixture = await createLifecycleFixture({
    actorDeps: {
      getConversationBackendFactory: () => ({
        backend: "claude",
        createRuntime: async () => backend,
        validateModelSelection() {},
      }),
      subscriptions: {
        prepareBriefing: (input) => notice.service.prepareBriefing(input),
      },
    },
  });
  const notice = await prepareWorkflowNotice(fixture, () => {
    if (fail) throw new Error("subscription receipt unavailable");
    recorded++;
  });
  const request = {
    binding: fixture.binding,
    turn: {
      promptText: "Use the workflow result",
      inputOrigin: "user" as const,
    },
  };
  const turn = await fixture.manager.submitConversationTurn(request);
  if (turn.kind !== "accepted") throw new Error(turn.message);
  expect((await turn.turn.completed).outcome).toMatchObject({
    kind: "settlement_failed",
    code: "delivery_receipt",
  });
  expect(await fixture.manager.submitConversationTurn(request)).toMatchObject({
    kind: "refused",
    code: "busy",
  });
  expect(
    (await notice.repo.readInbox(notice.recipient, { includeSettled: true }))
      .items[0],
  ).toMatchObject({ state: "queued", acceptedAt: null });
  fail = false;
  await fixture.manager.ensureConversationLifecycle(fixture.binding);
  expect(recorded).toBe(1);
  expect(dispatches).toBe(1);
  expect(
    (await notice.repo.readInbox(notice.recipient, { includeSettled: true }))
      .items[0],
  ).toMatchObject({ state: "accepted", attemptCount: 1 });
});

it("releases prepared subscription evidence when a later preparation step fails", async () => {
  let dispatches = 0;
  const backend = createMockBackendRuntime({
    sendTurn: async () => {
      dispatches++;
      return result;
    },
  });
  fixture = await createLifecycleFixture({
    actorDeps: {
      getConversationBackendFactory: () => ({
        backend: "claude",
        createRuntime: async () => backend,
        validateModelSelection() {},
      }),
      subscriptions: {
        prepareBriefing: (input) => notice.service.prepareBriefing(input),
      },
      getDebugLogUrl: () => {
        throw new Error("context preparation unavailable");
      },
    },
  });
  const notice = await prepareWorkflowNotice(fixture);
  const turn = await fixture.manager.submitConversationTurn({
    binding: fixture.binding,
    turn: { promptText: "Prepare context", inputOrigin: "user" },
  });
  if (turn.kind !== "accepted") throw new Error(turn.message);
  await turn.turn.completed;
  expect(
    (await notice.repo.readInbox(notice.recipient, {})).items[0],
  ).toMatchObject({ state: "failed", acceptedAt: null, attemptCount: 1 });
  expect(dispatches).toBe(0);
});

it("leaves legacy notices untouched and excludes them from runtime instructions", async () => {
  const created: ConversationBackendCreateInput[] = [];
  const backend = createMockBackendRuntime({
    sendTurn: async (input) => {
      await input.onEvent({ type: "input_accepted" });
      return result;
    },
  });
  fixture = await createLifecycleFixture({
    actorDeps: {
      getConversationBackendFactory: () => ({
        backend: "claude",
        validateModelSelection() {},
        createRuntime: async (input) => {
          created.push(input);
          if (!fixture) throw new Error("Lifecycle fixture is not ready");
          await fixture.persistence.store.mutateConversation(
            "/lifecycle-fixture",
            "s",
            "c",
            "append_notice_during_creation",
            (row) => {
              row.pendingAgentNotices.push("Arrived during creation");
            },
          );
          return backend;
        },
      }),
    },
  });
  await fixture.persistence.store.mutateConversation(
    "/lifecycle-fixture",
    "s",
    "c",
    "prepare_notice",
    (row) => {
      row.pendingAgentNotices = ["Prepared notice"];
    },
  );
  for (let index = 0; index < 2; index++) {
    const turn = await fixture.manager.submitConversationTurn({
      binding: fixture.binding,
      turn: { promptText: "Proceed" },
    });
    if (turn.kind !== "accepted") throw new Error(turn.message);
    expect((await turn.turn.completed).outcome.kind).toBe("call_result");
  }
  expect(created).toHaveLength(1);
  expect(created[0]?.sessionInstructions.join("\n")).not.toContain(
    "Prepared notice",
  );
  expect(created[0]?.sessionInstructions.join("\n")).not.toContain(
    "Arrived during creation",
  );
  expect(
    (
      await fixture.persistence.store.getConversation(
        "/lifecycle-fixture",
        "s",
        "c",
      )
    )?.pendingAgentNotices,
  ).toEqual(["Prepared notice", "Arrived during creation"]);
});
