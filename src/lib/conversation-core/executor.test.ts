import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createControlPermits, type ControlPermits } from "@/lib/control/permits";
import type { OwnerRef, PendingIntent } from "@/lib/intents/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createControlPermitsRepo } from "@/lib/state-store/control-permits-repo";
import { createConversationCoreRepo } from "@/lib/state-store/conversation-core-repo";
import { createWorkspaceAdmission, type WorkspaceAdmission } from "@/lib/workspace/admission";
import {
  createConversationCore,
  type ConversationCore,
  type SeatTurnPort,
  type SeatTurnResult,
} from "./executor";
import { createConversationRequests, type ConversationRequests } from "./requests";
import type { SeatTurnRequest } from "./schemas";

const now = "2026-10-03T10:00:00.000Z";
const worktree = "/repo/.worktrees/session";

let fixture: PersistenceFixture;
let permits: ControlPermits;
let admission: WorkspaceAdmission;
let requests: ConversationRequests;
let touched: OwnerRef[];
let spawned: number;
let turnCalls: Array<{ conversationId: string; request: SeatTurnRequest; signal: AbortSignal; attemptId: string }>;
let nextResult: () => Promise<SeatTurnResult>;
let freeSlots: number;

const ok = (finalText = "Done."): SeatTurnResult => ({
  status: "succeeded",
  finalText,
  structuredOutput: null,
  outputIssue: null,
  failure: null,
  backendRef: "session-1",
});

const turns: SeatTurnPort = {
  async run(input) {
    turnCalls.push(input);
    return nextResult();
  },
};

