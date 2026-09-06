/**
 * R6.1 — the write policy survives every hop of the conversation dispatch path.
 *
 * Absent means UNRESTRICTED. That asymmetry is the whole reason this file
 * exists: a hop that forgets the field produces no error, no log line, and no
 * failed turn — it produces a lane that quietly runs with the whole worktree
 * writable. So each hop between the composer and the backend gets its own
 * assertion, driven through that hop's production mapping rather than through a
 * re-implementation of it, and the one hop that can legitimately be handed a
 * policy it cannot honour is asserted to FAIL rather than continue.
 */

import { describe, expect, it, vi } from "vitest";
import { createActor, fromPromise } from "xstate";
import type { FsWritePolicy } from "@/lib/agent-backends/task";
import { executePromptStream, type PromptDeps } from "@/lib/prompt/sdk-driver";
import { conversationMachine } from "@/lib/workflows/conversation/machine";
import type {
  ExecutePromptInput,
  PromptActorResult,
} from "@/lib/workflows/conversation/types";
import { shouldRecreateRuntime } from "@/lib/workflows/conversation/pre-turn/runtime-recreate";
import type { SessionState } from "@/lib/sessions/schemas";

const POLICY: FsWritePolicy = {
  mode: "allowlist",
  allowWrite: [
    "/scratch/context-build",
    "/repo/src/lib",
    "/scratch/context-build/tmp",
  ],
  denyWrite: ["/repo/.git"],
};

function makeSession(): SessionState {
  return {
    sessionName: "envelope-session",
    worktreePath: "/repo",
    branchName: "csm/envelope",
    createdAt: new Date(0).toISOString(),
    lastActivityAt: new Date(0).toISOString(),
    archived: false,
    finished: false,
    conversations: [],
  } as unknown as SessionState;
}

describe("hop 1 — prompt options to the conversation lifecycle's turn request", () => {
  async function submitWith(
    fsWritePolicy: FsWritePolicy | undefined,
  ): Promise<{ fsWritePolicy?: FsWritePolicy }> {
    let turn: { fsWritePolicy?: FsWritePolicy } = {};
    const deps = {
      getConversation: async () => ({
        id: "conversation-1",
        agentBackend: "claude",
        pendingQueue: [],
      }),
      createConversation: async () => ({ id: "conversation-1" }),
      setConversationBackend: async () => {},
      getProjectDisplayName: async () => "repo",
      readConfig: async () => ({ projects: [] }),
      getConversationBackendFactory: () => ({ backend: "claude" }),
      ensureConversationLifecycle: async () => {},
      executeConversationTurn: async (input: {
        turn: { fsWritePolicy?: FsWritePolicy };
      }) => {
        turn = input.turn;
        return {
          status: "completed" as const,
          result: {
            contextTokens: null,
            contextWindowMax: null,
            aborted: false,
            compacted: false,
            error: null,
          },
        };
      },
    } as unknown as PromptDeps;

    await executePromptStream(
      "/repo",
      makeSession(),
      "Implement the context",
      () => {},
      "conversation-1",
      undefined,
      undefined,
      {
        autonomous: true,
        ...(fsWritePolicy !== undefined ? { fsWritePolicy } : {}),
      },
      deps,
    );
    return turn;
  }

  it("forwards a present policy", async () => {
    expect((await submitWith(POLICY)).fsWritePolicy).toEqual(POLICY);
  });

  it("leaves the field absent for an ordinary conversation", async () => {
    expect((await submitWith(undefined)).fsWritePolicy).toBeUndefined();
  });
});

describe("hop 2 — the machine's turn claim and the executePrompt actor input", () => {
  async function claimAndExecute(
    fsWritePolicy: FsWritePolicy | undefined,
  ): Promise<ExecutePromptInput> {
    let captured: ExecutePromptInput | undefined;
    const machine = conversationMachine.provide({
      actors: {
        prepareTurn: fromPromise(async () => ({
          transcriptPath: "/repo/.cc/transcript.jsonl",
        })) as never,
        executePrompt: fromPromise<PromptActorResult, ExecutePromptInput>(
          async ({ input }) => {
            captured = input;
            return {
              backendRef: null,
              contextTokens: null,
              contextWindow: null,
              contentBlocks: [],
              structuredOutput: undefined,
              aborted: false,
              compacted: false,
              numTurns: 0,
              error: null,
            } as unknown as PromptActorResult;
          },
        ) as never,
      },
      actions: {
        persistSnapshot: () => {},
        syncDerivedFields: () => {},
        broadcastConversationStatus: () => {},
        broadcastAskQuestion: () => {},
        broadcastDebugModeStatus: () => {},
        releaseResources: () => {},
        dispatchPushNotification: () => {},
        drainPendingQueue: () => {},
      } as never,
    });

    const actor = createActor(machine, {
      input: {
        projectPath: "/repo",
        projectName: "repo",
        sessionName: "envelope-session",
        worktreePath: "/repo",
        conversationId: "conversation-1",
        agentBackend: "claude",
        transient: false,
        persistence: "ephemeral",
      } as never,
    });
    actor.start();

    actor.send({
      type: "SUBMIT_PROMPT",
      promptText: "Implement the context",
      streamId: "stream-1",
      ...(fsWritePolicy !== undefined ? { fsWritePolicy } : {}),
    });

    await vi.waitFor(() => {
      if (captured === undefined) throw new Error("executePrompt not invoked");
    });
    actor.stop();
    // Narrowed rather than asserted: `vi.waitFor` above proves the value
    // arrived, but only a runtime check carries that into the return type.
    if (captured === undefined) throw new Error("executePrompt not invoked");
    return captured;
  }

  it("claims the policy onto the active turn and hands it to the executing actor", async () => {
    expect((await claimAndExecute(POLICY)).fsWritePolicy).toEqual(POLICY);
  });

  it("leaves the field absent for an ordinary turn", async () => {
    expect((await claimAndExecute(undefined)).fsWritePolicy).toBeUndefined();
  });
});

describe("hop 3 — a live runtime whose envelope is not this turn's", () => {
  const selection = {
    modelId: "opus",
    parameters: { effort: "high" },
  };
  const alive = { status: "alive", modelSelection: selection };

  it("rebuilds a runtime that was created unrestricted when the turn carries a policy", () => {
    // The drop that matters most: reusing the unrestricted session would run
    // the confined turn outside its envelope, and nothing downstream could tell.
    expect(
      shouldRecreateRuntime(alive, selection, undefined, null, POLICY),
    ).toBe(true);
  });

  it("rebuilds a runtime whose envelope no longer matches the turn's", () => {
    const widened: FsWritePolicy = {
      ...POLICY,
      allowWrite: [...POLICY.allowWrite, "/repo/src/components"],
    };

    expect(
      shouldRecreateRuntime(
        { ...alive, fsWritePolicy: POLICY },
        selection,
        undefined,
        null,
        widened,
      ),
    ).toBe(true);
  });

  it("rebuilds a confined runtime when the turn is no longer confined", () => {
    expect(
      shouldRecreateRuntime(
        { ...alive, fsWritePolicy: POLICY },
        selection,
        undefined,
        null,
        undefined,
      ),
    ).toBe(true);
  });

  it("reuses a runtime whose envelope is the same policy composed afresh", () => {
    // The composer builds a new object per turn, so identity comparison would
    // recreate the backend session on every single iteration.
    expect(
      shouldRecreateRuntime(
        { ...alive, fsWritePolicy: POLICY },
        selection,
        undefined,
        null,
        { ...POLICY, allowWrite: [...POLICY.allowWrite] },
      ),
    ).toBe(false);
  });
});
