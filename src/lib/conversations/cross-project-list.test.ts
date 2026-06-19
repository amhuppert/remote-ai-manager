import { describe, it, expect } from "vitest";
import {
  createListAllConversations,
  createFindConversationById,
} from "./cross-project-list";
import type { ConversationState } from "./schemas";
import type { ManagerState, ProjectState } from "@/lib/projects/schemas";
import type { SessionState } from "@/lib/sessions/schemas";

function makeConversation(
  overrides: Partial<ConversationState> & { id: string },
): ConversationState {
  return {
    id: overrides.id,
    scope: overrides.scope ?? "session",
    name: overrides.name ?? null,
    transcriptPath: overrides.transcriptPath ?? null,
    status: overrides.status ?? "new",
    promptCount: overrides.promptCount ?? 0,
    createdAt: overrides.createdAt ?? "2024-01-01T00:00:00Z",
    lastActivityAt: overrides.lastActivityAt ?? "2024-01-01T00:00:00Z",
    source: overrides.source ?? "cc",
    summary: overrides.summary ?? null,
    archived: overrides.archived ?? false,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    forkedFrom: null,
    role: overrides.role ?? null,
    activeTurnSource: overrides.activeTurnSource ?? null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: overrides.debugMode ?? null,
    machineSnapshot: null,
    agentBackend: overrides.agentBackend ?? "claude",
    backendRef: overrides.backendRef ?? null,
    unread: overrides.unread ?? false,
    pendingQueue: overrides.pendingQueue ?? [],
  };
}

function makeSession(
  name: string,
  conversations: ConversationState[],
  archived = false,
  projectRoot = "/projects/proj",
): SessionState {
  return {
    sessionName: name,
    worktreePath: `${projectRoot}/.worktrees/${name}`,
    branchName: `cc/${name}`,
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    archived,
    finished: false,
    conversations,
    source: "cc",
    objective: null,
    creationMode: "fast",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    referenceDocuments: [],
  };
}

function makeState(opts: {
  projects: Record<string, ProjectState>;
  archivedProjects?: string[];
}): ManagerState {
  return {
    projects: opts.projects,
    archivedProjects: opts.archivedProjects ?? [],
    pinnedProjects: [],
  };
}

