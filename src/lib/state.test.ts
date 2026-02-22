import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const TEST_DIR = path.join("/tmp", "csm-state-test-" + Date.now());
const STATE_FILE = path.join(TEST_DIR, "state.json");

// Mock config to return our test state file path
vi.mock("./config", () => ({
  readConfig: vi.fn().mockResolvedValue({
    baseDir: "/tmp/projects",
    ignorePatterns: [],
    stateFilePath: STATE_FILE,
    claudeTimeoutMs: 300_000,
  }),
}));

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  vi.resetModules();
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("state", () => {
  it("readState returns empty state when file does not exist", async () => {
    const { readState } = await import("./state");
    const state = await readState();
    expect(state.projects).toEqual({});
  });

  it("writeState and readState roundtrip", async () => {
    const { readState, writeState } = await import("./state");
    await writeState({
      projects: {
        "/some/project": {
          rootPath: "/some/project",
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
    const { getOrCreateProject, readState } = await import("./state");
    const project = await getOrCreateProject("/new/project");

    expect(project.rootPath).toBe("/new/project");
    expect(project.sessions).toEqual({});

    const state = await readState();
    expect(state.projects["/new/project"]).toBeDefined();
  });

  it("getOrCreateProject returns existing project", async () => {
    const { getOrCreateProject, writeState } = await import("./state");
    await writeState({
      projects: {
        "/existing": {
          rootPath: "/existing",
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
              source: "csm" as const,
              containerId: null,
              containerStatus: "none" as const,
              containerError: null,
              claudeHostDir: null,
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
    const { updateSession, getSession } = await import("./state");
    const session = {
      sessionName: "new-session",
      worktreePath: "/proj/.worktrees/new-session",
      branchName: "csm/new-session",
      createdAt: "2024-01-01T00:00:00Z",
      lastActivityAt: "2024-01-01T00:00:00Z",
      archived: false,
      finished: false,
      conversations: [],
      source: "csm" as const,
      claudeSessionId: null,
      transcriptPath: null,
      status: "new" as const,
      promptCount: 0,
      containerId: null,
      containerStatus: "none" as const,
      containerError: null,
      claudeHostDir: null,
    };

    await updateSession("/proj", session);

    const retrieved = await getSession("/proj", "new-session");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.branchName).toBe("csm/new-session");
  });

  it("removeSession deletes session from state", async () => {
    const { updateSession, removeSession, getSession } =
      await import("./state");
    const session = {
      sessionName: "to-delete",
      worktreePath: "/proj/.worktrees/to-delete",
      branchName: "csm/to-delete",
      createdAt: "2024-01-01T00:00:00Z",
      lastActivityAt: "2024-01-01T00:00:00Z",
      archived: false,
      finished: false,
      conversations: [],
      source: "csm" as const,
      claudeSessionId: null,
      transcriptPath: null,
      status: "new" as const,
      promptCount: 0,
      containerId: null,
      containerStatus: "none" as const,
      containerError: null,
      claudeHostDir: null,
    };

    await updateSession("/proj", session);
    expect(await getSession("/proj", "to-delete")).not.toBeNull();

    await removeSession("/proj", "to-delete");
    expect(await getSession("/proj", "to-delete")).toBeNull();
  });

  it("getProjectSessions returns all sessions for a project", async () => {
    const { updateSession, getProjectSessions } = await import("./state");

    const baseSession = {
      worktreePath: "",
      branchName: "",
      createdAt: "2024-01-01T00:00:00Z",
      lastActivityAt: "2024-01-01T00:00:00Z",
      archived: false,
      finished: false,
      conversations: [],
      source: "csm" as const,
      claudeSessionId: null,
      transcriptPath: null,
      status: "new" as const,
      promptCount: 0,
      containerId: null,
      containerStatus: "none" as const,
      containerError: null,
      claudeHostDir: null,
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
    const { getSession } = await import("./state");
    const result = await getSession("/nonexistent", "anything");
    expect(result).toBeNull();
  });

  it("getProjectSessions returns empty array for non-existent project", async () => {
    const { getProjectSessions } = await import("./state");
    const result = await getProjectSessions("/nonexistent");
    expect(result).toEqual([]);
  });
});

describe("archive helpers", () => {
  it("getArchivedProjects returns empty set for fresh state", async () => {
    const { getArchivedProjects } = await import("./state");
    const archived = await getArchivedProjects();
    expect(archived.size).toBe(0);
  });

  it("setProjectArchived adds a project path to the archive set", async () => {
    const { setProjectArchived, getArchivedProjects } = await import("./state");

    await setProjectArchived("/some/project", true);

    const archived = await getArchivedProjects();
    expect(archived.has("/some/project")).toBe(true);
    expect(archived.size).toBe(1);
  });

  it("setProjectArchived removes a project path from the archive set", async () => {
    const { setProjectArchived, getArchivedProjects, writeState } =
      await import("./state");

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
      await import("./state");

    const session = {
      sessionName: "test",
      worktreePath: "/proj/.worktrees/test",
      branchName: "csm/test",
      createdAt: "2024-01-01T00:00:00Z",
      lastActivityAt: "2024-01-01T00:00:00Z",
      archived: false,
      finished: false,
      conversations: [],
      source: "csm" as const,
      containerId: null,
      containerStatus: "none" as const,
      containerError: null,
      claudeHostDir: null,
    };

    await writeState({
      projects: {
        "/proj": {
          rootPath: "/proj",
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
    const { setProjectArchived, readState } = await import("./state");

    await setProjectArchived("/proj", true);
    await setProjectArchived("/proj", true);

    const state = await readState();
    expect(state.archivedProjects.filter((p) => p === "/proj")).toHaveLength(1);
  });
});

describe("pin helpers", () => {
  it("getPinnedProjects returns empty set for fresh state", async () => {
    const { getPinnedProjects } = await import("./state");
    const pinned = await getPinnedProjects();
    expect(pinned.size).toBe(0);
  });

  it("setProjectPinned adds a project path to the pinned set", async () => {
    const { setProjectPinned, getPinnedProjects } = await import("./state");

    await setProjectPinned("/some/project", true);

    const pinned = await getPinnedProjects();
    expect(pinned.has("/some/project")).toBe(true);
    expect(pinned.size).toBe(1);
  });

  it("setProjectPinned removes a project path from the pinned set", async () => {
    const { setProjectPinned, getPinnedProjects, writeState } =
      await import("./state");

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
    const { setProjectPinned, readState, writeState } = await import("./state");

    const session = {
      sessionName: "test",
      worktreePath: "/proj/.worktrees/test",
      branchName: "csm/test",
      createdAt: "2024-01-01T00:00:00Z",
      lastActivityAt: "2024-01-01T00:00:00Z",
      archived: false,
      finished: false,
      conversations: [],
      source: "csm" as const,
      containerId: null,
      containerStatus: "none" as const,
      containerError: null,
      claudeHostDir: null,
    };

    await writeState({
      projects: {
        "/proj": {
          rootPath: "/proj",
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
    const { setProjectPinned, readState } = await import("./state");

    await setProjectPinned("/proj", true);
    await setProjectPinned("/proj", true);

    const state = await readState();
    expect(state.pinnedProjects.filter((p) => p === "/proj")).toHaveLength(1);
  });
});