function newCore(): ConversationCore {
  const repo = createConversationCoreRepo(fixture.db);
  return createConversationCore({
    transaction: (fn) => fixture.db.transaction(fn)(),
    repo,
    permits,
    admission,
    async createSeatConversation() {
      spawned += 1;
      return `conv-${spawned}`;
    },
    turns,
    slots: {
      async tryAcquire() {
        if (freeSlots === 0) return null;
        freeSlots -= 1;
        return () => {
          freeSlots += 1;
        };
      },
      waitForRelease: () => new Promise(() => {}),
    },
    questions: requests,
    touchRequester: (owner) => touched.push(owner),
    now: () => now,
    permitPollMs: 5,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

let sequence = 0;
function workIntent(overrides: Partial<SeatTurnRequest> = {}): PendingIntent {
  sequence += 1;
  const request: SeatTurnRequest = {
    kind: "work",
    workspace: {
      projectPath: "/repo",
      sessionName: "session",
      worktreePath: worktree,
      access: "write",
      scope: { mode: "full" },
    },
    seat: {
      contextId: "ctx-1",
      assignmentId: "implementer",
      role: "implementer",
      assignment: {
        id: "implementer",
        profile: { tier: "builtin", id: "general-reviewer" },
        backend: "claude",
        modelSelection: { modelId: "sonnet", parameters: {} },
      },
      replacement: 0,
      canAsk: true,
    },
    message: "Implement the task",
    timeoutMs: null,
    ...overrides,
  };
  return {
    id: `intent-${sequence}`,
    requester: { kind: "context", id: "ctx-1" },
    executor: "conversation",
    cause: `ctx-1:work:${sequence}`,
    permit: permits.current("context:ctx-1"),
    request,
    recordedAt: now,
  };
}

beforeEach(() => {
  fixture = createPersistenceFixture();
  permits = createControlPermits(createControlPermitsRepo(fixture.db));
  permits.issue({ controllerId: "context:ctx-1", parent: null, now });
  admission = createWorkspaceAdmission();
  requests = createConversationRequests({
    transaction: (fn) => fixture.db.transaction(fn)(),
    repo: createConversationCoreRepo(fixture.db),
    touchRequester: (owner) => touched.push(owner),
    now: () => now,
  });
  touched = [];
  spawned = 0;
  turnCalls = [];
  nextResult = async () => ok();
  freeSlots = 2;
});
afterEach(() => fixture.close());

describe("conversation core for seats", () => {
  it("spawns the seat conversation once, runs the turn and settles a report", async () => {
    const core = newCore();
    const first = workIntent();
    await core.submit(first);
    await core.idle();

    expect(core.outcome(first.cause)).toEqual({
      kind: "settled",
      outcome: {
        status: "succeeded",
        conversationId: "conv-1",
        finalText: "Done.",
        structuredOutput: null,
        outputIssue: null,
        openQuestionId: null,
        failure: null,
      },
    });
    expect(core.seatBinding("conv-1")).toMatchObject({ contextId: "ctx-1", assignmentId: "implementer", backendRef: "session-1" });
    expect(touched).toContainEqual({ kind: "context", id: "ctx-1" });

    const second = workIntent({ message: "Continue" });
    await core.submit(second);
    await core.idle();
    expect(spawned).toBe(1);
    expect(turnCalls.map((c) => c.conversationId)).toEqual(["conv-1", "conv-1"]);
  });

  it("leaves an item queued without calling the backend while its permit is closed", async () => {
    const core = newCore();
    permits.close("context:ctx-1", now);
    const intent = workIntent();
    await core.submit(intent);
    await core.idle();

    expect(core.outcome(intent.cause)).toEqual({ kind: "queued" });
    expect(turnCalls).toEqual([]);

    const permit = permits.reopen("context:ctx-1", now);
    await core.submit({ ...intent, permit });
    await core.idle();
    expect(core.outcome(intent.cause)).toMatchObject({ kind: "settled" });
  });

  it("reports a running turn and turns an interrupt into a cancelled report", async () => {
    const core = newCore();
    let finish: (result: SeatTurnResult) => void = () => {};
    nextResult = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const intent = workIntent();
    await core.submit(intent);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(core.outcome(intent.cause)).toEqual({ kind: "running" });
    await core.interrupt?.(intent.cause);
    expect(turnCalls[0]?.signal.aborted).toBe(true);
    finish({ ...ok(), status: "cancelled", finalText: null });
    await core.idle();
    expect(core.outcome(intent.cause)).toMatchObject({ kind: "settled", outcome: { status: "cancelled" } });
  });

  it("settles a thrown turn as failed with its message", async () => {
    const core = newCore();
    nextResult = async () => {
      throw new Error("provider exploded");
    };
    const intent = workIntent();
    await core.submit(intent);
    await core.idle();
    expect(core.outcome(intent.cause)).toMatchObject({
      kind: "settled",
      outcome: { status: "failed", failure: "provider exploded" },
    });
  });

  it("reports the question a seat opened during its turn", async () => {
    const core = newCore();
    nextResult = async () => {
      const call = turnCalls.at(-1);
      if (call === undefined) throw new Error("no call");
      requests.open({ conversationId: call.conversationId, attemptId: call.attemptId, questionText: "Which file?", questions: [] });
      return ok("Asked my owner.");
    };
    const intent = workIntent();
    await core.submit(intent);
    await core.idle();

    const state = core.outcome(intent.cause);
    expect(state).toMatchObject({ kind: "settled" });
    const questionId = state.kind === "settled" ? (state.outcome as { openQuestionId: string | null }).openQuestionId : null;
    expect(questionId).not.toBeNull();
  });

  it("waits for a conflicting stable read before a write turn starts", async () => {
    const core = newCore();
    const review = admission.tryAcquire({ worktree, kind: "stable_read", holder: "review" });
    const intent = workIntent();
    await core.submit(intent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turnCalls).toEqual([]);

    if (review === null) throw new Error("review not granted");
    admission.release(review);
    await core.idle();
    expect(core.outcome(intent.cause)).toMatchObject({ kind: "settled" });
  });

  it("after a restart reports an admitted turn as interrupted and requeues an unadmitted one", async () => {
    const repo = createConversationCoreRepo(fixture.db);
    const core = newCore();
    permits.close("context:ctx-1", now);
    const queued = workIntent();
    await core.submit(queued);
    await core.idle();
    permits.reopen("context:ctx-1", now);

    const admitted = workIntent();
    repo.insertMailboxIfAbsent({
      cause: admitted.cause,
      conversationId: "conv-1",
      requester: admitted.requester,
      request: admitted.request,
      permit: null,
      state: "queued",
      attemptId: null,
      createdAt: now,
      updatedAt: now,
    });
    repo.insertAttempt({ attemptId: "att-x", conversationId: "conv-1", cause: admitted.cause, state: "admitted", outcome: null, openedAt: now, settledAt: null });

    const restarted = newCore();
    restarted.recover();
    expect(restarted.outcome(admitted.cause)).toMatchObject({ kind: "settled", outcome: { status: "interrupted" } });
    expect(restarted.outcome(queued.cause)).toEqual({ kind: "queued" });
  });

  it("withdraws a queued item", async () => {
    const core = newCore();
    permits.close("context:ctx-1", now);
    const intent = workIntent();
    await core.submit(intent);
    await core.idle();
    await core.withdraw(intent.cause);
    expect(core.outcome(intent.cause)).toEqual({ kind: "unknown" });
  });
});

describe("conversation requests", () => {
  it("settles a wait when the owner answers and hints the waiting requester", async () => {
    const questionId = requests.open({ conversationId: "conv-1", attemptId: "att-1", questionText: "Which file?", questions: [] });
    const wait: PendingIntent = {
      id: "intent-q",
      requester: { kind: "context", id: "ctx-1" },
      executor: "requests",
      cause: `ctx-1:answer:${questionId}`,
      permit: null,
      request: { kind: "answer", questionId },
      recordedAt: now,
    };
    await requests.submit(wait);
    expect(requests.outcome(wait.cause)).toEqual({ kind: "running" });

    requests.answer(questionId, "notice.ts");
    expect(requests.outcome(wait.cause)).toEqual({
      kind: "settled",
      outcome: { kind: "answered", question: "Which file?", answer: "notice.ts" },
    });
    expect(touched).toContainEqual({ kind: "context", id: "ctx-1" });
  });
});
