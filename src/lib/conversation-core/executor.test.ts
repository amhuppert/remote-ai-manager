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
import { createConversationsRepo } from "@/lib/state-store/conversations-repo";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
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
  type CustodyLease,
  type RetainedRuntime,
  type LostTask,
  BACKGROUND_WORK_RUNNING,
} from "./executor";
import { BackgroundWorkUnstoppedError } from "./background-work";
import type { CustodyRow } from "./conversation-record";
import type { CustodyEnd } from "./schemas";
import { taskTurnRequestSchema } from "@/lib/conversation-core/turn/turn-spec";
import type { TurnExecutionOutcome } from "@/lib/conversation-core/turn/turn-result";
import { settledConversationTurn } from "@/lib/conversation-core/turn/testing/turn-result-fixture";
import {
  createConversationRequests,
  type ConversationRequests,
} from "./requests";
import type { SeatTurnRequest } from "./schemas";
import { createCustodyLossRecorder } from "./contributions/custody-loss";
import { createSubscriptionService } from "@/lib/subscriptions/service";
import { createConversationSubscriptionsRepo } from "@/lib/state-store/conversation-subscriptions-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";

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
  const execution = settledConversationTurn({
    outcome: { kind: "completed", text },
  });
  if (execution.kind !== "settled") throw new Error("fixture");
  return execution.turn.outcome;
}

const turns: SeatTurnPort = {
  async run(input) {
    turnCalls.push(input);
    return nextResult();
  },
};

let interrupted: Array<{
  projectPath: string;
  storeSessionName: string;
  conversationId: string;
}>;
let withdrawn: string[];
let queuedRequests: unknown[];
let notStarted: { cause: string; reason: string; endedBy: string }[];
let taskCalls: string[];
let nextTaskRun: () => Promise<{
  result: CoreTurnResult;
  outcome: TurnExecutionOutcome;
}>;
let userCalls: Array<{
  conversationId: string;
  text: string;
  signal: AbortSignal;
  streamed: boolean;
}>;
let nextUserResult: (
  input: Parameters<UserTurnPort["run"]>[0],
) => Promise<CoreTurnResult>;

const taskTurns: TaskTurnPort = {
  async run(input) {
    taskCalls.push(input.request.promptText);
    return nextTaskRun();
  },
};

const userTurns: UserTurnPort = {
  notStarted(input) {
    notStarted.push({
      cause: input.cause,
      reason: input.reason,
      endedBy: input.endedBy,
    });
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
    return nextUserResult(input);
  },
};

let questionsPending: Set<string>;
let questionWithdrawals: string[];
let claims: string[];
/** What custody showed on the row at each of its writes, as the write read it. */
let rowWrites: Array<CustodyRow | null>;
/** Runtime losses recorded for custody, as `attempt:end`. */
let losses: string[];
let lossFailures: number;
let uptime: number;

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
    hasPendingQuestion: (identity) =>
      questionsPending.has(identity.conversationId),
    async recordSegment(_identity, _usage, project) {
      rowWrites.push(project());
    },
    async withdrawQuestion(identity) {
      if (!questionsPending.delete(identity.conversationId)) return false;
      questionWithdrawals.push(identity.conversationId);
      return true;
    },
  };
}

/** The real repository, whose first `failures` mailbox removals fail as a storage error would. */
function failingDeletes(
  repo: ConversationCoreDeps["repo"],
  failures: number,
): ConversationCoreDeps["repo"] {
  let left = failures;
  return {
    ...repo,
    deleteMailbox(cause) {
      if (left > 0) {
        left -= 1;
        throw new Error("disk I/O error");
      }
      repo.deleteMailbox(cause);
    },
  };
}

function newCore(
  overrides: Partial<ConversationCoreDeps> = {},
): ConversationCore {
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
    async custodyLoss({ attemptId, end, collected }) {
      if (lossFailures > 0) {
        lossFailures -= 1;
        throw new Error("the inbox could not be written");
      }
      losses.push(`${attemptId}:${end}${collected ? "" : ":unconfirmed"}`);
    },
    uptimeMs: () => uptime,
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
    documents: [],
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
  rowWrites = [];
  losses = [];
  lossFailures = 0;
  uptime = 60_000;
  queuedRequests = [];
  notStarted = [];
  taskCalls = [];
  nextTaskRun = async () => ({
    result: ok("feat: add notices"),
    outcome: taskOutcome("feat: add notices"),
  });
  nextUserResult = async () => ok("Hi.");
  freeSlots = 2;
  slotWaiters = [];
});

