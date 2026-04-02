import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { createConfigReader } from "./config";
import { createStateManager } from "./state";

const TEST_DIR = path.join("/tmp", "cc-state-test-" + Date.now());

// Create a state manager backed by a temp directory — no vi.mock needed
function createTestStateManager() {
  const configReader = createConfigReader(TEST_DIR);
  return createStateManager({
    readConfig: () => configReader.readConfig(),
  });
}

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("state", () => {
  it("readState returns empty state when file does not exist", async () => {
    const { readState } = createTestStateManager();
    const state = await readState();
    expect(state.projects).toEqual({});
  });

  it("writeState and readState roundtrip", async () => {
    const { readState, writeState } = createTestStateManager();
    await writeState({
      projects: {
        "/some/project": {
          rootPath: "/some/project",
          roadmapItems: [],
          sessions: {},
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    const state = await readState();
    expect(state.projects["/some/project"]).toBeDefined();
    expect(state.projects["/some/project"]!.rootPath).toBe("/some/project");
  });

  it("getOrCreateProject creates new project entry", async () => {
    const { getOrCreateProject, readState } = createTestStateManager();
    const project = await getOrCreateProject("/new/project");

    expect(project.rootPath).toBe("/new/project");
    expect(project.sessions).toEqual({});

    const state = await readState();
    expect(state.projects["/new/project"]).toBeDefined();
  });

  it("getOrCreateProject returns existing project", async () => {
    const { getOrCreateProject, writeState } = createTestStateManager();
    await writeState({
      projects: {
        "/existing": {
          rootPath: "/existing",
          roadmapItems: [],
          sessions: {
            test: {
              sessionName: "test",
              worktreePath: "/existing/.worktrees/test",
              branchName: "csm/test",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "cc" as const,
              objective: null,
              creationMode: "fast" as const,
              tddEnabled: true,
              targetBranch: "main",
              parentSessionName: null,
              graphWorkflowExecution: null,
              graphWorkflowExecutionHistory: [],
              referenceDocuments: [],
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    const project = await getOrCreateProject("/existing");
    expect(Object.keys(project.sessions)).toHaveLength(1);
  });

  it("updateSession creates project and session if needed", async () => {
    const { updateSession, getSession } = createTestStateManager();
    const session = {
      sessionName: "new-session",
      worktreePath: "/proj/.worktrees/new-session",
      branchName: "csm/new-session",
      createdAt: "2024-01-01T00:00:00Z",
      lastActivityAt: "2024-01-01T00:00:00Z",
      archived: false,
      finished: false,
      conversations: [],
      source: "cc" as const,
      objective: null,
      creationMode: "fast" as const,
      tddEnabled: true,
      targetBranch: "main",
      parentSessionName: null,
      graphWorkflowExecution: null,
      graphWorkflowExecutionHistory: [],
      referenceDocuments: [],
      claudeSessionId: null,
      transcriptPath: null,
      status: "new" as const,
      promptCount: 0,
    };

    await updateSession("/proj", session);

    const retrieved = await getSession("/proj", "new-session");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.branchName).toBe("csm/new-session");
  });

  it("removeSession deletes session from state", async () => {
    const { updateSession, removeSession, getSession } =
      createTestStateManager();
    const session = {
      sessionName: "to-delete",
      worktreePath: "/proj/.worktrees/to-delete",
      branchName: "csm/to-delete",
      createdAt: "2024-01-01T00:00:00Z",
      lastActivityAt: "2024-01-01T00:00:00Z",
      archived: false,
      finished: false,
      conversations: [],
      source: "cc" as const,
      objective: null,
      creationMode: "fast" as const,
      tddEnabled: true,
      targetBranch: "main",
      parentSessionName: null,
      graphWorkflowExecution: null,
      graphWorkflowExecutionHistory: [],
      referenceDocuments: [],
      claudeSessionId: null,
      transcriptPath: null,
      status: "new" as const,
      promptCount: 0,
    };

    await updateSession("/proj", session);
    expect(await getSession("/proj", "to-delete")).not.toBeNull();

    await removeSession("/proj", "to-delete");
    expect(await getSession("/proj", "to-delete")).toBeNull();
  });

  it("getProjectSessions returns all sessions for a project", async () => {
    const { updateSession, getProjectSessions } = createTestStateManager();

    const baseSession = {
      worktreePath: "",
      branchName: "",
      createdAt: "2024-01-01T00:00:00Z",
      lastActivityAt: "2024-01-01T00:00:00Z",
      archived: false,
      finished: false,
      conversations: [],
      source: "cc" as const,
      objective: null,
      creationMode: "fast" as const,
      tddEnabled: true,
      targetBranch: "main",
      parentSessionName: null,
      graphWorkflowExecution: null,
      graphWorkflowExecutionHistory: [],
      referenceDocuments: [],
      claudeSessionId: null,
      transcriptPath: null,
      status: "new" as const,
      promptCount: 0,
    };

    await updateSession("/proj2", {
      ...baseSession,
      sessionName: "s1",
      worktreePath: "/proj2/.worktrees/s1",
      branchName: "csm/s1",
    });
    await updateSession("/proj2", {
      ...baseSession,
      sessionName: "s2",
      worktreePath: "/proj2/.worktrees/s2",
      branchName: "csm/s2",
    });

    const sessions = await getProjectSessions("/proj2");
    expect(sessions).toHaveLength(2);
  });

  it("getSession returns null for non-existent project", async () => {
    const { getSession } = createTestStateManager();
    const result = await getSession("/nonexistent", "anything");
    expect(result).toBeNull();
  });

  it("getProjectSessions returns empty array for non-existent project", async () => {
    const { getProjectSessions } = createTestStateManager();
    const result = await getProjectSessions("/nonexistent");
    expect(result).toEqual([]);
  });
});

describe("archive helpers", () => {
  it("getArchivedProjects returns empty set for fresh state", async () => {
    const { getArchivedProjects } = createTestStateManager();
    const archived = await getArchivedProjects();
    expect(archived.size).toBe(0);
  });

  it("setProjectArchived adds a project path to the archive set", async () => {
    const { setProjectArchived, getArchivedProjects } =
      createTestStateManager();

    await setProjectArchived("/some/project", true);

    const archived = await getArchivedProjects();
    expect(archived.has("/some/project")).toBe(true);
    expect(archived.size).toBe(1);
  });

  it("setProjectArchived removes a project path from the archive set", async () => {
    const { setProjectArchived, getArchivedProjects, writeState } =
      createTestStateManager();

    // Seed state with an archived project
    await writeState({
      projects: {},
      archivedProjects: ["/some/project"],
      pinnedProjects: [],
    });

    await setProjectArchived("/some/project", false);

    const archived = await getArchivedProjects();
    expect(archived.has("/some/project")).toBe(false);
    expect(archived.size).toBe(0);
  });

  it("archiving does not alter existing project entries or session data", async () => {
    const { setProjectArchived, readState, writeState } =
      createTestStateManager();

    const session = {
      sessionName: "test",
      worktreePath: "/proj/.worktrees/test",
      branchName: "csm/test",
      createdAt: "2024-01-01T00:00:00Z",
      lastActivityAt: "2024-01-01T00:00:00Z",
      archived: false,
      finished: false,
      conversations: [],
      source: "cc" as const,
      objective: null,
      creationMode: "fast" as const,
      tddEnabled: true,
      targetBranch: "main",
      parentSessionName: null,
      graphWorkflowExecution: null,
      graphWorkflowExecutionHistory: [],
      referenceDocuments: [],
    };

    await writeState({
      projects: {
        "/proj": {
          rootPath: "/proj",
          roadmapItems: [],
          sessions: { test: session },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    await setProjectArchived("/proj", true);

    const state = await readState();
    const savedSession = state.projects["/proj"]!.sessions["test"]!;
    expect(savedSession.sessionName).toBe("test");
    expect(savedSession.branchName).toBe("csm/test");
    expect(savedSession.conversations).toEqual([]);
    expect(state.archivedProjects).toContain("/proj");
  });

  it("archiving the same project twice does not create duplicates", async () => {
    const { setProjectArchived, readState } = createTestStateManager();

    await setProjectArchived("/proj", true);
    await setProjectArchived("/proj", true);

    const state = await readState();
    expect(state.archivedProjects.filter((p) => p === "/proj")).toHaveLength(1);
  });
});

describe("recoverStaleConversations", () => {
  function makeConversation(overrides: Record<string, unknown> = {}) {
    return {
      id: "conv-1",
      status: "running" as const,
      createdAt: "2024-01-01T00:00:00Z",
      lastActivityAt: "2024-01-01T00:00:00Z",
      promptCount: 1,
      pendingQuestionId: null,
      pendingQuestions: null,
      claudeSessionId: null,
      transcriptPath: null,
      totalCostUsd: 0,
      totalDurationMs: 0,
      totalTurns: 0,
      forkedFrom: null,
      role: null,
      name: null,
      source: "cc" as const,
      summary: null,
      archived: false,
      contextTokens: null,
      contextWindowMax: null,
      debugMode: null,
      machineSnapshot: null,
      ...overrides,
    };
  }

  function makeState(conversations: ReturnType<typeof makeConversation>[]) {
    return {
      projects: {
        "/proj": {
          rootPath: "/proj",
          roadmapItems: [],
          sessions: {
            "test-session": {
              sessionName: "test-session",
              worktreePath: "/proj/.worktrees/test-session",
              branchName: "csm/test-session",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations,
              source: "cc" as const,
              objective: null,
              creationMode: "fast" as const,
              tddEnabled: true,
              targetBranch: "main",
              parentSessionName: null,
              graphWorkflowExecution: null,
              graphWorkflowExecutionHistory: [],
              referenceDocuments: [],
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    };
  }

  it("resets stale 'running' conversations to 'awaiting'", async () => {
    const { writeState, readState, recoverStaleConversations } =
      createTestStateManager();
    await writeState(makeState([makeConversation({ status: "running" })]));

    const count = await recoverStaleConversations();
    expect(count).toBe(1);

    const state = await readState();
    const conv =
      state.projects["/proj"]!.sessions["test-session"]!.conversations[0]!;
    expect(conv.status).toBe("awaiting");
  });

  it("resets stale 'waiting_for_input' conversations to 'awaiting'", async () => {
    const { writeState, readState, recoverStaleConversations } =
      createTestStateManager();
    await writeState(
      makeState([
        makeConversation({
          status: "waiting_for_input",
          pendingQuestionId: "q1",
          pendingQuestions: [
            {
              question: "?",
              options: [
                { value: "yes", label: "Yes" },
                { value: "no", label: "No" },
              ],
            },
          ],
        }),
      ]),
    );

    const count = await recoverStaleConversations();
    expect(count).toBe(1);

    const state = await readState();
    const conv =
      state.projects["/proj"]!.sessions["test-session"]!.conversations[0]!;
    expect(conv.status).toBe("awaiting");
    expect(conv.pendingQuestionId).toBeNull();
    expect(conv.pendingQuestions).toBeNull();
  });

  it("skips conversations with machineSnapshot (actor will be rehydrated)", async () => {
    const { writeState, readState, recoverStaleConversations } =
      createTestStateManager();
    await writeState(
      makeState([
        makeConversation({
          status: "running",
          machineSnapshot: { version: 1, snapshot: { some: "data" } },
        }),
      ]),
    );

    const count = await recoverStaleConversations();
    expect(count).toBe(0);

    const state = await readState();
    const conv =
      state.projects["/proj"]!.sessions["test-session"]!.conversations[0]!;
    expect(conv.status).toBe("running");
  });

  it("does not touch 'awaiting' or 'new' conversations", async () => {
    const { writeState, recoverStaleConversations } = createTestStateManager();
    await writeState(
      makeState([
        makeConversation({ id: "c1", status: "awaiting" }),
        makeConversation({ id: "c2", status: "new" }),
      ]),
    );

    const count = await recoverStaleConversations();
    expect(count).toBe(0);
  });
});

describe("schema backwards compatibility", () => {
  it("readState handles sessions missing the archived field (pre-migration data)", async () => {
    const configReader = createConfigReader(TEST_DIR);
    const config = await configReader.readConfig();

    // Write raw JSON that simulates pre-migration state: sessions without the "archived" field
    const legacyState = {
      projects: {
        "/proj": {
          rootPath: "/proj",
          roadmapItems: [],
          sessions: {
            "my-session": {
              sessionName: "my-session",
              worktreePath: "/proj/.worktrees/my-session",
              branchName: "csm/my-session",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              // NOTE: no "archived" field — this is the bug trigger
              finished: false,
              conversations: [],
              source: "cc",
              objective: null,
              creationMode: "fast",
              tddEnabled: true,
            },
          },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    };

    await writeFile(config.stateFilePath, JSON.stringify(legacyState), "utf-8");

    const { readState } = createTestStateManager();
    const state = await readState();

    // The session must be visible — not silently dropped
    const project = state.projects["/proj"];
    expect(project).toBeDefined();
    expect(Object.keys(project!.sessions)).toHaveLength(1);
    expect(project!.sessions["my-session"]!.archived).toBe(false);
  });
});

describe("pin helpers", () => {
  it("getPinnedProjects returns empty set for fresh state", async () => {
    const { getPinnedProjects } = createTestStateManager();
    const pinned = await getPinnedProjects();
    expect(pinned.size).toBe(0);
  });

  it("setProjectPinned adds a project path to the pinned set", async () => {
    const { setProjectPinned, getPinnedProjects } = createTestStateManager();

    await setProjectPinned("/some/project", true);

    const pinned = await getPinnedProjects();
    expect(pinned.has("/some/project")).toBe(true);
    expect(pinned.size).toBe(1);
  });

  it("setProjectPinned removes a project path from the pinned set", async () => {
    const { setProjectPinned, getPinnedProjects, writeState } =
      createTestStateManager();

    // Seed state with a pinned project
    await writeState({
      projects: {},
      archivedProjects: [],
      pinnedProjects: ["/some/project"],
    });

    await setProjectPinned("/some/project", false);

    const pinned = await getPinnedProjects();
    expect(pinned.has("/some/project")).toBe(false);
    expect(pinned.size).toBe(0);
  });

  it("pinning does not alter existing project entries or session data", async () => {
    const { setProjectPinned, readState, writeState } =
      createTestStateManager();

    const session = {
      sessionName: "test",
      worktreePath: "/proj/.worktrees/test",
      branchName: "csm/test",
      createdAt: "2024-01-01T00:00:00Z",
      lastActivityAt: "2024-01-01T00:00:00Z",
      archived: false,
      finished: false,
      conversations: [],
      source: "cc" as const,
      objective: null,
      creationMode: "fast" as const,
      tddEnabled: true,
      targetBranch: "main",
      parentSessionName: null,
      graphWorkflowExecution: null,
      graphWorkflowExecutionHistory: [],
      referenceDocuments: [],
    };

    await writeState({
      projects: {
        "/proj": {
          rootPath: "/proj",
          roadmapItems: [],
          sessions: { test: session },
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    await setProjectPinned("/proj", true);

    const state = await readState();
    const savedSession = state.projects["/proj"]!.sessions["test"]!;
    expect(savedSession.sessionName).toBe("test");
    expect(savedSession.branchName).toBe("csm/test");
    expect(savedSession.conversations).toEqual([]);
    expect(state.pinnedProjects).toContain("/proj");
  });

  it("pinning the same project twice does not create duplicates", async () => {
    const { setProjectPinned, readState } = createTestStateManager();

    await setProjectPinned("/proj", true);
    await setProjectPinned("/proj", true);

    const state = await readState();
    expect(state.pinnedProjects.filter((p) => p === "/proj")).toHaveLength(1);
  });
});

describe("readState error handling", () => {
  it("throws when state file contains invalid JSON", async () => {
    const configReader = createConfigReader(TEST_DIR);
    const config = await configReader.readConfig();
    await writeFile(config.stateFilePath, "not valid json{{{", "utf-8");

    const { readState } = createTestStateManager();
    await expect(readState()).rejects.toThrow();
  });

  it("throws when state file fails schema validation", async () => {
    const configReader = createConfigReader(TEST_DIR);
    const config = await configReader.readConfig();
    // Valid JSON but doesn't match managerStateSchema
    await writeFile(
      config.stateFilePath,
      JSON.stringify({ projects: "not-an-object" }),
      "utf-8",
    );

    const { readState } = createTestStateManager();
    await expect(readState()).rejects.toThrow();
  });

  it("mutateState does not overwrite corrupted file with empty state", async () => {
    const configReader = createConfigReader(TEST_DIR);
    const config = await configReader.readConfig();

    // Write valid state with real data
    const validState = {
      projects: {
        "/proj": { rootPath: "/proj", sessions: {}, roadmapItems: [] },
      },
      archivedProjects: [],
      pinnedProjects: [],
    };
    await writeFile(config.stateFilePath, JSON.stringify(validState), "utf-8");

    // Corrupt the file
    await writeFile(config.stateFilePath, "corrupted!", "utf-8");

    const { mutateState } = createTestStateManager();

    // mutateState should propagate the readState error
    await expect(
      mutateState("test", (state) => {
        state.pinnedProjects.push("/foo");
      }),
    ).rejects.toThrow();

    // File must still contain corrupted content — NOT overwritten with empty state
    const fileContent = await readFile(config.stateFilePath, "utf-8");
    expect(fileContent).toBe("corrupted!");
  });
});
