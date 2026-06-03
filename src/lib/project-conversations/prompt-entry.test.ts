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
    machineSnapshot: null,
    agentBackend: overrides.agentBackend ?? "claude",
    backendRef: null,
    unread: false,
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
  const createdBroadcasts: Array<{ projectPath: string; id: string }> = [];
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
      createdBroadcasts.push({ projectPath, id: conversation.id });
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
      { projectPath: "/repo", id: "created-1" },
    ]);
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