/** An interactive conversation the core runs: a row in the session with no role. */
function interactiveConversation(conversationId = "conv-u"): void {
  fixture.seedProject("/repo");
  fixture.seedSession("/repo", "session");
  createConversationsRepo(fixture.db).upsert(
    "/repo",
    "session",
    makeConversationState({ id: conversationId, role: null }),
  );
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
          resolve({
            ...ok(),
            status: signal.reason === "shutdown" ? "interrupted" : "cancelled",
            finalText: null,
          }),
        );
      });
    const intent = workIntent();
    await core.submit(intent);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await core.shutdown();
    expect(turnCalls[0]?.signal.reason).toBe("shutdown");
    expect(core.outcome(intent.cause)).toMatchObject({
      kind: "settled",
      outcome: { status: "interrupted" },
    });
  });

  describe("a person's message to a conversation the core runs", () => {
    it("runs with no permit or workspace grant, streams to its sender, and resolves the sender's wait", async () => {
      interactiveConversation();
      const core = newCore();
      const events: string[] = [];
      const sent = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Hello",
        inputOrigin: "user",
        stream: { emit: (event) => events.push(event) },
      });
      if (sent.kind !== "accepted") throw new Error(sent.message);

      expect(await sent.settled).toMatchObject({
        status: "succeeded",
        conversationId: "conv-u",
        finalText: "Hi.",
      });
      expect(userCalls).toEqual([
        expect.objectContaining({
          conversationId: "conv-u",
          text: "Hello",
          streamed: true,
        }),
      ]);
      expect(events).toEqual(["content"]);
      expect(freeSlots).toBe(2);
    });

    it("waits for a Git operation on its worktree, then holds the worktree for interactive writes while it runs", async () => {
      interactiveConversation();
      const worktree = "/repo/.worktrees/session";
      const core = newCore({ interactiveWorktree: async () => worktree });
      const publication = admission.tryAcquire({
        worktree,
        kind: "git",
        holder: "publish",
      });
      if (publication === null) throw new Error("no grant");
      let finish: (result: CoreTurnResult) => void = () => {};
      nextUserResult = () => new Promise((resolve) => (finish = resolve));

      const sent = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Hello",
        inputOrigin: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(userCalls).toEqual([]);

      admission.release(publication);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(userCalls).toHaveLength(1);
      // Supervised writers still work beside it; Git operations wait for it.
      const seat = admission.tryAcquire({
        worktree,
        kind: "scoped_write",
        paths: ["src"],
        holder: "seat",
      });
      expect(seat).not.toBeNull();
      if (seat !== null) admission.release(seat);
      expect(
        admission.tryAcquire({ worktree, kind: "git", holder: "publish-2" }),
      ).toBeNull();

      finish(ok());
      if (sent.kind === "accepted") await sent.settled;
      await core.conversationIdle("conv-u");
      expect(
        admission.tryAcquire({ worktree, kind: "git", holder: "publish-3" }),
      ).not.toBeNull();
    });

    it("refuses a conversation the core does not run, and one already running a turn", async () => {
      const core = newCore();
      expect(
        await core.sendUserMessage({
          conversationId: "conv-x",
          text: "Hello",
          inputOrigin: "user",
        }),
      ).toMatchObject({
        kind: "refused",
        code: "not_core",
      });

      interactiveConversation();
      let finish: (result: CoreTurnResult) => void = () => {};
      nextUserResult = () => new Promise((resolve) => (finish = resolve));
      const first = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "One",
        inputOrigin: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(
        await core.sendUserMessage({
          conversationId: "conv-u",
          text: "Two",
          inputOrigin: "user",
        }),
      ).toMatchObject({
        kind: "refused",
        code: "busy",
      });
      finish(ok());
      if (first.kind === "accepted") await first.settled;
    });

    it("stops the conversation's running turn on request", async () => {
      interactiveConversation();
      const core = newCore();
      nextUserResult = () =>
        new Promise((resolve) =>
          userCalls[userCalls.length - 1]?.signal.addEventListener(
            "abort",
            () => resolve({ ...ok(), status: "cancelled", finalText: null }),
          ),
        );
      const sent = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Long",
        inputOrigin: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(core.stopConversation("conv-u").requested).toBe(true);
      if (sent.kind !== "accepted") throw new Error("refused");
      expect(await sent.settled).toMatchObject({ status: "cancelled" });
      await core.conversationIdle("conv-u");
      expect(core.stopConversation("conv-u").requested).toBe(false);
    });

    it("leaves a conversation to the core when its retirement's disposal fails, so its repair can still hold it", async () => {
      interactiveConversation();
      const core = newCore();

      await expect(
        core.retireConversation("conv-u", async () => {
          throw new Error("the runtime could not be closed");
        }),
      ).rejects.toThrow("the runtime could not be closed");

      const held = core.hold("conv-u", {
        kind: "checkpoint",
        requestId: "req-1",
      });
      expect(held.kind).toBe("held");
      if (held.kind === "held") held.release();
    });

    it("reports a stop as failed when the stopped turn's agent processes could not be confirmed closed", async () => {
      interactiveConversation();
      const core = newCore();
      nextUserResult = () =>
        new Promise((resolve) =>
          userCalls[userCalls.length - 1]?.signal.addEventListener(
            "abort",
            () =>
              resolve({
                ...ok(),
                status: "cancelled",
                finalText: null,
                runtimeUncollected: "the agent process did not exit",
              }),
          ),
        );
      await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Long",
        inputOrigin: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const stop = core.stopConversation("conv-u");

      expect(stop.requested).toBe(true);
      await expect(stop.settled).rejects.toThrow(
        /could not be confirmed stopped: the agent process did not exit/,
      );
    });

    it("keeps a message the person stopped before it started as the one a debug retry sends again", async () => {
      interactiveConversation();
      freeSlots = 0;
      const core = newCore();
      const sent = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Waiting",
        inputOrigin: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      core.stopConversation("conv-u");
      if (sent.kind === "accepted") await sent.settled;
      await core.conversationIdle("conv-u");
      expect(core.lastMessageRequest("conv-u")).toMatchObject({
        text: "Waiting",
      });
      expect(
        createConversationCoreRepo(fixture.db).queuedFor("conv-u"),
      ).toEqual([]);
    });

    it("withdraws a message still waiting for model capacity when the person stops it", async () => {
      interactiveConversation();
      freeSlots = 0;
      const core = newCore();
      const sent = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Hello",
        inputOrigin: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(core.stopConversation("conv-u").requested).toBe(true);
      if (sent.kind !== "accepted") throw new Error("refused");
      expect(await sent.settled).toMatchObject({ status: "cancelled" });
      expect(userCalls).toEqual([]);
      await core.conversationIdle("conv-u");
      expect(
        await core.sendUserMessage({
          conversationId: "conv-u",
          text: "Again",
          inputOrigin: "user",
        }),
      ).toMatchObject({
        kind: "accepted",
      });
    });

    it("after a crash, withdraws a message that was still waiting to start, so the conversation takes new ones", async () => {
      interactiveConversation();
      // The process that died never gets model capacity.
      const crashed = newCore({
        slots: {
          acquire: (_label, signal) =>
            new Promise((_resolve, reject) =>
              signal.addEventListener("abort", () =>
                reject(new Error("aborted")),
              ),
            ),
        },
      });
      const image = {
        attachmentId: "img-1",
        mediaType: "image/png" as const,
        base64Data: "aGk=",
      };
      expect(
        await crashed.sendUserMessage({
          conversationId: "conv-u",
          text: "",
          images: [image],
          inputOrigin: "user",
        }),
      ).toMatchObject({ kind: "accepted" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const repo = createConversationCoreRepo(fixture.db);
      const heldWhileRecording: number[] = [];
      const reasons: string[] = [];
      const restarted = newCore({
        records: {
          ...records(),
          async recordWithdrawn(_identity, unsent) {
            // The mailbox keeps the only copy until its replacement is durable.
            heldWhileRecording.push(repo.queuedFor("conv-u").length);
            withdrawn.push(JSON.stringify(unsent.request.images));
            reasons.push(unsent.reason);
          },
        },
      });
      await restarted.recover();
      expect(heldWhileRecording).toEqual([1]);
      expect(reasons).toEqual([
        "The server restarted before this message could start, so it was not sent",
      ]);
      // The person gets the whole message back, images included, to send again.
      expect(withdrawn).toEqual([JSON.stringify([image])]);
      const sent = await restarted.sendUserMessage({
        conversationId: "conv-u",
        text: "Again",
        inputOrigin: "user",
      });
      if (sent.kind !== "accepted") throw new Error(sent.message);
      expect(await sent.settled).toMatchObject({ status: "succeeded" });
      expect(userCalls.map((call) => call.text)).toEqual(["Again"]);
      await crashed.shutdown();
    });

    it("answers the sender and frees the conversation when a turn fails before it can settle", async () => {
      interactiveConversation();
      let failSettlement = true;
      const core = newCore({
        questions: {
          openedDuring() {
            if (failSettlement) throw new Error("database is locked");
            return null;
          },
        },
      });
      const sent = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "One",
        inputOrigin: "user",
      });
      if (sent.kind !== "accepted") throw new Error(sent.message);
      expect(await sent.settled).toMatchObject({
        status: "failed",
        failure: "database is locked",
      });

      failSettlement = false;
      await core.conversationIdle("conv-u");
      const next = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Two",
        inputOrigin: "user",
      });
      if (next.kind !== "accepted") throw new Error(next.message);
      expect(await next.settled).toMatchObject({ status: "succeeded" });
    });

    it("asks an idle conversation's queue for its next turn once its mailbox is empty", async () => {
      interactiveConversation();
      const idle: string[] = [];
      const core = newCore({
        onConversationIdle: (conversationId) => idle.push(conversationId),
      });
      const sent = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Hello",
        inputOrigin: "user",
      });
      if (sent.kind !== "accepted") throw new Error(sent.message);
      await sent.settled;
      await core.conversationIdle("conv-u");
      expect(idle).toEqual(["conv-u"]);
    });

    it("answers a stop once the stopped turn has ended", async () => {
      interactiveConversation();
      nextUserResult = () =>
        new Promise((resolve) =>
          userCalls[userCalls.length - 1]?.signal.addEventListener(
            "abort",
            () => resolve({ ...ok(), status: "cancelled" }),
          ),
        );
      const core = newCore();
      const sent = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Long",
        inputOrigin: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const stop = core.stopConversation("conv-u");
      expect(stop.requested).toBe(true);
      await stop.settled;
      if (sent.kind !== "accepted") throw new Error("refused");
      expect(await sent.settled).toMatchObject({ status: "cancelled" });
    });

    it("shows the conversation running while its turn waits for model capacity, and ends that once the turn is over", async () => {
      interactiveConversation();
      freeSlots = 0;
      const core = newCore();
      const sent = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Hello",
        inputOrigin: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(claims).toEqual(["claim:conv-u"]);
      expect(userCalls).toEqual([]);

      core.stopConversation("conv-u");
      if (sent.kind !== "accepted") throw new Error("refused");
      await sent.settled;
      await core.conversationIdle("conv-u");
      expect(claims).toEqual(["claim:conv-u", "end:conv-u"]);

      freeSlots = 1;
      const next = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Again",
        inputOrigin: "user",
      });
      if (next.kind !== "accepted") throw new Error("refused");
      await next.settled;
      await core.conversationIdle("conv-u");
      expect(claims).toEqual([
        "claim:conv-u",
        "end:conv-u",
        "claim:conv-u",
        "end:conv-u",
      ]);
    });

    it("after a crash, ends the claim of a turn that was still waiting to start", async () => {
      interactiveConversation();
      const crashed = newCore({
        slots: {
          acquire: (_label, signal) =>
            new Promise((_resolve, reject) =>
              signal.addEventListener("abort", () =>
                reject(new Error("aborted")),
              ),
            ),
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
      interactiveConversation();
      const idle: string[] = [];
      let finish: (result: CoreTurnResult) => void = () => {};
      nextUserResult = () => new Promise((resolve) => (finish = resolve));
      const core = newCore({
        onConversationIdle: (conversationId) => idle.push(conversationId),
      });
      const sent = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Busy",
        inputOrigin: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await core.whileIdle("conv-u", async () => "applied")).toEqual({
        kind: "busy",
      });
      finish(ok());
      if (sent.kind === "accepted") await sent.settled;
      await core.conversationIdle("conv-u");
      idle.length = 0;

      let release: () => void = () => {};
      const command = core.whileIdle(
        "conv-u",
        () =>
          new Promise<string>(
            (resolve) => (release = () => resolve("applied")),
          ),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(
        await core.sendUserMessage({
          conversationId: "conv-u",
          text: "Meanwhile",
          inputOrigin: "user",
        }),
      ).toMatchObject({
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
      interactiveConversation();
      const idle: string[] = [];
      const core = newCore({
        onConversationIdle: (conversationId) => idle.push(conversationId),
      });
      const lease = core.hold("conv-u", {
        kind: "checkpoint",
        requestId: "req-1",
      });
      if (lease.kind !== "held") throw new Error("not held");
      expect(
        core.hold("conv-u", { kind: "checkpoint", requestId: "req-2" }),
      ).toMatchObject({ kind: "busy" });
      expect(
        await core.sendUserMessage({
          conversationId: "conv-u",
          text: "Meanwhile",
          inputOrigin: "user",
        }),
      ).toMatchObject({
        kind: "refused",
        code: "busy",
      });
      expect(await core.whileIdle("conv-u", async () => "applied")).toEqual({
        kind: "busy",
      });
      expect(core.isBusy("conv-u")).toBe(true);

      lease.release();
      await core.conversationIdle("conv-u");
      expect(idle).toEqual(["conv-u"]);
      expect(core.isBusy("conv-u")).toBe(false);
    });

    it("tells a holder to stop when the conversation is going away", async () => {
      interactiveConversation();
      const core = newCore();
      const lease = core.hold("conv-u", {
        kind: "checkpoint",
        requestId: "req-1",
      });
      if (lease.kind !== "held") throw new Error("not held");
      const retired = core.retireConversation("conv-u");
      expect(lease.signal.aborted).toBe(true);
      lease.release();
      await retired;
    });

    it("answers admission alike for every entry: a running turn holds messages, commands and claims, and a task waits its turn", async () => {
      interactiveConversation();
      let finish: (result: CoreTurnResult) => void = () => {};
      nextUserResult = () => new Promise((resolve) => (finish = resolve));
      const core = newCore({ holds: { refusal: async () => null } });
      const sent = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Working",
        inputOrigin: "user",
      });
      if (sent.kind !== "accepted") throw new Error(sent.message);
      await new Promise((resolve) => setTimeout(resolve, 10));

      for (const turn of ["message", "command", "claim"] as const) {
        expect(await core.admission("conv-u", turn)).toMatchObject({
          code: "busy",
        });
      }
      expect(await core.admission("conv-u", "task")).toBeNull();

      finish(ok("Done."));
      await sent.settled;
      await core.conversationIdle("conv-u");
      expect(await core.admission("conv-u", "command")).toBeNull();
    });

    it("checks a direct message's holds again when its turn comes after another admitted alongside it", async () => {
      interactiveConversation();
      let finish: (result: CoreTurnResult) => void = () => {};
      nextUserResult = () => new Promise((resolve) => (finish = resolve));
      let held: { code: "queue_review"; message: string } | null = null;
      const reads: Array<(value: null) => void> = [];
      const repo = createConversationCoreRepo(fixture.db);
      const handedBack: Array<{ reason: string; mailbox: string | null }> = [];
      const core = newCore({
        records: {
          ...records(),
          async recordWithdrawn(_identity, unsent) {
            withdrawn.push(`conv-u:${unsent.request.text}`);
            handedBack.push({
              reason: unsent.reason,
              mailbox: repo.getMailbox(unsent.cause)?.state ?? null,
            });
          },
        },
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
      const direct = core.sendUserMessage({
        conversationId: "conv-u",
        text: "Direct",
        inputOrigin: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      for (const release of reads) release(null);
      const [queued, typed] = await Promise.all([delivery, direct]);
      if (queued.kind !== "accepted" || typed.kind !== "accepted")
        throw new Error("not admitted");
      await new Promise((resolve) => setTimeout(resolve, 10));

      // The delivery left something to review while the direct message waited.
      held = {
        code: "queue_review",
        message: "Review queued deliveries before sending another prompt.",
      };
      finish(ok("Done."));
      expect(await typed.settled).toMatchObject({
        status: "failed",
        failure: "Review queued deliveries before sending another prompt.",
      });
      expect(userCalls.map((call) => call.text)).toEqual(["Queued"]);
      // The person's words go back to them for review rather than being dropped, saying why,
      // while the mailbox still holds them: a crash in between hands them back again.
      expect(withdrawn).toEqual(["conv-u:Direct"]);
      expect(handedBack).toEqual([
        {
          reason: "Review queued deliveries before sending another prompt.",
          mailbox: "queued",
        },
      ]);
    });

    it("passes a durable hold's own code through to every entry", async () => {
      interactiveConversation();
      const core = newCore({
        holds: {
          async refusal(_conversationId, turn) {
            return turn === "message"
              ? null
              : { code: "debug_mode", message: "Exit debug mode first" };
          },
        },
      });
      expect(await core.admission("conv-u", "command")).toEqual({
        code: "debug_mode",
        message: "Exit debug mode first",
      });
      expect(
        await core.runTask({ conversationId: "conv-u", turn: commitTask() }),
      ).toMatchObject({
        kind: "not_started",
        message: "Exit debug mode first",
      });
      expect(await core.admission("conv-u", "message")).toBeNull();
    });

    it("refuses new work while another owner durably holds the conversation, and admits it once released", async () => {
      interactiveConversation();
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
      expect(
        await core.sendUserMessage({
          conversationId: "conv-u",
          text: "Hello",
          inputOrigin: "user",
        }),
      ).toEqual({
        kind: "refused",
        code: "owned",
        message: "A collaboration owns this conversation",
      });
      expect(
        await core.runTask({ conversationId: "conv-u", turn: commitTask() }),
      ).toMatchObject({
        kind: "not_started",
        message: "A collaboration owns this conversation",
      });
      expect(turnsAsked).toEqual(["message", "task"]);
      expect(userCalls).toEqual([]);

      refusal = null;
      const sent = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Now",
        inputOrigin: "user",
      });
      if (sent.kind !== "accepted") throw new Error(sent.message);
      await sent.settled;
      expect(userCalls.map((call) => call.text)).toEqual(["Now"]);
    });

    it("re-reads the holds when a claim began and ended while a message's admission was being read", async () => {
      interactiveConversation();
      let owned = false;
      const reads: string[] = [];
      let release: (value: null) => void = () => {};
      const core = newCore({
        holds: {
          async refusal(_conversationId, turn) {
            reads.push(turn);
            if (reads.length === 1)
              return new Promise((resolve) => (release = resolve));
            return owned
              ? {
                  code: "owned",
                  message: "A collaboration owns this conversation",
                }
              : null;
          },
        },
      });
      const sent = core.sendUserMessage({
        conversationId: "conv-u",
        text: "Hello",
        inputOrigin: "user",
      });
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
      interactiveConversation();
      const asked: string[] = [];
      const core = newCore({
        holds: {
          async refusal(_conversationId, turn) {
            asked.push(turn);
            return turn === "claim"
              ? {
                  code: "busy",
                  message:
                    "A ready checkpoint is delivered by the next ordinary conversation turn",
                }
              : null;
          },
        },
      });
      expect(
        await core.whileIdle(
          "conv-u",
          async () => "claimed",
          { kind: "collaboration_claim" },
          { holds: "claim" },
        ),
      ).toEqual({
        kind: "busy",
        reason:
          "A ready checkpoint is delivered by the next ordinary conversation turn",
      });
      // Leaving debug mode (or recording) is never held: the hold it would wait on may need debug mode gone.
      expect(await core.whileIdle("conv-u", async () => "applied")).toEqual({
        kind: "ran",
        value: "applied",
      });
      expect(asked).toEqual(["claim"]);
      await core.conversationIdle("conv-u");
      expect(core.isBusy("conv-u")).toBe(false);
    });

    it("lets go of the conversation when reading its holds fails", async () => {
      interactiveConversation();
      const core = newCore({
        holds: {
          async refusal() {
            throw new Error("database is locked");
          },
        },
      });
      await expect(
        core.whileIdle(
          "conv-u",
          async () => "claimed",
          { kind: "collaboration_claim" },
          { holds: "claim" },
        ),
      ).rejects.toThrow("database is locked");
      expect(core.isBusy("conv-u")).toBe(false);
    });

    it("checks a queued task's holds again when its turn comes, after the turn before it settled", async () => {
      interactiveConversation();
      let held = false;
      let finish: (result: CoreTurnResult) => void = () => {};
      nextUserResult = () => new Promise((resolve) => (finish = resolve));
      const core = newCore({
        holds: {
          async refusal() {
            return held
              ? {
                  code: "busy",
                  message: "The applied checkpoint continuation was lost",
                }
              : null;
          },
        },
      });
      await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Busy",
        inputOrigin: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const task = core.runTask({
        conversationId: "conv-u",
        turn: commitTask(),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      // The running turn loses the continuation as it settles.
      held = true;
      finish(ok());
      expect(await task).toMatchObject({
        kind: "not_started",
        message: "The applied checkpoint continuation was lost",
      });
      expect(taskCalls).toEqual([]);
    });

    it("does not run a task cancelled while its turn's holds were being read", async () => {
      interactiveConversation();
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
      const task = core.runTask({
        conversationId: "conv-u",
        turn: commitTask(),
        signal: cancel.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      cancel.abort();
      answerTurnCheck(null);
      expect(await task).toMatchObject({
        kind: "not_started",
        reason: "cancelled",
      });
      await core.conversationIdle("conv-u");
      expect(taskCalls).toEqual([]);
    });

    it("does not run a task whose caller cancelled it while its admission was being checked", async () => {
      interactiveConversation();
      let answerHold: (refusal: null) => void = () => {};
      const core = newCore({
        holds: {
          refusal: () => new Promise((resolve) => (answerHold = resolve)),
        },
      });
      const cancel = new AbortController();
      const task = core.runTask({
        conversationId: "conv-u",
        turn: commitTask(),
        signal: cancel.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      cancel.abort();
      answerHold(null);
      expect(await task).toMatchObject({
        kind: "not_started",
        reason: "cancelled",
      });
      await core.conversationIdle("conv-u");
      expect(taskCalls).toEqual([]);
    });

    it("keeps the request of the conversation's latest message, for a debug retry", async () => {
      interactiveConversation();
      const core = newCore();
      expect(core.lastMessageRequest("conv-u")).toBeNull();
      const image = {
        attachmentId: "img-1",
        mediaType: "image/png" as const,
        base64Data: "aGk=",
      };
      for (const message of [
        { text: "First", inputOrigin: "user" as const },
        {
          text: "It crashes",
          images: [image],
          inputOrigin: "user" as const,
          queuedDelivery: { messageIds: ["q-1"], deliveryAttemptId: "att-1" },
        },
      ]) {
        const sent = await core.sendUserMessage({
          conversationId: "conv-u",
          ...message,
        });
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
      interactiveConversation();
      const idle: string[] = [];
      const core = newCore({
        onConversationIdle: (conversationId) => idle.push(conversationId),
      });
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
      interactiveConversation();
      const events: string[] = [];
      nextUserResult = () =>
        new Promise((resolve) =>
          userCalls[userCalls.length - 1]?.signal.addEventListener(
            "abort",
            () => {
              // The question was asked mid-turn, after the stop was requested.
              questionsPending.add("conv-u");
              events.push("turn ended");
              resolve({ ...ok(), status: "cancelled" });
            },
          ),
        );
      const core = newCore({
        records: {
          ...records(),
          async withdrawQuestion(identity) {
            events.push("question withdrawn");
            return records().withdrawQuestion(identity);
          },
        },
      });
      await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Ask me",
        inputOrigin: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const stop = core.stopConversation("conv-u");
      expect(stop.requested).toBe(true);
      await stop.settled;
      expect(events).toEqual(["turn ended", "question withdrawn"]);
      expect(questionsPending.has("conv-u")).toBe(false);
    });

    it("a workflow cancelling its own task leaves the person's question standing", async () => {
      interactiveConversation();
      questionsPending.add("conv-u");
      const core = newCore({
        taskTurns: {
          run: ({ signal }) =>
            new Promise((resolve) =>
              signal.addEventListener("abort", () =>
                resolve({
                  result: { ...ok(), status: "cancelled", finalText: null },
                  outcome: {
                    kind: "not_started",
                    reason: "cancelled",
                    message: "stopped",
                  },
                }),
              ),
            ),
        },
      });
      const cancel = new AbortController();
      const task = core.runTask({
        conversationId: "conv-u",
        turn: commitTask(),
        signal: cancel.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      cancel.abort();
      await task;
      await core.conversationIdle("conv-u");
      expect(questionWithdrawals).toEqual([]);
      expect(questionsPending.has("conv-u")).toBe(true);
    });

    it("retiring a conversation stops what runs, and it takes and drains nothing more", async () => {
      interactiveConversation();
      const idle: string[] = [];
      nextUserResult = () =>
        new Promise((resolve) =>
          userCalls[userCalls.length - 1]?.signal.addEventListener(
            "abort",
            () => resolve({ ...ok(), status: "cancelled" }),
          ),
        );
      const core = newCore({
        onConversationIdle: (conversationId) => idle.push(conversationId),
      });
      await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Long",
        inputOrigin: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      await core.retireConversation("conv-u");
      expect(idle).toEqual([]);
      // Its row goes with the deletion that retired it; until then nothing more starts.
      expect(
        await core.sendUserMessage({
          conversationId: "conv-u",
          text: "Again",
          inputOrigin: "user",
        }),
      ).toMatchObject({
        kind: "refused",
      });
      expect(userCalls.map((call) => call.text)).toEqual(["Long"]);
    });

    it("carries a queued delivery's content and identity to its turn, once", async () => {
      interactiveConversation();
      const core = newCore();
      const delivery = { messageIds: ["q-1"], deliveryAttemptId: "att-q" };
      const first = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Queued while busy",
        images: [
          { attachmentId: "img-1", mediaType: "image/png", base64Data: "aGk=" },
        ],
        inputOrigin: "user",
        queuedDelivery: delivery,
      });
      if (first.kind !== "accepted") throw new Error(first.message);
      expect(first.cause).toBe("queue:conv-u:att-q");
      await first.settled;
      expect(queuedRequests).toEqual([
        expect.objectContaining({
          text: "Queued while busy",
          queuedDelivery: delivery,
          images: [expect.anything()],
        }),
      ]);
    });

    it("hands a queued delivery that never started back to its owner, saying who stopped it", async () => {
      interactiveConversation();
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
      expect(notStarted).toEqual([
        {
          cause: "queue:conv-u:att-q",
          reason: "cancelled before admission",
          endedBy: "person",
        },
      ]);

      const crashed = newCore({
        slots: {
          acquire: (_label, signal) =>
            new Promise((_resolve, reject) =>
              signal.addEventListener("abort", () =>
                reject(new Error("aborted")),
              ),
            ),
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
            notStarted.push({
              cause: input.cause,
              reason: input.reason,
              endedBy: input.endedBy,
            });
          },
        },
      });
      await restarted.recover();
      // Provably never sent: the queue gets it back to deliver, before the mailbox copy goes.
      expect(notStarted[1]).toEqual({
        cause: "queue:conv-u:att-r",
        reason: "the server restarted before it started",
        endedBy: "server",
      });
      expect(heldWhileReturning).toEqual([1]);
      expect(repo.queuedFor("conv-u")).toEqual([]);
      expect(withdrawn).toEqual([]);
      await crashed.shutdown();
    });

    it("leaves a message a server stop caught before it started for the next boot, which hands it back whole", async () => {
      interactiveConversation();
      const image = {
        attachmentId: "img-1",
        mediaType: "image/png" as const,
        base64Data: "aGk=",
      };
      const stopping = newCore({
        slots: {
          acquire: (_label, signal) =>
            new Promise((_resolve, reject) =>
              signal.addEventListener("abort", () =>
                reject(new Error("aborted")),
              ),
            ),
        },
      });
      await stopping.sendUserMessage({
        conversationId: "conv-u",
        text: "",
        images: [image],
        inputOrigin: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await stopping.shutdown();
      // Nothing settled it away: the mailbox keeps the only copy.
      expect(
        createConversationCoreRepo(fixture.db).queuedFor("conv-u"),
      ).toHaveLength(1);
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
      expect(
        createConversationCoreRepo(fixture.db).queuedFor("conv-u"),
      ).toEqual([]);
    });

    it("answers a task's caller when the conversation goes away or the server stops before the task runs", async () => {
      interactiveConversation();
      let finish: (result: CoreTurnResult) => void = () => {};
      nextUserResult = () =>
        new Promise((resolve) => {
          finish = resolve;
          userCalls[userCalls.length - 1]?.signal.addEventListener(
            "abort",
            () => resolve({ ...ok(), status: "cancelled" }),
          );
        });
      const core = newCore();
      await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Busy",
        inputOrigin: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const waiting = core.runTask({
        conversationId: "conv-u",
        turn: commitTask(),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await core.retireConversation("conv-u");
      expect(await waiting).toMatchObject({
        kind: "not_started",
        reason: "cancelled",
      });

      interactiveConversation("conv-v");
      nextUserResult = () =>
        new Promise((resolve) =>
          userCalls[userCalls.length - 1]?.signal.addEventListener(
            "abort",
            () => resolve({ ...ok(), status: "interrupted" }),
          ),
        );
      await core.sendUserMessage({
        conversationId: "conv-v",
        text: "Busy",
        inputOrigin: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const stopped = core.runTask({
        conversationId: "conv-v",
        turn: commitTask(),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await core.shutdown();
      expect(await stopped).toMatchObject({
        kind: "not_started",
        interruption: { reason: "shutdown" },
      });
      expect(taskCalls).toEqual([]);
      finish(ok());
    });

    it("settles a queued delivery as failed when the core itself fails to run it", async () => {
      interactiveConversation();
      const repo = createConversationCoreRepo(fixture.db);
      const order: string[] = [];
      const core = newCore({
        repo: {
          ...repo,
          admitAttempt() {
            throw new Error("database is locked");
          },
        },
        userTurns: {
          ...userTurns,
          async notStarted(input) {
            await userTurns.notStarted?.(input);
            await new Promise((resolve) => setTimeout(resolve, 5));
            order.push(
              `queue told, mailbox ${repo.getMailbox(input.cause)?.state ?? "empty"}`,
            );
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
      expect(await sent.settled).toMatchObject({
        status: "failed",
        failure: "database is locked",
      });
      order.push("sender answered");
      await core.conversationIdle("conv-u");
      expect(notStarted).toEqual([
        {
          cause: "queue:conv-u:att-5",
          reason: "database is locked",
          endedBy: "failure",
        },
      ]);
      // The queue hears before the mailbox lets go of the batch and before its sender is answered.
      expect(order).toEqual(["queue told, mailbox queued", "sender answered"]);
      expect(repo.queuedFor("conv-u")).toEqual([]);
    });

    it("runs a workflow's task in the conversation's own turn order and hands back its outcome", async () => {
      interactiveConversation();
      let finish: (result: CoreTurnResult) => void = () => {};
      nextUserResult = () => new Promise((resolve) => (finish = resolve));
      const core = newCore();
      await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Busy",
        inputOrigin: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const task = core.runTask({
        conversationId: "conv-u",
        turn: commitTask(),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(taskCalls).toEqual([]);
      finish(ok());
      expect(await task).toEqual(taskOutcome("feat: add notices"));
      expect(taskCalls).toEqual(["Write a commit message"]);
    });

    it("withdraws a task its caller cancels while it waits, and refuses one for a conversation it does not run", async () => {
      interactiveConversation();
      nextUserResult = () =>
        new Promise((resolve) =>
          userCalls[userCalls.length - 1]?.signal.addEventListener(
            "abort",
            () => resolve({ ...ok(), status: "cancelled" }),
          ),
        );
      const core = newCore();
      await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Busy",
        inputOrigin: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const cancel = new AbortController();
      const task = core.runTask({
        conversationId: "conv-u",
        turn: commitTask(),
        signal: cancel.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      cancel.abort();
      expect(await task).toMatchObject({
        kind: "not_started",
        reason: "cancelled",
      });

      core.stopConversation("conv-u");
      await core.conversationIdle("conv-u");
      expect(taskCalls).toEqual([]);
      expect(
        await core.runTask({ conversationId: "conv-x", turn: commitTask() }),
      ).toMatchObject({
        kind: "not_started",
        reason: "configuration",
      });
    });

    it("never runs a task it answered as cancelled, even when removing it failed at first", async () => {
      interactiveConversation();
      let finish: (result: CoreTurnResult) => void = () => {};
      nextUserResult = () => new Promise((resolve) => (finish = resolve));
      const repo = createConversationCoreRepo(fixture.db);
      const core = newCore({ repo: failingDeletes(repo, 1) });
      await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Busy",
        inputOrigin: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const cancel = new AbortController();
      const task = core.runTask({
        conversationId: "conv-u",
        turn: commitTask(),
        signal: cancel.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      cancel.abort();
      expect(await task).toMatchObject({
        kind: "not_started",
        reason: "cancelled",
      });

      finish(ok());
      await core.conversationIdle("conv-u");
      expect(taskCalls).toEqual([]);
      expect(repo.queuedFor("conv-u")).toEqual([]);
      expect(core.isBusy("conv-u")).toBe(false);
    });

    it("after a restart, never runs an orphaned task whose removal failed", async () => {
      interactiveConversation();
      const crashed = newCore({
        slots: {
          acquire: (_label, signal) =>
            new Promise((_resolve, reject) =>
              signal.addEventListener("abort", () =>
                reject(new Error("aborted")),
              ),
            ),
        },
      });
      void crashed.runTask({ conversationId: "conv-u", turn: commitTask() });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const core = newCore({
        repo: failingDeletes(createConversationCoreRepo(fixture.db), 1),
      });
      await core.recover();
      const summary = taskTurnRequestSchema.parse({
        kind: "task_run",
        promptText: "Summarize the session",
        executionClass: "nongoverned-task",
      });
      expect(
        await core.runTask({ conversationId: "conv-u", turn: summary }),
      ).toEqual(taskOutcome("feat: add notices"));
      expect(taskCalls).toEqual(["Summarize the session"]);
      await crashed.shutdown();
    });

    it("removes a mailbox item no request schema reads, rather than letting it hold the conversation", async () => {
      interactiveConversation();
      const repo = createConversationCoreRepo(fixture.db);
      const unreadable = (cause: string) =>
        repo.insertMailboxIfAbsent({
          cause,
          conversationId: "conv-u",
          requester: null,
          request: { kind: "user_message", text: 42 },
          permit: null,
          state: "queued",
          attemptId: null,
          createdAt: now,
          updatedAt: now,
        });
      fixture.db.transaction(() => unreadable("user:conv-u:old-shape"))();
      const core = newCore();

      const task = core.runTask({
        conversationId: "conv-u",
        turn: commitTask(),
      });
      expect(
        await Promise.race([
          task,
          new Promise((resolve) => setTimeout(() => resolve("stuck"), 300)),
        ]),
      ).toEqual(taskOutcome("feat: add notices"));

      await core.conversationIdle("conv-u");
      fixture.db.transaction(() => unreadable("user:conv-u:old-shape-2"))();
      await core.retireConversation("conv-u");
      expect(repo.queuedFor("conv-u")).toEqual([]);
    });

    it("refuses a message once the server is stopping, rather than leaving its sender waiting", async () => {
      interactiveConversation();
      const core = newCore();
      await core.shutdown();
      expect(
        await core.sendUserMessage({
          conversationId: "conv-u",
          text: "Hello",
          inputOrigin: "user",
        }),
      ).toMatchObject({
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
    const elsewhere = admission.tryAcquire({
      worktree,
      kind: "full_write",
      holder: "someone-else",
    });
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
    nextResult = async () => ({
      ...ok(),
      runtimeUncollected: "child process cleanup could not be verified",
    });
    const core = newCore();
    const intent = workIntent();
    await core.submit(intent);
    await core.idle();

    expect(core.outcome(intent.cause)).toMatchObject({
      kind: "settled",
      outcome: {
        status: "failed",
        failure: expect.stringContaining("could not be confirmed stopped"),
      },
    });
    expect(
      admission.tryAcquire({
        worktree,
        kind: "full_write",
        holder: "someone-else",
      }),
    ).toBeNull();
  });

  it("fails a turn that needs that workspace at once, saying why, rather than waiting on it forever", async () => {
    nextResult = async () => ({
      ...ok(),
      runtimeUncollected: "child process cleanup could not be verified",
    });
    const core = newCore();
    await core.submit(workIntent({ message: "First" }));
    await core.idle();

    nextResult = async () => ok();
    const second = workIntent({ message: "Second" });
    await core.submit(second);
    await core.idle();
    expect(core.outcome(second.cause)).toMatchObject({
      kind: "settled",
      outcome: {
        status: "failed",
        failure: expect.stringContaining("could not be confirmed stopped"),
      },
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
    expect(interrupted).toEqual([
      {
        projectPath: "/repo",
        storeSessionName: "session",
        conversationId: "conv-1",
      },
    ]);
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

describe("custody of a runtime that still owes work (design C5b §3)", () => {
  const worktreeOf = async () => worktree;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  async function eventually(check: () => boolean): Promise<void> {
    for (let i = 0; i < 400; i += 1) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error("it never happened");
  }
  const repo = () => createConversationCoreRepo(fixture.db);

  /** The runtime side of a custody: whether a provider turn runs in it, how its close goes, and what custody told it. */
  function retained(close: () => Promise<void> = async () => {}) {
    const told: string[] = [];
    let segment = false;
    /** Why its last close failed, as the host keeps it until a later close collects it. */
    let closeFailure: string | null = null;
    /** The tasks it reported cut short as it closed, which custody claimed. */
    let lost: LostTask[] = [];
    const runtime: RetainedRuntime = {
      segmentActive: () => segment,
      async close() {
        told.push("close");
        try {
          await close();
          closeFailure = null;
        } catch (error) {
          closeFailure = error instanceof Error ? error.message : String(error);
          throw error;
        }
      },
      closeFailure: () => closeFailure,
      lossClaimed: () => told.push("loss-claimed"),
      lostTasks: () => lost,
      released: (end: CustodyEnd) => told.push(`released:${end}`),
    };
    return {
      runtime,
      told,
      /** Its close reports these tasks cut short, as the runtime's report of lost tasks hands them to custody. */
      lose(tasks: LostTask[]) {
        lost = tasks;
      },
      segment(active: boolean) {
        segment = active;
      },
      /** A later close collected its processes. */
      confirmCollected() {
        closeFailure = null;
      },
      /** Its processes are not confirmed stopped, as a release that could not close it leaves them. */
      failCollection(failure: string) {
        closeFailure = failure;
      },
    };
  }

  /** A message whose turn ends with its runtime still owing work, which custody keeps. */
  async function custodyAfterTurn(
    core: ConversationCore,
    held = retained(),
    autonomous = false,
  ) {
    const opened: { lease: CustodyLease | null; turnAttempt: string } = {
      lease: null,
      turnAttempt: "",
    };
    nextUserResult = async (input) => {
      opened.turnAttempt = input.attemptId;
      opened.lease = input.custody.open(held.runtime);
      return ok();
    };
    const sent = await core.sendUserMessage({
      conversationId: "conv-u",
      text: "Run the suite in the background",
      inputOrigin: "user",
      ...(autonomous ? { autonomous: true } : {}),
    });
    if (sent.kind !== "accepted") throw new Error(sent.message);
    await sent.settled;
    await core.conversationIdle("conv-u");
    nextUserResult = async () => ok("Hi.");
    if (opened.lease === null) throw new Error("custody did not open");
    return { lease: opened.lease, turnAttempt: opened.turnAttempt, held };
  }

  it("keeps a turn's runtime in custody when it still owes work, taking custody's own attempt and worktree grant before the turn lets go of its own", async () => {
    interactiveConversation();
    const core = newCore({ interactiveWorktree: worktreeOf });
    const held = retained();
    let grantsAtOpen: string[] = [];
    const opened: { lease: CustodyLease | null; turnAttempt: string } = {
      lease: null,
      turnAttempt: "",
    };
    nextUserResult = async (input) => {
      opened.turnAttempt = input.attemptId;
      opened.lease = input.custody.open(held.runtime);
      grantsAtOpen = admission.held().map((grant) => grant.holder);
      return ok();
    };
    const sent = await core.sendUserMessage({
      conversationId: "conv-u",
      text: "Run the suite in the background",
      inputOrigin: "user",
    });
    if (sent.kind !== "accepted") throw new Error(sent.message);
    expect(await sent.settled).toMatchObject({ status: "succeeded" });
    await core.conversationIdle("conv-u");

    const custody = `custody:${opened.turnAttempt}`;
    expect(grantsAtOpen).toEqual([sent.cause, custody]);
    expect(repo().getAttempt(opened.turnAttempt)).toMatchObject({
      state: "settled",
      outcome: { status: "succeeded" },
    });
    expect(repo().latestAttemptFor(custody)).toMatchObject({
      attemptId: opened.lease?.attemptId,
      conversationId: "conv-u",
      state: "admitted",
      outcome: null,
    });
    // Custody holds the worktree for its writes: a publication waits for it.
    expect(admission.held().map((grant) => grant.holder)).toEqual([custody]);
    expect(
      admission.tryAcquire({ worktree, kind: "git", holder: "publish" }),
    ).toBeNull();
    // Nothing runs: the queue may hand a message over.
    expect(core.isBusy("conv-u")).toBe(false);
    expect(core.runningAttempt("conv-u")).toBeNull();
    expect(held.told).toEqual([]);
  });

  it("ends custody once the runtime owes nothing: it closes and collects the runtime first, then settles, lets the worktree go and leaves the busy set", async () => {
    interactiveConversation();
    const idle: string[] = [];
    const core = newCore({
      interactiveWorktree: worktreeOf,
      onConversationIdle: (conversationId) => idle.push(conversationId),
    });
    let collect: () => void = () => {};
    const held = retained(() => new Promise((resolve) => (collect = resolve)));
    const { lease } = await custodyAfterTurn(core, held);
    idle.length = 0;

    lease.settled();
    await tick();
    // Still closing: custody keeps its attempt, its grant and the conversation.
    expect(held.told).toEqual(["close"]);
    expect(repo().getAttempt(lease.attemptId)?.state).toBe("admitted");
    expect(admission.held()).toHaveLength(1);
    expect(await core.admission("conv-u", "task")).toMatchObject({
      code: "busy",
    });

    collect();
    await eventually(
      () => repo().getAttempt(lease.attemptId)?.state === "settled",
    );
    expect(repo().getAttempt(lease.attemptId)?.outcome).toEqual({
      kind: "custody",
      end: "settled",
    });
    expect(held.told).toEqual(["close", "released:settled"]);
    expect(admission.held()).toEqual([]);
    expect(await core.admission("conv-u", "task")).toBeNull();
    // Nothing was cut short.
    expect(losses).toEqual([]);
    expect(idle).toEqual(["conv-u"]);

    // What its runtime side reports afterwards changes nothing.
    lease.lost();
    lease.settled();
    await tick();
    expect(held.told).toEqual(["close", "released:settled"]);
    expect(lease.row()).toBeNull();
  });

  it("refuses a task, a command, a claim and maintenance while custody holds the conversation, saying why, and admits a message", async () => {
    interactiveConversation();
    const core = newCore({ interactiveWorktree: worktreeOf });
    await custodyAfterTurn(core);

    for (const turn of ["task", "command", "claim"] as const)
      expect(await core.admission("conv-u", turn)).toEqual({
        code: "busy",
        message: BACKGROUND_WORK_RUNNING,
      });
    expect(await core.admission("conv-u", "message")).toBeNull();
    expect(await core.admission("conv-u", "delivery")).toBeNull();
    // A checkpoint, a debug command and a collaboration's claim all need the conversation idle.
    expect(
      core.hold("conv-u", { kind: "checkpoint", requestId: "cp-1" }),
    ).toEqual({ kind: "busy", reason: BACKGROUND_WORK_RUNNING });
    expect(await core.whileIdle("conv-u", async () => "entered")).toEqual({
      kind: "busy",
      reason: BACKGROUND_WORK_RUNNING,
    });
    expect(
      await core.runTask({ conversationId: "conv-u", turn: commitTask() }),
    ).toEqual({
      kind: "not_started",
      reason: "configuration",
      message: BACKGROUND_WORK_RUNNING,
    });
    expect(taskCalls).toEqual([]);
  });

  it("answers a task already waiting behind the turn that left custody as not started, rather than leaving it waiting", async () => {
    interactiveConversation();
    const core = newCore();
    const held = retained();
    let finish: () => void = () => {};
    nextUserResult = (input) =>
      new Promise((resolve) => {
        finish = () => {
          input.custody.open(held.runtime);
          resolve(ok());
        };
      });
    const sent = await core.sendUserMessage({
      conversationId: "conv-u",
      text: "Start the build",
      inputOrigin: "user",
    });
    await tick();
    const task = core.runTask({ conversationId: "conv-u", turn: commitTask() });
    await tick();
    finish();

    expect(await task).toEqual({
      kind: "not_started",
      reason: "configuration",
      message: BACKGROUND_WORK_RUNNING,
    });
    expect(taskCalls).toEqual([]);
    if (sent.kind === "accepted") await sent.settled;
  });

  it("shows custody's provider turns on the row under the handing turn's source, and offers the queue the conversation when one ends", async () => {
    interactiveConversation();
    const idle: string[] = [];
    const core = newCore({
      onConversationIdle: (conversationId) => idle.push(conversationId),
    });
    const { lease, held } = await custodyAfterTurn(core);
    idle.length = 0;
    expect(lease.row()).toEqual({ status: "idle", notify: null });

    held.segment(true);
    expect(lease.row()).toEqual({ status: "running", source: "user" });
    // The queue keeps what arrives for the provider turn's end.
    expect(core.isBusy("conv-u")).toBe(true);

    held.segment(false);
    expect(lease.row(true)).toEqual({ status: "idle", notify: "user" });
    lease.segmentEnded();
    expect(idle).toEqual(["conv-u"]);
    expect(core.isBusy("conv-u")).toBe(false);
  });

  it("gives an unattended turn's custody the turn's workflow source", async () => {
    interactiveConversation();
    const core = newCore();
    const { lease, held } = await custodyAfterTurn(core, retained(), true);
    held.segment(true);
    expect(lease.row()).toEqual({ status: "running", source: "workflow" });
  });

  it("hands the runtime over to a message at its admission: until then custody keeps it and its grant, then custody settles handed over and its grant goes", async () => {
    interactiveConversation();
    const core = newCore({ interactiveWorktree: worktreeOf });
    const { lease, held } = await custodyAfterTurn(core);
    freeSlots = 0;
    const sent = await core.sendUserMessage({
      conversationId: "conv-u",
      text: "And then?",
      inputOrigin: "user",
    });
    if (sent.kind !== "accepted") throw new Error(sent.message);
    await tick();

    // Waiting for model capacity: custody still owns the runtime and the worktree.
    expect(repo().getAttempt(lease.attemptId)?.state).toBe("admitted");
    expect(held.told).toEqual([]);
    expect(admission.held().map((grant) => grant.holder)).toEqual([
      `custody:${repo().getAttempt(lease.attemptId)?.cause.slice("custody:".length)}`,
    ]);
    // The waiting turn holds the row: no provider turn's source is shown.
    expect(lease.row()).toEqual({ status: "running", source: null });

    let grantsAtRun: string[] = [];
    nextUserResult = async () => {
      grantsAtRun = admission.held().map((grant) => grant.holder);
      return ok();
    };
    releaseSlot();
    expect(await sent.settled).toMatchObject({ status: "succeeded" });

    expect(repo().getAttempt(lease.attemptId)?.outcome).toEqual({
      kind: "custody",
      end: "handed_over",
    });
    // Never closed: the turn runs on the runtime custody kept.
    expect(held.told).toEqual(["released:handed_over"]);
    expect(grantsAtRun).toEqual([sent.cause]);
    expect(losses).toEqual([]);
    expect(lease.row()).toBeNull();
  });

  it("starts a message that arrives while custody is closing its runtime only once the close is over, with nothing handed over", async () => {
    interactiveConversation();
    const core = newCore({ interactiveWorktree: worktreeOf });
    let collect: () => void = () => {};
    const held = retained(() => new Promise((resolve) => (collect = resolve)));
    const { lease } = await custodyAfterTurn(core, held);
    lease.settled();
    await tick();

    const sent = await core.sendUserMessage({
      conversationId: "conv-u",
      text: "Next",
      inputOrigin: "user",
    });
    if (sent.kind !== "accepted") throw new Error(sent.message);
    await tick();
    expect(userCalls).toHaveLength(1);

    collect();
    expect(await sent.settled).toMatchObject({ status: "succeeded" });
    expect(userCalls).toHaveLength(2);
    expect(repo().getAttempt(lease.attemptId)?.outcome).toEqual({
      kind: "custody",
      end: "settled",
    });
    expect(held.told).toEqual(["close", "released:settled"]);
  });

  it("keeps custody the owner when the message waiting to take over is cancelled before admission, and shows the row as custody leaves it", async () => {
    interactiveConversation();
    const core = newCore({ interactiveWorktree: worktreeOf });
    const { lease, held } = await custodyAfterTurn(core);
    freeSlots = 0;
    const sent = await core.sendUserMessage({
      conversationId: "conv-u",
      text: "Never mind",
      inputOrigin: "user",
    });
    if (sent.kind !== "accepted") throw new Error(sent.message);
    await tick();
    rowWrites = [];
    claims = [];

    core.interrupt?.(sent.cause);
    expect(await sent.settled).toMatchObject({ status: "cancelled" });
    await core.conversationIdle("conv-u");

    expect(rowWrites).toEqual([{ status: "idle", notify: null }]);
    expect(claims).toEqual([]);
    expect(repo().getAttempt(lease.attemptId)?.state).toBe("admitted");
    expect(held.told).toEqual([]);
    expect(admission.held()).toHaveLength(1);
  });

  it("while a message waits for model capacity, keeps a provider turn that starts meanwhile on the row, and Stop stops both", async () => {
    interactiveConversation();
    const core = newCore({ interactiveWorktree: worktreeOf });
    const { lease, held } = await custodyAfterTurn(core);
    freeSlots = 0;
    const sent = await core.sendUserMessage({
      conversationId: "conv-u",
      text: "Also fix the lint",
      inputOrigin: "user",
    });
    if (sent.kind !== "accepted") throw new Error(sent.message);
    await tick();

    held.segment(true);
    expect(lease.row()).toEqual({ status: "running", source: "user" });

    const stop = core.stopConversation("conv-u");
    expect(stop.requested).toBe(true);
    await stop.settled;
    expect(await sent.settled).toMatchObject({ status: "cancelled" });
    // Only the turn that left custody ran.
    expect(userCalls).toHaveLength(1);
    expect(held.told).toEqual(["close", "released:stopped"]);
    expect(losses).toEqual([`${lease.attemptId}:stopped`]);
    expect(repo().getAttempt(lease.attemptId)?.outcome).toEqual({
      kind: "custody",
      end: "stopped",
    });
    expect(admission.held()).toEqual([]);
    expect(core.stopConversation("conv-u").requested).toBe(false);
  });

  it("stops custody on request, answering once its runtime is collected: the loss is recorded and custody settles stopped", async () => {
    interactiveConversation();
    const core = newCore({ interactiveWorktree: worktreeOf });
    let collect: () => void = () => {};
    const held = retained(() => new Promise((resolve) => (collect = resolve)));
    const { lease } = await custodyAfterTurn(core, held);

    const stop = core.stopConversation("conv-u");
    expect(stop.requested).toBe(true);
    let stopped = false;
    void stop.settled.then(() => (stopped = true));
    await tick();
    expect(stopped).toBe(false);

    collect();
    await stop.settled;
    expect(held.told).toEqual(["close", "released:stopped"]);
    expect(losses).toEqual([`${lease.attemptId}:stopped`]);
    expect(repo().getAttempt(lease.attemptId)?.outcome).toEqual({
      kind: "custody",
      end: "stopped",
    });
    expect(admission.held()).toEqual([]);
  });

  it("fails the stop and keeps custody's worktree grant when its runtime cannot be confirmed collected", async () => {
    interactiveConversation();
    const core = newCore({ interactiveWorktree: worktreeOf });
    const held = retained(async () => {
      throw new Error("the CLI did not exit");
    });
    const { lease } = await custodyAfterTurn(core, held);

    await expect(core.stopConversation("conv-u").settled).rejects.toThrow(
      /could not be confirmed stopped: the CLI did not exit/,
    );
    // The person hears the stop was not confirmed; the agent's loss waits until it is.
    expect(losses).toEqual([`${lease.attemptId}:stopped:unconfirmed`]);
    expect(repo().getAttempt(lease.attemptId)?.state).toBe("admitted");
    expect(
      admission.tryAcquire({ worktree, kind: "git", holder: "publish" }),
    ).toBeNull();
  });

  /** The production loss recorder over the fixture's subscription store, and what it kept. */
  function realLossRecorder() {
    const service = createSubscriptionService({
      repo: createConversationSubscriptionsRepo(fixture.db, createWriteQueue()),
      isRecipientEligible: async () => true,
      readSource: async () => ({ cursor: "0", facts: [], missing: false }),
    });
    const notices: string[] = [];
    const record = createCustodyLossRecorder({
      recordRuntimeLossNotice: (input) =>
        service.recordRuntimeLossNotice(input),
      async appendTranscriptEntryOnce(_identity, entry) {
        const block = entry.content?.[0];
        if (block?.type === "text") notices.push(block.text);
      },
      log: { warn: () => {} },
    });
    const custodyLoss: ConversationCoreDeps["custodyLoss"] = ({
      place,
      attemptId,
      end,
      collected,
      tasks,
    }) =>
      record({
        identity: {
          projectPath: place.projectPath,
          storeSessionName: place.sessionName,
          conversationId: place.conversationId,
        },
        key: attemptId,
        end,
        collected,
        tasks,
      });
    const recovery = async () =>
      (
        await service.prepareRuntimeLossNotice({
          recipient: { projectPath: "/repo", conversationId: "conv-u" },
          attemptId: "probe",
        })
      ).block;
    return { custodyLoss, notices, recovery };
  }

  it("refuses the next message while custody's runtime could not be confirmed collected, and records no termination for it", async () => {
    interactiveConversation();
    const loss = realLossRecorder();
    const core = newCore({
      interactiveWorktree: worktreeOf,
      custodyLoss: loss.custodyLoss,
    });
    const held = retained(async () => {
      throw new Error("the CLI did not exit");
    });
    const { lease } = await custodyAfterTurn(core, held);
    await expect(core.stopConversation("conv-u").settled).rejects.toThrow(
      /could not be confirmed stopped/,
    );

    expect(
      await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Next",
        inputOrigin: "user",
      }),
    ).toMatchObject({
      kind: "refused",
      code: "busy",
      message: expect.stringContaining("the CLI did not exit"),
    });
    expect(await core.admission("conv-u", "task")).toMatchObject({
      code: "busy",
    });
    expect(userCalls).toHaveLength(1);
    expect(await loss.recovery()).toBeNull();
    expect(loss.notices.join("\n")).not.toMatch(/were terminated/);
    expect(repo().getAttempt(lease.attemptId)?.state).toBe("admitted");
  });

  it("refuses a message that was waiting for model capacity when custody ended and its runtime could not be collected", async () => {
    interactiveConversation();
    const loss = realLossRecorder();
    const core = newCore({
      interactiveWorktree: worktreeOf,
      custodyLoss: loss.custodyLoss,
    });
    const held = retained(async () => {
      throw new Error("the CLI did not exit");
    });
    const { lease } = await custodyAfterTurn(core, held);
    freeSlots = 0;
    const sent = await core.sendUserMessage({
      conversationId: "conv-u",
      text: "Next",
      inputOrigin: "user",
    });
    if (sent.kind !== "accepted") throw new Error(sent.message);
    await tick();

    // The work finishes while the message waits; collecting the runtime fails.
    lease.settled();
    await eventually(() => held.told.includes("close"));
    await tick();
    releaseSlot();

    expect(await sent.settled).toMatchObject({
      status: "failed",
      failure: expect.stringContaining("the CLI did not exit"),
    });
    await core.conversationIdle("conv-u");
    expect(userCalls).toHaveLength(1);
    expect(loss.notices.join("\n")).not.toMatch(/were terminated/);
  });

  it("refuses a message that waited for a closing custody whose runtime then could not be collected, and records no termination for it", async () => {
    interactiveConversation();
    const loss = realLossRecorder();
    const core = newCore({
      interactiveWorktree: worktreeOf,
      custodyLoss: loss.custodyLoss,
    });
    let fail: (error: Error) => void = () => {};
    const held = retained(
      () => new Promise<void>((_resolve, reject) => (fail = reject)),
    );
    const { lease } = await custodyAfterTurn(core, held);
    lease.lost();
    await tick();

    const sent = await core.sendUserMessage({
      conversationId: "conv-u",
      text: "Next",
      inputOrigin: "user",
    });
    if (sent.kind !== "accepted") throw new Error(sent.message);
    await tick();
    fail(new Error("the CLI did not exit"));

    expect(await sent.settled).toMatchObject({
      status: "failed",
      failure: expect.stringContaining("the CLI did not exit"),
    });
    await core.conversationIdle("conv-u");
    expect(userCalls).toHaveLength(1);
    expect(await loss.recovery()).toBeNull();
    expect(loss.notices.join("\n")).not.toMatch(/were terminated/);
    expect(repo().getAttempt(lease.attemptId)?.state).toBe("admitted");
  });

  it.each([1, 2, 3, 4, 5])(
    "never hands over a custody that starts ending just before the message's admission (custody's step %i microtasks later)",
    async (depth) => {
      interactiveConversation();
      const base = createConversationCoreRepo(fixture.db);
      let onRead: (() => void) | null = null;
      const core = newCore({
        interactiveWorktree: worktreeOf,
        repo: {
          ...base,
          attemptsInState(state) {
            const read = onRead;
            onRead = null;
            read?.();
            return base.attemptsInState(state);
          },
        },
      });
      const { lease, held } = await custodyAfterTurn(core);
      // As custody's event chain does: its step runs a few microtasks after the readiness read.
      onRead = () => {
        const later = (left: number): void =>
          queueMicrotask(() => (left > 1 ? later(left - 1) : lease.settled()));
        later(depth);
      };

      const sent = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Next",
        inputOrigin: "user",
      });
      if (sent.kind !== "accepted") throw new Error(sent.message);
      expect(await sent.settled).toMatchObject({ status: "succeeded" });
      await core.conversationIdle("conv-u");

      // Either custody ended first and the turn started fresh, or the turn took it over first and its
      // late end changed nothing; never a handover of a custody already closing.
      const settledFirst = held.told[0] === "close";
      expect(held.told).toEqual(
        settledFirst ? ["close", "released:settled"] : ["released:handed_over"],
      );
      expect(repo().getAttempt(lease.attemptId)?.outcome).toEqual({
        kind: "custody",
        end: settledFirst ? "settled" : "handed_over",
      });
    },
  );

  it("ends custody at its bound as timed out, recording the loss", async () => {
    interactiveConversation();
    const core = newCore({
      interactiveWorktree: worktreeOf,
      custodyBoundMs: 15,
    });
    const { lease, held } = await custodyAfterTurn(core);

    await eventually(() => repo().getAttempt(lease.attemptId)?.outcome != null);
    expect(repo().getAttempt(lease.attemptId)?.outcome).toEqual({
      kind: "custody",
      end: "timed_out",
    });
    expect(held.told).toEqual(["close", "released:timed_out"]);
    expect(losses).toEqual([`${lease.attemptId}:timed_out`]);
    expect(admission.held()).toEqual([]);
  });

  it("ends custody lost when its runtime dies, closing and collecting the dead runtime", async () => {
    interactiveConversation();
    const core = newCore({ interactiveWorktree: worktreeOf });
    const { lease, held } = await custodyAfterTurn(core);

    lease.lost();
    await eventually(() => repo().getAttempt(lease.attemptId)?.outcome != null);
    expect(repo().getAttempt(lease.attemptId)?.outcome).toEqual({
      kind: "custody",
      end: "lost",
    });
    expect(held.told).toEqual(["close", "released:lost"]);
    expect(losses).toEqual([`${lease.attemptId}:lost`]);
  });

  it("at server stop ends custody as interrupted once its runtime is closed, and keeps none for a turn ending meanwhile", async () => {
    interactiveConversation();
    interactiveConversation("conv-v");
    const core = newCore({ interactiveWorktree: worktreeOf });
    const { lease, held } = await custodyAfterTurn(core);
    let opened: CustodyLease | null | undefined;
    nextUserResult = (input) =>
      new Promise((resolve) =>
        input.signal.addEventListener("abort", () => {
          opened = input.custody.open(retained().runtime);
          resolve({ ...ok(), status: "interrupted" });
        }),
      );
    await core.sendUserMessage({
      conversationId: "conv-v",
      text: "Long",
      inputOrigin: "user",
    });
    await tick();

    await core.shutdown();
    expect(repo().getAttempt(lease.attemptId)?.outcome).toEqual({
      kind: "custody",
      end: "interrupted",
    });
    expect(held.told).toEqual(["close", "released:interrupted"]);
    expect(losses).toEqual([`${lease.attemptId}:interrupted`]);
    expect(opened).toBeNull();
  });

  it("keeps a custody admitted when its loss cannot be recorded as it ends, and records it, naming its tasks, before the conversation's next message runs", async () => {
    interactiveConversation();
    const loss = realLossRecorder();
    let writeFailures = 1;
    const core = newCore({
      interactiveWorktree: worktreeOf,
      async custodyLoss(input) {
        if (writeFailures > 0) {
          writeFailures -= 1;
          throw new Error("the inbox could not be written");
        }
        losses.push(`${input.attemptId}:${input.end}`);
        await loss.custodyLoss(input);
      },
    });
    const held = retained(async () =>
      held.lose([
        { taskId: "build-1", description: "npm run build" },
        { taskId: "lint-1", description: "npm run lint" },
      ]),
    );
    const { lease } = await custodyAfterTurn(core, held);

    await core.stopConversation("conv-u").settled;
    // Collected: the worktree and the conversation are free, but the loss is still owed.
    expect(repo().getAttempt(lease.attemptId)?.state).toBe("admitted");
    expect(admission.held()).toEqual([]);
    expect(await core.admission("conv-u", "task")).toBeNull();

    let lossesAtRun: string[] = [];
    nextUserResult = async () => {
      lossesAtRun = [...losses];
      return ok();
    };
    const sent = await core.sendUserMessage({
      conversationId: "conv-u",
      text: "What happened?",
      inputOrigin: "user",
    });
    if (sent.kind !== "accepted") throw new Error(sent.message);
    expect(await sent.settled).toMatchObject({ status: "succeeded" });
    await core.conversationIdle("conv-u");
    expect(lossesAtRun).toEqual([`${lease.attemptId}:stopped`]);
    expect(repo().getAttempt(lease.attemptId)?.outcome).toEqual({
      kind: "custody",
      end: "stopped",
    });
    const recovery = await loss.recovery();
    expect(recovery).toContain("build-1 (npm run build)");
    expect(recovery).toContain("lint-1 (npm run lint)");
  });

  it("ends lost, naming the task, a custody that chose to settle when its close still cut a task short; its death reported later adds nothing", async () => {
    interactiveConversation();
    const loss = realLossRecorder();
    const core = newCore({
      interactiveWorktree: worktreeOf,
      custodyLoss: loss.custodyLoss,
    });
    // A task started after the settle check: the close cuts it short and reports it.
    const held = retained(async () =>
      held.lose([{ taskId: "build-2", description: "npm run build" }]),
    );
    const { lease } = await custodyAfterTurn(core, held);

    lease.settled();
    await eventually(() => repo().getAttempt(lease.attemptId)?.outcome != null);
    lease.lost();
    await tick();

    expect(repo().getAttempt(lease.attemptId)?.outcome).toEqual({
      kind: "custody",
      end: "lost",
    });
    expect(held.told).toEqual(["close", "released:lost"]);
    expect(loss.notices).toHaveLength(1);
    expect(loss.notices[0]).toContain("build-2 (npm run build)");
    const recovery = await loss.recovery();
    expect(recovery?.match(/"event":"background-tasks-lost"/g)).toHaveLength(1);
    expect(recovery).toContain("build-2 (npm run build)");
  });

  it.each(["the loss cannot be written", "the runtime cannot be collected"])(
    "keeps such a custody owed as lost, with its task, when %s, and records it so before the next message",
    async (failure) => {
      interactiveConversation();
      const loss = realLossRecorder();
      let writeFailures = failure === "the loss cannot be written" ? 1 : 0;
      const core = newCore({
        interactiveWorktree: worktreeOf,
        async custodyLoss(input) {
          if (writeFailures > 0) {
            writeFailures -= 1;
            throw new Error("the inbox could not be written");
          }
          await loss.custodyLoss(input);
        },
      });
      const held = retained(async () => {
        held.lose([{ taskId: "build-2", description: "npm run build" }]);
        if (failure === "the runtime cannot be collected")
          throw new Error("the CLI did not exit");
      });
      const { lease } = await custodyAfterTurn(core, held);

      lease.settled();
      await eventually(() => held.told.length === 2);
      expect(held.told).toEqual(["close", "released:lost"]);
      expect(repo().getAttempt(lease.attemptId)?.state).toBe("admitted");

      held.confirmCollected();
      const sent = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "What happened?",
        inputOrigin: "user",
      });
      if (sent.kind !== "accepted") throw new Error(sent.message);
      expect(await sent.settled).toMatchObject({ status: "succeeded" });
      await core.conversationIdle("conv-u");

      expect(repo().getAttempt(lease.attemptId)?.outcome).toEqual({
        kind: "custody",
        end: "lost",
      });
      expect(await loss.recovery()).toContain("build-2 (npm run build)");
    },
  );

  it("refuses the next message, saying why, while the loss a custody left still cannot be recorded", async () => {
    interactiveConversation();
    const core = newCore({ interactiveWorktree: worktreeOf });
    const { lease } = await custodyAfterTurn(core);
    lossFailures = 2;
    await core.stopConversation("conv-u").settled;

    const sent = await core.sendUserMessage({
      conversationId: "conv-u",
      text: "What happened?",
      inputOrigin: "user",
    });
    if (sent.kind !== "accepted") throw new Error(sent.message);
    expect(await sent.settled).toMatchObject({
      status: "failed",
      failure: expect.stringContaining("the inbox could not be written"),
    });
    await core.conversationIdle("conv-u");
    expect(userCalls).toHaveLength(1);
    expect(repo().getAttempt(lease.attemptId)?.state).toBe("admitted");
    expect(admission.held()).toEqual([]);
  });

  it("records at the next boot a loss the server could not record before it stopped", async () => {
    interactiveConversation();
    const core = newCore({ interactiveWorktree: worktreeOf });
    const { lease } = await custodyAfterTurn(core);
    lossFailures = 1;
    await core.stopConversation("conv-u").settled;

    await newCore().recover();
    expect(losses).toEqual([`${lease.attemptId}:interrupted`]);
    expect(repo().getAttempt(lease.attemptId)?.outcome).toEqual({
      kind: "custody",
      end: "interrupted",
    });
  });

  it("retiring the conversation stops its custody, collecting the runtime before disposing of it", async () => {
    interactiveConversation();
    const core = newCore({ interactiveWorktree: worktreeOf });
    const { lease, held } = await custodyAfterTurn(core);

    await core.retireConversation("conv-u", async () => {
      held.told.push("dispose");
    });
    expect(held.told).toEqual(["close", "released:stopped", "dispose"]);
    expect(repo().getAttempt(lease.attemptId)?.outcome).toEqual({
      kind: "custody",
      end: "stopped",
    });
    expect(admission.held()).toEqual([]);
  });

  it("after a restart fences a crashed custody's worktree even when its loss cannot be recorded yet", async () => {
    interactiveConversation();
    repo().insertAttempt({
      attemptId: "custody-1",
      conversationId: "conv-u",
      cause: "custody:turn-1",
      state: "admitted",
      outcome: null,
      openedAt: now,
      settledAt: null,
    });
    uptime = 4_970;
    lossFailures = 1;
    const core = newCore({ interactiveWorktree: worktreeOf });
    await core.recover();

    expect(
      admission.tryAcquire({ worktree, kind: "git", holder: "publish" }),
    ).toBeNull();
    expect(
      admission.tryAcquire({
        worktree,
        kind: "interactive_write",
        holder: "turn",
      }),
    ).toBeNull();
    expect(
      createConversationCoreRepo(fixture.db).getAttempt("custody-1")?.state,
    ).toBe("admitted");
  });

  it("after a crash during custody, boot records the runtime loss before settling custody interrupted, and a later boot adds nothing", async () => {
    interactiveConversation();
    repo().insertAttempt({
      attemptId: "custody-1",
      conversationId: "conv-u",
      cause: "custody:turn-1",
      state: "admitted",
      outcome: null,
      openedAt: now,
      settledAt: null,
    });

    // The loss could not be written: custody stays admitted for the next boot to try again.
    lossFailures = 1;
    await newCore().recover();
    expect(repo().getAttempt("custody-1")?.state).toBe("admitted");
    expect(losses).toEqual([]);

    await newCore().recover();
    expect(losses).toEqual(["custody-1:interrupted"]);
    expect(repo().getAttempt("custody-1")?.outcome).toEqual({
      kind: "custody",
      end: "interrupted",
    });

    await newCore().recover();
    expect(losses).toEqual(["custody-1:interrupted"]);
  });

  it("after a restart keeps a crashed custody's worktree closed to turns and publications until 5 s after the server started", async () => {
    interactiveConversation();
    repo().insertAttempt({
      attemptId: "custody-1",
      conversationId: "conv-u",
      cause: "custody:turn-1",
      state: "admitted",
      outcome: null,
      openedAt: now,
      settledAt: null,
    });
    uptime = 4_970;
    const core = newCore({ interactiveWorktree: worktreeOf });
    await core.recover();

    expect(
      admission.tryAcquire({ worktree, kind: "git", holder: "publish" }),
    ).toBeNull();
    const sent = await core.sendUserMessage({
      conversationId: "conv-u",
      text: "Where were we?",
      inputOrigin: "user",
    });
    await tick();
    expect(userCalls).toEqual([]);

    if (sent.kind === "accepted") await sent.settled;
    expect(userCalls).toHaveLength(1);
    await core.conversationIdle("conv-u");
    expect(admission.held()).toEqual([]);
  });

  it("fences nothing when the server has been up longer than the window", async () => {
    interactiveConversation();
    repo().insertAttempt({
      attemptId: "custody-1",
      conversationId: "conv-u",
      cause: "custody:turn-1",
      state: "admitted",
      outcome: null,
      openedAt: now,
      settledAt: null,
    });
    uptime = 6_000;
    await newCore({ interactiveWorktree: worktreeOf }).recover();
    expect(admission.held()).toEqual([]);
  });

  describe("guards outside the conversation (design C5b §5)", () => {
    const session = { projectPath: "/repo", sessionName: "session" };

    /** A second conversation the core runs, in another session of the project. */
    function otherSessionConversation(): void {
      fixture.seedSession("/repo", "other");
      createConversationsRepo(fixture.db).upsert(
        "/repo",
        "other",
        makeConversationState({ id: "conv-o", role: null }),
      );
    }

    /** A second conversation in the same session as `conv-u`. */
    function sibling(conversationId = "conv-b"): void {
      createConversationsRepo(fixture.db).upsert(
        "/repo",
        "session",
        makeConversationState({ id: conversationId, role: null }),
      );
    }

    /**
     * A message to `conversationId` whose turn ends owing work: custody's answer
     * at the turn's end, and the turn's own result (a runtime it released and
     * could not collect, when `uncollected`).
     */
    async function turnOwing(
      core: ConversationCore,
      conversationId: string,
      options: {
        held?: ReturnType<typeof retained>;
        uncollected?: string;
        atEnd?: () => void;
      } = {},
    ) {
      const held = options.held ?? retained();
      const outcome: { lease: CustodyLease | null; turnAttempt: string } = {
        lease: null,
        turnAttempt: "",
      };
      nextUserResult = async (input) => {
        outcome.turnAttempt = input.attemptId;
        options.atEnd?.();
        outcome.lease = input.custody.open(held.runtime);
        return options.uncollected === undefined
          ? ok()
          : { ...ok(), runtimeUncollected: options.uncollected };
      };
      const sent = await core.sendUserMessage({
        conversationId,
        text: "Run the suite in the background",
        inputOrigin: "user",
      });
      if (sent.kind !== "accepted") throw new Error(sent.message);
      await sent.settled;
      await core.conversationIdle(conversationId);
      nextUserResult = async () => ok("Hi.");
      return { ...outcome, held };
    }

    /** The attempt that owes a custody's loss, by the turn whose custody it was. */
    const custodyOf = (turnAttempt: string) =>
      repo().latestAttemptFor(`custody:${turnAttempt}`);

    it("names the conversations of a project or session whose background work custody holds, and none whose turn only runs", async () => {
      interactiveConversation();
      const core = newCore({ interactiveWorktree: worktreeOf });
      let finish: () => void = () => {};
      nextUserResult = () =>
        new Promise((resolve) => (finish = () => resolve(ok())));
      const running = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Edit the file",
        inputOrigin: "user",
      });
      if (running.kind !== "accepted") throw new Error(running.message);
      await eventually(() => userCalls.length === 1);
      // A running turn is not background work: a merge refuses only custody.
      expect(core.backgroundWorkIn({ projectPath: "/repo" })).toEqual([]);
      expect(core.holdsCustody("conv-u")).toBe(false);
      finish();
      await running.settled;
      await core.conversationIdle("conv-u");

      const { lease } = await custodyAfterTurn(core);
      const held = [{ conversationId: "conv-u", unconfirmed: null }];
      expect(core.backgroundWorkIn(session)).toEqual(held);
      expect(core.backgroundWorkIn({ projectPath: "/repo" })).toEqual(held);
      expect(
        core.backgroundWorkIn({
          ...session,
          conversationId: "conv-u",
        }),
      ).toEqual(held);
      expect(
        core.backgroundWorkIn({ projectPath: "/repo", sessionName: "other" }),
      ).toEqual([]);
      expect(core.backgroundWorkIn({ projectPath: "/elsewhere" })).toEqual([]);
      expect(core.holdsCustody("conv-u")).toBe(true);

      lease.settled();
      await eventually(() => !core.holdsCustody("conv-u"));
      expect(core.backgroundWorkIn({ projectPath: "/repo" })).toEqual([]);
    });

    it("keeps naming background work whose Stop could not confirm its runtime collected, until a later close collects it", async () => {
      interactiveConversation();
      const core = newCore({ interactiveWorktree: worktreeOf });
      const { held } = await custodyAfterTurn(
        core,
        retained(async () => {
          throw new Error("the CLI did not exit");
        }),
      );

      await expect(core.stopConversation("conv-u").settled).rejects.toThrow();
      // Stop is over, so nothing shows custody; what guards the session still sees it.
      expect(core.holdsCustody("conv-u")).toBe(false);
      expect(core.backgroundWorkIn(session)).toEqual([
        { conversationId: "conv-u", unconfirmed: "the CLI did not exit" },
      ]);

      held.confirmCollected();
      expect(core.backgroundWorkIn(session)).toEqual([]);
    });

    it("refuses archive and deletion again on every retry while that runtime stays unconfirmed, changing nothing", async () => {
      interactiveConversation();
      const core = newCore({ interactiveWorktree: worktreeOf });
      await custodyAfterTurn(
        core,
        retained(async () => {
          throw new Error("the CLI did not exit");
        }),
      );
      await expect(core.stopConversation("conv-u").settled).rejects.toThrow();

      const commits: string[] = [];
      for (const attempt of [1, 2]) {
        const archived = core.closeBackgroundWork(
          session,
          async () => {
            commits.push(`archive:${attempt}`);
          },
          { end: "archived", stop: true },
        );
        await expect(archived).rejects.toBeInstanceOf(
          BackgroundWorkUnstoppedError,
        );
        await expect(archived).rejects.toMatchObject({
          details: { conversationId: "conv-u" },
        });
      }
      const disposed: string[] = [];
      await expect(
        core.retireConversation("conv-u", async () => {
          disposed.push("dispose");
        }),
      ).rejects.toBeInstanceOf(BackgroundWorkUnstoppedError);
      expect(commits).toEqual([]);
      expect(disposed).toEqual([]);
    });

    it("opens no custody once a merge delivers the session: the runtime is released, then the agent and the person hear a merge stopped the work, and custody's attempt settles refused", async () => {
      interactiveConversation();
      let closed: "merging" | null = null;
      const asked: string[] = [];
      const order: string[] = [];
      const core = newCore({
        interactiveWorktree: worktreeOf,
        custodyFence(place) {
          asked.push(`${place.projectPath}:${place.sessionName}`);
          return closed;
        },
        async custodyLoss({ attemptId, end, collected }) {
          order.push("loss");
          losses.push(`${attemptId}:${end}${collected ? "" : ":unconfirmed"}`);
        },
      });
      const { lease, turnAttempt } = await turnOwing(core, "conv-u", {
        // The merge starts delivering while the turn runs: read at custody's insert.
        atEnd: () => {
          closed = "merging";
          order.push("released");
        },
      });

      expect(lease).toBeNull();
      expect(asked).toEqual(["/repo:session"]);
      expect(order).toEqual(["released", "loss"]);
      const owed = custodyOf(turnAttempt);
      expect(losses).toEqual([`${owed?.attemptId}:merging`]);
      expect(owed).toMatchObject({
        state: "settled",
        outcome: { kind: "custody", end: "refused" },
      });
      expect(core.holdsCustody("conv-u")).toBe(false);
      expect(admission.held()).toEqual([]);
    });

    it("owes a merge-refused custody's loss while its runtime is unconfirmed, keeps it as background work, and records it once collection is confirmed", async () => {
      interactiveConversation();
      const real = realLossRecorder();
      const core = newCore({
        custodyFence: () => "merging",
        custodyLoss: async (input) => {
          losses.push(
            `${input.attemptId}:${input.end}${input.collected ? "" : ":unconfirmed"}`,
          );
          await real.custodyLoss(input);
        },
      });
      const { held, turnAttempt } = await turnOwing(core, "conv-u", {
        uncollected: "the CLI did not exit",
      });
      const owedId = custodyOf(turnAttempt)?.attemptId;
      held.failCollection("the CLI did not exit");

      expect(losses).toEqual([`${owedId}:merging:unconfirmed`]);
      expect(custodyOf(turnAttempt)?.state).toBe("admitted");
      expect(await real.recovery()).toBeNull();
      expect(core.backgroundWorkIn(session)).toEqual([
        { conversationId: "conv-u", unconfirmed: "the CLI did not exit" },
      ]);

      held.confirmCollected();
      const next = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Carry on",
        inputOrigin: "user",
      });
      if (next.kind !== "accepted") throw new Error(next.message);
      expect(await next.settled).toMatchObject({ status: "succeeded" });
      expect(losses).toEqual([
        `${owedId}:merging:unconfirmed`,
        `${owedId}:merging`,
      ]);
      expect(custodyOf(turnAttempt)).toMatchObject({
        state: "settled",
        outcome: { kind: "custody", end: "refused" },
      });
      expect(
        (await real.recovery())?.match(/the session is being merged/g),
      ).toHaveLength(1);
    });

    it("records a merge-refused custody's loss whose write failed at the next message, or else at the next boot, once", async () => {
      interactiveConversation();
      const core = newCore({ custodyFence: () => "merging" });
      lossFailures = 1;
      const { turnAttempt } = await turnOwing(core, "conv-u");
      const owedId = custodyOf(turnAttempt)?.attemptId;
      expect(losses).toEqual([]);
      expect(custodyOf(turnAttempt)?.state).toBe("admitted");

      // Without a next message, the next boot records it.
      await newCore().recover();
      expect(losses).toEqual([`${owedId}:interrupted`]);
      expect(custodyOf(turnAttempt)?.state).toBe("settled");

      lossFailures = 1;
      const second = await turnOwing(core, "conv-u");
      const secondId = custodyOf(second.turnAttempt)?.attemptId;
      const next = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Carry on",
        inputOrigin: "user",
      });
      if (next.kind !== "accepted") throw new Error(next.message);
      await next.settled;
      expect(losses).toEqual([`${owedId}:interrupted`, `${secondId}:merging`]);
      expect(custodyOf(second.turnAttempt)).toMatchObject({
        state: "settled",
        outcome: { kind: "custody", end: "refused" },
      });
    });

    it("closes a session to background work: stops its custody, refuses custody that tries to open meanwhile, commits, and opens again afterwards", async () => {
      interactiveConversation();
      sibling();
      const core = newCore({ interactiveWorktree: worktreeOf });
      let collect: () => void = () => {};
      const a = await custodyAfterTurn(
        core,
        retained(() => new Promise((resolve) => (collect = resolve))),
      );

      const seen: string[] = [];
      const closing = core.closeBackgroundWork(
        session,
        async () => {
          seen.push(
            `commit a=${core.holdsCustody("conv-u")} b=${core.holdsCustody("conv-b")}`,
          );
          return "archived";
        },
        { end: "archived", stop: true },
      );
      await tick();
      expect(a.held.told).toEqual(["close"]);
      // B's turn ends owing work while A's close is pending: no custody escapes the archive.
      const b = await turnOwing(core, "conv-b");
      expect(b.lease).toBeNull();
      const bOwed = custodyOf(b.turnAttempt)?.attemptId;
      expect(losses).toContain(`${bOwed}:archived`);

      collect();
      expect(await closing).toBe("archived");
      expect(seen).toEqual(["commit a=false b=false"]);
      expect(core.backgroundWorkIn(session)).toEqual([]);

      // Released once the commit is over.
      expect((await turnOwing(core, "conv-b")).lease).not.toBeNull();
    });

    /**
     * A's custody closes on demand while B's turn ends owing work: refused by the
     * closing, B's runtime is still being released when A's close completes.
     */
    async function closingWithPendingRelease(
      core: ConversationCore,
      bRelease: CoreTurnResult,
    ) {
      let collectA: () => void = () => {};
      await custodyAfterTurn(
        core,
        retained(() => new Promise((resolve) => (collectA = resolve))),
      );
      const commits: string[] = [];
      const closing = core.closeBackgroundWork(
        session,
        async () => {
          commits.push(
            `commit ${JSON.stringify(core.backgroundWorkIn(session))}`,
          );
        },
        { end: "archived", stop: true },
      );
      await tick();
      let releaseB: () => void = () => {};
      let refused: CustodyLease | null | undefined;
      const heldB = retained();
      nextUserResult = async (input) => {
        refused = input.custody.open(heldB.runtime);
        await new Promise<void>((resolve) => (releaseB = resolve));
        // A release that could not close the runtime leaves the host's failure behind.
        if (bRelease.runtimeUncollected !== undefined)
          heldB.failCollection(bRelease.runtimeUncollected);
        return bRelease;
      };
      const sent = await core.sendUserMessage({
        conversationId: "conv-b",
        text: "Run the suite in the background",
        inputOrigin: "user",
      });
      if (sent.kind !== "accepted") throw new Error(sent.message);
      await eventually(() => refused !== undefined);
      expect(refused).toBeNull();
      // Refused, its collection still pending: background work for every guard meanwhile.
      expect(core.backgroundWorkIn(session)).toContainEqual({
        conversationId: "conv-b",
        unconfirmed: null,
      });
      collectA();
      await tick();
      expect(commits).toEqual([]);
      releaseB();
      await sent.settled;
      return { closing, commits };
    }

    it("waits for a refused custody's release before an archive commits, and refuses when that release cannot be collected", async () => {
      interactiveConversation();
      sibling();
      const core = newCore({ interactiveWorktree: worktreeOf });
      const { closing, commits } = await closingWithPendingRelease(core, {
        ...ok(),
        runtimeUncollected: "the CLI did not exit",
      });

      await expect(closing).rejects.toMatchObject({
        code: "BACKGROUND_WORK_UNSTOPPED",
        details: { conversationId: "conv-b" },
      });
      expect(commits).toEqual([]);
    });

    it("commits the archive once a refused custody's release is collected", async () => {
      interactiveConversation();
      sibling();
      const core = newCore({ interactiveWorktree: worktreeOf });
      const { closing, commits } = await closingWithPendingRelease(core, ok());

      await closing;
      expect(commits).toEqual(["commit []"]);
      expect(core.backgroundWorkIn(session)).toEqual([]);
    });

    it("lets marking merged read a refused custody's release only once it settled, so the read sees it unconfirmed", async () => {
      interactiveConversation();
      const core = newCore({
        interactiveWorktree: worktreeOf,
        // A merge is delivering the session: the turn's custody is refused at its end.
        custodyFence: () => "merging",
      });
      const held = retained();
      let release: () => void = () => {};
      let opened = false;
      nextUserResult = async (input) => {
        input.custody.open(held.runtime);
        opened = true;
        await new Promise<void>((resolve) => (release = resolve));
        held.failCollection("the CLI did not exit");
        return { ...ok(), runtimeUncollected: "the CLI did not exit" };
      };
      const sent = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Run the suite in the background",
        inputOrigin: "user",
      });
      if (sent.kind !== "accepted") throw new Error(sent.message);
      await eventually(() => opened);

      const reads: string[] = [];
      const marking = core.closeBackgroundWork(
        session,
        async () => {
          reads.push(JSON.stringify(core.backgroundWorkIn(session)));
        },
        { end: "merged", stop: false },
      );
      await tick();
      expect(reads).toEqual([]);
      release();
      await sent.settled;
      await marking;
      expect(reads).toEqual([
        JSON.stringify([
          { conversationId: "conv-u", unconfirmed: "the CLI did not exit" },
        ]),
      ]);
    });

    it("fences only new custody through a commit that keeps existing custody (marking a session merged), and releases the fence even when the commit fails", async () => {
      interactiveConversation();
      sibling();
      const core = newCore({ interactiveWorktree: worktreeOf });
      const a = await custodyAfterTurn(core);

      let write: () => void = () => {};
      const marking = core.closeBackgroundWork(
        session,
        async () => {
          // The caller reads what holds inside its commit, under the fence.
          expect(core.backgroundWorkIn(session)).toEqual([
            { conversationId: "conv-u", unconfirmed: null },
          ]);
          await new Promise<void>((resolve) => (write = resolve));
          throw new Error("the finished flag could not be written");
        },
        { end: "merged", stop: false },
      );
      await tick();
      // Existing custody is the caller's to refuse, not the fence's to stop.
      expect(a.held.told).toEqual([]);
      const b = await turnOwing(core, "conv-b");
      expect(b.lease).toBeNull();
      expect(losses).toContain(`${custodyOf(b.turnAttempt)?.attemptId}:merged`);

      write();
      await expect(marking).rejects.toThrow("could not be written");
      expect((await turnOwing(core, "conv-b")).lease).not.toBeNull();
    });

    it("refuses the closing before its commit when a stopped custody cannot be collected, and releases the fence", async () => {
      interactiveConversation();
      sibling();
      const core = newCore({ interactiveWorktree: worktreeOf });
      await custodyAfterTurn(
        core,
        retained(async () => {
          throw new Error("the CLI did not exit");
        }),
      );
      const commits: string[] = [];

      await expect(
        core.closeBackgroundWork(
          session,
          async () => {
            commits.push("commit");
          },
          { end: "deleted", stop: true },
        ),
      ).rejects.toMatchObject({
        code: "BACKGROUND_WORK_UNSTOPPED",
        details: { conversationId: "conv-u" },
        message: expect.stringContaining("the CLI did not exit"),
      });
      expect(commits).toEqual([]);
      expect((await turnOwing(core, "conv-b")).lease).not.toBeNull();
    });

    it("refuses a session's deletion before retiring any of its conversations when the second's collection fails, so the first still takes a message", async () => {
      interactiveConversation();
      sibling();
      const core = newCore({ interactiveWorktree: worktreeOf });
      const a = await custodyAfterTurn(core);
      await turnOwing(core, "conv-b", {
        held: retained(async () => {
          throw new Error("the CLI did not exit");
        }),
      });

      await expect(
        core.closeBackgroundWork(
          session,
          async () => {
            await core.retireConversation("conv-u");
            await core.retireConversation("conv-b");
          },
          { end: "deleted", stop: true },
        ),
      ).rejects.toMatchObject({ details: { conversationId: "conv-b" } });
      expect(a.held.told).toEqual(["close", "released:stopped"]);

      const sent = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "Still here?",
        inputOrigin: "user",
      });
      if (sent.kind !== "accepted") throw new Error(sent.message);
      expect(await sent.settled).toMatchObject({ status: "succeeded" });
    });

    it("refuses the retirement without withdrawing queued input or retiring the conversation, when custody cannot be collected", async () => {
      interactiveConversation();
      const core = newCore({ interactiveWorktree: worktreeOf });
      const { held } = await custodyAfterTurn(
        core,
        retained(async () => {
          throw new Error("the CLI did not exit");
        }),
      );
      repo().insertMailboxIfAbsent({
        cause: "queued-1",
        conversationId: "conv-u",
        requester: null,
        request: {
          kind: "user_message",
          text: "Queued meanwhile",
          inputOrigin: "user",
        },
        permit: null,
        state: "queued",
        attemptId: null,
        createdAt: now,
        updatedAt: now,
      });

      const retiring = core.retireConversation("conv-u", async () => {
        held.told.push("dispose");
      });
      await expect(retiring).rejects.toBeInstanceOf(
        BackgroundWorkUnstoppedError,
      );
      await expect(retiring).rejects.toMatchObject({
        details: { conversationId: "conv-u" },
        message: expect.stringContaining("the CLI did not exit"),
      });
      expect(held.told).toEqual(["close", "released:stopped"]);
      expect(repo().getMailbox("queued-1")?.state).toBe("queued");
      expect(notStarted).toEqual([]);
      // Its processes may still write: the worktree stays held for them.
      expect(
        admission.tryAcquire({ worktree, kind: "git", holder: "publish" }),
      ).toBeNull();
    });

    it("refuses the retirement with the typed refusal when disposing of the runtime cannot close it", async () => {
      interactiveConversation();
      const core = newCore();
      await expect(
        core.retireConversation("conv-u", async () => {
          throw new Error("the runtime could not be closed");
        }),
      ).rejects.toBeInstanceOf(BackgroundWorkUnstoppedError);
    });

    it("tells observers custody holds as it opens, and no longer as it ends or hands the runtime over", async () => {
      interactiveConversation();
      const changes: string[] = [];
      const core = newCore({
        interactiveWorktree: worktreeOf,
        custodyChanged: (place, held) =>
          changes.push(
            `${place.projectPath}:${place.sessionName}:${place.conversationId}:${held}`,
          ),
      });
      const first = await custodyAfterTurn(core);
      expect(changes).toEqual(["/repo:session:conv-u:true"]);
      first.lease.settled();
      await eventually(() => changes.length === 2);
      expect(changes[1]).toBe("/repo:session:conv-u:false");

      changes.length = 0;
      await custodyAfterTurn(core);
      const sent = await core.sendUserMessage({
        conversationId: "conv-u",
        text: "And then?",
        inputOrigin: "user",
      });
      if (sent.kind !== "accepted") throw new Error(sent.message);
      await sent.settled;
      expect(changes).toEqual([
        "/repo:session:conv-u:true",
        "/repo:session:conv-u:false",
      ]);
    });

    it("leaves custody elsewhere alone", async () => {
      interactiveConversation();
      otherSessionConversation();
      const core = newCore({ interactiveWorktree: worktreeOf });
      const { held } = await custodyAfterTurn(core);
      await core.closeBackgroundWork(
        { projectPath: "/repo", sessionName: "other" },
        async () => {},
        { end: "archived", stop: true },
      );
      expect(held.told).toEqual([]);
      expect(core.holdsCustody("conv-u")).toBe(true);
    });
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
