import { describe, it, expect, vi, afterEach } from "vitest";
import {
  collectRehydrationCandidates,
  getConversationActor,
  rehydrateConversationActors,
  setConversationQueueDeps,
  setMachineFactory,
  _resetConversationQueueDepsForTesting,
  _resetForTesting,
  _resetMachineFactoryForTesting,
  type ConversationQueueDeps,
  type RehydrateConversationActorsDeps,
} from "./manager";
import { conversationMachine } from "./machine";
import type {
  ConversationInput,
  ExecutePromptInput,
  PrepareTurnInput,
  PrepareTurnOutput,
  PromptActorResult,
} from "./types";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import {
  conversationStateSchema,
  type ConversationState,
} from "@/lib/conversations/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { managerStateSchema, type ManagerState } from "@/lib/projects/schemas";
import {
  createActor,
  fromPromise,
  type AnyActorRef,
  type Snapshot,
} from "xstate";

const ts = "2025-01-01T00:00:00.000Z";

function conv(
  overrides: Partial<ConversationState> & { id: string },
): ConversationState {
  return conversationStateSchema.parse({
    scope: "session",
    transcriptPath: null,
    status: "awaiting",
    promptCount: 1,
    createdAt: ts,
    lastActivityAt: ts,
    ...overrides,
  });
}

function stateWith(conversations: ConversationState[]): ManagerState {
  const session = sessionStateSchema.parse({
    sessionName: "feat",
    worktreePath: "/repo/.worktrees/feat",
    branchName: "csm/feat",
    createdAt: ts,
    lastActivityAt: ts,
    conversations,
  });
  return managerStateSchema.parse({
    projects: { "/repo": { rootPath: "/repo", sessions: { feat: session } } },
    archivedProjects: [],
    pinnedProjects: [],
  });
}

const emptyState = (): ManagerState =>
  managerStateSchema.parse({
    projects: {},
    archivedProjects: [],
    pinnedProjects: [],
  });

afterEach(() => {
  _resetForTesting();
  _resetMachineFactoryForTesting();
  _resetConversationQueueDepsForTesting();
});

describe("collectRehydrationCandidates", () => {
  it("flattens session and project conversations with the right keying", () => {
    const state = stateWith([conv({ id: "s1" })]);
    const candidates = collectRehydrationCandidates(state, [
      {
        projectPath: "/repo",
        conversation: conv({ id: "p1", scope: "project" }),
      },
    ]);

    const session = candidates.find((c) => c.conversation.id === "s1");
    expect(session?.sessionName).toBe("feat");
    expect(session?.worktreePath).toBe("/repo/.worktrees/feat");

    const project = candidates.find((c) => c.conversation.id === "p1");
    expect(project?.sessionName).toBe(PROJECT_CONVERSATION_SESSION_SENTINEL);
    expect(project?.worktreePath).toBe("/repo");
    expect(project?.projectPath).toBe("/repo");
  });
});

describe("rehydrateConversationActors (project conversations)", () => {
  function makeDeps(
    projectConvs: { projectPath: string; conversation: ConversationState }[],
    validate: RehydrateConversationActorsDeps["validateRestoredSnapshot"],
  ): RehydrateConversationActorsDeps {
    return {
      readState: async () => emptyState(),
      listAllProjectConversations: async () => projectConvs,
      getProjectDisplayName: () => "demo",
      validateRestoredSnapshot: validate,
    };
  }

  it("walks a project conversation's snapshot via the injected validator", async () => {
    const projConv = conv({
      id: "p1",
      scope: "project",
      machineSnapshot: { marker: "p1-snapshot" },
    });
    const validate = vi.fn(() => null); // treat as invalid → no actor
    const count = await rehydrateConversationActors(
      makeDeps([{ projectPath: "/repo", conversation: projConv }], validate),
    );
    expect(count).toBe(0);
    expect(validate).toHaveBeenCalledWith({ marker: "p1-snapshot" }, "p1", 1);
  });

  it("skips a non-resumable project snapshot (active without a pending question)", async () => {
    const projConv = conv({
      id: "p1",
      scope: "project",
      machineSnapshot: { x: 1 },
    });
    const nonResumable = {
      status: "active",
      value: "running",
      context: {},
    } as unknown as Snapshot<unknown>;
    const count = await rehydrateConversationActors(
      makeDeps(
        [{ projectPath: "/repo", conversation: projConv }],
        () => nonResumable,
      ),
    );
    expect(count).toBe(0);
  });

  it("does not validate a project conversation with no persisted snapshot", async () => {
    const projConv = conv({ id: "p1", scope: "project" }); // machineSnapshot null
    const validate = vi.fn(() => null);
    const count = await rehydrateConversationActors(
      makeDeps([{ projectPath: "/repo", conversation: projConv }], validate),
    );
    expect(count).toBe(0);
    expect(validate).not.toHaveBeenCalled();
  });
});

