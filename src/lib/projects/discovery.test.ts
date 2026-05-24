import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ManagerState } from "@/lib/projects/schemas";
import { createConfigReader } from "@/lib/config/loader";
import { createDiscoveryService } from "./discovery";
import type { DiscoveryDeps } from "./discovery";

const TEST_DIR = path.join("/tmp", "cc-discovery-test-" + Date.now());
const CONFIG_DIR = path.join(TEST_DIR, "config");
const BASE_DIR = path.join(TEST_DIR, "projects");

beforeEach(async () => {
  await mkdir(CONFIG_DIR, { recursive: true });
  await mkdir(BASE_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

const EMPTY_STATE = {
  projects: {},
  archivedProjects: [],
  pinnedProjects: [],
} as ManagerState;

function createTestService(
  stateOverride: Partial<ManagerState> = {},
  configOverrides: Record<string, unknown> = {},
) {
  const state = { ...EMPTY_STATE, ...stateOverride } as ManagerState;
  const configReader = createConfigReader(CONFIG_DIR);
  const deps: DiscoveryDeps = {
    readConfig: async () => {
      const config = await configReader.readConfig();
      return { ...config, baseDir: BASE_DIR, ...configOverrides };
    },
    readState: async () => state,
  };
  return createDiscoveryService(deps);
}

/** Helper: create a directory with a .git entry */
async function createGitRepo(name: string) {
  const repoPath = path.join(BASE_DIR, name);
  await mkdir(path.join(repoPath, ".git"), { recursive: true });
  return repoPath;
}

/** Helper: create a plain directory (no .git) */
async function createPlainDir(name: string) {
  const dirPath = path.join(BASE_DIR, name);
  await mkdir(dirPath, { recursive: true });
  return dirPath;
}

/** Helper: create a file in baseDir */
async function createFile(name: string) {
  await writeFile(path.join(BASE_DIR, name), "dummy", "utf-8");
}

// ============================================================
// Task 1.1: Directory Scanning and Filtering (Req 1.1–1.5)
// ============================================================
describe("discoverProjects — scanning and filtering", () => {
  it("discovers directories containing .git", async () => {
    await createGitRepo("alpha");
    await createGitRepo("bravo");

    const service = createTestService();
    const projects = await service.discoverProjects();

    expect(projects).toHaveLength(2);
    expect(projects.map((p) => p.name)).toContain("alpha");
    expect(projects.map((p) => p.name)).toContain("bravo");
  });

  it("excludes directories without .git", async () => {
    await createGitRepo("has-git");
    await createPlainDir("no-git");

    const service = createTestService();
    const projects = await service.discoverProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe("has-git");
  });

  it("skips non-directory entries (files)", async () => {
    await createGitRepo("real-repo");
    await createFile("some-file.txt");

    const service = createTestService();
    const projects = await service.discoverProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe("real-repo");
  });

  it("excludes directories matching ignore patterns", async () => {
    await createGitRepo("my-project");
    await createGitRepo("node_modules");
    await createGitRepo(".cache");

    const service = createTestService(EMPTY_STATE, {
      ignorePatterns: ["node_modules", ".cache"],
    });
    const projects = await service.discoverProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe("my-project");
  });

  it("returns empty list when baseDir does not exist", async () => {
    const configReader = createConfigReader(CONFIG_DIR);
    const service = createDiscoveryService({
      readConfig: async () => {
        const config = await configReader.readConfig();
        return {
          ...config,
          baseDir: "/tmp/cc-nonexistent-" + Date.now(),
        };
      },
      readState: async () => EMPTY_STATE,
    });
    const projects = await service.discoverProjects();

    expect(projects).toEqual([]);
  });
});

// ============================================================
// Task 1.2: Session Metadata Enrichment (Req 2.1–2.4)
// ============================================================
describe("discoverProjects — session metadata enrichment", () => {
  it("returns name, path, activeSessions, and hasRunningSession for each project", async () => {
    const repoPath = await createGitRepo("my-repo");

    const service = createTestService();
    const projects = await service.discoverProjects();

    expect(projects).toHaveLength(1);
    const project = projects[0]!;
    expect(project).toEqual({
      name: "my-repo",
      path: repoPath,
      activeSessions: 0,
      hasRunningSession: false,
    });
  });

  it("counts non-archived sessions as activeSessions", async () => {
    const repoPath = await createGitRepo("active-project");

    const state = {
      projects: {
        [repoPath]: {
          rootPath: repoPath,
          sessions: {
            "session-1": {
              sessionName: "session-1",
              worktreePath: "/tmp/wt1",
              branchName: "csm/session-1",
              createdAt: "2026-01-01T00:00:00Z",
              lastActivityAt: "2026-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
            },
            "session-2": {
              sessionName: "session-2",
              worktreePath: "/tmp/wt2",
              branchName: "csm/session-2",
              createdAt: "2026-01-01T00:00:00Z",
              lastActivityAt: "2026-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
            },
            "session-archived": {
              sessionName: "session-archived",
              worktreePath: "/tmp/wt3",
              branchName: "csm/session-archived",
              createdAt: "2026-01-01T00:00:00Z",
              lastActivityAt: "2026-01-01T00:00:00Z",
              archived: true,
              conversations: [],
            },
          },
        } as never,
      },
    };

    const service = createTestService(state);
    const projects = await service.discoverProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]!.activeSessions).toBe(2);
  });

  it("sets hasRunningSession to true when any session is running", async () => {
    const repoPath = await createGitRepo("running-project");

    const state = {
      projects: {
        [repoPath]: {
          rootPath: repoPath,
          sessions: {
            "session-idle": {
              sessionName: "session-idle",
              worktreePath: "/tmp/wt1",
              branchName: "csm/session-idle",
              createdAt: "2026-01-01T00:00:00Z",
              lastActivityAt: "2026-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
            },
            "session-running": {
              sessionName: "session-running",
              worktreePath: "/tmp/wt2",
              branchName: "csm/session-running",
              createdAt: "2026-01-01T00:00:00Z",
              lastActivityAt: "2026-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [
                {
                  id: "conv-run",
                  transcriptPath: null,
                  status: "running",
                  promptCount: 1,
                  createdAt: "2026-01-01T00:00:00Z",
                  lastActivityAt: "2026-01-01T00:00:00Z",
                  source: "cc",
                  summary: null,
                },
              ],
            },
          },
        } as never,
      },
    };

    const service = createTestService(state);
    const projects = await service.discoverProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]!.hasRunningSession).toBe(true);
  });

  it("ignores archived sessions for hasRunningSession", async () => {
    const repoPath = await createGitRepo("archived-running");

    const state = {
      projects: {
        [repoPath]: {
          rootPath: repoPath,
          sessions: {
            "session-archived-running": {
              sessionName: "session-archived-running",
              worktreePath: "/tmp/wt1",
              branchName: "csm/session-archived-running",
              createdAt: "2026-01-01T00:00:00Z",
              lastActivityAt: "2026-01-01T00:00:00Z",
              archived: true,
              finished: false,
              conversations: [
                {
                  id: "conv-stuck",
                  transcriptPath: null,
                  status: "running",
                  promptCount: 1,
                  createdAt: "2026-01-01T00:00:00Z",
                  lastActivityAt: "2026-01-01T00:00:00Z",
                  source: "cc",
                  summary: null,
                },
              ],
            },
          },
        } as never,
      },
    };

    const service = createTestService(state);
    const projects = await service.discoverProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]!.hasRunningSession).toBe(false);
    expect(projects[0]!.activeSessions).toBe(0);
  });

  it("ignores finished sessions for hasRunningSession", async () => {
    const repoPath = await createGitRepo("finished-running");

    const state = {
      projects: {
        [repoPath]: {
          rootPath: repoPath,
          sessions: {
            "session-finished": {
              sessionName: "session-finished",
              worktreePath: "/tmp/wt1",
              branchName: "csm/session-finished",
              createdAt: "2026-01-01T00:00:00Z",
              lastActivityAt: "2026-01-01T00:00:00Z",
              archived: false,
              finished: true,
              conversations: [
                {
                  id: "conv-stuck",
                  transcriptPath: null,
                  status: "running",
                  promptCount: 1,
                  createdAt: "2026-01-01T00:00:00Z",
                  lastActivityAt: "2026-01-01T00:00:00Z",
                  source: "cc",
                  summary: null,
                },
              ],
            },
          },
        } as never,
      },
    };

    const service = createTestService(state);
    const projects = await service.discoverProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]!.hasRunningSession).toBe(false);
  });

  it("returns activeSessions: 0 and hasRunningSession: false when project has no state entry", async () => {
    await createGitRepo("unknown-project");

    const service = createTestService();
    const projects = await service.discoverProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]!.activeSessions).toBe(0);
    expect(projects[0]!.hasRunningSession).toBe(false);
  });

  it("marks a project running when a session has a running collaboration envelope but no active conversation", async () => {
    const repoPath = await createGitRepo("collab-running-project");

    const state = {
      projects: {
        [repoPath]: {
          rootPath: repoPath,
          sessions: {
            "session-collab": {
              sessionName: "session-collab",
              worktreePath: "/tmp/wt-collab",
              branchName: "csm/session-collab",
              createdAt: "2026-01-01T00:00:00Z",
              lastActivityAt: "2026-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              workflowEnvelopes: {
                "wf-1": {
                  workflowId: "wf-1",
                  workflowType: "collaboration",
                  status: "running",
                  phase: "round",
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-01T00:00:00Z",
                  featureSnapshot: {},
                },
              },
            },
          },
        } as never,
      },
    };

    const service = createTestService(state);
    const projects = await service.discoverProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]!.hasRunningSession).toBe(true);
  });
});