describe("listAllConversations", () => {
  it("walks every project / session / conversation and emits a list item per conversation", async () => {
    const state = makeState({
      projects: {
        "/projects/a": {
          rootPath: "/projects/a",
          sessions: {
            s1: makeSession("s1", [
              makeConversation({ id: "c1", name: "First" }),
              makeConversation({ id: "c2", name: "Second" }),
            ]),
          },
        },
        "/projects/b": {
          rootPath: "/projects/b",
          sessions: {
            s2: makeSession("s2", [
              makeConversation({ id: "c3", name: "Third" }),
            ]),
          },
        },
      },
    });

    const listAll = createListAllConversations({
      readState: async () => state,
      getFirstPromptSnippet: async () => null,
    });

    const { items, totalCount } = await listAll({ includeArchived: false });
    expect(items).toHaveLength(3);
    expect(totalCount).toBe(3);
    expect(items.map((i) => i.conversationId).sort()).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
  });

  it("derives projectName from basename, carries worktreePath and sessionName", async () => {
    const state = makeState({
      projects: {
        "/repos/awesome-app": {
          rootPath: "/repos/awesome-app",
          sessions: {
            main: makeSession(
              "main",
              [makeConversation({ id: "c1", name: "A" })],
              false,
              "/repos/awesome-app",
            ),
          },
        },
      },
    });

    const listAll = createListAllConversations({
      readState: async () => state,
      getFirstPromptSnippet: async () => null,
    });

    const { items } = await listAll({ includeArchived: false });
    expect(items[0]).toMatchObject({
      projectName: "awesome-app",
      projectPath: "/repos/awesome-app",
      sessionName: "main",
      worktreePath: "/repos/awesome-app/.worktrees/main",
    });
  });

  it("excludes archived projects when includeArchived is false", async () => {
    const state = makeState({
      projects: {
        "/projects/active": {
          rootPath: "/projects/active",
          sessions: {
            s1: makeSession("s1", [makeConversation({ id: "active" })]),
          },
        },
        "/projects/archived": {
          rootPath: "/projects/archived",
          sessions: {
            s2: makeSession("s2", [makeConversation({ id: "archived" })]),
          },
        },
      },
      archivedProjects: ["/projects/archived"],
    });

    const listAll = createListAllConversations({
      readState: async () => state,
      getFirstPromptSnippet: async () => null,
    });

    const { items } = await listAll({ includeArchived: false });
    expect(items.map((i) => i.conversationId)).toEqual(["active"]);
  });

  it("includes archived projects and archived conversations when includeArchived is true", async () => {
    const state = makeState({
      projects: {
        "/projects/active": {
          rootPath: "/projects/active",
          sessions: {
            s1: makeSession("s1", [
              makeConversation({ id: "live" }),
              makeConversation({ id: "archived-conv", archived: true }),
            ]),
          },
        },
        "/projects/archived": {
          rootPath: "/projects/archived",
          sessions: {
            s2: makeSession("s2", [makeConversation({ id: "in-archived" })]),
          },
        },
      },
      archivedProjects: ["/projects/archived"],
    });

    const listAll = createListAllConversations({
      readState: async () => state,
      getFirstPromptSnippet: async () => null,
    });

    const { items, totalCount } = await listAll({ includeArchived: true });
    expect(totalCount).toBe(3);
    expect(items.map((i) => i.conversationId).sort()).toEqual([
      "archived-conv",
      "in-archived",
      "live",
    ]);
  });

  it("excludes archived conversations when includeArchived is false", async () => {
    const state = makeState({
      projects: {
        "/projects/a": {
          rootPath: "/projects/a",
          sessions: {
            s1: makeSession("s1", [
              makeConversation({ id: "live" }),
              makeConversation({ id: "stale", archived: true }),
            ]),
          },
        },
      },
    });

    const listAll = createListAllConversations({
      readState: async () => state,
      getFirstPromptSnippet: async () => null,
    });

    const { items } = await listAll({ includeArchived: false });
    expect(items.map((i) => i.conversationId)).toEqual(["live"]);
  });

  it("populates firstPromptSnippet only when both name and summary are null", async () => {
    const state = makeState({
      projects: {
        "/projects/a": {
          rootPath: "/projects/a",
          sessions: {
            s1: makeSession("s1", [
              makeConversation({
                id: "has-name",
                name: "Has name",
                transcriptPath: "/t/has-name.jsonl",
              }),
              makeConversation({
                id: "has-summary",
                name: null,
                summary: "Has summary",
                transcriptPath: "/t/has-summary.jsonl",
              }),
              makeConversation({
                id: "no-name-no-summary",
                name: null,
                summary: null,
                transcriptPath: "/t/no-name-no-summary.jsonl",
              }),
            ]),
          },
        },
      },
    });

    const snippetCalls: string[] = [];
    const listAll = createListAllConversations({
      readState: async () => state,
      getFirstPromptSnippet: async (path) => {
        snippetCalls.push(path);
        return "snippet for " + path;
      },
    });

    const { items } = await listAll({ includeArchived: false });
    const byId = new Map(items.map((i) => [i.conversationId, i]));

    expect(byId.get("has-name")?.firstPromptSnippet).toBeNull();
    expect(byId.get("has-summary")?.firstPromptSnippet).toBeNull();
    expect(byId.get("no-name-no-summary")?.firstPromptSnippet).toBe(
      "snippet for /t/no-name-no-summary.jsonl",
    );
    expect(snippetCalls).toEqual(["/t/no-name-no-summary.jsonl"]);
  });

  it("does not call getFirstPromptSnippet when transcriptPath is null", async () => {
    const state = makeState({
      projects: {
        "/projects/a": {
          rootPath: "/projects/a",
          sessions: {
            s1: makeSession("s1", [
              makeConversation({
                id: "no-transcript",
                name: null,
                summary: null,
                transcriptPath: null,
              }),
            ]),
          },
        },
      },
    });

    let called = false;
    const listAll = createListAllConversations({
      readState: async () => state,
      getFirstPromptSnippet: async () => {
        called = true;
        return null;
      },
    });

    const { items } = await listAll({ includeArchived: false });
    expect(called).toBe(false);
    expect(items[0]?.firstPromptSnippet).toBeNull();
  });

  it("maps backend, backendRef, transcriptPath, debugLogPath, status, lastActivityAt into the item", async () => {
    const state = makeState({
      projects: {
        "/projects/a": {
          rootPath: "/projects/a",
          sessions: {
            s1: makeSession("s1", [
              makeConversation({
                id: "c1",
                name: "Detailed",
                status: "running",
                lastActivityAt: "2024-06-01T12:00:00Z",
                agentBackend: "codex",
                backendRef: { backend: "codex", threadId: "thread-xyz" },
                transcriptPath: "/t/c1.jsonl",
                debugMode: {
                  active: true,
                  recording: true,
                  logFilePath: "/d/c1.log",
                  enteredAt: "2024-06-01T00:00:00Z",
                  hypotheses: [],
                  reproductionSteps: [],
                  fixSummary: null,
                  verificationSteps: [],
                  instructionsDelivered: false,
                  phase: "hypothesizing",
                  lastTurnFailed: false,
                },
              }),
            ]),
          },
        },
      },
    });

    const listAll = createListAllConversations({
      readState: async () => state,
      getFirstPromptSnippet: async () => null,
    });

    const { items } = await listAll({ includeArchived: false });
    expect(items[0]).toMatchObject({
      conversationId: "c1",
      conversationName: "Detailed",
      backend: "codex",
      backendRef: { backend: "codex", threadId: "thread-xyz" },
      transcriptPath: "/t/c1.jsonl",
      debugLogPath: "/d/c1.log",
      status: "running",
      lastActivityAt: "2024-06-01T12:00:00Z",
    });
  });

  it("returns empty result with totalCount 0 when there are no projects", async () => {
    const state = makeState({ projects: {} });
    const listAll = createListAllConversations({
      readState: async () => state,
      getFirstPromptSnippet: async () => null,
    });

    const result = await listAll({ includeArchived: false });
    expect(result.items).toEqual([]);
    expect(result.totalCount).toBe(0);
  });
});

