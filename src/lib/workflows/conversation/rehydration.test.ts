import { describe, it, expect, vi, afterEach } from "vitest";
import {
  collectRehydrationCandidates,
  rehydrateConversationActors,
  _resetForTesting,
  type RehydrateConversationActorsDeps,
} from "./manager";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import {
  conversationStateSchema,
  type ConversationState,
} from "@/lib/conversations/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { managerStateSchema, type ManagerState } from "@/lib/projects/schemas";
import type { Snapshot } from "xstate";

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