describe("waitingForInput rehydration contract", () => {
  // The turn must stay open until ASK_QUESTION lands, so executePrompt
  // resolves only when the test releases it.
  let releaseTurn: (() => void) | null = null;

  const stubbedMachine = () =>
    conversationMachine.provide({
      actors: {
        prepareTurn: fromPromise<PrepareTurnOutput, PrepareTurnInput>(
          async () => ({ transcriptPath: "/tmp/t.jsonl" }),
        ),
        executePrompt: fromPromise<PromptActorResult, ExecutePromptInput>(
          () =>
            new Promise((resolve) => {
              releaseTurn = () => resolve(promptResult());
            }),
        ),
      },
      actions: {
        persistSnapshot: () => {},
        syncDerivedFields: () => {},
        broadcastConversationStatus: () => {},
        broadcastAskQuestion: () => {},
        broadcastDebugModeStatus: () => {},
        releaseResources: () => {},
        dispatchPushNotification: () => {},
        markUnreadOnFinish: () => {},
        markReadOnUserTurnStart: () => {},
        drainPendingQueue: () => {},
      },
    });

  function promptResult(): PromptActorResult {
    return {
      backendRef: null,
      costUsd: null,
      durationMs: null,
      numTurns: 1,
      contextTokens: null,
      contextWindow: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      contentBlocks: [],
      aborted: false,
      compacted: false,
      error: null,
      structuredOutput: undefined,
    };
  }

  const actorInput: ConversationInput = {
    projectPath: "/repo",
    projectName: "demo",
    sessionName: "feat",
    worktreePath: "/repo/.worktrees/feat",
    conversationId: "c-wfi",
    createdAt: ts,
    forkedFrom: null,
    role: null,
    transcriptPath: null,
    agentBackend: "claude",
    backendRef: null,
    promptCount: 0,
  };

  const claimNextTurnBatch = vi.fn(async () => null);
  const noopQueueDeps: ConversationQueueDeps = {
    claimNextTurnBatch,
    markPending: async () => {},
    markDelivered: async () => {},
    markFailed: async () => {},
    recoverAbandonedDeliveries: async () => 0,
    runConversationCommand: async () => {
      throw new Error("not used");
    },
  };

  /** Drive a throwaway actor into waitingForInput and capture its persisted
   *  snapshot — the exact payload persistSnapshot would have written. */
  async function captureWaitingForInputSnapshot(): Promise<unknown> {
    const actor = createActor(stubbedMachine(), { input: actorInput });
    actor.start();
    actor.send({ type: "SUBMIT_PROMPT", promptText: "hi", streamId: "s1" });
    await waitForValue(actor, (v) => JSON.stringify(v).includes("executing"));
    await new Promise((r) => setTimeout(r, 10));
    actor.send({ type: "ASK_QUESTION", questionId: "q-9", questions: [] });
    releaseTurn!();
    await waitForValue(actor, (v) => v === "waitingForInput");
    const persisted = actor.getPersistedSnapshot();
    actor.stop();
    return persisted;
  }

  function waitForValue(
    actor: AnyActorRef,
    predicate: (value: unknown) => boolean,
    timeoutMs = 3000,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Timed out; current: ${JSON.stringify(actor.getSnapshot().value)}`,
            ),
          ),
        timeoutMs,
      );
      if (predicate(actor.getSnapshot().value)) {
        clearTimeout(timer);
        resolve();
        return;
      }
      const sub = actor.subscribe((s) => {
        if (predicate(s.value)) {
          clearTimeout(timer);
          sub.unsubscribe();
          resolve();
        }
      });
    });
  }

  it("a conversation persisted in waitingForInput wakes in waitingForInput after restart", async () => {
    const persisted = await captureWaitingForInputSnapshot();
    setMachineFactory(stubbedMachine);
    setConversationQueueDeps(noopQueueDeps);

    const conversation = conv({
      id: "c-wfi",
      status: "waiting_for_input",
      machineSnapshot: persisted as ConversationState["machineSnapshot"],
    });
    const deps: RehydrateConversationActorsDeps = {
      readState: async () => stateWith([conversation]),
      listAllProjectConversations: async () => [],
      getProjectDisplayName: () => "demo",
      validateRestoredSnapshot: (raw) => raw as Snapshot<unknown>,
    };

    const count = await rehydrateConversationActors(deps);
    expect(count).toBe(1);

    const actor = getConversationActor("/repo", "feat", "c-wfi");
    expect(actor).toBeDefined();
    const snap = actor!.getSnapshot();
    expect(snap.value).toBe("waitingForInput");
    expect(snap.context.pendingQuestion).toEqual({
      questionId: "q-9",
      questions: [],
    });
    // The woken actor accepts the answer/supersede turn claim.
    expect(
      snap.can({ type: "SUBMIT_PROMPT", promptText: "answer", streamId: "s2" }),
    ).toBe(true);

    // Restored actors never re-fire entry drains; the rehydrator must drain
    // explicitly so rows enqueued before the restart deliver.
    await vi.waitFor(() => {
      expect(claimNextTurnBatch).toHaveBeenCalledWith({
        projectPath: "/repo",
        sessionName: "feat",
        conversationId: "c-wfi",
      });
    });
  });
});
