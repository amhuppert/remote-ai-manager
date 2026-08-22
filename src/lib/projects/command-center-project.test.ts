import { describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "@/lib/config/schemas";
import type { GitClient } from "@/lib/git/client";
import type { DiscoveredProject } from "./schemas";
import {
  createCommandCenterProjectResolver,
  resolveGitCommonDirectory,
  type CommandCenterProjectResolverDeps,
} from "./command-center-project";

const SERVER_WORKTREE = "/repos/command-center/.worktrees/feature";

function config(overrides: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    baseDir: "/projects",
    ignorePatterns: [],
    agentBackends: {
      claude: {
        model: "opus",
        reasoningEffort: "high",
        timeoutMs: 60_000,
      },
      codex: {
        model: "gpt-5.4",
        reasoningEffort: "high",
        fastMode: false,
        timeoutMs: null,
      },
      cursor: { model: "composer-2.5", timeoutMs: null },
    },
    defaultAgentBackend: "claude",
    ...overrides,
  };
}

function project(name: string, path = `/projects/${name}`): DiscoveredProject {
  return {
    name,
    path,
    activeSessions: 0,
    hasRunningSession: false,
  };
}

function makeDeps(
  input: {
    config?: GlobalConfig;
    projects?: DiscoveredProject[];
    commonDirs?: Record<string, string | Error>;
  } = {},
): CommandCenterProjectResolverDeps {
  const currentConfig = input.config ?? config();
  const projects = input.projects ?? [];
  const commonDirs = input.commonDirs ?? {};
  return {
    readConfig: vi.fn(async () => currentConfig),
    discoverProjects: vi.fn(async () => projects),
    resolveProjectPath: vi.fn(async (name, baseDir) =>
      name === "command-center" && baseDir === currentConfig.baseDir
        ? `/projects/${name}`
        : null,
    ),
    gitClient: {
      git: vi.fn(async (_args, cwd) => {
        const result = commonDirs[cwd];
        if (result instanceof Error) throw result;
        if (result === undefined) throw new Error(`not git: ${cwd}`);
        return { stdout: `${result}\n`, stderr: "" };
      }),
    },
    realpath: vi.fn(async (value) => `/canonical${value}`),
    serverWorkingDirectory: () => SERVER_WORKTREE,
  };
}

describe("resolveGitCommonDirectory", () => {
  it("requests an absolute git common dir and canonicalizes it", async () => {
    const git = vi.fn(async () => ({
      stdout: "/repos/command-center/.git\n",
      stderr: "",
    }));
    const realpath = vi.fn(async () => "/canonical/command-center/.git");

    await expect(
      resolveGitCommonDirectory("/worktree", {
        gitClient: { git } as GitClient,
        realpath,
      }),
    ).resolves.toBe("/canonical/command-center/.git");

    expect(git).toHaveBeenCalledWith(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      "/worktree",
    );
    expect(realpath).toHaveBeenCalledWith("/repos/command-center/.git");
  });

  it("returns null for non-Git directories", async () => {
    await expect(
      resolveGitCommonDirectory("/package", {
        gitClient: {
          git: vi.fn(async () => {
            throw new Error("not a git repository");
          }),
        },
        realpath: vi.fn(async (value) => value),
      }),
    ).resolves.toBeNull();
  });
});