// ============================================================
// Orphan projects (in state but not on disk)
// ============================================================
describe("discoverProjects — orphan/missing projects", () => {
  it("surfaces projects present in state but missing from disk with missing: true", async () => {
    await createGitRepo("real-repo");
    const orphanPath = "/tmp/cc-orphan-" + Date.now();

    const state = {
      projects: {
        [orphanPath]: {
          rootPath: orphanPath,
          sessions: {},
        } as never,
      },
    };

    const service = createTestService(state);
    const projects = await service.discoverProjects();

    const orphan = projects.find((p) => p.path === orphanPath);
    expect(orphan).toBeDefined();
    expect(orphan!.missing).toBe(true);
    expect(orphan!.name).toBe(path.basename(orphanPath));

    const real = projects.find((p) => p.name === "real-repo");
    expect(real).toBeDefined();
    expect(real!.missing).toBeFalsy();
  });

  it("does not duplicate on-disk projects that also have state entries", async () => {
    const repoPath = await createGitRepo("dual-repo");
    const state = {
      projects: {
        [repoPath]: {
          rootPath: repoPath,
          sessions: {},
        } as never,
      },
    };

    const service = createTestService(state);
    const projects = await service.discoverProjects();

    expect(projects.filter((p) => p.path === repoPath)).toHaveLength(1);
    expect(projects[0]!.missing).toBeFalsy();
  });

  it("counts sessions for orphan projects so the UI shows what will be purged", async () => {
    const orphanPath = "/tmp/cc-orphan-with-sessions-" + Date.now();
    const state = {
      projects: {
        [orphanPath]: {
          rootPath: orphanPath,
          sessions: {
            s1: {
              sessionName: "s1",
              worktreePath: "/tmp/wt1",
              branchName: "csm/s1",
              createdAt: "2026-01-01T00:00:00Z",
              lastActivityAt: "2026-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
            },
          },
        } as never,
      },
    };

    const service = createTestService(state);
    const projects = await service.discoverProjects();

    const orphan = projects.find((p) => p.path === orphanPath);
    expect(orphan).toBeDefined();
    expect(orphan!.activeSessions).toBe(1);
  });
});

