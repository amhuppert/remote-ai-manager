/**
 * Unit tests for the four v1 help-context providers (docs/design/cc-cli/04 §4.3).
 *
 * Each provider is pure given its injected deps, so these tests pass plain fakes
 * (no `vi.mock` of internal modules) and assert the returned blocks. Every
 * provider covers has-data, no-data ([]), and dependency-throw (propagated so the
 * service logs + omits — see service.test.ts) per engineering-principles.
 */
import { describe, expect, it } from "vitest";

import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type { DevServerStatusItem } from "@/lib/dev-server/service";

import {
  createConversationProvider,
  createDevProvider,
  createFixtureProvider,
  createWorkflowProvider,
  type ConversationArtifactSummary,
  type HelpContextRequest,
} from "./providers";

function devServer(
  overrides: Partial<DevServerStatusItem> = {},
): DevServerStatusItem {
  return {
    serverName: "web",
    command: "bun run dev",
    status: "running",
    port: 3000,
    localUrl: "http://localhost:3000",
    remoteUrl: null,
    startedAt: null,
    errorMessage: null,
    recentOutput: [],
    ownedByThisSession: true,
    worktreePath: null,
    ownerPid: null,
    logFilePath: null,
    ...overrides,
  };
}

const BASE: HelpContextRequest = {
  command: ["dev", "list"],
  project: "repo",
  session: "sess",
};

describe("dev provider", () => {
  const listWith = (servers: DevServerStatusItem[]) => async () => servers;

  it("lists configured servers with status and URLs", async () => {
    const provider = createDevProvider({
      resolveProjectPath: async () => "/p",
      listDevServers: listWith([
        devServer(),
        devServer({
          serverName: "storybook",
          status: "stopped",
          port: null,
          localUrl: null,
          remoteUrl: "https://sb.ts.net",
        }),
      ]),
    });

    const blocks = await provider.provide(BASE);

    expect(blocks).toEqual([
      {
        title: "dev servers",
        body:
          "web — running — http://localhost:3000\n" +
          "storybook — stopped — no local URL · remote https://sb.ts.net",
      },
    ]);
  });

  it("returns [] when the project configures no dev servers", async () => {
    const provider = createDevProvider({
      resolveProjectPath: async () => "/p",
      listDevServers: listWith([]),
    });
    expect(await provider.provide(BASE)).toEqual([]);
  });

  it("returns [] without a project/session identity", async () => {
    const provider = createDevProvider({
      resolveProjectPath: async () => "/p",
      listDevServers: listWith([devServer()]),
    });
    expect(await provider.provide({ command: ["dev"] })).toEqual([]);
  });

  it("returns [] when the project cannot be resolved", async () => {
    const provider = createDevProvider({
      resolveProjectPath: async () => null,
      listDevServers: listWith([devServer()]),
    });
    expect(await provider.provide(BASE)).toEqual([]);
  });

  it("propagates a dependency failure so the service logs + omits it", async () => {
    const provider = createDevProvider({
      resolveProjectPath: async () => "/p",
      listDevServers: async () => {
        throw new Error("registry down");
      },
    });
    await expect(provider.provide(BASE)).rejects.toThrow("registry down");
  });
});

describe("fixture provider", () => {
  it("points at the running server's URL", async () => {
    const provider = createFixtureProvider({
      resolveProjectPath: async () => "/p",
      listDevServers: async () => [devServer({ status: "running" })],
    });
    expect(await provider.provide(BASE)).toEqual([
      {
        title: "fixture dev server",
        body: "web is running at http://localhost:3000 — fixtures can drive it",
      },
    ]);
  });

  it("suggests dev ensure when configured but not running", async () => {
    const provider = createFixtureProvider({
      resolveProjectPath: async () => "/p",
      listDevServers: async () => [devServer({ status: "stopped" })],
    });
    expect(await provider.provide(BASE)).toEqual([
      {
        title: "fixture dev server",
        body: "no dev server is running — run 'cctl dev ensure' before driving fixtures",
      },
    ]);
  });

  it("returns [] when no dev servers are configured", async () => {
    const provider = createFixtureProvider({
      resolveProjectPath: async () => "/p",
      listDevServers: async () => [],
    });
    expect(await provider.provide(BASE)).toEqual([]);
  });

  it("propagates a dependency failure", async () => {
    const provider = createFixtureProvider({
      resolveProjectPath: async () => "/p",
      listDevServers: async () => {
        throw new Error("boom");
      },
    });
    await expect(provider.provide(BASE)).rejects.toThrow("boom");
  });
});

