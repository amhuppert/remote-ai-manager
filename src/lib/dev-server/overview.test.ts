import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import {
  createDevServerOverview,
  type DevServerOverviewDeps,
} from "./overview";
import type { DevServerEntry } from "./registry";
import type { DevServerStatusItem } from "./service";

function entry(overrides: Partial<DevServerEntry>): DevServerEntry {
  return {
    serverName: "web",
    projectPath: "/repos/alpha",
    sessionName: "feature",
    command: "bun dev",
    status: "running",
    port: 3001,
    remoteUrl: null,
    startedAt: "2026-09-24T10:00:00.000Z",
    errorMessage: null,
    recentOutput: [],
    worktreePath: "/repos/alpha/.worktrees/feature-1a2b3c",
    ownedByThisSession: true,
    ownerPid: 10,
    logFilePath: "/tmp/web.log",
    _process: null,
    _pid: null,
    _logStream: null,
    _stdoutRemainder: "",
    _stderrRemainder: "",
    ...overrides,
  };
}

function rootItem(
  overrides: Partial<DevServerStatusItem>,
): DevServerStatusItem {
  return {
    serverName: "web",
    command: "bun dev",
    status: "stopped",
    port: null,
    localUrl: null,
    remoteUrl: null,
    startedAt: null,
    errorMessage: null,
    recentOutput: [],
    ownedByThisSession: false,
    worktreePath: null,
    ownerPid: null,
    logFilePath: null,
    ...overrides,
  };
}

function deps(
  overrides: Partial<DevServerOverviewDeps>,
): DevServerOverviewDeps {
  return {
    listProjects: async () => [],
    listProjectRootServers: async () => [],
    listRegisteredServers: () => [],
    getSessionWorktree: async () => null,
    ...overrides,
  };
}

describe("createDevServerOverview", () => {
  it("lists configured project-root servers, then the active session and lane servers", async () => {
    const overview = createDevServerOverview(
      deps({
        listProjects: async () => [{ name: "alpha", path: "/repos/alpha" }],
        listProjectRootServers: async () => [
          rootItem({ serverName: "web" }),
          rootItem({
            serverName: "docs",
            status: "running",
            port: 4000,
            localUrl: "http://localhost:4000",
          }),
        ],
        listRegisteredServers: () => [
          entry({
            sessionName: "zeta",
            worktreePath: "/repos/alpha/.worktrees/zeta-9f",
          }),
          entry({ sessionName: "feature", status: "stopped" }),
          entry({
            sessionName: "feature",
            worktreePath: "/repos/alpha/.worktrees/feature-1a2b3c.ctx-api",
            port: 3002,
          }),
          entry({
            sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
            worktreePath: "/repos/alpha",
            serverName: "docs",
          }),
        ],
        getSessionWorktree: async (_projectPath, sessionName) =>
          sessionName === "feature"
            ? "/repos/alpha/.worktrees/feature-1a2b3c"
            : "/repos/alpha/.worktrees/zeta-9f",
      }),
    );

    const { projects } = await overview.read();

    expect(projects).toHaveLength(1);
    expect(
      projects[0]?.servers.map((s) => [
        s.serverName,
        s.owner,
        s.status,
        s.worktreePath,
      ]),
    ).toEqual([
      ["web", { kind: "project" }, "stopped", "/repos/alpha"],
      ["docs", { kind: "project" }, "running", "/repos/alpha"],
      [
        "web",
        {
          kind: "workflow-lane",
          sessionName: "feature",
          worktreeName: "feature-1a2b3c.ctx-api",
        },
        "running",
        "/repos/alpha/.worktrees/feature-1a2b3c.ctx-api",
      ],
      [
        "web",
        { kind: "session", sessionName: "zeta" },
        "running",
        "/repos/alpha/.worktrees/zeta-9f",
      ],
    ]);
    expect(projects[0]?.servers[2]?.localUrl).toBe("http://localhost:3002");
  });

  it("reports an unreadable CommandCenter.json and still lists the project's running session servers", async () => {
    const invalid = z
      .object({ devServers: z.array(z.string()) })
      .safeParse({ devServers: [1] });
    const overview = createDevServerOverview(
      deps({
        listProjects: async () => [{ name: "alpha", path: "/repos/alpha" }],
        listProjectRootServers: async () => {
          if (!invalid.success) throw invalid.error;
          return [];
        },
        listRegisteredServers: () => [entry({})],
        getSessionWorktree: async () =>
          "/repos/alpha/.worktrees/feature-1a2b3c",
      }),
    );

    const { projects } = await overview.read();

    expect(projects[0]?.configError).toMatch(
      /^CommandCenter.json is invalid\./,
    );
    expect(projects[0]?.configError).toContain("devServers");
    expect(projects[0]?.servers.map((s) => s.owner)).toEqual([
      { kind: "session", sessionName: "feature" },
    ]);
  });

  it("orders projects with a starting or running server first, then by name", async () => {
    const overview = createDevServerOverview(
      deps({
        listProjects: async () => [
          { name: "alpha", path: "/repos/alpha" },
          { name: "gamma", path: "/repos/gamma" },
          { name: "beta", path: "/repos/beta" },
        ],
        listProjectRootServers: async (projectPath) =>
          projectPath === "/repos/gamma"
            ? [rootItem({ status: "starting" })]
            : [rootItem({})],
      }),
    );

    const { projects } = await overview.read();

    expect(projects.map((p) => p.projectName)).toEqual([
      "gamma",
      "alpha",
      "beta",
    ]);
  });
});
