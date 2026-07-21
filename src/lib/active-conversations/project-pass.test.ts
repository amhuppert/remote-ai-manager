import { describe, it, expect } from "vitest";
import {
  createActiveConversationsRouteHandlers,
  type ActiveConversationsRouteDeps,
} from "./route-handlers";
import { activeConversationsResponseSchema } from "./schemas";
import {
  conversationStateSchema,
  type ConversationState,
} from "@/lib/conversations/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { managerStateSchema, type ManagerState } from "@/lib/projects/schemas";
import type { SessionConversationListItem } from "@/lib/state-store";

/**
 * Project the fixture `ManagerState` into the two focused accessors the handler
 * consumes. The full session/conversation objects carry every field the feed
 * reads, so a controlled cast to the list-item projection keeps the fixture
 * faithful without re-declaring the projection shapes.
 */
function stateToActiveDeps(
  state: ManagerState,
): Pick<
  ActiveConversationsRouteDeps,
  "listSessionConversationListItems" | "getArchivedProjects"
> {
  return {
    getArchivedProjects: async () => new Set(state.archivedProjects),
    listSessionConversationListItems: async () =>
      Object.entries(state.projects).flatMap(([projectPath, project]) =>
        Object.values(project.sessions).map(
          (session) =>
            ({
              projectPath,
              session,
              conversations: session.conversations,
            }) as unknown as SessionConversationListItem,
        ),
      ),
  };
}

const ts = "2025-01-01T00:00:00.000Z";

function sessionConv(): ConversationState {
  return conversationStateSchema.parse({
    id: "s1",
    transcriptPath: null,
    status: "awaiting",
    promptCount: 1,
    createdAt: ts,
    lastActivityAt: "2025-01-01T00:00:01.000Z",
  });
}

function projectConv(
  id: string,
  opts: { open: boolean; archived: boolean },
): ConversationState {
  return conversationStateSchema.parse({
    id,
    scope: "project",
    transcriptPath: null,
    status: "awaiting",
    promptCount: 1,
    createdAt: ts,
    lastActivityAt: ts,
    open: opts.open,
    archived: opts.archived,
  });
}

function stateWithSession(): ManagerState {
  const session = sessionStateSchema.parse({
    sessionName: "feat",
    worktreePath: "/repo/.worktrees/feat",
    branchName: "csm/feat",
    createdAt: ts,
    lastActivityAt: ts,
    conversations: [sessionConv()],
  });
  return managerStateSchema.parse({
    projects: {
      "/repo": { rootPath: "/repo", sessions: { feat: session } },
    },
    archivedProjects: [],
    pinnedProjects: [],
  });
}

function makeDeps(
  projectConvs: { projectPath: string; conversation: ConversationState }[],
): ActiveConversationsRouteDeps {
  return {
    ...stateToActiveDeps(stateWithSession()),
    getProjectDisplayName: () => "demo",
    readLastAssistantContent: async () => null,
    listProjectConversations: async () => projectConvs,
    listActiveGraphWorkflowExecutions: async () => new Map(),
    listActiveSpecExecutions: async () => [],
  };
}

describe("active-conversations project pass", () => {
  it("returns session and project conversations together, excluding archived PLCs", async () => {
    const deps = makeDeps([
      {
        projectPath: "/repo",
        conversation: projectConv("p-open", { open: true, archived: false }),
      },
      {
        projectPath: "/repo",
        conversation: projectConv("p-closed", { open: false, archived: false }),
      },
      {
        projectPath: "/repo",
        conversation: projectConv("p-arch", { open: true, archived: true }),
      },
    ]);
    const res = await createActiveConversationsRouteHandlers(deps).GET();
    const body = activeConversationsResponseSchema.parse(await res.json());
    const ids = body.conversations.map((c) => c.id).sort();

    expect(ids).toEqual(["p-closed", "p-open", "s1"]); // archived excluded
    expect(body.conversations.find((c) => c.id === "p-open")).toMatchObject({
      scope: "project",
      open: true,
    });
    expect(body.conversations.find((c) => c.id === "p-closed")).toMatchObject({
      scope: "project",
      open: false,
    });
  });

  it("emits the project variant with the project main worktree and no sessionName", async () => {
    const deps = makeDeps([
      {
        projectPath: "/repo",
        conversation: projectConv("p-open", { open: true, archived: false }),
      },
    ]);
    const res = await createActiveConversationsRouteHandlers(deps).GET();
    const body = activeConversationsResponseSchema.parse(await res.json());

    const proj = body.conversations.find((c) => c.id === "p-open");
    expect(proj?.scope).toBe("project");
    expect(proj?.worktreePath).toBe("/repo");
    expect(proj && "sessionName" in proj).toBe(false);

    const sess = body.conversations.find((c) => c.id === "s1");
    expect(sess?.scope).toBe("session");
    if (sess?.scope === "session") {
      expect(sess.sessionName).toBe("feat");
    }
  });
});
