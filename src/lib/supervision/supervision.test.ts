import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversationCheckpointsRepo } from "@/lib/conversation-checkpoints/repo";
import type { CheckpointScopeKey } from "@/lib/conversation-checkpoints/schemas";
import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { fingerprintQueuedRows } from "@/lib/workflows/conversation/checkpoint-queue-repair";
import type { CoreTurnResult } from "@/lib/conversation-core/executor";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationCoreRepo } from "@/lib/state-store/conversation-core-repo";
import { createProductionConversationHold } from "@/lib/conversation-core/production-holds";
import type { Supervision } from "./supervision";
import {
  compileWorkflow,
  workflowLaunchRequestSchema,
} from "@/lib/runs/workflow-definition";
import {
  agentStartRequest,
  checkpointPayload,
  createSupervisionHarness,
  done,
  quiesce,
} from "./testing/supervision-fixture";

let fixture: PersistenceFixture;
let h: ReturnType<typeof createSupervisionHarness>;

async function launch(
  s: Supervision,
  runId: string,
  turnsSettle = true,
): Promise<void> {
  await s.runs.launch({
    runId,
    cause: `launch-${runId}`,
    kind: "agent",
    title: "Fix the notice",
    projectPath: "/repo",
    sessionName: "session",
    owner: { conversationId: "owner-1", sessionName: "session" },
    contexts: [
      { key: "agent", dependsOn: [], request: agentStartRequest(runId) },
    ],
  });
  await quiesce(s, turnsSettle);
}

beforeEach(() => {
  fixture = createPersistenceFixture();
  h = createSupervisionHarness(fixture);
});
afterEach(() => fixture.close());

describe("run supervision", () => {
  it("runs an enrolled conversation's queued message on the core when its queue is drained, and after a restart", async () => {
    createConversationCoreRepo(fixture.db).enrollInteractive({
      conversationId: "chat-1",
      projectPath: "/repo",
      sessionName: "session",
      enrolledAt: "2026-10-03T10:00:00.000Z",
    });
    const s = h.compose();
    h.queued.push({ deliveryAttemptId: "att-1", messageIds: ["q-1"], content: [{ type: "text", text: "First" }], command: null });
    await s.drainConversationQueue("chat-1");
    await quiesce(s);
    expect(h.userMessages).toEqual(["First"]);

    h.queued.push({ deliveryAttemptId: "att-2", messageIds: ["q-2"], content: [{ type: "text", text: "Second" }], command: null });
    const restarted = h.compose();
    await restarted.boot();
    await quiesce(restarted);
    expect(h.queueRecoveries).toEqual(["chat-1"]);
    expect(h.userMessages).toEqual(["First", "Second"]);
  });

  it("forgets at boot an enrolled conversation whose row is gone, instead of recovering it", async () => {
    const repo = createConversationCoreRepo(fixture.db);
    repo.enrollInteractive({
      conversationId: "chat-gone",
      projectPath: "/repo",
      sessionName: "session",
      enrolledAt: "2026-10-03T10:00:00.000Z",
    });
    h.deletedConversations.add("chat-gone");
    const s = h.compose();
    await s.boot();
    await quiesce(s);
    expect(h.queueRecoveries).toEqual([]);
    expect(repo.getInteractive("chat-gone")).toBeNull();
  });

  it("runs one agent end to end, gives the worktree back, and lets the next run bind it", async () => {
    const s = h.compose();
    await launch(s, "run-1");

    expect(s.runs.observe("run-1")?.record.progress).toEqual({
      kind: "succeeded",
    });
    expect(h.notified.map((b) => [b.runId, b.kind, b.detail])).toEqual([
      ["run-1", "succeeded", { outputs: { agent: { summary: "Done." } } }],
    ]);

    await launch(s, "run-2");
    expect(s.runs.observe("run-2")?.record.progress).toEqual({
      kind: "succeeded",
    });
    expect(h.turnMessages).toHaveLength(2);
  });

  it("carries a seat's question to the owner and the answer back into the seat", async () => {
    const seen: unknown[] = [];
    h.script = async (input, self) => {
      if (h.turnMessages.length > 1) return done("Used notice.ts");
      seen.push(self.seatFor(input.conversationId));
      self.requests.open({
        conversationId: input.conversationId,
        attemptId: input.attemptId,
        questionText: "Which file holds the notice?",
        questions: [{ question: "Which file holds the notice?" }],
      });
      return done("Waiting for an answer.");
    };
    const s = h.compose();
    await launch(s, "run-1");

    expect(seen).toEqual([
      { canAsk: true, attemptId: expect.any(String), openQuestionId: null },
    ]);
    expect(s.seatFor("owner-1")).toBeNull();
    const question = h.notified.find((b) => b.kind === "question");
    expect(s.runs.observe("run-1")?.record.progress.kind).toBe("needs_owner");
    const questionId = (question?.detail as { questionId: string }).questionId;
    expect(s.requests.answer(questionId, "notice.ts")).toBe(true);
    await quiesce(s);

    expect(h.turnMessages[1]).toContain("notice.ts");
    expect(s.runs.observe("run-1")?.record.progress).toEqual({
      kind: "succeeded",
    });
  });

  it("restores a run interrupted by a restart paused, with the interrupted turn visible as a halt", async () => {
    h.script = () => new Promise<CoreTurnResult>(() => {});
    const before = h.compose();
    await launch(before, "run-1", false);
    expect(h.turnMessages).toHaveLength(1);
    expect(before.runs.observe("run-1")?.record.progress).toEqual({
      kind: "running",
    });

    const after = h.compose();
    const booted = await after.boot();
    await quiesce(after);

    expect(booted.restoredRuns).toBe(1);
    expect(after.runs.observe("run-1")?.record.progress.kind).toBe("paused");
    expect(
      after.contexts.observe("run-1.agent")?.record.progress,
    ).toMatchObject({ kind: "halted", halt: "interrupted" });
    expect(h.notified.map((b) => b.kind)).toContain("restored_paused");
  });
});

