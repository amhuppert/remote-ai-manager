import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createControlPermits,
  type ControlPermits,
} from "@/lib/control/permits";
import type { OwnerRef, PendingIntent } from "@/lib/intents/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createControlPermitsRepo } from "@/lib/state-store/control-permits-repo";
import { createConversationCoreRepo } from "@/lib/state-store/conversation-core-repo";
import {
  createWorkspaceAdmission,
  type WorkspaceAdmission,
} from "@/lib/workspace/admission";
import {
  type ConversationCoreDeps,
  createConversationCore,
  type ConversationCore,
  type SeatTurnPort,
  type UserTurnPort,
  type CoreTurnResult,
  type TaskTurn,
  type TaskTurnPort,
} from "./executor";
import { taskTurnRequestSchema } from "@/lib/workflows/conversation/turn-spec";
import type { TurnExecutionOutcome } from "@/lib/workflows/conversation/turn-result";
import { settledConversationTurn } from "@/lib/workflows/conversation/testing/turn-result-fixture";
import {
  createConversationRequests,
  type ConversationRequests,
} from "./requests";
import type { SeatTurnRequest } from "./schemas";

const now = "2026-10-03T10:00:00.000Z";
const worktree = "/repo/.worktrees/session";

let fixture: PersistenceFixture;
let permits: ControlPermits;
let admission: WorkspaceAdmission;
let requests: ConversationRequests;
let touched: OwnerRef[];
let spawned: number;
let turnCalls: Array<{
  conversationId: string;
  request: SeatTurnRequest;
  signal: AbortSignal;
  attemptId: string;
}>;
let nextResult: () => Promise<CoreTurnResult>;
let freeSlots: number;
/** Seats waiting in line for model capacity, served first come, first served. */
let slotWaiters: Array<() => void>;
function releaseSlot(): void {
  const next = slotWaiters.shift();
  if (next !== undefined) next();
  else freeSlots += 1;
}

const ok = (finalText = "Done."): CoreTurnResult => ({
  status: "succeeded",
  finalText,
  structuredOutput: null,
  outputIssue: null,
  failure: null,
});

function commitTask(): TaskTurn {
  return taskTurnRequestSchema.parse({
    kind: "task_run",
    promptText: "Write a commit message",
    executionClass: "nongoverned-task",
  });
}

function taskOutcome(text: string): TurnExecutionOutcome {
  const execution = settledConversationTurn({ outcome: { kind: "completed", text } });
  if (execution.kind !== "settled") throw new Error("fixture");
  return execution.turn.outcome;
}

const turns: SeatTurnPort = {
  async run(input) {
    turnCalls.push(input);
    return nextResult();
  },
};

let interrupted: Array<{ projectPath: string; storeSessionName: string; conversationId: string }>;
let withdrawn: string[];
let queuedRequests: unknown[];
let notStarted: { cause: string; reason: string; endedBy: string }[];
let taskCalls: string[];
let nextTaskRun: () => Promise<{ result: CoreTurnResult; outcome: TurnExecutionOutcome }>;
let userCalls: Array<{ conversationId: string; text: string; signal: AbortSignal; streamed: boolean }>;
let nextUserResult: () => Promise<CoreTurnResult>;

const taskTurns: TaskTurnPort = {
  async run(input) {
    taskCalls.push(input.request.promptText);
    return nextTaskRun();
  },
};

const userTurns: UserTurnPort = {
  notStarted(input) {
    notStarted.push({ cause: input.cause, reason: input.reason, endedBy: input.endedBy });
  },
  async run(input) {
    queuedRequests.push(input.request);
    userCalls.push({
      conversationId: input.conversationId,
      text: input.request.text,
      signal: input.signal,
      streamed: input.stream !== null,
    });
    input.stream?.emit("content", { type: "text", text: "Hi." });
    return nextUserResult();
  },
};

let questionsPending: Set<string>;
let questionWithdrawals: string[];
let claims: string[];

function records(): ConversationCoreDeps["records"] {
  return {
    async recordInterrupted(identity) {
      interrupted.push(identity);
    },
    async recordWithdrawn(identity, unsent) {
      withdrawn.push(`${identity.conversationId}:${unsent.request.text}`);
    },
    async claimTurn(identity) {
      claims.push(`claim:${identity.conversationId}`);
    },
    async endClaim(identity) {
      claims.push(`end:${identity.conversationId}`);
    },
    hasPendingQuestion: (identity) => questionsPending.has(identity.conversationId),
    async withdrawQuestion(identity) {
      if (!questionsPending.delete(identity.conversationId)) return false;
      questionWithdrawals.push(identity.conversationId);
      return true;
    },
  };
}