describe("findConversationById", () => {
  function makeLookupRecord(
    overrides: Partial<ConversationState> & { id: string },
  ) {
    return {
      projectPath: "/repos/awesome-app",
      sessionName: "main",
      worktreePath: "/repos/awesome-app/.worktrees/main",
      conversation: makeConversation(overrides),
    };
  }

  it("builds the list item from the focused lookup record", async () => {
    const calls: string[] = [];
    const find = createFindConversationById({
      getConversationById: async (id) => {
        calls.push(id);
        return makeLookupRecord({
          id: "target",
          name: "Target",
          status: "running",
          lastActivityAt: "2024-06-01T12:00:00Z",
        });
      },
      getFirstPromptSnippet: async () => null,
    });

    const item = await find("target");
    expect(item).toMatchObject({
      projectName: "awesome-app",
      projectPath: "/repos/awesome-app",
      sessionName: "main",
      worktreePath: "/repos/awesome-app/.worktrees/main",
      conversationId: "target",
      conversationName: "Target",
      status: "running",
      lastActivityAt: "2024-06-01T12:00:00Z",
      archived: false,
    });
    expect(calls).toEqual(["target"]);
  });

  it("passes archived conversations through (archived deep links must resolve)", async () => {
    const find = createFindConversationById({
      getConversationById: async () =>
        makeLookupRecord({ id: "buried", archived: true }),
      getFirstPromptSnippet: async () => null,
    });

    const item = await find("buried");
    expect(item?.conversationId).toBe("buried");
    expect(item?.archived).toBe(true);
  });

  it("returns null when the lookup finds nothing", async () => {
    const find = createFindConversationById({
      getConversationById: async () => null,
      getFirstPromptSnippet: async () => null,
    });

    expect(await find("missing")).toBeNull();
  });

  it("reads the first-prompt snippet for an unnamed conversation", async () => {
    const snippetCalls: string[] = [];
    const find = createFindConversationById({
      getConversationById: async () =>
        makeLookupRecord({
          id: "target",
          name: null,
          summary: null,
          transcriptPath: "/t/target.jsonl",
        }),
      getFirstPromptSnippet: async (path) => {
        snippetCalls.push(path);
        return "snippet";
      },
    });

    const item = await find("target");
    expect(item?.firstPromptSnippet).toBe("snippet");
    expect(snippetCalls).toEqual(["/t/target.jsonl"]);
  });

  it("does not read a snippet when the conversation has a name or summary", async () => {
    let called = false;
    const find = createFindConversationById({
      getConversationById: async () =>
        makeLookupRecord({
          id: "named",
          name: "Named",
          transcriptPath: "/t/named.jsonl",
        }),
      getFirstPromptSnippet: async () => {
        called = true;
        return null;
      },
    });

    const item = await find("named");
    expect(called).toBe(false);
    expect(item?.firstPromptSnippet).toBeNull();
  });

  it("returns the item with a null snippet when the snippet read fails", async () => {
    const find = createFindConversationById({
      getConversationById: async () =>
        makeLookupRecord({
          id: "target",
          name: null,
          summary: null,
          transcriptPath: "/t/target.jsonl",
        }),
      getFirstPromptSnippet: async () => {
        throw new Error("transcript unreadable");
      },
    });

    const item = await find("target");
    expect(item?.conversationId).toBe("target");
    expect(item?.firstPromptSnippet).toBeNull();
  });
});