describe("workflow runs on the supervision graph", () => {
  it("runs disjoint writers at the same time and their shared whole-tree check once, for the context that covers it", async () => {
    // Each writer's turn waits until both writers are working: the test fails
    // if one binding waited for the other.
    const working = new Set<string>();
    let bothWorking: () => void = () => {};
    const together = new Promise<void>((resolve) => {
      bothWorking = resolve;
    });
    h.script = async (input) => {
      const writer = ["# Build the API", "# Build the UI"].find((title) =>
        input.request.message.startsWith(title),
      );
      if (writer !== undefined) {
        working.add(writer);
        if (working.size === 2) bothWorking();
        await Promise.race([
          together,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("writers did not overlap")), 2000),
          ),
        ]);
      }
      return done("Done.");
    };
    const s = h.compose();
    const seat = {
      backend: "claude" as const,
      modelSelection: { modelId: "sonnet", parameters: {} },
    };
    const request = workflowLaunchRequestSchema.parse({
      title: "Two writers and an integration",
      contexts: [
        { key: "api", title: "Build the API", brief: "API", scope: { mode: "owned", paths: ["src/api"] }, checks: ["typecheck"] },
        { key: "ui", title: "Build the UI", brief: "UI", scope: { mode: "owned", paths: ["src/ui"] }, checks: ["typecheck"] },
        { key: "integrate", title: "Check the journey", brief: "Check", dependsOn: ["api", "ui"], scope: { mode: "readOnly" }, checks: ["typecheck"] },
      ],
    });
    const launch = compileWorkflow({
      runId: "run-w",
      cause: "launch-run-w",
      projectPath: "/repo",
      session: { sessionName: "session", worktreePath: "/repo/.worktrees/session" },
      owner: { conversationId: "owner-1", sessionName: "session" },
      request,
      seats: {
        api: { implementer: seat, reviewers: [] },
        ui: { implementer: seat, reviewers: [] },
        integrate: { implementer: seat, reviewers: [] },
      },
    });

    await s.runs.launch(launch);
    await quiesce(s);

    expect(working.size).toBe(2);
    expect(s.runs.observe("run-w")?.record.progress).toEqual({ kind: "succeeded" });
    expect(h.checksRun).toEqual([{ bindingId: "run-w.integrate", command: "typecheck" }]);
  });
});

