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
              claudeSessionId: null,
              transcriptPath: null,
              status: "ready",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              promptCount: 0,
              archived: false,
            },
          },
        },
      },
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
      claudeSessionId: null,
      transcriptPath: null,
      status: "ready" as const,
      createdAt: "2024-01-01T00:00:00Z",
      lastActivityAt: "2024-01-01T00:00:00Z",
      promptCount: 0,
      archived: false,
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
      claudeSessionId: null,
      transcriptPath: null,
      status: "ready" as const,
      createdAt: "2024-01-01T00:00:00Z",
      lastActivityAt: "2024-01-01T00:00:00Z",
      promptCount: 0,
      archived: false,
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
      claudeSessionId: null,
      transcriptPath: null,
      status: "ready" as const,
      createdAt: "2024-01-01T00:00:00Z",
      lastActivityAt: "2024-01-01T00:00:00Z",
      promptCount: 0,
      archived: false,
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