// ============================================================
// Task 1.3: Result Ordering (Req 3.1–3.2)
// ============================================================
describe("discoverProjects — result ordering", () => {
  it("sorts projects with active sessions before inactive ones", async () => {
    await createGitRepo("aaa-inactive");
    const activePath = await createGitRepo("zzz-active");

    const state = {
      projects: {
        [activePath]: {
          rootPath: activePath,
          sessions: {
            s1: {
              sessionName: "s1",
              worktreePath: "/tmp/wt1",
              branchName: "csm/s1",
              createdAt: "2026-01-01T00:00:00Z",
              lastActivityAt: "2026-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
            },
          },
        } as never,
      },
    };

    const service = createTestService(state);
    const projects = await service.discoverProjects();

    expect(projects).toHaveLength(2);
    expect(projects[0]!.name).toBe("zzz-active");
    expect(projects[1]!.name).toBe("aaa-inactive");
  });

  it("sorts alphabetically within the same activity tier using locale-aware comparison", async () => {
    await createGitRepo("charlie");
    await createGitRepo("alpha");
    await createGitRepo("bravo");

    const service = createTestService();
    const projects = await service.discoverProjects();

    expect(projects.map((p) => p.name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("maintains stable ordering with multiple projects across both tiers", async () => {
    const activeB = await createGitRepo("beta-active");
    const activeA = await createGitRepo("alpha-active");
    await createGitRepo("delta-inactive");
    await createGitRepo("gamma-inactive");

    const state = {
      projects: {
        [activeA]: {
          rootPath: activeA,
          sessions: {
            s1: {
              sessionName: "s1",
              worktreePath: "/tmp/wt1",
              branchName: "csm/s1",
              createdAt: "2026-01-01T00:00:00Z",
              lastActivityAt: "2026-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
            },
          },
        } as never,
        [activeB]: {
          rootPath: activeB,
          sessions: {
            s2: {
              sessionName: "s2",
              worktreePath: "/tmp/wt2",
              branchName: "csm/s2",
              createdAt: "2026-01-01T00:00:00Z",
              lastActivityAt: "2026-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [
                {
                  id: "conv-s2",
                  transcriptPath: null,
                  status: "running",
                  promptCount: 1,
                  createdAt: "2026-01-01T00:00:00Z",
                  lastActivityAt: "2026-01-01T00:00:00Z",
                  source: "cc",
                  summary: null,
                },
              ],
            },
          },
        } as never,
      },
    };

    const service = createTestService(state);
    const projects = await service.discoverProjects();

    expect(projects.map((p) => p.name)).toEqual([
      "alpha-active",
      "beta-active",
      "delta-inactive",
      "gamma-inactive",
    ]);
  });
});