describe("a collaboration's claim on a conversation the core runs", () => {
  beforeEach(() => {
    fixture.seedProject("/repo");
    fixture.seedSession("/repo", "session");
  });

  it("holds the person's message while the row has an owner, and admits it once the conversation is handed back", async () => {
    await fixture.seedConversation(
      "/repo",
      "session",
      makeConversationState({ id: "chat-collab", owner: { kind: "collaboration", workflowId: "wf-1", attemptEpoch: 1 } }),
    );
    createConversationCoreRepo(fixture.db).enrollInteractive({
      conversationId: "chat-collab",
      projectPath: "/repo",
      sessionName: "session",
      enrolledAt: "2026-10-03T10:00:00.000Z",
    });
    h.conversationHold = createProductionConversationHold(() => fixture.db);
    const s = h.compose();

    expect(
      await s.core.sendUserMessage({ conversationId: "chat-collab", text: "Meanwhile", inputOrigin: "user" }),
    ).toMatchObject({ kind: "refused", code: "owned" });
    // The collaboration's own claim (a reclaim) is not held by its owner.
    expect(
      await s.core.whileIdle("chat-collab", async () => "reclaimed", { kind: "collaboration_claim" }, { holds: "claim" }),
    ).toEqual({ kind: "ran", value: "reclaimed" });

    await fixture.store.mutateConversation("/repo", "session", "chat-collab", "test.release", (row) => {
      row.owner = null;
    });
    const sent = await s.core.sendUserMessage({ conversationId: "chat-collab", text: "Now", inputOrigin: "user" });
    if (sent.kind !== "accepted") throw new Error(sent.message);
    await sent.settled;
    expect(h.userMessages).toEqual(["Now"]);
  });
});

