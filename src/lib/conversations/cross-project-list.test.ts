import { describe, it, expect } from "vitest";
import {
  createListAllConversations,
  createFindConversationById,
  type ListAllConversationsDeps,
} from "./cross-project-list";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "./project-conversation-scope";
import type { ConversationState } from "./schemas";
import type { ContextArtifactRow } from "@/lib/context-artifacts/schemas";
import type { SessionConversationListItem } from "@/lib/state-store";
import type { ManagerState, ProjectState } from "@/lib/projects/schemas";
import type { SessionState } from "@/lib/sessions/schemas";

/**
 * Project a `ManagerState` fixture into the two focused accessors
 * `listAllConversations` now consumes. The full session/conversation objects
 * carry every field the list builder reads, so a controlled cast to the
 * list-item projection keeps the fixtures faithful without re-declaring the
 * projection shapes here.
 */
function stateToListDeps(
  state: ManagerState,
): Pick<
  ListAllConversationsDeps,
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

function makeConversation(
  overrides: Partial<ConversationState> & { id: string },
): ConversationState {
  return {
    id: overrides.id,
    scope: overrides.scope ?? "session",
    nameOrigin: "default",
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
    agentBackend: overrides.agentBackend ?? "claude",
    backendRef: overrides.backendRef ?? null,
    unread: overrides.unread ?? false,
    pendingQueue: overrides.pendingQueue ?? [],
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
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
    creationMode: "normal",
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

function makeDeps(
  overrides: Partial<ListAllConversationsDeps> = {},
): ListAllConversationsDeps {
  return {
    listSessionConversationListItems:
      overrides.listSessionConversationListItems ?? (async () => []),
    getArchivedProjects:
      overrides.getArchivedProjects ?? (async () => new Set<string>()),
    listAllProjectConversations:
      overrides.listAllProjectConversations ?? (async () => []),
    getFirstPromptSnippet:
      overrides.getFirstPromptSnippet ?? (async () => null),
    findArtifactsByConversationIds:
      overrides.findArtifactsByConversationIds ?? (() => []),
    readTranscriptEntries:
      overrides.readTranscriptEntries ??
      (async () => ({ entries: [], maxSeq: -1 })),
  };
}

function makeArtifactRow(
  overrides: Partial<ContextArtifactRow> & { conversationId: string },
): ContextArtifactRow {
  return {
    id: overrides.id ?? `art-${overrides.conversationId}`,
    kind: overrides.kind ?? "conversation_compaction",
    scope: overrides.scope ?? "session",
    projectPath: overrides.projectPath ?? "/projects/a",
    sessionName: overrides.sessionName ?? "s1",
    conversationId: overrides.conversationId,
    messageId: overrides.messageId ?? null,
    messageIndex: overrides.messageIndex ?? null,
    coveredStartSeq: overrides.coveredStartSeq ?? 0,
    coveredEndSeq: overrides.coveredEndSeq ?? 421,
    sourceHash: overrides.sourceHash ?? "hash",
    status: overrides.status ?? "complete",
    error: overrides.error ?? null,
    modelProvider: overrides.modelProvider ?? "claude",
    model: overrides.model ?? "claude-sonnet-4-5",
    effort: overrides.effort ?? null,
    schemaVersion: overrides.schemaVersion ?? 1,
    promptVersion: overrides.promptVersion ?? "v1",
    normalizerVersion: overrides.normalizerVersion ?? "v1",
    createdBy: overrides.createdBy ?? "user",
    createdByConversationId: overrides.createdByConversationId ?? null,
    payload: overrides.payload ?? null,
    createdAt: overrides.createdAt ?? "2026-07-01T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-07-01T00:00:00Z",
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

    const listAll = createListAllConversations(
      makeDeps(stateToListDeps(state)),
    );

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

    const listAll = createListAllConversations(
      makeDeps(stateToListDeps(state)),
    );

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

    const listAll = createListAllConversations(
      makeDeps(stateToListDeps(state)),
    );

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

    const listAll = createListAllConversations(
      makeDeps(stateToListDeps(state)),
    );

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

    const listAll = createListAllConversations(
      makeDeps(stateToListDeps(state)),
    );

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
    const listAll = createListAllConversations(
      makeDeps({
        ...stateToListDeps(state),
        getFirstPromptSnippet: async (path) => {
          snippetCalls.push(path);
          return "snippet for " + path;
        },
      }),
    );

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
    const listAll = createListAllConversations(
      makeDeps({
        ...stateToListDeps(state),
        getFirstPromptSnippet: async () => {
          called = true;
          return null;
        },
      }),
    );

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
                backendRef: { backend: "codex", ref: "thread-xyz" },
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

    const listAll = createListAllConversations(
      makeDeps(stateToListDeps(state)),
    );

    const { items } = await listAll({ includeArchived: false });
    expect(items[0]).toMatchObject({
      conversationId: "c1",
      conversationName: "Detailed",
      backend: "codex",
      backendRef: { backend: "codex", ref: "thread-xyz" },
      transcriptPath: "/t/c1.jsonl",
      debugLogPath: "/d/c1.log",
      status: "running",
      lastActivityAt: "2024-06-01T12:00:00Z",
    });
  });

  it("returns empty result with totalCount 0 when there are no projects", async () => {
    const state = makeState({ projects: {} });
    const listAll = createListAllConversations(
      makeDeps(stateToListDeps(state)),
    );

    const result = await listAll({ includeArchived: false });
    expect(result.items).toEqual([]);
    expect(result.totalCount).toBe(0);
  });
});

