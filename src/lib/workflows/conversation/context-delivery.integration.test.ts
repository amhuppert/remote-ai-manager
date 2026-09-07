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
import {
  createNotepadDeliveryTracker,
  createNotepadDeliveryStateReader,
} from "@/lib/notepads/change-notices";
import { createNotepadService } from "@/lib/notepads/service";
import { createNotepadInjectionReader } from "@/lib/notepads/injection";
import { createLifecycleFixture } from "./testing/lifecycle-fixture";
import { createMockBackendRuntime } from "./testing/actor-deps-fixture";
import type { GraphWorkflowResultDelivery } from "@/lib/workflow-graph/schemas";

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
      prepareNotepadChangeNotice: (id, references) =>
        tracker.prepare(id, references),
      recordNotepadDeliveries: record,
      settleNotepadChangeNotice: (notice) => tracker.settle(notice),
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
  const tracker: ReturnType<typeof createNotepadDeliveryTracker> =
    createNotepadDeliveryTracker({
      watermarks,
      readDeliveryState: createNotepadDeliveryStateReader({ repo, comments }),
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
  expect((await tracker.prepare("c")).block).toContain("changed: comments");
});

function workflowResult(): GraphWorkflowResultDelivery {
  return {
    executionId: "workflow",
    boundarySeq: 1,
    projectPath: "/lifecycle-fixture",
    sessionName: "s",
    originConversationId: "c",
    payload: { status: "completed", output: "Completed work" },
    recordedAt: "2026-09-06T10:00:00.000Z",
    state: "delivering",
    attemptId: "receipt-attempt",
    attemptCount: 1,
    deliveredAt: null,
    effectsDeliveredAt: null,
  };
}

it("retains a required workflow receipt failure for reconciliation without another dispatch", async () => {
  let fail = true;
  let dispatches = 0;
  let recorded = 0;
  const backend = createMockBackendRuntime({
    sendTurn: async (input) => {
      dispatches++;
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
      claimWorkflowResults: async () => [workflowResult()],
      settleWorkflowResults: async () => {
        if (fail) throw new Error("workflow receipt unavailable");
        recorded++;
        return 1;
      },
      releaseWorkflowResults: async () => {
        throw new Error("An accepted claim must remain owned");
      },
    },
  });
  const request = {
    binding: fixture.binding,
    turn: { promptText: "Use the workflow result" },
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
  fail = false;
  await fixture.manager.ensureConversationLifecycle(fixture.binding);
  expect(recorded).toBe(1);
  expect(dispatches).toBe(1);
});

it("releases claimed workflow context when a later preparation step fails", async () => {
  let claimed = false;
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
      claimWorkflowResults: async () => {
        claimed = true;
        return [workflowResult()];
      },
      releaseWorkflowResults: async () => {
        claimed = false;
        return 1;
      },
      getDebugLogUrl: () => {
        throw new Error("context preparation unavailable");
      },
    },
  });
  const turn = await fixture.manager.submitConversationTurn({
    binding: fixture.binding,
    turn: { promptText: "Prepare context" },
  });
  if (turn.kind !== "accepted") throw new Error(turn.message);
  await turn.turn.completed;
  expect(claimed).toBe(false);
  expect(dispatches).toBe(0);
});

it("consumes only notices prepared for successful runtime creation and reuses that runtime", async () => {
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
          await fixture!.persistence.store.mutateConversation(
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
  expect(created[0]?.sessionInstructions.join("\n")).toContain(
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
  ).toEqual(["Arrived during creation"]);
});