describe("run supervision boot and the checkpoints of enrolled conversations", () => {
  const BASIS = { capturedThroughSeq: 4, sourceHash: "sha256:source" };
  const LIVE_REF = { backend: "claude", ref: "sdk-live" } as const;
  const keyOf = (conversationId: string): CheckpointScopeKey => ({
    scope: "session",
    projectPath: "/repo",
    sessionName: "session",
    conversationId,
  });
  const at = () => new Date().toISOString();

  async function enrolledChat(conversationId: string, overrides: Parameters<typeof makeConversationState>[0] = {}) {
    await fixture.seedConversation(
      "/repo",
      "session",
      makeConversationState({ id: conversationId, promptCount: 2, transcriptPath: `/t/${conversationId}.jsonl`, backendRef: LIVE_REF, ...overrides }),
    );
    createConversationCoreRepo(fixture.db).enrollInteractive({
      conversationId,
      projectPath: "/repo",
      sessionName: "session",
      enrolledAt: "2026-10-03T10:00:00.000Z",
    });
  }

  function unwrap<T>(result: { ok: true; value: T } | { ok: false; refusal: { code: string } }): T {
    if (!result.ok) throw new Error(`refused: ${result.refusal.code}`);
    return result.value;
  }

  /** Drives an operation through the real repository to `phase`, as a crashed process left it. */
  async function operationAt(conversationId: string, phase: "building" | "retiring" | "delivering", binding = {}) {
    const repo = h.checkpoint.repo;
    const key = keyOf(conversationId);
    const id = `op-${conversationId}`;
    unwrap(await repo.admitOperation({ key, requestId: id, sourceBasis: BASIS, priorBackendRef: LIVE_REF.ref, requestedAt: at() }));
    if (phase === "building") return id;
    unwrap(await repo.freezePayload({ key, operationId: id, payload: checkpointPayload(id, BASIS, at()), at: at() }));
    if (phase === "retiring") return id;
    unwrap(await repo.commitReady({ key, operationId: id, at: at() }));
    unwrap(
      await repo.beginDelivery({
        key,
        operationId: id,
        binding: {
          attemptId: "attempt-crashed",
          inputFingerprint: "sha256:input",
          submittedInputFingerprint: "sha256:input",
          queuedAttemptId: null,
          queuedMessageId: null,
          ...binding,
        },
        at: at(),
      }),
    );
    return id;
  }

  function reloadedRepo() {
    return createConversationCheckpointsRepo(fixture.db, createWriteQueue(), fixture.recreateStore().checkpointContinuation);
  }

  beforeEach(() => {
    fixture.seedProject("/repo");
    fixture.seedSession("/repo", "session");
  });

  it("settles what the last process left in flight: a build fails, a retirement finishes, a delivery is held", async () => {
    await enrolledChat("chat-a");
    await enrolledChat("chat-b");
    await enrolledChat("chat-c");
    const building = await operationAt("chat-a", "building");
    const retiring = await operationAt("chat-b", "retiring");
    const delivering = await operationAt("chat-c", "delivering");

    const s = h.compose();
    await s.boot();
    await quiesce(s);

    const repo = reloadedRepo();
    expect(await repo.getOperation(keyOf("chat-a"), building)).toMatchObject({ phase: "failed" });
    expect(await repo.getOperation(keyOf("chat-b"), retiring)).toMatchObject({ phase: "ready" });
    expect((await fixture.recreateStore().getConversation("/repo", "session", "chat-b"))?.backendRef).toBeNull();
    expect(await repo.getOperation(keyOf("chat-c"), delivering)).toMatchObject({
      phase: "needs_reconciliation",
      lastStablePhase: "delivering",
    });
    expect(await s.core.sendUserMessage({ conversationId: "chat-c", text: "Hello", inputOrigin: "user" })).toMatchObject({
      kind: "refused",
      code: "busy",
    });
  });

  it("keeps a queued batch in its queue behind a delivery the restart left unresolved", async () => {
    await enrolledChat("chat-c");
    await operationAt("chat-c", "delivering");
    h.queued.push({ deliveryAttemptId: "att-1", messageIds: ["q-1"], content: [{ type: "text", text: "Next" }], command: null });

    const s = h.compose();
    await s.boot();
    await quiesce(s);

    expect(h.queued).toHaveLength(1);
    expect(h.userMessages).toEqual([]);
  });

  it("confirms queued rows an accepted delivery proves were sent, instead of sending them again", async () => {
    const row: PendingQueuedMessage = {
      id: "q-1",
      content: [{ type: "text", text: "Continue with the builder" }],
      status: "uncertain",
      enqueuedAt: "2026-10-03T10:00:00.000Z",
      updatedAt: "2026-10-03T10:00:00.000Z",
      deliveryStartedAt: "2026-10-03T10:00:00.000Z",
      deliveredAt: null,
      cancelledAt: null,
      failedAt: null,
      deliveryAttemptId: "queued-att-1",
      attemptCount: 1,
      error: null,
      metadata: null,
      inputOrigin: "user",
    };
    await enrolledChat("chat-q");
    const id = await operationAt("chat-q", "delivering", {
      queuedAttemptId: "queued-att-1",
      queuedMessageId: "q-1",
      submittedInputFingerprint: fingerprintQueuedRows([row]),
    });
    unwrap(
      await h.checkpoint.repo.recordAcceptance({
        key: keyOf("chat-q"),
        operationId: id,
        acceptance: { attemptId: "attempt-crashed", seedHash: `sha256:${id}`, acceptedAt: at() },
        acceptedBackendRef: "sdk-fresh",
      }),
    );
    // The crash came after the acceptance and the fresh reference, before the queue's own receipt.
    await enrolledChat("chat-q", { backendRef: { backend: "claude", ref: "sdk-fresh" }, pendingQueue: [row] });

    const s = h.compose();
    await s.boot();
    await quiesce(s);

    expect(h.checkpoint.confirmed).toEqual(["q-1"]);
    expect(h.userMessages).toEqual([]);
    expect(await reloadedRepo().getOperation(keyOf("chat-q"), id)).toMatchObject({ phase: "applied" });
  });
});