describe("listAllConversations project conversations", () => {
  it("emits project conversations as project-scoped items with a project-root worktree", async () => {
    const state = makeState({
      projects: {
        "/repos/awesome-app": {
          rootPath: "/repos/awesome-app",
          sessions: {
            s1: makeSession(
              "s1",
              [makeConversation({ id: "session-c1", name: "Session convo" })],
              false,
              "/repos/awesome-app",
            ),
          },
        },
      },
    });

    const listAll = createListAllConversations(
      makeDeps({
        ...stateToListDeps(state),
        listAllProjectConversations: async () => [
          {
            projectPath: "/repos/awesome-app",
            conversation: makeConversation({
              id: "plc-1",
              name: "Project convo",
              scope: "project",
            }),
          },
        ],
      }),
    );

    const { items, totalCount } = await listAll({ includeArchived: false });
    expect(totalCount).toBe(2);
    const plc = items.find((i) => i.conversationId === "plc-1");
    expect(plc).toMatchObject({
      scope: "project",
      projectName: "awesome-app",
      projectPath: "/repos/awesome-app",
      worktreePath: "/repos/awesome-app",
      conversationName: "Project convo",
    });
    // R1.3: this is a public API response — the project variant has no session
    // field at all, so the sentinel cannot appear anywhere in the payload.
    expect(plc).not.toHaveProperty("sessionName");
    expect(JSON.stringify(items)).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );

    const sessionItem = items.find((i) => i.conversationId === "session-c1");
    expect(sessionItem).toMatchObject({ scope: "session", sessionName: "s1" });
  });

  it("filters archived project conversations and archived projects unless includeArchived", async () => {
    const state = makeState({
      projects: {
        "/projects/live": { rootPath: "/projects/live", sessions: {} },
      },
      archivedProjects: ["/projects/archived"],
    });
    const projectConversations = async () => [
      {
        projectPath: "/projects/live",
        conversation: makeConversation({ id: "plc-live", scope: "project" }),
      },
      {
        projectPath: "/projects/live",
        conversation: makeConversation({
          id: "plc-archived",
          scope: "project",
          archived: true,
        }),
      },
      {
        projectPath: "/projects/archived",
        conversation: makeConversation({
          id: "plc-in-archived-project",
          scope: "project",
        }),
      },
    ];

    const listAll = createListAllConversations(
      makeDeps({
        ...stateToListDeps(state),
        listAllProjectConversations: projectConversations,
      }),
    );

    const excluded = await listAll({ includeArchived: false });
    expect(excluded.items.map((i) => i.conversationId)).toEqual(["plc-live"]);

    const included = await listAll({ includeArchived: true });
    expect(included.items.map((i) => i.conversationId).sort()).toEqual([
      "plc-archived",
      "plc-in-archived-project",
      "plc-live",
    ]);
  });

  it("enriches unnamed project conversations with first-prompt snippets and batches their artifact lookup", async () => {
    const state = makeState({
      projects: {
        "/projects/a": {
          rootPath: "/projects/a",
          sessions: {
            s1: makeSession("s1", [
              makeConversation({ id: "session-c1", name: "Named" }),
            ]),
          },
        },
      },
    });
    const artifactCalls: string[][] = [];
    const listAll = createListAllConversations(
      makeDeps({
        ...stateToListDeps(state),
        listAllProjectConversations: async () => [
          {
            projectPath: "/projects/a",
            conversation: makeConversation({
              id: "plc-1",
              scope: "project",
              name: null,
              summary: null,
              transcriptPath: "/t/plc-1.jsonl",
            }),
          },
        ],
        getFirstPromptSnippet: async (path) => `snippet for ${path}`,
        findArtifactsByConversationIds: (ids) => {
          artifactCalls.push(ids);
          return [];
        },
      }),
    );

    const { items } = await listAll({ includeArchived: false });
    const plc = items.find((i) => i.conversationId === "plc-1");
    expect(plc?.firstPromptSnippet).toBe("snippet for /t/plc-1.jsonl");
    expect(artifactCalls).toEqual([["session-c1", "plc-1"]]);
  });
});