describe("workflow provider", () => {
  const laneRequest: HelpContextRequest = {
    command: ["workflow", "task", "complete"],
    project: "repo",
    session: "sess",
    executionId: "execution-1",
    contextId: "context-implement",
  };

  it("summarizes lane identity, tasks, and the iteration budget", async () => {
    const execution = createWorkflowExecution();
    execution.taskStates["task-implement-1"]!.status = "running";
    execution.contextStates["context-implement"]!.iterationCount = 2;
    execution.contextStates["context-implement"]!.totalTaskCount = 3;
    execution.contextStates["context-implement"]!.completedTaskCount = 1;

    const provider = createWorkflowProvider({
      resolveProjectPath: async () => "/p",
      getActiveGraphWorkflowExecution: async () => execution,
    });

    expect(await provider.provide(laneRequest)).toEqual([
      {
        title: "workflow lane",
        body: [
          "lane: Implement",
          "current task: Write code",
          "remaining tasks: 2",
          "iterations: 2 of 3 before the circuit breaker halts",
          "lane-only verbs: cctl workflow task complete/add, shared-doc upsert, collab request",
        ].join("\n"),
      },
    ]);
  });

  it("reports 'none in progress' when no task is running", async () => {
    const execution = createWorkflowExecution();
    const provider = createWorkflowProvider({
      resolveProjectPath: async () => "/p",
      getActiveGraphWorkflowExecution: async () => execution,
    });
    const [block] = await provider.provide(laneRequest);
    expect(block?.body).toContain("current task: none in progress");
  });

  it("returns [] outside a lane (executionId/contextId absent)", async () => {
    const provider = createWorkflowProvider({
      resolveProjectPath: async () => "/p",
      getActiveGraphWorkflowExecution: async () => createWorkflowExecution(),
    });
    expect(
      await provider.provide({
        command: ["workflow", "create"],
        project: "repo",
        session: "sess",
      }),
    ).toEqual([]);
  });

  it("returns [] when the active execution id does not match the lane", async () => {
    const execution = createWorkflowExecution({ id: "other-execution" });
    const provider = createWorkflowProvider({
      resolveProjectPath: async () => "/p",
      getActiveGraphWorkflowExecution: async () => execution,
    });
    expect(await provider.provide(laneRequest)).toEqual([]);
  });

  it("returns [] when there is no active execution", async () => {
    const provider = createWorkflowProvider({
      resolveProjectPath: async () => "/p",
      getActiveGraphWorkflowExecution: async () => null,
    });
    expect(await provider.provide(laneRequest)).toEqual([]);
  });

  it("propagates a dependency failure", async () => {
    const provider = createWorkflowProvider({
      resolveProjectPath: async () => "/p",
      getActiveGraphWorkflowExecution: async () => {
        throw new Error("state read failed");
      },
    });
    await expect(provider.provide(laneRequest)).rejects.toThrow(
      "state read failed",
    );
  });
});

describe("conversation provider", () => {
  const convoRequest: HelpContextRequest = {
    command: ["conversation", "read"],
    project: "repo",
    session: "sess",
    conversation: "conv-1",
  };

  function summary(
    overrides: Partial<ConversationArtifactSummary> = {},
  ): ConversationArtifactSummary {
    return {
      kind: "conversation_compaction",
      stale: false,
      outdated: false,
      ...overrides,
    };
  }

  it("reports existing artifacts and flags stale ones", async () => {
    const provider = createConversationProvider({
      resolveConversationArtifacts: async () => [
        summary(),
        summary({ stale: true }),
      ],
    });
    expect(await provider.provide(convoRequest)).toEqual([
      {
        title: "conversation",
        body:
          "conversation: conv-1\n" +
          "2 compaction artifact(s), 1 stale — refresh with 'cctl conversation compact'",
      },
    ]);
  });

  it("reports all-fresh when no artifact is stale or outdated", async () => {
    const provider = createConversationProvider({
      resolveConversationArtifacts: async () => [summary()],
    });
    const [block] = await provider.provide(convoRequest);
    expect(block?.body).toContain("1 compaction artifact(s), all fresh");
  });

  it("notes that none exist yet when there are no artifacts", async () => {
    const provider = createConversationProvider({
      resolveConversationArtifacts: async () => [],
    });
    const [block] = await provider.provide(convoRequest);
    expect(block?.body).toContain("no compaction artifacts yet");
  });

  it("returns [] without a conversation param", async () => {
    const provider = createConversationProvider({
      resolveConversationArtifacts: async () => [summary()],
    });
    expect(
      await provider.provide({ command: ["conversation", "read"] }),
    ).toEqual([]);
  });

  it("propagates a dependency failure", async () => {
    const provider = createConversationProvider({
      resolveConversationArtifacts: async () => {
        throw new Error("repo error");
      },
    });
    await expect(provider.provide(convoRequest)).rejects.toThrow("repo error");
  });
});