function newCore(overrides: Partial<ConversationCoreDeps> = {}): ConversationCore {
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
    userTurns,
    taskTurns,
    records: records(),
    slots: {
      acquire(_label, signal) {
        if (freeSlots > 0) {
          freeSlots -= 1;
          return Promise.resolve(releaseSlot);
        }
        return new Promise((resolve, reject) => {
          const waiter = () => resolve(releaseSlot);
          slotWaiters.push(waiter);
          // Like the real semaphore, a waiter that gives up leaves the line.
          signal.addEventListener(
            "abort",
            () => {
              slotWaiters = slotWaiters.filter((queued) => queued !== waiter);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    },
    questions: requests,
    touchRequester: (owner) => touched.push(owner),
    now: () => now,
    permitPollMs: 5,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
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
      grant: { kind: "full_write" },
      writes: { mode: "all" },
    },
    seat: {
      contextId: "ctx-1",
      conversationId: null,
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
  userCalls = [];
  interrupted = [];
  withdrawn = [];
  questionsPending = new Set();
  questionWithdrawals = [];
  claims = [];
  queuedRequests = [];
  notStarted = [];
  taskCalls = [];
  nextTaskRun = async () => ({ result: ok("feat: add notices"), outcome: taskOutcome("feat: add notices") });
  nextUserResult = async () => ok("Hi.");
  freeSlots = 2;
  slotWaiters = [];
});

function enroll(conversationId = "conv-u"): void {
  createConversationCoreRepo(fixture.db).enrollInteractive({
    conversationId,
    projectPath: "/repo",
    sessionName: "session",
    enrolledAt: now,
  });
}
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
    expect(core.seatBinding("conv-1")).toMatchObject({
      contextId: "ctx-1",
      assignmentId: "implementer",
    });
    expect(touched).toContainEqual({ kind: "context", id: "ctx-1" });

    const second = workIntent({ message: "Continue" });
    await core.submit(second);
    await core.idle();
    expect(spawned).toBe(1);
    expect(turnCalls.map((c) => c.conversationId)).toEqual([
      "conv-1",
      "conv-1",
    ]);
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
    let finish: (result: CoreTurnResult) => void = () => {};
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
    expect(core.outcome(intent.cause)).toMatchObject({
      kind: "settled",
      outcome: { status: "cancelled" },
    });
  });

  it("at shutdown aborts running turns with the shutdown reason and waits for them to settle", async () => {
    const core = newCore();
    nextResult = () =>
      new Promise((resolve) => {
        const signal = turnCalls[turnCalls.length - 1]?.signal;
        signal?.addEventListener("abort", () =>
          resolve({ ...ok(), status: signal.reason === "shutdown" ? "interrupted" : "cancelled", finalText: null }),
        );
      });
    const intent = workIntent();
    await core.submit(intent);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await core.shutdown();
    expect(turnCalls[0]?.signal.reason).toBe("shutdown");
    expect(core.outcome(intent.cause)).toMatchObject({ kind: "settled", outcome: { status: "interrupted" } });
  });

  describe("a person's message to an enrolled conversation", () => {
    it("runs with no permit or workspace grant, streams to its sender, and resolves the sender's wait", async () => {
      enroll();
      const core = newCore();
      const events: string[] = [];
      const sent = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Hello",
        inputOrigin: "user",
        stream: { emit: (event) => events.push(event) },
      });
      if (sent.kind !== "accepted") throw new Error(sent.message);

      expect(await sent.settled).toMatchObject({ status: "succeeded", conversationId: "conv-u", finalText: "Hi." });
      expect(userCalls).toEqual([expect.objectContaining({ conversationId: "conv-u", text: "Hello", streamed: true })]);
      expect(events).toEqual(["content"]);
      expect(freeSlots).toBe(2);
    });

    it("waits for a Git operation on its worktree, then holds the worktree for interactive writes while it runs", async () => {
      enroll();
      const worktree = "/repo/.worktrees/session";
      const core = newCore({ interactiveWorktree: async () => worktree });
      const publication = admission.tryAcquire({ worktree, kind: "git", holder: "publish" });
      if (publication === null) throw new Error("no grant");
      let finish: (result: CoreTurnResult) => void = () => {};
      nextUserResult = () => new Promise((resolve) => (finish = resolve));

      const sent = await core.sendUserMessage({ conversationId: "conv-u", text: "Hello", inputOrigin: "user" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(userCalls).toEqual([]);

      admission.release(publication);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(userCalls).toHaveLength(1);
      // Supervised writers still work beside it; Git operations wait for it.
      const seat = admission.tryAcquire({ worktree, kind: "scoped_write", paths: ["src"], holder: "seat" });
      expect(seat).not.toBeNull();
      if (seat !== null) admission.release(seat);
      expect(admission.tryAcquire({ worktree, kind: "git", holder: "publish-2" })).toBeNull();

      finish(ok());
      if (sent.kind === "accepted") await sent.settled;
      await core.conversationIdle("conv-u");
      expect(admission.tryAcquire({ worktree, kind: "git", holder: "publish-3" })).not.toBeNull();
    });

    it("refuses a conversation the core does not run, and one already running a turn", async () => {
      const core = newCore();
      expect(await core.sendUserMessage({ conversationId: "conv-x", text: "Hello", inputOrigin: "user" })).toMatchObject({
        kind: "refused",
        code: "not_enrolled",
      });

      enroll();
      let finish: (result: CoreTurnResult) => void = () => {};
      nextUserResult = () => new Promise((resolve) => (finish = resolve));
      const first = await core.sendUserMessage({ conversationId: "conv-u", text: "One", inputOrigin: "user" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await core.sendUserMessage({ conversationId: "conv-u", text: "Two", inputOrigin: "user" })).toMatchObject({
        kind: "refused",
        code: "busy",
      });
      finish(ok());
      if (first.kind === "accepted") await first.settled;
    });

    it("stops the conversation's running turn on request", async () => {
      enroll();
      const core = newCore();
      nextUserResult = () =>
        new Promise((resolve) =>
          userCalls[userCalls.length - 1]?.signal.addEventListener("abort", () =>
            resolve({ ...ok(), status: "cancelled", finalText: null }),
          ),
        );
      const sent = await core.sendUserMessage({ conversationId: "conv-u", text: "Long", inputOrigin: "user" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(core.stopConversation("conv-u").requested).toBe(true);
      if (sent.kind !== "accepted") throw new Error("refused");
      expect(await sent.settled).toMatchObject({ status: "cancelled" });
      await core.conversationIdle("conv-u");
      expect(core.stopConversation("conv-u").requested).toBe(false);
    });

    it("keeps a message the person stopped before it started as the one a debug retry sends again", async () => {
      enroll();
      freeSlots = 0;
      const core = newCore();
      const sent = await core.sendUserMessage({ conversationId: "conv-u", text: "Waiting", inputOrigin: "user" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      core.stopConversation("conv-u");
      if (sent.kind === "accepted") await sent.settled;
      await core.conversationIdle("conv-u");
      expect(core.lastMessageRequest("conv-u")).toMatchObject({ text: "Waiting" });
      expect(createConversationCoreRepo(fixture.db).queuedFor("conv-u")).toEqual([]);
    });

    it("withdraws a message still waiting for model capacity when the person stops it", async () => {
      enroll();
      freeSlots = 0;
      const core = newCore();
      const sent = await core.sendUserMessage({ conversationId: "conv-u", text: "Hello", inputOrigin: "user" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(core.stopConversation("conv-u").requested).toBe(true);
      if (sent.kind !== "accepted") throw new Error("refused");
      expect(await sent.settled).toMatchObject({ status: "cancelled" });
      expect(userCalls).toEqual([]);
      await core.conversationIdle("conv-u");
      expect(await core.sendUserMessage({ conversationId: "conv-u", text: "Again", inputOrigin: "user" })).toMatchObject({
        kind: "accepted",
      });
    });

    it("after a crash, withdraws a message that was still waiting to start, so the conversation takes new ones", async () => {
      enroll();
      // The process that died never gets model capacity.
      const crashed = newCore({
        slots: {
          acquire: (_label, signal) =>
            new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
        },
      });
      const image = { attachmentId: "img-1", mediaType: "image/png" as const, base64Data: "aGk=" };
      expect(
        await crashed.sendUserMessage({ conversationId: "conv-u", text: "", images: [image], inputOrigin: "user" }),
      ).toMatchObject({ kind: "accepted" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const repo = createConversationCoreRepo(fixture.db);
      const heldWhileRecording: number[] = [];
      const restarted = newCore({
        records: {
          ...records(),
          async recordWithdrawn(_identity, unsent) {
            // The mailbox keeps the only copy until its replacement is durable.
            heldWhileRecording.push(repo.queuedFor("conv-u").length);
            withdrawn.push(JSON.stringify(unsent.request.images));
          },
        },
      });
      await restarted.recover();
      expect(heldWhileRecording).toEqual([1]);
      // The person gets the whole message back, images included, to send again.
      expect(withdrawn).toEqual([JSON.stringify([image])]);
      const sent = await restarted.sendUserMessage({ conversationId: "conv-u", text: "Again", inputOrigin: "user" });
      if (sent.kind !== "accepted") throw new Error(sent.message);
      expect(await sent.settled).toMatchObject({ status: "succeeded" });
      expect(userCalls.map((call) => call.text)).toEqual(["Again"]);
      await crashed.shutdown();
    });

    it("answers the sender and frees the conversation when a turn fails before it can settle", async () => {
      enroll();
      let failSettlement = true;
      const core = newCore({
        questions: {
          openedDuring() {
            if (failSettlement) throw new Error("database is locked");
            return null;
          },
        },
      });
      const sent = await core.sendUserMessage({ conversationId: "conv-u", text: "One", inputOrigin: "user" });
      if (sent.kind !== "accepted") throw new Error(sent.message);
      expect(await sent.settled).toMatchObject({ status: "failed", failure: "database is locked" });

      failSettlement = false;
      await core.conversationIdle("conv-u");
      const next = await core.sendUserMessage({ conversationId: "conv-u", text: "Two", inputOrigin: "user" });
      if (next.kind !== "accepted") throw new Error(next.message);
      expect(await next.settled).toMatchObject({ status: "succeeded" });
    });

    it("asks an idle conversation's queue for its next turn once its mailbox is empty", async () => {
      enroll();
      const idle: string[] = [];
      const core = newCore({ onConversationIdle: (conversationId) => idle.push(conversationId) });
      const sent = await core.sendUserMessage({ conversationId: "conv-u", text: "Hello", inputOrigin: "user" });
      if (sent.kind !== "accepted") throw new Error(sent.message);
      await sent.settled;
      await core.conversationIdle("conv-u");
      expect(idle).toEqual(["conv-u"]);
    });

    it("answers a stop once the stopped turn has ended", async () => {
      enroll();
      nextUserResult = () =>
        new Promise((resolve) =>
          userCalls[userCalls.length - 1]?.signal.addEventListener("abort", () => resolve({ ...ok(), status: "cancelled" })),
        );
      const core = newCore();
      const sent = await core.sendUserMessage({ conversationId: "conv-u", text: "Long", inputOrigin: "user" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const stop = core.stopConversation("conv-u");
      expect(stop.requested).toBe(true);
      await stop.settled;
      if (sent.kind !== "accepted") throw new Error("refused");
      expect(await sent.settled).toMatchObject({ status: "cancelled" });
    });

    it("shows the conversation running while its turn waits for model capacity, and ends that once the turn is over", async () => {
      enroll();
      freeSlots = 0;
      const core = newCore();
      const sent = await core.sendUserMessage({ conversationId: "conv-u", text: "Hello", inputOrigin: "user" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(claims).toEqual(["claim:conv-u"]);
      expect(userCalls).toEqual([]);

      core.stopConversation("conv-u");
      if (sent.kind !== "accepted") throw new Error("refused");
      await sent.settled;
      await core.conversationIdle("conv-u");
      expect(claims).toEqual(["claim:conv-u", "end:conv-u"]);

      freeSlots = 1;
      const next = await core.sendUserMessage({ conversationId: "conv-u", text: "Again", inputOrigin: "user" });
      if (next.kind !== "accepted") throw new Error("refused");
      await next.settled;
      await core.conversationIdle("conv-u");
      expect(claims).toEqual(["claim:conv-u", "end:conv-u", "claim:conv-u", "end:conv-u"]);
    });

    it("after a crash, ends the claim of a turn that was still waiting to start", async () => {
      enroll();
      const crashed = newCore({
        slots: {
          acquire: (_label, signal) =>
            new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
        },
      });
      void crashed.runTask({ conversationId: "conv-u", turn: commitTask() });
      await new Promise((resolve) => setTimeout(resolve, 10));
      claims = [];

      await newCore().recover();
      expect(claims).toEqual(["end:conv-u"]);
      await crashed.shutdown();
    });

    it("runs a debug command only while nothing runs or waits, holding messages off while it does", async () => {
      enroll();
      const idle: string[] = [];
      let finish: (result: CoreTurnResult) => void = () => {};
      nextUserResult = () => new Promise((resolve) => (finish = resolve));
      const core = newCore({ onConversationIdle: (conversationId) => idle.push(conversationId) });
      const sent = await core.sendUserMessage({ conversationId: "conv-u", text: "Busy", inputOrigin: "user" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await core.whileIdle("conv-u", async () => "applied")).toEqual({ kind: "busy" });
      finish(ok());
      if (sent.kind === "accepted") await sent.settled;
      await core.conversationIdle("conv-u");
      idle.length = 0;

      let release: () => void = () => {};
      const command = core.whileIdle("conv-u", () => new Promise<string>((resolve) => (release = () => resolve("applied"))));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await core.sendUserMessage({ conversationId: "conv-u", text: "Meanwhile", inputOrigin: "user" })).toMatchObject({
        kind: "refused",
        code: "busy",
      });
      release();
      expect(await command).toEqual({ kind: "ran", value: "applied" });
      await core.conversationIdle("conv-u");
      // What the command held back (such as the queue) may run now.
      expect(idle).toEqual(["conv-u"]);
    });

    it("holds the conversation for maintenance: nothing starts until the holder lets go", async () => {
      enroll();
      const idle: string[] = [];
      const core = newCore({ onConversationIdle: (conversationId) => idle.push(conversationId) });
      const lease = core.hold("conv-u", { kind: "checkpoint", requestId: "req-1" });
      if (lease.kind !== "held") throw new Error("not held");
      expect(core.hold("conv-u", { kind: "checkpoint", requestId: "req-2" })).toMatchObject({ kind: "busy" });
      expect(await core.sendUserMessage({ conversationId: "conv-u", text: "Meanwhile", inputOrigin: "user" })).toMatchObject({
        kind: "refused",
        code: "busy",
      });
      expect(await core.whileIdle("conv-u", async () => "applied")).toEqual({ kind: "busy" });
      expect(core.isBusy("conv-u")).toBe(true);

      lease.release();
      await core.conversationIdle("conv-u");
      expect(idle).toEqual(["conv-u"]);
      expect(core.isBusy("conv-u")).toBe(false);
    });

    it("tells a holder to stop when the conversation is going away", async () => {
      enroll();
      const core = newCore();
      const lease = core.hold("conv-u", { kind: "checkpoint", requestId: "req-1" });
      if (lease.kind !== "held") throw new Error("not held");
      const retired = core.retireConversation("conv-u");
      expect(lease.signal.aborted).toBe(true);
      lease.release();
      await retired;
    });

    it("answers admission alike for every entry: a running turn holds messages, commands and claims, and a task waits its turn", async () => {
      enroll();
      let finish: (result: CoreTurnResult) => void = () => {};
      nextUserResult = () => new Promise((resolve) => (finish = resolve));
      const core = newCore({ holds: { refusal: async () => null } });
      const sent = await core.sendUserMessage({ conversationId: "conv-u", text: "Working", inputOrigin: "user" });
      if (sent.kind !== "accepted") throw new Error(sent.message);
      await new Promise((resolve) => setTimeout(resolve, 10));

      for (const turn of ["message", "command", "claim"] as const) {
        expect(await core.admission("conv-u", turn)).toMatchObject({ code: "busy" });
      }
      expect(await core.admission("conv-u", "task")).toBeNull();

      finish(ok("Done."));
      await sent.settled;
      await core.conversationIdle("conv-u");
      expect(await core.admission("conv-u", "command")).toBeNull();
    });

    it("checks a direct message's holds again when its turn comes after another admitted alongside it", async () => {
      enroll();
      let finish: (result: CoreTurnResult) => void = () => {};
      nextUserResult = () => new Promise((resolve) => (finish = resolve));
      let held: { code: "queue_review"; message: string } | null = null;
      const reads: Array<(value: null) => void> = [];
      const core = newCore({
        holds: {
          refusal: (_conversationId, turn, options) =>
            options?.betweenTurns === true
              ? Promise.resolve(turn === "message" ? held : null)
              : new Promise((resolve) => reads.push(resolve)),
        },
      });
      // A queued delivery and a direct message are admitted together, before either is in the mailbox.
      const delivery = core.sendUserMessage({
        conversationId: "conv-u",
        text: "Queued",
        inputOrigin: "user",
        queuedDelivery: { messageIds: ["q-9"], deliveryAttemptId: "att-9" },
      });
      const direct = core.sendUserMessage({ conversationId: "conv-u", text: "Direct", inputOrigin: "user" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      for (const release of reads) release(null);
      const [queued, typed] = await Promise.all([delivery, direct]);
      if (queued.kind !== "accepted" || typed.kind !== "accepted") throw new Error("not admitted");
      await new Promise((resolve) => setTimeout(resolve, 10));

      // The delivery left something to review while the direct message waited.
      held = { code: "queue_review", message: "Review queued deliveries before sending another prompt." };
      finish(ok("Done."));
      expect(await typed.settled).toMatchObject({
        status: "failed",
        failure: "Review queued deliveries before sending another prompt.",
      });
      expect(userCalls.map((call) => call.text)).toEqual(["Queued"]);
      // The person's words go back to them for review rather than being dropped.
      expect(withdrawn).toEqual(["conv-u:Direct"]);
    });

    it("passes a durable hold's own code through to every entry", async () => {
      enroll();
      const core = newCore({
        holds: {
          async refusal(_conversationId, turn) {
            return turn === "message" ? null : { code: "debug_mode", message: "Exit debug mode first" };
          },
        },
      });
      expect(await core.admission("conv-u", "command")).toEqual({ code: "debug_mode", message: "Exit debug mode first" });
      expect(await core.runTask({ conversationId: "conv-u", turn: commitTask() })).toMatchObject({
        kind: "not_started",
        message: "Exit debug mode first",
      });
      expect(await core.admission("conv-u", "message")).toBeNull();
    });

    it("refuses new work while another owner durably holds the conversation, and admits it once released", async () => {
      enroll();
      let refusal: { code: "busy" | "owned"; message: string } | null = {
        code: "owned",
        message: "A collaboration owns this conversation",
      };
      const turnsAsked: string[] = [];
      const core = newCore({
        holds: {
          async refusal(_conversationId, turn) {
            turnsAsked.push(turn);
            return refusal;
          },
        },
      });
      expect(await core.sendUserMessage({ conversationId: "conv-u", text: "Hello", inputOrigin: "user" })).toEqual({
        kind: "refused",
        code: "owned",
        message: "A collaboration owns this conversation",
      });
      expect(await core.runTask({ conversationId: "conv-u", turn: commitTask() })).toMatchObject({
        kind: "not_started",
        message: "A collaboration owns this conversation",
      });
      expect(turnsAsked).toEqual(["message", "task"]);
      expect(userCalls).toEqual([]);

      refusal = null;
      const sent = await core.sendUserMessage({ conversationId: "conv-u", text: "Now", inputOrigin: "user" });
      if (sent.kind !== "accepted") throw new Error(sent.message);
      await sent.settled;
      expect(userCalls.map((call) => call.text)).toEqual(["Now"]);
    });

    it("re-reads the holds when a claim began and ended while a message's admission was being read", async () => {
      enroll();
      let owned = false;
      const reads: string[] = [];
      let release: (value: null) => void = () => {};
      const core = newCore({
        holds: {
          async refusal(_conversationId, turn) {
            reads.push(turn);
            if (reads.length === 1) return new Promise((resolve) => (release = resolve));
            return owned ? { code: "owned", message: "A collaboration owns this conversation" } : null;
          },
        },
      });
      const sent = core.sendUserMessage({ conversationId: "conv-u", text: "Hello", inputOrigin: "user" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      // A collaboration claims the conversation and lets go of the lease while the first read is pending.
      const lease = core.hold("conv-u", { kind: "collaboration_claim" });
      if (lease.kind !== "held") throw new Error("not held");
      owned = true;
      lease.release();
      release(null);
      expect(await sent).toMatchObject({ kind: "refused", code: "owned" });
      expect(userCalls).toEqual([]);
    });

    it("asks the durable holds for exclusive work only when its caller says what it is", async () => {
      enroll();
      const asked: string[] = [];
      const core = newCore({
        holds: {
          async refusal(_conversationId, turn) {
            asked.push(turn);
            return turn === "claim" ? { code: "busy", message: "A ready checkpoint is delivered by the next ordinary conversation turn" } : null;
          },
        },
      });
      expect(
        await core.whileIdle("conv-u", async () => "claimed", { kind: "collaboration_claim" }, { holds: "claim" }),
      ).toEqual({ kind: "busy", reason: "A ready checkpoint is delivered by the next ordinary conversation turn" });
      // Leaving debug mode (or recording) is never held: the hold it would wait on may need debug mode gone.
      expect(await core.whileIdle("conv-u", async () => "applied")).toEqual({ kind: "ran", value: "applied" });
      expect(asked).toEqual(["claim"]);
      await core.conversationIdle("conv-u");
      expect(core.isBusy("conv-u")).toBe(false);
    });

    it("lets go of the conversation when reading its holds fails", async () => {
      enroll();
      const core = newCore({
        holds: {
          async refusal() {
            throw new Error("database is locked");
          },
        },
      });
      await expect(
        core.whileIdle("conv-u", async () => "claimed", { kind: "collaboration_claim" }, { holds: "claim" }),
      ).rejects.toThrow("database is locked");
      expect(core.isBusy("conv-u")).toBe(false);
    });

    it("checks a queued task's holds again when its turn comes, after the turn before it settled", async () => {
      enroll();
      let held = false;
      let finish: (result: CoreTurnResult) => void = () => {};
      nextUserResult = () => new Promise((resolve) => (finish = resolve));
      const core = newCore({
        holds: {
          async refusal() {
            return held ? { code: "busy", message: "The applied checkpoint continuation was lost" } : null;
          },
        },
      });
      await core.sendUserMessage({ conversationId: "conv-u", text: "Busy", inputOrigin: "user" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const task = core.runTask({ conversationId: "conv-u", turn: commitTask() });
      await new Promise((resolve) => setTimeout(resolve, 10));
      // The running turn loses the continuation as it settles.
      held = true;
      finish(ok());
      expect(await task).toMatchObject({ kind: "not_started", message: "The applied checkpoint continuation was lost" });
      expect(taskCalls).toEqual([]);
    });

    it("does not run a task cancelled while its turn's holds were being read", async () => {
      enroll();
      let answerTurnCheck: (refusal: null) => void = () => {};
      const core = newCore({
        holds: {
          refusal: (_conversationId, _turn, options) =>
            options?.betweenTurns === true
              ? new Promise((resolve) => (answerTurnCheck = resolve))
              : Promise.resolve(null),
        },
      });
      const cancel = new AbortController();
      const task = core.runTask({ conversationId: "conv-u", turn: commitTask(), signal: cancel.signal });
      await new Promise((resolve) => setTimeout(resolve, 10));
      cancel.abort();
      answerTurnCheck(null);
      expect(await task).toMatchObject({ kind: "not_started", reason: "cancelled" });
      await core.conversationIdle("conv-u");
      expect(taskCalls).toEqual([]);
    });

    it("does not run a task whose caller cancelled it while its admission was being checked", async () => {
      enroll();
      let answerHold: (refusal: null) => void = () => {};
      const core = newCore({
        holds: {
          refusal: () => new Promise((resolve) => (answerHold = resolve)),
        },
      });
      const cancel = new AbortController();
      const task = core.runTask({ conversationId: "conv-u", turn: commitTask(), signal: cancel.signal });
      await new Promise((resolve) => setTimeout(resolve, 10));
      cancel.abort();
      answerHold(null);
      expect(await task).toMatchObject({ kind: "not_started", reason: "cancelled" });
      await core.conversationIdle("conv-u");
      expect(taskCalls).toEqual([]);
    });

    it("keeps the request of the conversation's latest message, for a debug retry", async () => {
      enroll();
      const core = newCore();
      expect(core.lastMessageRequest("conv-u")).toBeNull();
      const image = { attachmentId: "img-1", mediaType: "image/png" as const, base64Data: "aGk=" };
      for (const message of [
        { text: "First", inputOrigin: "user" as const },
        {
          text: "It crashes",
          images: [image],
          inputOrigin: "user" as const,
          queuedDelivery: { messageIds: ["q-1"], deliveryAttemptId: "att-1" },
        },
      ]) {
        const sent = await core.sendUserMessage({ conversationId: "conv-u", ...message });
        if (sent.kind === "accepted") await sent.settled;
        await core.conversationIdle("conv-u");
      }
      await core.runTask({ conversationId: "conv-u", turn: commitTask() });
      // The queue already delivered its batch: a retry is a new message, not that delivery again.
      expect(core.lastMessageRequest("conv-u")).toEqual({
        kind: "user_message",
        text: "It crashes",
        images: [image],
        inputOrigin: "user",
      });
    });

    it("a stop with no turn running withdraws the agent's unanswered question, and lets held work run", async () => {
      enroll();
      const idle: string[] = [];
      const core = newCore({ onConversationIdle: (conversationId) => idle.push(conversationId) });
      expect(core.stopConversation("conv-u").requested).toBe(false);

      questionsPending.add("conv-u");
      const stop = core.stopConversation("conv-u");
      expect(stop.requested).toBe(true);
      await stop.settled;
      expect(questionWithdrawals).toEqual(["conv-u"]);
      expect(questionsPending.has("conv-u")).toBe(false);
      expect(idle).toEqual(["conv-u"]);
    });

    it("stopping the turn that asked withdraws its question once the turn has ended", async () => {
      enroll();
      const events: string[] = [];
      nextUserResult = () =>
        new Promise((resolve) =>
          userCalls[userCalls.length - 1]?.signal.addEventListener("abort", () => {
            // The question was asked mid-turn, after the stop was requested.
            questionsPending.add("conv-u");
            events.push("turn ended");
            resolve({ ...ok(), status: "cancelled" });
          }),
        );
      const core = newCore({ records: { ...records(), async withdrawQuestion(identity) {
        events.push("question withdrawn");
        return records().withdrawQuestion(identity);
      } } });
      await core.sendUserMessage({ conversationId: "conv-u", text: "Ask me", inputOrigin: "user" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const stop = core.stopConversation("conv-u");
      expect(stop.requested).toBe(true);
      await stop.settled;
      expect(events).toEqual(["turn ended", "question withdrawn"]);
      expect(questionsPending.has("conv-u")).toBe(false);
    });

    it("a workflow cancelling its own task leaves the person's question standing", async () => {
      enroll();
      questionsPending.add("conv-u");
      const core = newCore({
        taskTurns: {
          run: ({ signal }) =>
            new Promise((resolve) =>
              signal.addEventListener("abort", () =>
                resolve({
                  result: { ...ok(), status: "cancelled", finalText: null },
                  outcome: { kind: "not_started", reason: "cancelled", message: "stopped" },
                }),
              ),
            ),
        },
      });
      const cancel = new AbortController();
      const task = core.runTask({ conversationId: "conv-u", turn: commitTask(), signal: cancel.signal });
      await new Promise((resolve) => setTimeout(resolve, 10));
      cancel.abort();
      await task;
      await core.conversationIdle("conv-u");
      expect(questionWithdrawals).toEqual([]);
      expect(questionsPending.has("conv-u")).toBe(true);
    });

    it("retiring a conversation stops what runs, and it takes and drains nothing more", async () => {
      enroll();
      const idle: string[] = [];
      nextUserResult = () =>
        new Promise((resolve) =>
          userCalls[userCalls.length - 1]?.signal.addEventListener("abort", () => resolve({ ...ok(), status: "cancelled" })),
        );
      const core = newCore({ onConversationIdle: (conversationId) => idle.push(conversationId) });
      await core.sendUserMessage({ conversationId: "conv-u", text: "Long", inputOrigin: "user" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      await core.retireConversation("conv-u");
      expect(idle).toEqual([]);
      // Gone for good: nothing recovers or drains it at the next boot.
      expect(createConversationCoreRepo(fixture.db).getInteractive("conv-u")).toBeNull();
      expect(await core.sendUserMessage({ conversationId: "conv-u", text: "Again", inputOrigin: "user" })).toMatchObject({
        kind: "refused",
      });
      expect(userCalls.map((call) => call.text)).toEqual(["Long"]);
    });

    it("carries a queued delivery's content and identity to its turn, once", async () => {
      enroll();
      const core = newCore();
      const delivery = { messageIds: ["q-1"], deliveryAttemptId: "att-q" };
      const first = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Queued while busy",
        images: [{ attachmentId: "img-1", mediaType: "image/png", base64Data: "aGk=" }],
        inputOrigin: "user",
        queuedDelivery: delivery,
      });
      if (first.kind !== "accepted") throw new Error(first.message);
      expect(first.cause).toBe("queue:conv-u:att-q");
      await first.settled;
      expect(queuedRequests).toEqual([
        expect.objectContaining({ text: "Queued while busy", queuedDelivery: delivery, images: [expect.anything()] }),
      ]);
    });

    it("hands a queued delivery that never started back to its owner, saying who stopped it", async () => {
      enroll();
      freeSlots = 0;
      const core = newCore();
      await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Queued",
        inputOrigin: "user",
        queuedDelivery: { messageIds: ["q-1"], deliveryAttemptId: "att-q" },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      core.stopConversation("conv-u");
      await core.conversationIdle("conv-u");
      expect(notStarted).toEqual([{ cause: "queue:conv-u:att-q", reason: "cancelled before admission", endedBy: "person" }]);

      const crashed = newCore({
        slots: {
          acquire: (_label, signal) =>
            new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
        },
      });
      await crashed.sendUserMessage({
        conversationId: "conv-u",
        text: "Queued again",
        inputOrigin: "user",
        queuedDelivery: { messageIds: ["q-2"], deliveryAttemptId: "att-r" },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const repo = createConversationCoreRepo(fixture.db);
      const heldWhileReturning: number[] = [];
      const restarted = newCore({
        userTurns: {
          ...userTurns,
          notStarted(input) {
            heldWhileReturning.push(repo.queuedFor("conv-u").length);
            notStarted.push({ cause: input.cause, reason: input.reason, endedBy: input.endedBy });
          },
        },
      });
      await restarted.recover();
      // Provably never sent: the queue gets it back to deliver, before the mailbox copy goes.
      expect(notStarted[1]).toEqual({ cause: "queue:conv-u:att-r", reason: "the server restarted before it started", endedBy: "server" });
      expect(heldWhileReturning).toEqual([1]);
      expect(repo.queuedFor("conv-u")).toEqual([]);
      expect(withdrawn).toEqual([]);
      await crashed.shutdown();
    });

    it("leaves a message a server stop caught before it started for the next boot, which hands it back whole", async () => {
      enroll();
      const image = { attachmentId: "img-1", mediaType: "image/png" as const, base64Data: "aGk=" };
      const stopping = newCore({
        slots: {
          acquire: (_label, signal) =>
            new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
        },
      });
      await stopping.sendUserMessage({ conversationId: "conv-u", text: "", images: [image], inputOrigin: "user" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await stopping.shutdown();
      // Nothing settled it away: the mailbox keeps the only copy.
      expect(createConversationCoreRepo(fixture.db).queuedFor("conv-u")).toHaveLength(1);
      expect(notStarted).toEqual([]);

      const restarted = newCore({
        records: {
          ...records(),
          async recordWithdrawn(_identity, unsent) {
            withdrawn.push(JSON.stringify(unsent.request.images));
          },
        },
      });
      await restarted.recover();
      expect(withdrawn).toEqual([JSON.stringify([image])]);
      expect(createConversationCoreRepo(fixture.db).queuedFor("conv-u")).toEqual([]);
    });

    it("answers a task's caller when the conversation goes away or the server stops before the task runs", async () => {
      enroll();
      let finish: (result: CoreTurnResult) => void = () => {};
      nextUserResult = () =>
        new Promise((resolve) => {
          finish = resolve;
          userCalls[userCalls.length - 1]?.signal.addEventListener("abort", () => resolve({ ...ok(), status: "cancelled" }));
        });
      const core = newCore();
      await core.sendUserMessage({ conversationId: "conv-u", text: "Busy", inputOrigin: "user" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const waiting = core.runTask({ conversationId: "conv-u", turn: commitTask() });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await core.retireConversation("conv-u");
      expect(await waiting).toMatchObject({ kind: "not_started", reason: "cancelled" });

      enroll("conv-v");
      nextUserResult = () =>
        new Promise((resolve) =>
          userCalls[userCalls.length - 1]?.signal.addEventListener("abort", () => resolve({ ...ok(), status: "interrupted" })),
        );
      await core.sendUserMessage({ conversationId: "conv-v", text: "Busy", inputOrigin: "user" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const stopped = core.runTask({ conversationId: "conv-v", turn: commitTask() });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await core.shutdown();
      expect(await stopped).toMatchObject({ kind: "not_started", interruption: { reason: "shutdown" } });
      expect(taskCalls).toEqual([]);
      finish(ok());
    });

    it("settles a queued delivery as failed when the core itself fails to run it", async () => {
      enroll();
      const repo = createConversationCoreRepo(fixture.db);
      const core = newCore({
        repo: {
          ...repo,
          admitAttempt() {
            throw new Error("database is locked");
          },
        },
      });
      const sent = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Queued",
        inputOrigin: "user",
        queuedDelivery: { messageIds: ["q-5"], deliveryAttemptId: "att-5" },
      });
      if (sent.kind !== "accepted") throw new Error(sent.message);
      expect(await sent.settled).toMatchObject({ status: "failed", failure: "database is locked" });
      await core.conversationIdle("conv-u");
      expect(notStarted).toEqual([{ cause: "queue:conv-u:att-5", reason: "database is locked", endedBy: "failure" }]);
    });

    it("runs a workflow's task in the conversation's own turn order and hands back its outcome", async () => {
      enroll();
      let finish: (result: CoreTurnResult) => void = () => {};
      nextUserResult = () => new Promise((resolve) => (finish = resolve));
      const core = newCore();
      await core.sendUserMessage({ conversationId: "conv-u", text: "Busy", inputOrigin: "user" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const task = core.runTask({ conversationId: "conv-u", turn: commitTask() });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(taskCalls).toEqual([]);
      finish(ok());
      expect(await task).toEqual(taskOutcome("feat: add notices"));
      expect(taskCalls).toEqual(["Write a commit message"]);
    });

    it("withdraws a task its caller cancels while it waits, and refuses one for a conversation it does not run", async () => {
      enroll();
      nextUserResult = () =>
        new Promise((resolve) =>
          userCalls[userCalls.length - 1]?.signal.addEventListener("abort", () => resolve({ ...ok(), status: "cancelled" })),
        );
      const core = newCore();
      await core.sendUserMessage({ conversationId: "conv-u", text: "Busy", inputOrigin: "user" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const cancel = new AbortController();
      const task = core.runTask({ conversationId: "conv-u", turn: commitTask(), signal: cancel.signal });
      await new Promise((resolve) => setTimeout(resolve, 10));
      cancel.abort();
      expect(await task).toMatchObject({ kind: "not_started", reason: "cancelled" });

      core.stopConversation("conv-u");
      await core.conversationIdle("conv-u");
      expect(taskCalls).toEqual([]);
      expect(await core.runTask({ conversationId: "conv-x", turn: commitTask() })).toMatchObject({
        kind: "not_started",
        reason: "configuration",
      });
    });

    it("refuses a message once the server is stopping, rather than leaving its sender waiting", async () => {
      enroll();
      const core = newCore();
      await core.shutdown();
      expect(await core.sendUserMessage({ conversationId: "conv-u", text: "Hello", inputOrigin: "user" })).toMatchObject({
        kind: "refused",
        code: "stopping",
      });
    });
  });

  it("once stopping, starts no new turn: a later submission stays queued for the next boot", async () => {
    const core = newCore();
    await core.shutdown();
    const intent = workIntent();
    await core.submit(intent);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(turnCalls).toEqual([]);
    expect(core.outcome(intent.cause)).toEqual({ kind: "queued" });
  });

  it("waits in line for model capacity without a workspace grant, and starts when a slot frees", async () => {
    freeSlots = 0;
    const core = newCore();
    const intent = workIntent();
    await core.submit(intent);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(turnCalls).toEqual([]);
    const elsewhere = admission.tryAcquire({ worktree, kind: "full_write", holder: "someone-else" });
    expect(elsewhere).not.toBeNull();
    if (elsewhere !== null) admission.release(elsewhere);
    releaseSlot();
    await core.idle();
    expect(turnCalls).toHaveLength(1);
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
      requests.open({
        conversationId: call.conversationId,
        attemptId: call.attemptId,
        questionText: "Which file?",
        questions: [],
      });
      return ok("Asked my owner.");
    };
    const intent = workIntent();
    await core.submit(intent);
    await core.idle();

    const state = core.outcome(intent.cause);
    expect(state).toMatchObject({ kind: "settled" });
    const questionId =
      state.kind === "settled"
        ? (state.outcome as { openQuestionId: string | null }).openQuestionId
        : null;
    expect(questionId).not.toBeNull();
  });

  it("waits for a conflicting stable read before a write turn starts", async () => {
    const core = newCore();
    const review = admission.tryAcquire({
      worktree,
      kind: "stable_read",
      holder: "review",
    });
    const intent = workIntent();
    await core.submit(intent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turnCalls).toEqual([]);

    if (review === null) throw new Error("review not granted");
    admission.release(review);
    await core.idle();
    expect(core.outcome(intent.cause)).toMatchObject({ kind: "settled" });
  });

  it("keeps a seat's workspace grant while its agent's processes cannot be confirmed stopped", async () => {
    nextResult = async () => ({ ...ok(), runtimeUncollected: "child process cleanup could not be verified" });
    const core = newCore();
    const intent = workIntent();
    await core.submit(intent);
    await core.idle();

    expect(core.outcome(intent.cause)).toMatchObject({
      kind: "settled",
      outcome: { status: "failed", failure: expect.stringContaining("could not be confirmed stopped") },
    });
    expect(admission.tryAcquire({ worktree, kind: "full_write", holder: "someone-else" })).toBeNull();
  });

  it("fails a turn that needs that workspace at once, saying why, rather than waiting on it forever", async () => {
    nextResult = async () => ({ ...ok(), runtimeUncollected: "child process cleanup could not be verified" });
    const core = newCore();
    await core.submit(workIntent({ message: "First" }));
    await core.idle();

    nextResult = async () => ok();
    const second = workIntent({ message: "Second" });
    await core.submit(second);
    await core.idle();
    expect(core.outcome(second.cause)).toMatchObject({
      kind: "settled",
      outcome: { status: "failed", failure: expect.stringContaining("could not be confirmed stopped") },
    });
    expect(turnCalls).toHaveLength(1);
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
    repo.insertAttempt({
      attemptId: "att-x",
      conversationId: "conv-1",
      cause: admitted.cause,
      state: "admitted",
      outcome: null,
      openedAt: now,
      settledAt: null,
    });

    const restarted = newCore();
    await restarted.recover();
    expect(restarted.outcome(admitted.cause)).toMatchObject({
      kind: "settled",
      outcome: { status: "interrupted" },
    });
    expect(restarted.outcome(queued.cause)).toEqual({ kind: "queued" });
    // The seat conversation the interrupted turn ran in is idle again, with a notice.
    expect(interrupted).toEqual([{ projectPath: "/repo", storeSessionName: "session", conversationId: "conv-1" }]);
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
    const questionId = requests.open({
      conversationId: "conv-1",
      attemptId: "att-1",
      questionText: "Which file?",
      questions: [],
    });
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
      outcome: {
        kind: "answered",
        question: "Which file?",
        answer: "notice.ts",
      },
    });
    expect(touched).toContainEqual({ kind: "context", id: "ctx-1" });
  });
});
