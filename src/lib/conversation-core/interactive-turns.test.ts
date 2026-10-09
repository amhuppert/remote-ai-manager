import { describe, expect, it } from "vitest";
import type { DebugModePhase, DebugModeState } from "@/lib/debug-log/schemas";
import type { DebugFinalization } from "@/lib/workflows/debug/finalization";
import { resolveDebugOutputFormat } from "@/lib/workflows/debug/prompt-policy";
import type {
  ConversationBackendEvent,
  ConversationBackendRuntime,
  ConversationQueuedUserInput,
} from "@/lib/agent-backends/conversation";
import {
  InputDeliveryUncertainError,
  isPromptNotDeliveredFailure,
  markPromptNotDelivered,
} from "@/lib/agent-backends/errors";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import { settledConversationTurn } from "@/lib/conversation-core/turn/testing/turn-result-fixture";
import type { TurnExecutionOutcome } from "@/lib/conversation-core/turn/turn-result";
import type { ConversationRecordPort } from "./conversation-record";
import type { UserTurnRequest } from "./schemas";
import {
  createInteractiveTurns,
  type InteractiveTurnDeps,
} from "./interactive-turns";
import {
  prepareTurnInput,
  type InputDelivery,
  type TurnInputDependencies,
  type TurnInputRequest,
} from "./turn-input";
import type { TurnRequest } from "./turn-engine";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import {
  storeSessionNameFromScopeRef,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";

const enrollment = {
  conversationId: "conv-1",
  projectPath: "/repo",
  sessionName: "session",
  enrolledAt: "2026-10-03T10:00:00.000Z",
};
const identity = {
  projectPath: "/repo",
  storeSessionName: "session",
  conversationId: "conv-1",
};

const message = (
  overrides: Partial<UserTurnRequest> = {},
): UserTurnRequest => ({
  kind: "user_message",
  text: "Hello",
  inputOrigin: "user",
  ...overrides,
});

function outcomeOf(
  execution: ReturnType<typeof settledConversationTurn>,
): TurnExecutionOutcome {
  if (execution.kind !== "settled") throw new Error("fixture");
  return execution.turn.outcome;
}

const completed = (text = "Hi") =>
  outcomeOf(settledConversationTurn({ outcome: { kind: "completed", text } }));

interface Row {
  backendRef: AgentSessionRef | null;
  promptCount: number;
  debugMode?: DebugModeState | null;
  pendingQuestionId?: string | null;
}

const debugSession = (phase: DebugModePhase): DebugModeState => ({
  active: true,
  recording: true,
  logFilePath: "/w/.cc/debug/conv-1.ndjson",
  enteredAt: "2026-10-03T09:00:00.000Z",
  hypotheses: [],
  reproductionSteps: [],
  fixSummary: null,
  verificationSteps: [],
  instructionsDelivered: true,
  phase,
  lastTurnFailed: false,
  debugSessionId: "dbg-1",
});

function harness(
  answer: (turn: TurnRequest) => Promise<TurnExecutionOutcome>,
  row: Row | null = {
    backendRef: { backend: "claude", ref: "sdk-1" },
    promptCount: 2,
  },
  turnEnrollment: typeof enrollment = enrollment,
) {
  const turns: TurnRequest[] = [];
  const worktreeTargets: ConversationTarget[] = [];
  const events: string[] = [];
  const streamed: [string, unknown][] = [];
  const contexts: TurnInputRequest[] = [];
  const selections: unknown[] = [];
  const named: string[] = [];
  const accepted: (AgentSessionRef | null)[] = [];
  const archived: TranscriptEntry[] = [];
  const verifications: unknown[] = [];
  let settledDebug: DebugFinalization | null = null;
  /** The runtime the running turn holds, as the host would hand it out. */
  let runtime: ConversationBackendRuntime | null = null;
  const records: ConversationRecordPort = {
    async read() {
      return row === null
        ? null
        : {
            agentBackend: "claude",
            transcriptPath: "/t/conv-1.jsonl",
            debugMode: null,
            pendingQuestionId: null,
            owner: null,
            ...row,
          };
    },
    async beginTurn(_identity, source) {
      events.push(`begin:${source}`);
    },
    async recordContinuity(_identity, ref) {
      events.push(`continuity:${ref.ref}`);
    },
    async recordInterrupted() {},
    async recordWithdrawn() {},
    async claimTurn() {},
    async endClaim() {},
    hasPendingQuestion: () => false,
    async withdrawQuestion() {
      return false;
    },
    async settleTurn(_identity, settlement, source) {
      events.push(`settle:${settlement.counted}:${source}`);
      return { debug: settledDebug };
    },
    async adoptBackend(_identity, backend) {
      events.push(`adopt:${backend}`);
    },
    async admitProfile() {
      events.push("admit-profile");
      return {
        instructionBlock: "You review security.",
        snapshot: null,
        lockedAt: "2026-10-03T10:00:00.000Z",
      };
    },
  };
  const deps: InteractiveTurnDeps = {
    engine: {
      async runTurn(turn) {
        turns.push(turn);
        return answer(turn);
      },
    },
    records,
    host: {
      async release(conversationId) {
        events.push(`release:${conversationId}`);
      },
      isLive: () => false,
      runtime: () => runtime,
    },
    async worktreeOf(projectPath, target) {
      worktreeTargets.push(target);
      return target.scope === "session"
        ? `${projectPath}/.worktrees/${target.sessionName}`
        : projectPath;
    },
    async resolveModelSelection(input) {
      selections.push(input);
      return input.explicit ?? { modelId: "opus", parameters: {} };
    },
    continuation: async () => ({
      continuation: { kind: "ordinary" },
      seed: null,
    }),
    async prepareInput(request) {
      contexts.push(request);
      const delivery: InputDelivery = {
        dispatched: false,
        accepted: null,
        provenUndelivered: false,
      };
      return {
        promptText: `<memory-index/>\n\n${request.promptText}`,
        dispatchPromptText: `<memory-index/>\n\n${request.promptText}`,
        userPromptText: request.execution.turn.promptText,
        delivery,
        sending: () => {
          delivery.dispatched = true;
          events.push("dispatched");
        },
        failed: (error) => {
          delivery.provenUndelivered = isPromptNotDeliveredFailure(error);
        },
        async accepted(ref) {
          accepted.push(ref);
          delivery.accepted = { backendRef: ref };
          // As turn input does: keep the accepted input, then release the queue.
          await request.archive();
          await request.release();
        },
        async backendInit() {},
        async settle() {
          events.push("receipts-finished");
          return true;
        },
      };
    },
    nameConversation: (input) => named.push(input.content),
    async requestUserQuestion(scope, questions) {
      events.push(`asked:${scope.conversationId}:${questions.length}`);
      return { status: "answered" as const, answers: {} };
    },
    async persistImages(input) {
      if (input.images.length === 0)
        return { promptText: input.promptText, imageRefs: [] };
      return {
        promptText: `${input.promptText} [Image #3]`,
        imageRefs: input.images.map((image) => ({
          index: 3,
          mediaType: image.mediaType,
          path: "/t/images/3.png",
          base64Data: image.base64Data,
        })),
      };
    },
    queuedDelivery({ delivery, appendUserEntry }) {
      let released = false;
      return {
        async appendUserEntryAtDispatch() {},
        async appendAcceptedUserEntry() {
          events.push(`archive:${delivery.deliveryAttemptId}`);
          await appendUserEntry();
        },
        async handleInputAccepted() {
          released = true;
          events.push(`release:${delivery.deliveryAttemptId}`);
        },
        async releaseAccepted() {
          released = true;
          events.push(`release:${delivery.deliveryAttemptId}`);
        },
        async settleAfterTurn() {
          events.push(
            released ? "queue-settled" : `review:${delivery.deliveryAttemptId}`,
          );
        },
      };
    },
    async returnQueued({ delivery, error }) {
      events.push(`pending:${delivery.deliveryAttemptId}:${error}`);
    },
    async failQueued({ delivery, error }) {
      events.push(`failed:${delivery.deliveryAttemptId}:${error}`);
    },
    transcript: {
      async appendTranscriptEntryOnce(_conversationId, entry) {
        archived.push(entry);
      },
    },
    getProjectDisplayName: () => "repo",
    startDebugVerification(input) {
      verifications.push(input);
    },
    log: createCapturingLogger(),
  };
  // One port for the harness's life, as production composes it once.
  const port = createInteractiveTurns(deps);
  const run = (
    request: UserTurnRequest,
    signal = new AbortController().signal,
  ) =>
    port.run({
      conversationId: "conv-1",
      enrollment: turnEnrollment,
      request,
      attemptId: "attempt-1",
      signal,
      stream: { emit: (event, data) => streamed.push([event, data]) },
    });
  return {
    deps,
    port,
    run,
    turns,
    worktreeTargets,
    events,
    streamed,
    contexts,
    selections,
    named,
    accepted,
    archived,
    verifications,
    settleWithDebug(decision: DebugFinalization) {
      settledDebug = decision;
    },
    holdRuntime(held: ConversationBackendRuntime | null) {
      runtime = held;
    },
  };
}

/** A runtime that takes input into its running turn, recording what it was sent; `send` decides each delivery. */
function liveRuntime(
  send: (input: ConversationQueuedUserInput) => Promise<void> = (input) =>
    input.onAccepted?.() ?? Promise.resolve(),
) {
  const sent: ConversationQueuedUserInput[] = [];
  const runtime: ConversationBackendRuntime = {
    backend: "codex",
    status: "alive",
    modelSelection: { modelId: "gpt", parameters: {} },
    liveInput: "running_turn",
    sendTurn: async () => {
      throw new Error("not used");
    },
    async queueUserInput(input) {
      sent.push(input);
      await send(input);
    },
    close: async () => {},
  };
  return { runtime, sent };
}

/** Turn input as production prepares it, over inert context; records how its briefing finished. */
function realTurnInput(finished: string[] = []): TurnInputDependencies {
  return {
    context: {
      getLiveTicketBlock: async () => null,
      getMemoryIndexBlock: async () => null,
      readLiveReference: async () => null,
      readNotepadForInjection: async () => null,
    },
    effects: {
      recordNotepadDeliveries: async () => {},
      recordMemoryIndexDeliveries: async () => {},
    },
    subscriptions: {
      prepareBriefing: async () => ({
        block: "<briefing/>",
        onInputAccepted: async () => {},
        async finish(settled) {
          finished.push(settled?.disposition ?? "accepted");
        },
      }),
    },
    debug: { getDebugLogUrl: () => "http://debug" },
    log: createCapturingLogger(),
  };
}

const queued = (text: string, attempt = "att-9"): UserTurnRequest => ({
  kind: "user_message",
  text,
  inputOrigin: "user",
  queuedDelivery: { messageIds: [`q-${attempt}`], deliveryAttemptId: attempt },
});

describe("interactive turns", () => {
  it("runs a person's message as an ordinary turn of their conversation, with its context, model and continuity", async () => {
    const h = harness(async () => completed("Hi"));
    const result = await h.run(message());

    expect(result).toMatchObject({
      status: "succeeded",
      finalText: "Hi",
      failure: null,
    });
    expect(h.selections).toEqual([
      {
        projectPath: "/repo",
        backend: "claude",
        transcriptPath: "/t/conv-1.jsonl",
        explicit: null,
      },
    ]);
    expect(h.contexts[0]).toMatchObject({
      execution: {
        projectPath: "/repo",
        target: {
          scope: "session",
          sessionName: "session",
          conversationId: "conv-1",
        },
        worktreePath: "/repo/.worktrees/session",
        role: null,
        persistence: "durable",
        executionAttemptId: "attempt-1",
        turn: { inputOrigin: "user", promptText: "Hello" },
      },
      runtimeCreatedWithoutResume: false,
    });
    const turn = h.turns[0];
    expect(turn?.conversation).toMatchObject({
      conversationId: "conv-1",
      executionClass: "ordinary-conversation",
      persistedRef: { backend: "claude", ref: "sdk-1" },
      callerIdentity: "conv-1",
      worktreePath: "/repo/.worktrees/session",
    });
    expect(turn).toMatchObject({
      promptText: "<memory-index/>\n\nHello",
      userPromptText: "Hello",
      writeCapability: "write_capable",
      autonomous: false,
      waitForBackgroundTasks: false,
      requirements: {
        modelSelection: { modelId: "opus", parameters: {} },
        instructionSelection: { autonomous: false },
      },
      userEntry: {
        type: "user",
        content: [{ type: "text", text: "Hello" }],
        modelSelection: { modelId: "opus", parameters: {} },
      },
    });
    expect(h.events).toEqual([
      "begin:user",
      "admit-profile",
      "receipts-finished",
      "release:conv-1",
      "settle:true:user",
    ]);
    expect(h.named).toEqual([]);
  });

  it("runs a project conversation's message in the project root as the project, with no session identity for the agent", async () => {
    const projectEnrollment = {
      ...enrollment,
      sessionName: storeSessionNameFromScopeRef({ scope: "project" }),
    };
    const h = harness(
      async () => completed("Hi"),
      undefined,
      projectEnrollment,
    );
    const result = await h.run(message());

    expect(result).toMatchObject({ status: "succeeded", finalText: "Hi" });
    const target = {
      scope: "project",
      projectName: "repo",
      conversationId: "conv-1",
    };
    expect(h.worktreeTargets).toEqual([target]);
    expect(h.contexts[0]?.execution).toMatchObject({
      target,
      worktreePath: "/repo",
    });
    expect(h.turns[0]?.conversation).toMatchObject({
      target,
      worktreePath: "/repo",
    });
    // The agent of a project conversation has no session to act in (CC_CONVERSATION is session-only).
    expect(h.turns[0]?.conversation).not.toHaveProperty("callerIdentity");
  });

  it("streams the agent's content to the person's request and settles context receipts once the input is accepted", async () => {
    const block = { type: "text" as const, text: "Hi" };
    const h = harness(async (turn) => {
      await turn.onBackendInit?.({ backend: "claude", ref: "sdk-2" });
      const events: ConversationBackendEvent[] = [
        { type: "input_accepted" },
        { type: "content", block },
      ];
      for (const event of events) await turn.onEvent?.(event);
      return completed("Hi");
    });
    await h.run(message());

    expect(h.streamed).toEqual([["content", block]]);
    expect(h.accepted).toEqual([{ backend: "claude", ref: "sdk-2" }]);
    expect(h.events).toContain("continuity:sdk-2");
  });

  it("tells the person's request how a turn ended when it did not succeed, once", async () => {
    const cancelled = harness(async () => ({
      ...outcomeOf(
        settledConversationTurn({
          outcome: {
            kind: "failed",
            error: {
              backend: "claude",
              failureKind: "aborted",
              message: "aborted",
            },
          },
        }),
      ),
      interruption: { reason: "user" },
    }));
    expect((await cancelled.run(message())).status).toBe("cancelled");
    expect(cancelled.streamed).toEqual([
      ["aborted", { message: "Prompt execution was cancelled" }],
    ]);

    const timedOut = harness(async () => ({
      ...outcomeOf(
        settledConversationTurn({
          outcome: {
            kind: "failed",
            error: {
              backend: "claude",
              failureKind: "aborted",
              message: "aborted",
            },
          },
        }),
      ),
      interruption: { reason: "timeout", timeoutMs: 5000 },
    }));
    await timedOut.run(message());
    expect(timedOut.streamed).toEqual([
      ["aborted", { message: "Prompt execution timed out after 5000ms" }],
    ]);

    const failure = harness(async (turn) => {
      await turn.onEvent?.({ type: "error", message: "SDK transport closed" });
      return outcomeOf(
        settledConversationTurn({
          outcome: {
            kind: "failed",
            error: {
              backend: "claude",
              failureKind: "backend_error",
              message: "SDK transport closed",
            },
          },
        }),
      );
    });
    expect(await failure.run(message())).toMatchObject({
      status: "failed",
      failure: "SDK transport closed",
    });
    expect(failure.streamed).toEqual([
      ["error", { message: "SDK transport closed" }],
    ]);
  });

  it("refuses a model the project does not admit without running the turn, and leaves the turn uncounted", async () => {
    const h = harness(async () => completed());
    h.deps.resolveModelSelection = async () => {
      throw new Error('Model "gpt-x" is not available for this project');
    };
    const result = await h.run(
      message({ modelSelection: { modelId: "gpt-x", parameters: {} } }),
    );

    expect(result).toMatchObject({
      status: "failed",
      failure: 'Model "gpt-x" is not available for this project',
    });
    expect(h.turns).toEqual([]);
    expect(h.streamed).toEqual([
      ["error", { message: 'Model "gpt-x" is not available for this project' }],
    ]);
    expect(h.events).toEqual([
      "begin:user",
      "release:conv-1",
      "settle:false:user",
    ]);
  });

  it("takes the backend its first message chose, and refuses a different one once the conversation has run", async () => {
    const fresh = harness(async () => completed(), {
      backendRef: null,
      promptCount: 0,
    });
    await fresh.run(message({ backend: "codex" }));
    expect(fresh.events).toContain("adopt:codex");
    expect(fresh.turns[0]?.conversation.backend).toBe("codex");

    const used = harness(async () => completed());
    const result = await used.run(message({ backend: "codex" }));
    expect(result).toMatchObject({ status: "failed" });
    expect(result.failure).toContain("Backend mismatch");
    expect(used.turns).toEqual([]);
    expect(used.events).not.toContain("adopt:codex");
  });

  it("settles the conversation's profile before the turn and runs the agent under it", async () => {
    const h = harness(async () => completed());
    await h.run(message());
    expect(h.events.indexOf("admit-profile")).toBeGreaterThan(
      h.events.indexOf("begin:user"),
    );
    expect(h.turns[0]?.conversation.profile).toEqual({
      instructionBlock: "You review security.",
      snapshot: null,
      lockedAt: "2026-10-03T10:00:00.000Z",
    });
  });

  it("keeps an input whose receipts still owe after its turn, and settles it before the conversation's next turn", async () => {
    const h = harness(async () => completed());
    const prepare = h.deps.prepareInput;
    let firstSettles = 0;
    let inputs = 0;
    h.deps.prepareInput = async (request) => {
      inputs += 1;
      const prepared = await prepare(request);
      if (inputs > 1) return prepared;
      return {
        ...prepared,
        async settle() {
          firstSettles += 1;
          return firstSettles > 1;
        },
      };
    };
    await h.run(message());
    expect(firstSettles).toBe(1);

    await h.run(message({ text: "Next" }));
    expect(firstSettles).toBe(2);
  });

  describe("live input", () => {
    it("delivers a queued message into the running turn when its backend joins that turn, kept and released on acceptance", async () => {
      const live = liveRuntime();
      let outcome: unknown;
      const h = harness(async (turn) => {
        await turn.onEvent?.({ type: "input_accepted" });
        outcome = await h.port.deliverLive(identity, queued("Also this"));
        return completed();
      });
      h.holdRuntime(live.runtime);
      await h.run(message());

      expect(outcome).toBe("accepted");
      expect(
        h.contexts.map((context) => [context.mode, context.briefingAttemptId]),
      ).toEqual([
        ["turn", "attempt-1"],
        ["live", "att-9"],
      ]);
      expect(live.sent).toEqual([
        expect.objectContaining({
          content: [{ type: "text", text: "<memory-index/>\n\nAlso this" }],
          userPromptText: "Also this",
        }),
      ]);
      expect(h.events).toEqual(
        expect.arrayContaining(["archive:att-9", "release:att-9"]),
      );
      expect(h.archived.map((entry) => entry.id)).toContain("q-att-9");
    });

    it("leaves a message for the next turn when no turn runs, the runtime may answer it after the turn, or the row holds it", async () => {
      const seen: boolean[] = [];
      const h = harness(async (turn) => {
        // The turn's own input comes first.
        seen.push(await h.port.acceptsLive("conv-1"));
        await turn.onEvent?.({ type: "input_accepted" });
        seen.push(await h.port.acceptsLive("conv-1"));
        return completed();
      });
      h.holdRuntime(liveRuntime().runtime);
      seen.push(await h.port.acceptsLive("conv-1"));
      expect(await h.port.deliverLive(identity, queued("Too early"))).toBe(
        "not_sent",
      );
      expect(h.events).toContainEqual(expect.stringMatching(/^pending:att-9:/));
      await h.run(message());
      seen.push(await h.port.acceptsLive("conv-1"));
      expect(seen).toEqual([false, false, true, false]);

      const refused: boolean[] = [];
      const sessionScoped = { ...liveRuntime().runtime, liveInput: undefined };
      const withoutTurnScope = harness(async (turn) => {
        await turn.onEvent?.({ type: "input_accepted" });
        refused.push(await withoutTurnScope.port.acceptsLive("conv-1"));
        return completed();
      });
      withoutTurnScope.holdRuntime(sessionScoped);
      await withoutTurnScope.run(message());

      const asking = harness(
        async (turn) => {
          await turn.onEvent?.({ type: "input_accepted" });
          refused.push(await asking.port.acceptsLive("conv-1"));
          return completed();
        },
        { backendRef: null, promptCount: 1, pendingQuestionId: "question-1" },
      );
      asking.holdRuntime(liveRuntime().runtime);
      await asking.run(message());
      expect(refused).toEqual([false, false]);
    });

    it("returns an unsent message to the queue and holds an uncertain one for review", async () => {
      const outcomes: unknown[] = [];
      const failures: Error[] = [
        new Error("The turn ended"),
        new InputDeliveryUncertainError("No acknowledgement"),
      ];
      const live = liveRuntime(async () => {
        throw failures.shift();
      });
      const h = harness(async (turn) => {
        await turn.onEvent?.({ type: "input_accepted" });
        outcomes.push(
          await h.port.deliverLive(identity, queued("One", "att-1")),
        );
        outcomes.push(
          await h.port.deliverLive(identity, queued("Two", "att-2")),
        );
        return completed();
      });
      h.holdRuntime(live.runtime);
      await h.run(message());

      expect(outcomes).toEqual(["not_sent", "uncertain"]);
      expect(h.events).toContainEqual(expect.stringMatching(/^pending:att-1:/));
      expect(h.events).toContain("review:att-2");
    });

    it("settles the briefing a refused live delivery carried as not sent, as its message goes back to the queue", async () => {
      const finished: string[] = [];
      const inputDeps = realTurnInput(finished);
      // As Cursor refuses an attachment before anything is sent.
      const live = liveRuntime(async () => {
        throw new Error(
          "Cursor steering accepts text only; attachments require the next turn",
        );
      });
      let outcome: unknown;
      const h = harness(async (turn) => {
        await turn.onEvent?.({ type: "input_accepted" });
        finished.length = 0;
        outcome = await h.port.deliverLive(identity, queued("Look at this"));
        return completed();
      });
      h.deps.prepareInput = (request) => prepareTurnInput(inputDeps, request);
      h.holdRuntime(live.runtime);
      await h.run(message());

      expect(outcome).toBe("not_sent");
      expect(finished).toEqual(["not_sent"]);
    });

    it("holds an accepted live delivery for review when the queue could not release it", async () => {
      let outcome: unknown;
      const h = harness(async (turn) => {
        await turn.onEvent?.({ type: "input_accepted" });
        outcome = await h.port.deliverLive(identity, queued("Also this"));
        return completed();
      });
      const accounting = h.deps.queuedDelivery;
      h.deps.queuedDelivery = (input) => ({
        ...accounting(input),
        async releaseAccepted() {
          throw new Error("database is locked");
        },
      });
      h.holdRuntime(liveRuntime().runtime);
      await h.run(message());

      expect(outcome).toBe("accepted");
      expect(h.events).toContain("review:att-9");
    });

    it("returns a delivery whose turn began settling while it was checked", async () => {
      const gate = Promise.withResolvers<void>();
      let delivery: Promise<unknown> | undefined;
      const live = liveRuntime();
      const h = harness(async (turn) => {
        await turn.onEvent?.({ type: "input_accepted" });
        // Only the live check's row read waits: it is made synchronously inside the call.
        const read = h.deps.records.read;
        h.deps.records.read = async (identityRead) => {
          await gate.promise;
          return read(identityRead);
        };
        delivery = h.port.deliverLive(identity, queued("Late"));
        h.deps.records.read = read;
        return completed();
      });
      h.holdRuntime(live.runtime);
      await h.run(message());
      gate.resolve();

      expect(await delivery).toBe("not_sent");
      expect(live.sent).toEqual([]);
    });

    it("ends the turn only once a live delivery it took has settled", async () => {
      let deliver = () => {};
      const live = liveRuntime(
        (input) =>
          new Promise(
            (resolve) => (deliver = () => resolve(input.onAccepted?.())),
          ),
      );
      let delivery: Promise<unknown> | undefined;
      const h = harness(async (turn) => {
        await turn.onEvent?.({ type: "input_accepted" });
        delivery = h.port.deliverLive(identity, queued("Late"));
        // The turn ends while the send is in flight.
        while (live.sent.length === 0)
          await new Promise((resolve) => setTimeout(resolve, 1));
        setTimeout(() => deliver(), 10);
        return completed();
      });
      h.holdRuntime(live.runtime);
      await h.run(message());

      expect(h.events).toContain("release:att-9");
      expect(await delivery).toBe("accepted");
    });
  });

  it("saves a message's images with the transcript and hands them to the agent with their numbered text", async () => {
    const h = harness(async () => completed());
    await h.run(
      message({
        text: "What is this?",
        images: [
          { attachmentId: "a-1", mediaType: "image/png", base64Data: "aGk=" },
        ],
      }),
    );

    expect(h.contexts[0]?.promptText).toBe("What is this? [Image #3]");
    expect(h.turns[0]?.imageRefs).toEqual([
      {
        index: 3,
        mediaType: "image/png",
        path: "/t/images/3.png",
        base64Data: "aGk=",
      },
    ]);
    expect(h.turns[0]?.userEntry?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "image_ref",
          imagePath: "/t/images/3.png",
        }),
      ]),
    );
  });

  it("turns document feedback into the agent's prose while the transcript keeps the feedback itself", async () => {
    const h = harness(async () => completed());
    const documentFeedback = {
      items: [
        {
          docPath: "docs/plan.md",
          path: "docs/plan.md",
          headingLabel: "Rollout",
          line: 12,
          quote: "Ship it",
          note: "Too early",
        },
      ],
    };
    await h.run(
      message({ text: "", documentFeedback, inputOrigin: "generated" }),
    );

    expect(h.contexts[0]?.promptText).toContain("Too early");
    expect(h.turns[0]?.userEntry?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "document_feedback" }),
      ]),
    );
  });

  it("archives a queued delivery only once the backend accepts it, then releases its rows", async () => {
    const h = harness(async (turn) => {
      await turn.onEvent?.({ type: "input_accepted" });
      return completed();
    });
    const delivery = { messageIds: ["q-1"], deliveryAttemptId: "att-q" };
    await h.run(
      message({ text: "Queued while busy", queuedDelivery: delivery }),
    );

    expect(h.turns[0]?.userEntry).toBeNull();
    expect(h.archived).toEqual([
      expect.objectContaining({ id: "q-1", role: "user" }),
    ]);
    expect(h.events).toEqual(
      expect.arrayContaining([
        "archive:att-q",
        "release:att-q",
        "queue-settled",
      ]),
    );
    expect(h.events.indexOf("archive:att-q")).toBeLessThan(
      h.events.indexOf("release:att-q"),
    );
  });

  it("fails a queued delivery the turn never sent, keeping it visible with the reason", async () => {
    const h = harness(async () => completed());
    h.deps.resolveModelSelection = async () => {
      throw new Error("Model gpt-x is not available");
    };
    await h.run(
      message({
        text: "Queued",
        queuedDelivery: { messageIds: ["q-2"], deliveryAttemptId: "att-r" },
      }),
    );

    expect(h.events).toContain("failed:att-r:Model gpt-x is not available");
    expect(h.events.some((event) => event.startsWith("review:"))).toBe(false);
  });

  it("retries a queue release it could not confirm, at the latest before the conversation's next turn", async () => {
    let confirmFailures = 2;
    const released: string[] = [];
    const h = harness(async (turn) => {
      await turn.onEvent?.({ type: "input_accepted" });
      return completed();
    });
    h.deps.prepareInput = (request) =>
      prepareTurnInput(realTurnInput(), request);
    const accounting = h.deps.queuedDelivery;
    h.deps.queuedDelivery = (input) => ({
      ...accounting(input),
      async releaseAccepted() {
        if (confirmFailures > 0) {
          confirmFailures -= 1;
          throw new Error("database is locked");
        }
        released.push(input.delivery.deliveryAttemptId);
      },
    });
    await h.run(
      message({
        text: "Queued",
        queuedDelivery: { messageIds: ["q-7"], deliveryAttemptId: "att-7" },
      }),
    );
    expect(released).toEqual([]);

    await h.run(message({ text: "Next" }));
    expect(released).toEqual(["att-7"]);
  });

  it("fails a queued batch whose send provably never reached the agent, rather than holding it for review", async () => {
    const h = harness(async (turn) => {
      turn.observe?.sending();
      turn.observe?.failed(
        markPromptNotDelivered(
          new Error("the provider socket closed before the prompt was written"),
        ),
      );
      return outcomeOf(
        settledConversationTurn({
          outcome: {
            kind: "failed",
            error: {
              backend: "claude",
              failureKind: "backend_error",
              message: "socket closed",
            },
          },
        }),
      );
    });
    await h.run(
      message({
        text: "Queued",
        queuedDelivery: { messageIds: ["q-5"], deliveryAttemptId: "att-5" },
      }),
    );

    expect(h.events).toContainEqual(expect.stringMatching(/^failed:att-5:/));
    expect(h.events).not.toContain("review:att-5");
  });

  it("fails a batch the person stopped before it was sent, and gives one the server stopped back to the queue", async () => {
    const h = harness(async () => completed());
    const queued = (attempt: string) =>
      message({
        text: "Queued",
        queuedDelivery: {
          messageIds: [`q-${attempt}`],
          deliveryAttemptId: attempt,
        },
      });
    const notStarted = (
      attempt: string,
      endedBy: "person" | "server" | "failure",
      reason: string,
    ) =>
      h.port.notStarted?.({
        conversationId: "conv-1",
        enrollment,
        request: queued(attempt),
        cause: `queue:conv-1:${attempt}`,
        reason,
        endedBy,
      });
    await notStarted("att-s", "person", "cancelled before admission");
    // Provably never sent: it is delivered after the restart, not held as possibly seen.
    await notStarted("att-t", "server", "the server is stopping");
    await notStarted("att-u", "failure", "database is locked");
    await h.port.notStarted?.({
      conversationId: "conv-1",
      enrollment,
      request: message({ text: "Direct" }),
      cause: "user:conv-1:1",
      reason: "cancelled before admission",
      endedBy: "person",
    });
    expect(h.events).toEqual([
      "failed:att-s:Stopped before it was sent",
      "pending:att-t:The server stopped before it was sent",
      "failed:att-u:Not sent: database is locked",
    ]);
  });

  it("settles a queued batch even when its turn fails before it begins", async () => {
    const h = harness(async () => completed());
    h.deps.records.beginTurn = async () => {
      throw new Error("database is locked");
    };
    await expect(
      h.run(
        message({
          text: "Queued",
          queuedDelivery: { messageIds: ["q-9"], deliveryAttemptId: "att-9" },
        }),
      ),
    ).rejects.toThrow("database is locked");
    expect(h.turns).toEqual([]);
    expect(h.events).toEqual(["failed:att-9:database is locked"]);
  });

  it("lets the agent ask the person in the middle of a turn", async () => {
    const h = harness(async (turn) => {
      await turn.onUserQuestion?.(
        [
          {
            question: "Which database?",
            options: [],
            multiSelect: false,
            required: true,
            allowNote: true,
          },
        ],
        new AbortController().signal,
      );
      return completed();
    });
    await h.run(message());
    expect(h.events).toContain("asked:conv-1:1");
    expect(h.turns[0]?.requirements.instructionSelection).toEqual({
      autonomous: false,
    });
  });

  it("names a conversation from its first message", async () => {
    const h = harness(async () => completed(), {
      backendRef: null,
      promptCount: 0,
    });
    await h.run(message({ text: "Fix the flaky login test" }));
    expect(h.named).toEqual(["Fix the flaky login test"]);
  });

  it("delivers the full context to a continuing conversation whose runtime cannot resume", async () => {
    const h = harness(async () => completed(), {
      backendRef: null,
      promptCount: 3,
    });
    await h.run(message());
    expect(h.contexts[0]?.runtimeCreatedWithoutResume).toBe(true);
  });

  describe("in debug mode", () => {
    const report = { removedProbes: ["src/a.ts:12"] };

    it("runs the person's turn with the session's debug context and its phase's report format", async () => {
      const h = harness(async () => completed(), {
        backendRef: null,
        promptCount: 2,
        debugMode: debugSession("hypothesizing"),
      });
      await h.run(message({ text: "It crashes on save" }));
      expect(h.contexts[0]?.execution.debugMode).toMatchObject({
        phase: "hypothesizing",
        debugSessionId: "dbg-1",
      });
      expect(h.turns[0]?.outputFormat).toEqual(
        resolveDebugOutputFormat("hypothesizing"),
      );

      const waiting = harness(async () => completed(), {
        backendRef: null,
        promptCount: 2,
        debugMode: debugSession("awaiting_reproduction"),
      });
      await waiting.run(message({ text: "What should I try?" }));
      expect(waiting.turns[0]?.outputFormat).toBeUndefined();

      const ordinary = harness(async () => completed());
      await ordinary.run(message());
      expect(ordinary.contexts[0]?.execution.debugMode).toBeNull();
      expect(ordinary.turns[0]?.outputFormat).toBeUndefined();
    });

    it("keeps the report with the phase it answered, and hands a cleanup report to verification", async () => {
      const h = harness(
        async () =>
          outcomeOf(
            settledConversationTurn({
              outcome: {
                kind: "completed",
                text: "Removed.",
                structuredOutput: report,
              },
            }),
          ),
        {
          backendRef: null,
          promptCount: 2,
          debugMode: debugSession("cleanup_instrumentation"),
        },
      );
      h.settleWithDebug({
        kind: "verify_cleanup",
        debugMode: {
          ...debugSession("cleanup_instrumentation"),
          debugSessionId: "dbg-1",
          cleanupVerificationAttempt: 2,
        },
      });
      await h.run(message({ text: "Fixed, clean up" }));

      expect(h.archived).toEqual([
        expect.objectContaining({
          role: "assistant",
          content: [
            {
              type: "debug_structured",
              phase: "cleanup_instrumentation",
              payload: report,
            },
          ],
        }),
      ]);
      expect(h.verifications).toEqual([
        {
          identity: {
            projectPath: "/repo",
            storeSessionName: "session",
            conversationId: "conv-1",
          },
          worktreePath: "/repo/.worktrees/session",
          structuredOutput: report,
          debugSessionId: "dbg-1",
          attempt: 2,
          turnAttemptId: "attempt-1",
        },
      ]);
    });

    it("settles a debug turn the person stopped before it started, so its phase can mark it failed", async () => {
      const h = harness(async () => completed(), {
        backendRef: null,
        promptCount: 2,
        debugMode: debugSession("analyzing_evidence"),
      });
      await h.port.notStarted?.({
        conversationId: "conv-1",
        enrollment,
        request: message({ text: "Reproduced it" }),
        cause: "user:conv-1:1",
        reason: "cancelled before admission",
        endedBy: "person",
      });
      expect(h.events).toEqual(["settle:false:user"]);

      const ordinary = harness(async () => completed());
      await ordinary.port.notStarted?.({
        conversationId: "conv-1",
        enrollment,
        request: message({ text: "Never mind" }),
        cause: "user:conv-1:2",
        reason: "cancelled before admission",
        endedBy: "person",
      });
      expect(ordinary.events).toEqual([]);
    });

    it("keeps no report for a turn that failed", async () => {
      const h = harness(
        async () =>
          outcomeOf(
            settledConversationTurn({
              outcome: {
                kind: "failed",
                contentBlocks: [],
                error: {
                  backend: "claude",
                  failureKind: "backend_error",
                  message: "transport closed",
                },
              },
            }),
          ),
        {
          backendRef: null,
          promptCount: 2,
          debugMode: debugSession("hypothesizing"),
        },
      );
      await h.run(message({ text: "It crashes" }));
      expect(h.archived).toEqual([]);
      expect(h.verifications).toEqual([]);
    });
  });

  it("fails a message to a conversation that no longer exists without touching it", async () => {
    const h = harness(async () => completed(), null);
    expect(await h.run(message())).toMatchObject({ status: "failed" });
    expect(h.events).toEqual([]);
    expect(h.streamed).toEqual([
      ["error", { message: "Conversation conv-1 no longer exists" }],
    ]);
  });
});
