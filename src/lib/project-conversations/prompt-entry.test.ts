import { describe, it, expect } from "vitest";
import {
  createProjectPromptExecutor,
  type ExecuteProjectPromptStreamDeps,
} from "./prompt-entry";
import {
  BackendMismatchError,
  ModelEffortValidationError,
  type PromptStreamResult,
} from "@/lib/prompt/sdk-driver";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";
import type { EnsureActorInputData } from "@/lib/workflows/conversation/manager";

function makeConv(
  overrides: Partial<ConversationState> & { id: string },
): ConversationState {
  return {
    id: overrides.id,
    scope: "project",
    name: overrides.name ?? "Repo chat",
    transcriptPath: null,
    status: overrides.status ?? "new",
    promptCount: overrides.promptCount ?? 0,
    createdAt: "2025-01-01T00:00:00.000Z",
    lastActivityAt: "2025-01-01T00:00:00.000Z",
    source: "cc",
    summary: null,
    archived: false,
    open: true,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    agentBackend: overrides.agentBackend ?? "claude",
    backendRef: null,
    unread: false,
    pendingQueue: [],
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
    ...(overrides.creationRequestId !== undefined
      ? { creationRequestId: overrides.creationRequestId }
      : {}),
  };
}

interface ExecCall {
  projectPath: string;
  session: SessionState;
  text: string;
  conversationId: string | undefined;
  options:
    | {
        executionTarget?: ExecutionTarget;
        actorInput?: EnsureActorInputData;
        effort?: string;
        backend?: unknown;
      }
    | undefined;
}

function harness(opts?: {
  seed?: ConversationState[];
  executeImpl?: (call: ExecCall) => Promise<PromptStreamResult>;
  overrides?: Partial<ExecuteProjectPromptStreamDeps>;
}) {
  const store = new Map<string, ConversationState>();
  for (const c of opts?.seed ?? []) store.set(c.id, c);
  const calls: ExecCall[] = [];
  const adopted: Array<{ id: string; backend: string }> = [];
  const createdBroadcasts: Array<{
    projectPath: string;
    id: string;
    creationRequestId: string | undefined;
  }> = [];
  let createdCount = 0;

  const deps: ExecuteProjectPromptStreamDeps = {
    resolveExecutionTarget: async (projectPath): Promise<ExecutionTarget> => ({
      worktreePath: projectPath,
      branchName: "main",
      isolation: "worktree",
      laneId: null,
    }),
    executePromptStream: (async (
      projectPath,
      session,
      text,
      _emit,
      conversationId,
      _modelId,
      _images,
      options,
    ) => {
      const call: ExecCall = {
        projectPath,
        session,
        text,
        conversationId,
        options,
      };
      calls.push(call);
      if (opts?.executeImpl) return opts.executeImpl(call);
      return {
        conversationId: conversationId ?? "?",
        contextTokens: null,
        contextWindowMax: null,
      };
    }) as ExecuteProjectPromptStreamDeps["executePromptStream"],
    readConfig: (async () => ({
      defaultAgentBackend: "claude",
    })) as ExecuteProjectPromptStreamDeps["readConfig"],
    getProjectDisplayName: () => "my-project",
    createProjectConversation: async (_projectPath, o) => {
      createdCount += 1;
      const conv = makeConv({
        id: `created-${createdCount}`,
        agentBackend: o?.agentBackend ?? "claude",
        ...(o?.creationRequestId !== undefined
          ? { creationRequestId: o.creationRequestId }
          : {}),
      });
      store.set(conv.id, conv);
      return conv;
    },
    getProjectConversation: async (_projectPath, id) => store.get(id) ?? null,
    adoptProjectConversationBackend: async (_projectPath, id, backend) => {
      adopted.push({ id, backend });
      const c = store.get(id);
      if (c) c.agentBackend = backend;
    },
    broadcastConversationCreated: (projectPath, conversation) => {
      createdBroadcasts.push({
        projectPath,
        id: conversation.id,
        creationRequestId: conversation.creationRequestId,
      });
    },
    ...opts?.overrides,
  };

  const { executeProjectPromptStream } = createProjectPromptExecutor(deps);
  return {
    executeProjectPromptStream,
    calls,
    adopted,
    createdBroadcasts,
    store,
    createdCount: () => createdCount,
  };
}

