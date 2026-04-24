import { describe, expect, it } from "vitest";

import type {
  ManagerState,
  McpConfigViewResponse,
  SessionState,
} from "@/types";

import {
  computeConfigEditHash,
  createMcpConfigMutationService,
} from "./mcp-config-mutation-service";

function mkSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionName: overrides.sessionName ?? "sess",
    worktreePath: overrides.worktreePath ?? "/projects/proj/.worktrees/sess",
    branchName: overrides.branchName ?? "cc/sess",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    lastActivityAt: overrides.lastActivityAt ?? new Date().toISOString(),
    archived: overrides.archived ?? false,
    finished: overrides.finished ?? false,
    conversations: overrides.conversations ?? [],
    ...overrides,
  } as SessionState;
}

function baseState(): ManagerState {
  return {
    projects: {
      "/projects/proj": {
        rootPath: "/projects/proj",
        sessions: {
          sess: mkSession(),
        },
        roadmapItems: [],
      },
    },
    archivedProjects: [],
    pinnedProjects: [],
  };
}

function createInMemoryStateManager(state: ManagerState) {
  return {
    async mutateState<T>(
      _label: string,
      mutate: (draft: ManagerState) => Promise<T> | T,
    ): Promise<T> {
      return await mutate(state);
    },
  };
}

describe("computeConfigEditHash", () => {
  it("changes when the resolved definition signature changes even if enabled state does not", () => {
    const baseView: McpConfigViewResponse = {
      level: "project" as const,
      servers: [
        {
          serverKey: "calc",
          displayName: "calc",
          nativeId: "calc",
          transport: "stdio" as const,
          enabled: true,
          inheritanceStatus: "explicit" as const,
          sourceRefs: [
            { scope: "project" as const, filePath: "/projects/proj/.mcp.json" },
          ],
          reserved: false,
          orphaned: false,
          pending: false,
          diagnostics: [],
          tools: { state: "not-loaded" as const, tools: [], diagnostics: [] },
        },
      ],
      diagnostics: [],
      pendingServerKeys: [],
      projectName: "proj",
      effectiveConfigHash: "",
    };

    const first = computeConfigEditHash({
      view: baseView,
      discovered: [
        {
          serverKey: "calc",
          nativeId: "calc",
          transport: "stdio",
          config: { transport: "stdio", command: "node" },
          sourceRefs: baseView.servers[0]!.sourceRefs,
          configSignature: "sig-a",
          reserved: false,
          diagnostics: [],
        },
      ],
    });
    const second = computeConfigEditHash({
      view: baseView,
      discovered: [
        {
          serverKey: "calc",
          nativeId: "calc",
          transport: "stdio",
          config: { transport: "stdio", command: "node" },
          sourceRefs: baseView.servers[0]!.sourceRefs,
          configSignature: "sig-b",
          reserved: false,
          diagnostics: [],
        },
      ],
    });

    expect(first).not.toBe(second);
  });
});

describe("createMcpConfigMutationService", () => {
  it("succeeds when expectedEffectiveConfigHash matches the current project hash", async () => {
    const state = baseState();
    const service = createMcpConfigMutationService({
      stateManager: createInMemoryStateManager(state),
      globalStore: {
        async read() {
          return { servers: {} };
        },
        async patch() {
          throw new Error("not used");
        },
        async replace() {
          throw new Error("not used");
        },
      },
      discoverAllSources: async () => ({
        servers: [
          {
            serverKey: "calc",
            nativeId: "calc",
            transport: "stdio",
            config: { transport: "stdio", command: "node" },
            sourceRefs: [
              { scope: "project", filePath: "/projects/proj/.mcp.json" },
            ],
            configSignature: "sig-calc",
            reserved: false,
            diagnostics: [],
          },
        ],
        diagnostics: [],
        sourceFiles: [],
      }),
      globalConfigPath: () => "/home/test/.config/cc/.mcp.json",
    });

    const current = await service.patchProject({
      projectName: "proj",
      projectPath: "/projects/proj",
      operations: [],
    });
    if (!current.ok) {
      throw new Error("expected current hash");
    }

    const result = await service.patchProject({
      projectName: "proj",
      projectPath: "/projects/proj",
      operations: [
        { type: "set-server-enabled", serverKey: "calc", enabled: false },
      ],
      expectedEffectiveConfigHash: current.effectiveConfigHash,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changedServerKeys).toEqual(["calc"]);
  });

  it("returns a conflict when expectedEffectiveConfigHash does not match", async () => {
    const state = baseState();
    const service = createMcpConfigMutationService({
      stateManager: createInMemoryStateManager(state),
      globalStore: {
        async read() {
          return { servers: {} };
        },
        async patch() {
          throw new Error("not used");
        },
        async replace() {
          throw new Error("not used");
        },
      },
      discoverAllSources: async () => ({
        servers: [
          {
            serverKey: "calc",
            nativeId: "calc",
            transport: "stdio",
            config: { transport: "stdio", command: "node" },
            sourceRefs: [
              { scope: "project", filePath: "/projects/proj/.mcp.json" },
            ],
            configSignature: "sig-calc",
            reserved: false,
            diagnostics: [],
          },
        ],
        diagnostics: [],
        sourceFiles: [],
      }),
      globalConfigPath: () => "/home/test/.config/cc/.mcp.json",
    });

    const result = await service.patchProject({
      projectName: "proj",
      projectPath: "/projects/proj",
      operations: [
        { type: "set-server-enabled", serverKey: "calc", enabled: false },
      ],
      expectedEffectiveConfigHash: "stale-hash",
    });

    expect(result).toEqual({ ok: false, reason: "conflict" });
  });

  it("computes the current hash while still inside the serialized mutation path", async () => {
    const state = baseState();
    const observations: Array<"start" | "discover" | "end"> = [];
    const service = createMcpConfigMutationService({
      stateManager: {
        async mutateState<T>(
          _label: string,
          mutate: (draft: ManagerState) => Promise<T> | T,
        ): Promise<T> {
          observations.push("start");
          const result = await mutate(state);
          observations.push("end");
          return result;
        },
      },
      globalStore: {
        async read() {
          return { servers: {} };
        },
        async patch() {
          throw new Error("not used");
        },
        async replace() {
          throw new Error("not used");
        },
      },
      discoverAllSources: async () => {
        observations.push("discover");
        return {
          servers: [
            {
              serverKey: "calc",
              nativeId: "calc",
              transport: "stdio",
              config: { transport: "stdio", command: "node" },
              sourceRefs: [
                { scope: "project", filePath: "/projects/proj/.mcp.json" },
              ],
              configSignature: "sig-calc",
              reserved: false,
              diagnostics: [],
            },
          ],
          diagnostics: [],
          sourceFiles: [],
        };
      },
      globalConfigPath: () => "/home/test/.config/cc/.mcp.json",
    });

    await service.patchProject({
      projectName: "proj",
      projectPath: "/projects/proj",
      operations: [
        { type: "set-server-enabled", serverKey: "calc", enabled: false },
      ],
      expectedEffectiveConfigHash: "stale-hash",
    });

    expect(observations).toEqual(["start", "discover", "end"]);
  });
});