describe("createCommandCenterProjectResolver", () => {
  it("uses an available explicit override without auto-detection", async () => {
    const deps = makeDeps({
      config: config({ commandCenterProjectName: "command-center" }),
      projects: [project("other")],
    });
    const resolver = createCommandCenterProjectResolver(deps);

    await expect(resolver.resolveProjectName()).resolves.toBe("command-center");
    expect(deps.resolveProjectPath).toHaveBeenCalledWith(
      "command-center",
      "/projects",
    );
    expect(deps.discoverProjects).not.toHaveBeenCalled();
    expect(deps.gitClient.git).not.toHaveBeenCalled();
  });

  it("treats an unavailable explicit override as authoritative", async () => {
    const deps = makeDeps({
      config: config({ commandCenterProjectName: "missing" }),
      projects: [project("command-center")],
      commonDirs: {
        [SERVER_WORKTREE]: "/repos/command-center/.git",
        "/projects/command-center": "/repos/command-center/.git",
      },
    });
    const resolver = createCommandCenterProjectResolver(deps);

    await expect(resolver.resolveProjectName()).resolves.toBeNull();
    expect(deps.discoverProjects).not.toHaveBeenCalled();
    expect(deps.gitClient.git).not.toHaveBeenCalled();
  });

  it("matches a registered checkout to the server's linked worktree by common dir", async () => {
    const deps = makeDeps({
      projects: [project("other"), project("command-center")],
      commonDirs: {
        [SERVER_WORKTREE]: "/repos/command-center/.git",
        "/projects/other": "/repos/other/.git",
        "/projects/command-center": "/repos/command-center/.git",
      },
    });
    const resolver = createCommandCenterProjectResolver(deps);

    await expect(resolver.resolveProjectName()).resolves.toBe("command-center");
  });

  it("returns null when more than one candidate shares the server common dir", async () => {
    const deps = makeDeps({
      projects: [project("main"), project("alias")],
      commonDirs: {
        [SERVER_WORKTREE]: "/repos/command-center/.git",
        "/projects/main": "/repos/command-center/.git",
        "/projects/alias": "/repos/command-center/.git",
      },
    });
    const resolver = createCommandCenterProjectResolver(deps);

    await expect(resolver.resolveProjectName()).resolves.toBeNull();
  });

  it("returns null when the server checkout is not a Git repository", async () => {
    const deps = makeDeps({
      projects: [project("command-center")],
      commonDirs: {
        [SERVER_WORKTREE]: new Error("not git"),
        "/projects/command-center": "/repos/command-center/.git",
      },
    });
    const resolver = createCommandCenterProjectResolver(deps);

    await expect(resolver.resolveProjectName()).resolves.toBeNull();
  });

  it("ignores missing retained projects during auto-detection", async () => {
    const missing = { ...project("old"), missing: true };
    const deps = makeDeps({
      projects: [missing, project("command-center")],
      commonDirs: {
        [SERVER_WORKTREE]: "/repos/command-center/.git",
        "/projects/command-center": "/repos/command-center/.git",
      },
    });
    const resolver = createCommandCenterProjectResolver(deps);

    await expect(resolver.resolveProjectName()).resolves.toBe("command-center");
    expect(deps.gitClient.git).not.toHaveBeenCalledWith(
      expect.anything(),
      "/projects/old",
    );
  });

  it("reuses a resolution for the same config object and candidate set", async () => {
    const deps = makeDeps({
      projects: [project("command-center")],
      commonDirs: {
        [SERVER_WORKTREE]: "/repos/command-center/.git",
        "/projects/command-center": "/repos/command-center/.git",
      },
    });
    const resolver = createCommandCenterProjectResolver(deps);

    await resolver.resolveProjectName();
    await resolver.resolveProjectName();

    expect(deps.discoverProjects).toHaveBeenCalledTimes(2);
    expect(deps.gitClient.git).toHaveBeenCalledTimes(2);
  });

  it("invalidates the cache when the config loader returns a new version", async () => {
    const first = config();
    const second = config();
    const deps = makeDeps({
      config: first,
      projects: [project("command-center")],
      commonDirs: {
        [SERVER_WORKTREE]: "/repos/command-center/.git",
        "/projects/command-center": "/repos/command-center/.git",
      },
    });
    vi.mocked(deps.readConfig)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const resolver = createCommandCenterProjectResolver(deps);

    await resolver.resolveProjectName();
    await resolver.resolveProjectName();

    expect(deps.gitClient.git).toHaveBeenCalledTimes(4);
  });

  it("invalidates the cache when the candidate project set changes", async () => {
    const deps = makeDeps({
      projects: [project("command-center")],
      commonDirs: {
        [SERVER_WORKTREE]: "/repos/command-center/.git",
        "/projects/command-center": "/repos/command-center/.git",
        "/projects/alias": "/repos/command-center/.git",
      },
    });
    vi.mocked(deps.discoverProjects)
      .mockResolvedValueOnce([project("command-center")])
      .mockResolvedValueOnce([project("command-center"), project("alias")]);
    const resolver = createCommandCenterProjectResolver(deps);

    await expect(resolver.resolveProjectName()).resolves.toBe("command-center");
    await expect(resolver.resolveProjectName()).resolves.toBeNull();
  });
});