describe("executeProjectPromptStream", () => {
  it("creates the first project conversation and submits its first turn", async () => {
    const h = harness();
    await h.executeProjectPromptStream({
      projectPath: "/repo",
      promptText: "hello main",
      emit: () => {},
    });
    expect(h.createdCount()).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.conversationId).toBe("created-1");
    expect(h.calls[0]?.text).toBe("hello main");
  });

  it("broadcasts conversation-created when the first-prompt flow creates a PLC", async () => {
    const h = harness();
    await h.executeProjectPromptStream({
      projectPath: "/repo",
      promptText: "first",
      emit: () => {},
    });
    expect(h.createdBroadcasts).toEqual([
      { projectPath: "/repo", id: "created-1", creationRequestId: undefined },
    ]);
  });

  it("names the created conversation on the turn's own stream, before the turn runs", async () => {
    const emitted: Array<{ event: string; data: unknown }> = [];
    const emittedBeforeTurn: string[] = [];
    const h = harness({
      executeImpl: async (call) => {
        emittedBeforeTurn.push(...emitted.map((e) => e.event));
        return {
          conversationId: call.conversationId ?? "?",
          contextTokens: null,
          contextWindowMax: null,
          compacted: false,
        };
      },
    });

    await h.executeProjectPromptStream({
      projectPath: "/repo",
      promptText: "first",
      emit: (event, data) => emitted.push({ event, data }),
    });

    // The client that posted this turn learns which conversation is now its
    // own from the response it is already reading, so its turn state is never
    // attributed by guesswork to whichever conversation surfaces first.
    expect(emitted).toContainEqual({
      event: "conversation",
      data: { conversationId: "created-1" },
    });
    expect(emittedBeforeTurn).toEqual(["conversation"]);
  });

  it("records the posting client's creation-request token on the conversation it creates", async () => {
    const h = harness();
    await h.executeProjectPromptStream({
      projectPath: "/repo",
      promptText: "first",
      creationRequestId: "req-7",
      emit: () => {},
    });

    // Durable creation provenance: the client that posted this submission can
    // recognise the conversation created for it wherever the record is read,
    // including the list it already subscribes to — so a lost `conversation`
    // frame does not leave the turn unable to identify its own conversation.
    expect(h.store.get("created-1")?.creationRequestId).toBe("req-7");
    expect(h.createdBroadcasts).toEqual([
      { projectPath: "/repo", id: "created-1", creationRequestId: "req-7" },
    ]);
  });

  it("records no creation-request token on a turn that targets an existing conversation", async () => {
    const h = harness({ seed: [makeConv({ id: "c1", promptCount: 1 })] });
    await h.executeProjectPromptStream({
      projectPath: "/repo",
      conversationId: "c1",
      promptText: "next",
      creationRequestId: "req-7",
      emit: () => {},
    });

    // Nothing was created, so nothing gains a creation token — a later
    // create-and-send submission must not find this conversation wearing one.
    expect(h.store.get("c1")?.creationRequestId).toBeUndefined();
    expect(h.createdBroadcasts).toEqual([]);
  });

  it("names no conversation for an existing-conversation turn (the client already keyed it)", async () => {
    const emitted: string[] = [];
    const h = harness({ seed: [makeConv({ id: "c1", promptCount: 1 })] });
    await h.executeProjectPromptStream({
      projectPath: "/repo",
      conversationId: "c1",
      promptText: "next",
      emit: (event) => emitted.push(event),
    });
    expect(emitted).not.toContain("conversation");
  });

  it("does not broadcast conversation-created for an existing-conversation turn", async () => {
    const h = harness({
      seed: [makeConv({ id: "c1", promptCount: 1 })],
    });
    await h.executeProjectPromptStream({
      projectPath: "/repo",
      conversationId: "c1",
      promptText: "next",
      emit: () => {},
    });
    expect(h.createdBroadcasts).toEqual([]);
  });

  it("binds the agent cwd to the repo-root worktree via the sentinel session + executionTarget", async () => {
    const h = harness();
    await h.executeProjectPromptStream({
      projectPath: "/repo",
      promptText: "x",
      emit: () => {},
    });
    const call = h.calls[0]!;
    expect(call.session.sessionName).toBe(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
    expect(call.session.worktreePath).toBe("/repo");
    expect(call.options?.executionTarget?.worktreePath).toBe("/repo");
    expect(call.options?.actorInput?.sessionWorktreePath).toBe("/repo");
    // No backend change requested ⇒ entry never serializes/blocks on the dirty
    // main worktree (there is no clean check); the turn simply proceeds.
  });

  it("marks actor input as project scope and keeps backend out of prompt options", async () => {
    const h = harness({
      seed: [makeConv({ id: "c1", promptCount: 1, agentBackend: "codex" })],
    });
    await h.executeProjectPromptStream({
      projectPath: "/repo",
      conversationId: "c1",
      promptText: "next",
      emit: () => {},
    });

    expect(h.calls[0]?.options?.actorInput?.conversationScope).toBe("project");
    expect(h.calls[0]?.options?.actorInput?.conversation.agentBackend).toBe(
      "codex",
    );
    expect(h.calls[0]?.options).not.toHaveProperty("backend");
  });

  it("rejects a backend change after the first turn with BackendMismatchError", async () => {
    const h = harness({
      seed: [makeConv({ id: "c1", promptCount: 2, agentBackend: "claude" })],
    });
    await expect(
      h.executeProjectPromptStream({
        projectPath: "/repo",
        conversationId: "c1",
        promptText: "switch",
        backend: "codex",
        emit: () => {},
      }),
    ).rejects.toBeInstanceOf(BackendMismatchError);
    expect(h.calls).toHaveLength(0); // never reached execution
  });

  it("adopts a backend before the first turn and threads it into actorInput", async () => {
    const h = harness({
      seed: [makeConv({ id: "c1", promptCount: 0, agentBackend: "claude" })],
    });
    await h.executeProjectPromptStream({
      projectPath: "/repo",
      conversationId: "c1",
      promptText: "first",
      backend: "codex",
      emit: () => {},
    });
    expect(h.adopted).toEqual([{ id: "c1", backend: "codex" }]);
    expect(h.calls[0]?.options?.actorInput?.conversation.agentBackend).toBe(
      "codex",
    );
  });

  it("propagates a ModelEffortValidationError raised by executePromptStream", async () => {
    const h = harness({
      executeImpl: async () => {
        throw new ModelEffortValidationError("bad effort for backend");
      },
    });
    await expect(
      h.executeProjectPromptStream({
        projectPath: "/repo",
        promptText: "x",
        effort: "nope",
        emit: () => {},
      }),
    ).rejects.toBeInstanceOf(ModelEffortValidationError);
  });

  it("propagates a running-actor worktree mismatch raised downstream", async () => {
    const h = harness({
      seed: [makeConv({ id: "c1", promptCount: 1 })],
      executeImpl: async () => {
        throw new Error(
          "Conversation actor c1 is running with worktreePath=/other; cannot rebind",
        );
      },
    });
    await expect(
      h.executeProjectPromptStream({
        projectPath: "/repo",
        conversationId: "c1",
        promptText: "x",
        emit: () => {},
      }),
    ).rejects.toThrow(/cannot rebind/);
  });

  it("runs distinct conversation ids without adding its own serialization", async () => {
    const h = harness({
      seed: [
        makeConv({ id: "a", promptCount: 1 }),
        makeConv({ id: "b", promptCount: 1 }),
      ],
    });
    await Promise.all([
      h.executeProjectPromptStream({
        projectPath: "/repo",
        conversationId: "a",
        promptText: "1",
        emit: () => {},
      }),
      h.executeProjectPromptStream({
        projectPath: "/repo",
        conversationId: "b",
        promptText: "2",
        emit: () => {},
      }),
    ]);
    expect(h.calls.map((c) => c.conversationId).sort()).toEqual(["a", "b"]);
  });

  it("throws when an explicit conversationId does not exist", async () => {
    const h = harness();
    await expect(
      h.executeProjectPromptStream({
        projectPath: "/repo",
        conversationId: "missing",
        promptText: "x",
        emit: () => {},
      }),
    ).rejects.toThrow(/not found/);
  });
});
