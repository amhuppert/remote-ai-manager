import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const TEST_DIR = path.join("/tmp", "csm-discovery-test-" + Date.now());
const BASE_DIR = path.join(TEST_DIR, "projects");

// Mock node:os to redirect homedir to test directory
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: {
      ...actual,
      platform: () => "linux",
      homedir: () => TEST_DIR,
    },
    platform: () => "linux",
    homedir: () => TEST_DIR,
  };
});

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  await mkdir(BASE_DIR, { recursive: true });
  vi.resetModules();
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

/** Helper: set up config to point at our test BASE_DIR */
async function setupConfig(overrides: Record<string, unknown> = {}) {
  const { readConfig, writeConfig } = await import("./config");
  const config = await readConfig();
  await writeConfig({
    ...config,
    baseDir: BASE_DIR,
    ...overrides,
  });
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

/** Helper: write a state file with session data */
async function writeStateFile(
  stateFilePath: string,
  state: Record<string, unknown>,
) {
  const dir = path.dirname(stateFilePath);
  await mkdir(dir, { recursive: true });
  await writeFile(stateFilePath, JSON.stringify(state), "utf-8");
}

// ============================================================
// Task 1.1: Directory Scanning and Filtering (Req 1.1–1.5)
// ============================================================
describe("discoverProjects — scanning and filtering", () => {
  it("discovers directories containing .git", async () => {
    await setupConfig();
    await createGitRepo("alpha");
    await createGitRepo("bravo");

    const { discoverProjects } = await import("./discovery");
    const projects = await discoverProjects();

    expect(projects).toHaveLength(2);
    expect(projects.map((p) => p.name)).toContain("alpha");
    expect(projects.map((p) => p.name)).toContain("bravo");
  });

  it("excludes directories without .git", async () => {
    await setupConfig();
    await createGitRepo("has-git");
    await createPlainDir("no-git");

    const { discoverProjects } = await import("./discovery");
    const projects = await discoverProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe("has-git");
  });

  it("skips non-directory entries (files)", async () => {
    await setupConfig();
    await createGitRepo("real-repo");
    await createFile("some-file.txt");

    const { discoverProjects } = await import("./discovery");
    const projects = await discoverProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe("real-repo");
  });

  it("excludes directories matching ignore patterns", async () => {
    await setupConfig({ ignorePatterns: ["node_modules", ".cache"] });
    await createGitRepo("my-project");
    // These have .git but match ignore patterns
    await createGitRepo("node_modules");
    await createGitRepo(".cache");

    const { discoverProjects } = await import("./discovery");
    const projects = await discoverProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe("my-project");
  });

  it("returns empty list when baseDir does not exist", async () => {
    await setupConfig({ baseDir: "/tmp/csm-nonexistent-" + Date.now() });

    const { discoverProjects } = await import("./discovery");
    const projects = await discoverProjects();

    expect(projects).toEqual([]);
  });
});

// ============================================================
// Task 1.2: Session Metadata Enrichment (Req 2.1–2.4)
// ============================================================
describe("discoverProjects — session metadata enrichment", () => {
  it("returns name, path, activeSessions, and hasRunningSession for each project", async () => {
    await setupConfig();
    const repoPath = await createGitRepo("my-repo");

    const { discoverProjects } = await import("./discovery");
    const projects = await discoverProjects();

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
    await setupConfig();
    const repoPath = await createGitRepo("active-project");

    // Write state with sessions
    const { getConfigDirPath } = await import("./config");
    const stateFilePath = path.join(getConfigDirPath(), "state.json");

    await writeStateFile(stateFilePath, {
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
        },
      },
    });

    // Re-import to pick up fresh state
    vi.resetModules();
    const { discoverProjects } = await import("./discovery");
    const projects = await discoverProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]!.activeSessions).toBe(2);
  });

  it("sets hasRunningSession to true when any session is running", async () => {
    await setupConfig();
    const repoPath = await createGitRepo("running-project");

    const { getConfigDirPath } = await import("./config");
    const stateFilePath = path.join(getConfigDirPath(), "state.json");

    await writeStateFile(stateFilePath, {
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
                  claudeSessionId: "abc",
                  transcriptPath: null,
                  status: "running",

                  promptCount: 1,
                  createdAt: "2026-01-01T00:00:00Z",
                  lastActivityAt: "2026-01-01T00:00:00Z",
                  source: "csm",
                  summary: null,
                },
              ],
            },
          },
        },
      },
    });

    vi.resetModules();
    const { discoverProjects } = await import("./discovery");
    const projects = await discoverProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]!.hasRunningSession).toBe(true);
  });

  it("returns activeSessions: 0 and hasRunningSession: false when project has no state entry", async () => {
    await setupConfig();
    await createGitRepo("unknown-project");

    const { discoverProjects } = await import("./discovery");
    const projects = await discoverProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0]!.activeSessions).toBe(0);
    expect(projects[0]!.hasRunningSession).toBe(false);
  });
});

// ============================================================
// Task 1.3: Result Ordering (Req 3.1–3.2)
// ============================================================
describe("discoverProjects — result ordering", () => {
  it("sorts projects with active sessions before inactive ones", async () => {
    await setupConfig();
    const inactivePath = await createGitRepo("aaa-inactive");
    const activePath = await createGitRepo("zzz-active");

    const { getConfigDirPath } = await import("./config");
    const stateFilePath = path.join(getConfigDirPath(), "state.json");

    await writeStateFile(stateFilePath, {
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
        },
        [inactivePath]: {
          rootPath: inactivePath,
          sessions: {},
        },
      },
    });

    vi.resetModules();
    const { discoverProjects } = await import("./discovery");
    const projects = await discoverProjects();

    expect(projects).toHaveLength(2);
    // zzz-active should come first despite alphabetical order
    expect(projects[0]!.name).toBe("zzz-active");
    expect(projects[1]!.name).toBe("aaa-inactive");
  });

  it("sorts alphabetically within the same activity tier using locale-aware comparison", async () => {
    await setupConfig();
    await createGitRepo("charlie");
    await createGitRepo("alpha");
    await createGitRepo("bravo");

    const { discoverProjects } = await import("./discovery");
    const projects = await discoverProjects();

    expect(projects.map((p) => p.name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("maintains stable ordering with multiple projects across both tiers", async () => {
    await setupConfig();
    const activeB = await createGitRepo("beta-active");
    const activeA = await createGitRepo("alpha-active");
    await createGitRepo("delta-inactive");
    await createGitRepo("gamma-inactive");

    const { getConfigDirPath } = await import("./config");
    const stateFilePath = path.join(getConfigDirPath(), "state.json");

    await writeStateFile(stateFilePath, {
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
        },
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
                  claudeSessionId: null,
                  transcriptPath: null,
                  status: "running",

                  promptCount: 1,
                  createdAt: "2026-01-01T00:00:00Z",
                  lastActivityAt: "2026-01-01T00:00:00Z",
                  source: "csm",
                  summary: null,
                },
              ],
            },
          },
        },
      },
    });

    vi.resetModules();
    const { discoverProjects } = await import("./discovery");
    const projects = await discoverProjects();

    expect(projects.map((p) => p.name)).toEqual([
      "alpha-active",
      "beta-active",
      "delta-inactive",
      "gamma-inactive",
    ]);
  });
});