describe("listAllConversations compaction enrichment", () => {
  function singleProjectState(
    conversations: ConversationState[],
  ): ManagerState {
    return makeState({
      projects: {
        "/projects/a": {
          rootPath: "/projects/a",
          sessions: { s1: makeSession("s1", conversations) },
        },
      },
    });
  }

  it("marks a conversation fresh when the transcript has not advanced past the covered range", async () => {
    const state = singleProjectState([
      makeConversation({ id: "c1", name: "A", transcriptPath: "/t/c1.jsonl" }),
    ]);
    const listAll = createListAllConversations(
      makeDeps({
        ...stateToListDeps(state),
        findArtifactsByConversationIds: () => [
          makeArtifactRow({
            conversationId: "c1",
            id: "art-c1",
            coveredStartSeq: 0,
            coveredEndSeq: 421,
            createdAt: "2026-07-02T10:00:00Z",
          }),
        ],
        readTranscriptEntries: async () => ({ entries: [], maxSeq: 421 }),
      }),
    );

    const { items } = await listAll({ includeArchived: false });
    expect(items[0]).toMatchObject({
      compactArtifactId: "art-c1",
      compactStatus: "fresh",
      compactCoveredSeq: "0..421",
      compactCreatedAt: "2026-07-02T10:00:00Z",
    });
  });

  it("marks a conversation stale when the transcript advanced past coveredEndSeq", async () => {
    const state = singleProjectState([
      makeConversation({ id: "c1", name: "A", transcriptPath: "/t/c1.jsonl" }),
    ]);
    const readPaths: string[] = [];
    const listAll = createListAllConversations(
      makeDeps({
        ...stateToListDeps(state),
        findArtifactsByConversationIds: () => [
          makeArtifactRow({ conversationId: "c1", coveredEndSeq: 421 }),
        ],
        readTranscriptEntries: async (path) => {
          readPaths.push(path);
          return { entries: [], maxSeq: 500 };
        },
      }),
    );

    const { items } = await listAll({ includeArchived: false });
    expect(items[0]?.compactStatus).toBe("stale");
    expect(readPaths).toEqual(["/t/c1.jsonl"]);
  });

  it("ignores message_compaction and non-complete rows, reads no transcripts for them", async () => {
    const state = singleProjectState([
      makeConversation({ id: "c1", name: "A", transcriptPath: "/t/c1.jsonl" }),
      makeConversation({ id: "c2", name: "B", transcriptPath: "/t/c2.jsonl" }),
    ]);
    let reads = 0;
    const listAll = createListAllConversations(
      makeDeps({
        ...stateToListDeps(state),
        findArtifactsByConversationIds: () => [
          makeArtifactRow({
            conversationId: "c1",
            kind: "message_compaction",
            messageIndex: 3,
          }),
          makeArtifactRow({ conversationId: "c2", status: "pending" }),
        ],
        readTranscriptEntries: async () => {
          reads += 1;
          return { entries: [], maxSeq: 0 };
        },
      }),
    );

    const { items } = await listAll({ includeArchived: false });
    expect(reads).toBe(0);
    for (const item of items) {
      expect(item.compactArtifactId).toBeUndefined();
      expect(item.compactStatus).toBeUndefined();
      expect(item.compactCoveredSeq).toBeUndefined();
      expect(item.compactCreatedAt).toBeUndefined();
    }
  });

  it("batch-fetches artifacts once with every listed conversation id", async () => {
    const state = singleProjectState([
      makeConversation({ id: "c1", name: "A" }),
      makeConversation({ id: "c2", name: "B" }),
    ]);
    const calls: string[][] = [];
    const listAll = createListAllConversations(
      makeDeps({
        ...stateToListDeps(state),
        findArtifactsByConversationIds: (ids) => {
          calls.push(ids);
          return [];
        },
      }),
    );

    await listAll({ includeArchived: false });
    expect(calls).toEqual([["c1", "c2"]]);
  });

  it("does not fetch artifacts when there are no conversations", async () => {
    let called = false;
    const listAll = createListAllConversations(
      makeDeps({
        findArtifactsByConversationIds: () => {
          called = true;
          return [];
        },
      }),
    );

    await listAll({ includeArchived: false });
    expect(called).toBe(false);
  });

  it("treats a compacted conversation with no transcript as fresh without reading", async () => {
    const state = singleProjectState([
      makeConversation({ id: "c1", name: "A", transcriptPath: null }),
    ]);
    let reads = 0;
    const listAll = createListAllConversations(
      makeDeps({
        ...stateToListDeps(state),
        findArtifactsByConversationIds: () => [
          makeArtifactRow({ conversationId: "c1", id: "art-c1" }),
        ],
        readTranscriptEntries: async () => {
          reads += 1;
          return { entries: [], maxSeq: 0 };
        },
      }),
    );

    const { items } = await listAll({ includeArchived: false });
    expect(reads).toBe(0);
    expect(items[0]?.compactStatus).toBe("fresh");
    expect(items[0]?.compactArtifactId).toBe("art-c1");
  });

  it("degrades to stale when the transcript read fails", async () => {
    const state = singleProjectState([
      makeConversation({ id: "c1", name: "A", transcriptPath: "/t/c1.jsonl" }),
    ]);
    const listAll = createListAllConversations(
      makeDeps({
        ...stateToListDeps(state),
        findArtifactsByConversationIds: () => [
          makeArtifactRow({ conversationId: "c1", id: "art-c1" }),
        ],
        readTranscriptEntries: async () => {
          throw new Error("transcript unreadable");
        },
      }),
    );

    const { items } = await listAll({ includeArchived: false });
    expect(items[0]?.compactStatus).toBe("stale");
    expect(items[0]?.compactArtifactId).toBe("art-c1");
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
      getProjectConversationById: async () => null,
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
      getProjectConversationById: async () => null,
      getFirstPromptSnippet: async () => null,
    });

    const item = await find("buried");
    expect(item?.conversationId).toBe("buried");
    expect(item?.archived).toBe(true);
  });

  it("returns null when neither lookup finds anything", async () => {
    const find = createFindConversationById({
      getConversationById: async () => null,
      getProjectConversationById: async () => null,
      getFirstPromptSnippet: async () => null,
    });

    expect(await find("missing")).toBeNull();
  });

  // R2.4: `cctl conversation read <id>` on a project conversation resolves the
  // owning scope through this endpoint. While it queried only session
  // conversations, a cross-scope read of a project conversation 404'd and the
  // CLI could never select the project route.
  it("resolves a project conversation by id alone, as the project variant", async () => {
    const projectCalls: string[] = [];
    const find = createFindConversationById({
      getConversationById: async () => null,
      getProjectConversationById: async (id) => {
        projectCalls.push(id);
        return {
          projectPath: "/repos/awesome-app",
          conversation: makeConversation({
            id: "plc-1",
            name: "Project chat",
            status: "running",
          }),
        };
      },
      getFirstPromptSnippet: async () => null,
    });

    const item = await find("plc-1");
    expect(projectCalls).toEqual(["plc-1"]);
    expect(item?.scope).toBe("project");
    expect(item).toMatchObject({
      projectName: "awesome-app",
      projectPath: "/repos/awesome-app",
      // A project conversation executes in the project root, not a worktree.
      worktreePath: "/repos/awesome-app",
      conversationId: "plc-1",
      conversationName: "Project chat",
    });
    expect(JSON.stringify(item)).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
  });

  it("prefers the session conversation when an id exists in both tables", async () => {
    const find = createFindConversationById({
      getConversationById: async () => makeLookupRecord({ id: "dup" }),
      getProjectConversationById: async () => ({
        projectPath: "/repos/other",
        conversation: makeConversation({ id: "dup" }),
      }),
      getFirstPromptSnippet: async () => null,
    });

    const item = await find("dup");
    expect(item?.scope).toBe("session");
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
      getProjectConversationById: async () => null,
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
      getProjectConversationById: async () => null,
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
      getProjectConversationById: async () => null,
      getFirstPromptSnippet: async () => {
        throw new Error("transcript unreadable");
      },
    });

    const item = await find("target");
    expect(item?.conversationId).toBe("target");
    expect(item?.firstPromptSnippet).toBeNull();
  });
});
