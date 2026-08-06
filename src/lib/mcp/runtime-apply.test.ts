import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type {
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
} from "@/lib/agent-backends/conversation";
import type { McpApplyResult } from "@/lib/agent-backends/portable-mcp";
import { createConfigReader } from "@/lib/config/loader";
import type { ManagerState } from "@/lib/projects/schemas";
import {
  createStateStore as createStateManager,
  getStateDb,
} from "@/lib/state-store";
import {
  seedWholeState,
  readWholeStateForTest,
} from "@/lib/shared/testing/whole-state-fixture";
import {
  _createTestDb,
  _installTestDb,
  _resetForTesting as _resetStateDb,
} from "@/lib/state-store/state-db";
import {
  _resetForTesting as resetMutex,
  withWriteQueue,
} from "@/lib/state-store/write-queue";

import {
  computeEffectiveConfigHash,
  createMcpRuntimeApplyService,
  type McpRuntimeApplyDeps,
  type ResolvedPortableForConversation,
} from "./runtime-apply";

// ===========================================================================
// Helpers & fixtures
// ===========================================================================

const PROJECT_PATH = "/test/project";
const SESSION_NAME = "test-session";
const CONVERSATION_ID = "conv-1";

const TEST_DIR = path.join("/tmp", "cc-mcp-runtime-apply-test-" + Date.now());

function baseConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: CONVERSATION_ID,
    scope: "session" as const,
    nameOrigin: "default" as const,
    name: null,
    transcriptPath: null,
    status: "awaiting" as const,
    promptCount: 0,
    createdAt: "2026-04-21T00:00:00.000Z",
    lastActivityAt: "2026-04-21T00:00:00.000Z",
    source: "cc" as const,
    summary: null,
    archived: false,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    forkedFrom: null,
    role: "iteration" as const,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    machineSnapshot: null,
    agentBackend: "claude" as const,
    backendRef: null,
    unread: false,
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
    profileSnapshot: null,
    profileLockedAt: null,
    pendingQueue: [],
    ...overrides,
  };
}

function stateWith(convOverrides: Record<string, unknown> = {}): ManagerState {
  return {
    projects: {
      [PROJECT_PATH]: {
        rootPath: PROJECT_PATH,
        sessions: {
          [SESSION_NAME]: {
            sessionName: SESSION_NAME,
            worktreePath: "/tmp/wt",
            branchName: "csm/test",
            createdAt: "2026-04-21T00:00:00.000Z",
            lastActivityAt: "2026-04-21T00:00:00.000Z",
            archived: false,
            finished: false,
            conversations: [baseConversation(convOverrides)],
            source: "cc",
            creationMode: "normal",
            tddEnabled: true,
            targetBranch: "main",
            parentSessionName: null,
            graphWorkflowExecution: null,
            referenceDocuments: [],
          },
        },
      },
    },
    archivedProjects: [],
    pinnedProjects: [],
  };
}

function createTestHarness() {
  const configReader = createConfigReader(TEST_DIR);
  const stateManager = createStateManager({
    readConfig: () => configReader.readConfig(),
  });
  return { stateManager };
}

function makeFakeRuntime(options: {
  backend: "claude" | "codex";
  isTurnActive?: boolean;
  applyResult?: McpApplyResult;
  applyThrows?: Error;
}): ConversationBackendRuntime & {
  applyCalls: PortableMcpConfig[];
  isTurnActive: boolean;
} {
  const applyCalls: PortableMcpConfig[] = [];
  const runtime = {
    backend: options.backend,
    status: "alive" as const,
    modelId: undefined,
    reasoningEffort: undefined,
    outputFormat: undefined,
    isTurnActive: options.isTurnActive ?? false,
    applyCalls,
    async sendTurn(
      _input: ConversationBackendTurnInput,
    ): Promise<ConversationBackendTurnResult> {
      throw new Error("sendTurn not used in these tests");
    },
    async applyPortableMcpConfig(
      config: PortableMcpConfig,
    ): Promise<McpApplyResult> {
      applyCalls.push(config);
      if (options.applyThrows) throw options.applyThrows;
      return (
        options.applyResult ?? {
          disposition:
            options.backend === "claude" && !(options.isTurnActive ?? false)
              ? "applied_now"
              : "deferred_to_next_turn",
          droppedServerIds: [],
          droppedFields: [],
          errors: {},
        }
      );
    },
    close() {},
  };
  return runtime as typeof runtime & ConversationBackendRuntime;
}

function portableWith(
  servers: Array<{
    id: string;
    enabled?: boolean;
    enabledTools?: string[];
    disabledTools?: string[];
    command?: string;
  }>,
): PortableMcpConfig {
  return {
    servers: servers.map((s) => ({
      id: s.id,
      transport: "stdio",
      command: s.command ?? "/bin/true",
      ...(s.enabled !== undefined ? { enabled: s.enabled } : {}),
      ...(s.enabledTools !== undefined ? { enabledTools: s.enabledTools } : {}),
      ...(s.disabledTools !== undefined
        ? { disabledTools: s.disabledTools }
        : {}),
    })),
  };
}

function createDeps(
  stateManager: ReturnType<typeof createStateManager>,
  runtime: ConversationBackendRuntime | undefined,
  resolved: ResolvedPortableForConversation,
): McpRuntimeApplyDeps {
  return {
    stateManager,
    getRuntime: () => runtime,
    resolvePortableForConversation: async () => resolved,
    now: () => new Date("2026-04-21T00:00:00.000Z"),
  };
}

beforeEach(async () => {
  resetMutex();
  _installTestDb(_createTestDb({ inMemory: true }));
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  _resetStateDb();
  await rm(TEST_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ===========================================================================
// Task 10.1 — computeEffectiveConfigHash
// ===========================================================================

describe("computeEffectiveConfigHash", () => {
  it("returns the same hash for identical portable configs", () => {
    const a = portableWith([{ id: "s1" }, { id: "s2", enabled: false }]);
    const b = portableWith([{ id: "s1" }, { id: "s2", enabled: false }]);
    expect(computeEffectiveConfigHash(a)).toBe(computeEffectiveConfigHash(b));
  });

  it("is insensitive to the order of servers in the array", () => {
    const a = portableWith([{ id: "s1" }, { id: "s2" }]);
    const b = portableWith([{ id: "s2" }, { id: "s1" }]);
    expect(computeEffectiveConfigHash(a)).toBe(computeEffectiveConfigHash(b));
  });

  it("is insensitive to the order of enabledTools / disabledTools", () => {
    const a = portableWith([
      {
        id: "s1",
        enabledTools: ["a", "b", "c"],
        disabledTools: ["x", "y"],
      },
    ]);
    const b = portableWith([
      {
        id: "s1",
        enabledTools: ["c", "a", "b"],
        disabledTools: ["y", "x"],
      },
    ]);
    expect(computeEffectiveConfigHash(a)).toBe(computeEffectiveConfigHash(b));
  });

  it("changes when a server is disabled", () => {
    const a = portableWith([{ id: "s1" }]);
    const b = portableWith([{ id: "s1", enabled: false }]);
    expect(computeEffectiveConfigHash(a)).not.toBe(
      computeEffectiveConfigHash(b),
    );
  });

  it("changes when a tool filter changes", () => {
    const a = portableWith([{ id: "s1", disabledTools: ["x"] }]);
    const b = portableWith([{ id: "s1", disabledTools: ["y"] }]);
    expect(computeEffectiveConfigHash(a)).not.toBe(
      computeEffectiveConfigHash(b),
    );
  });

  it("changes when a server is added (gateway/user distinction irrelevant — hash covers the full emitted set)", () => {
    const a = portableWith([{ id: "s1" }]);
    const b = portableWith([{ id: "s1" }, { id: "gateway-extra" }]);
    expect(computeEffectiveConfigHash(a)).not.toBe(
      computeEffectiveConfigHash(b),
    );
  });

  it("is not raw JSON — returns a short hex digest (not a dump of config)", () => {
    const hash = computeEffectiveConfigHash(portableWith([{ id: "s1" }]));
    expect(hash).toMatch(/^[a-f0-9]{16,}$/);
  });
});

// ===========================================================================
// Task 10.2 — applyAfterOverrideChange decision logic
// ===========================================================================

describe("applyAfterOverrideChange — no active runtime", () => {
  it("records pending state but never writes lastAppliedConfigHash", async () => {
    const { stateManager } = createTestHarness();
    seedWholeState(
      getStateDb(),
      stateWith({
        mcpRuntime: {
          lastAppliedConfigHash: "previous-applied-hash",
        },
      }),
    );

    const resolved: ResolvedPortableForConversation = {
      portable: portableWith([{ id: "s1" }]),
      effectiveConfigHash: "will-be-ignored",
    };
    const service = createMcpRuntimeApplyService(
      createDeps(stateManager, undefined, resolved),
    );

    const result = await service.applyAfterOverrideChange({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      backend: "claude",
      changedServerKeys: ["s1"],
    });

    expect(result.disposition).toBe("no_active_runtime");

    const persisted = readWholeStateForTest(getStateDb());
    const conv = persisted.projects[PROJECT_PATH]!.sessions[
      SESSION_NAME
    ]!.conversations.find((c) => c.id === CONVERSATION_ID)!;

    // lastAppliedConfigHash must be preserved exactly (not mutated)
    expect(conv.mcpRuntime?.lastAppliedConfigHash).toBe(
      "previous-applied-hash",
    );
    expect(conv.mcpRuntime?.pendingConfigHash).toBe(result.effectiveConfigHash);
    expect(conv.mcpRuntime?.pendingServerKeys).toEqual(["s1"]);
    expect(conv.mcpRuntime?.lastApplyDisposition).toBe("no_active_runtime");
  });
});

describe("applyAfterOverrideChange — Claude idle", () => {
  it("applies now via runtime but still does NOT write lastAppliedConfigHash (turn-start path is the only writer)", async () => {
    const { stateManager } = createTestHarness();
    seedWholeState(
      getStateDb(),
      stateWith({
        mcpRuntime: { lastAppliedConfigHash: "previous-applied-hash" },
      }),
    );

    const runtime = makeFakeRuntime({
      backend: "claude",
      isTurnActive: false,
    });
    const resolved: ResolvedPortableForConversation = {
      portable: portableWith([{ id: "s1" }]),
      effectiveConfigHash: "ignored",
    };
    const service = createMcpRuntimeApplyService(
      createDeps(stateManager, runtime, resolved),
    );

    const result = await service.applyAfterOverrideChange({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      backend: "claude",
      changedServerKeys: ["s1"],
    });

    expect(result.disposition).toBe("applied_now");
    expect(runtime.applyCalls).toHaveLength(1);
    expect(runtime.applyCalls[0]!.servers[0]!.id).toBe("s1");

    const persisted = readWholeStateForTest(getStateDb());
    const conv = persisted.projects[PROJECT_PATH]!.sessions[
      SESSION_NAME
    ]!.conversations.find((c) => c.id === CONVERSATION_ID)!;

    expect(conv.mcpRuntime?.lastAppliedConfigHash).toBe(
      "previous-applied-hash",
    );
    expect(conv.mcpRuntime?.pendingConfigHash).toBe(result.effectiveConfigHash);
    expect(conv.mcpRuntime?.pendingServerKeys).toEqual(["s1"]);
    expect(conv.mcpRuntime?.lastApplyDisposition).toBe("applied_now");
  });
});

describe("applyAfterOverrideChange — Claude turn running", () => {
  it("records pending state without invoking the runtime (never interrupts)", async () => {
    const { stateManager } = createTestHarness();
    seedWholeState(getStateDb(), stateWith());

    const runtime = makeFakeRuntime({
      backend: "claude",
      isTurnActive: true,
    });
    const resolved: ResolvedPortableForConversation = {
      portable: portableWith([{ id: "s1" }]),
      effectiveConfigHash: "ignored",
    };
    const service = createMcpRuntimeApplyService(
      createDeps(stateManager, runtime, resolved),
    );

    const result = await service.applyAfterOverrideChange({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      backend: "claude",
      changedServerKeys: ["s1", "s2"],
    });

    expect(result.disposition).toBe("deferred_to_next_turn");
    expect(runtime.applyCalls).toHaveLength(0);

    const persisted = readWholeStateForTest(getStateDb());
    const conv = persisted.projects[PROJECT_PATH]!.sessions[
      SESSION_NAME
    ]!.conversations.find((c) => c.id === CONVERSATION_ID)!;

    expect(conv.mcpRuntime?.pendingConfigHash).toBe(result.effectiveConfigHash);
    expect(conv.mcpRuntime?.pendingServerKeys).toEqual(["s1", "s2"]);
    expect(conv.mcpRuntime?.lastApplyDisposition).toBe("deferred_to_next_turn");
  });
});

describe("applyAfterOverrideChange — Codex (always stage)", () => {
  it("stages for next turn regardless of idle state", async () => {
    const { stateManager } = createTestHarness();
    seedWholeState(getStateDb(), stateWith({ agentBackend: "codex" }));

    const runtime = makeFakeRuntime({
      backend: "codex",
      isTurnActive: false,
    });
    const resolved: ResolvedPortableForConversation = {
      portable: portableWith([{ id: "s1" }]),
      effectiveConfigHash: "ignored",
    };
    const service = createMcpRuntimeApplyService(
      createDeps(stateManager, runtime, resolved),
    );

    const result = await service.applyAfterOverrideChange({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      backend: "codex",
      changedServerKeys: ["s1"],
    });

    expect(result.disposition).toBe("deferred_to_next_turn");
    // Codex applyPortableMcpConfig is the staging path — we DO call it so the
    // runtime holds the latest portable for its next turn reconstruction.
    expect(runtime.applyCalls).toHaveLength(1);

    const persisted = readWholeStateForTest(getStateDb());
    const conv = persisted.projects[PROJECT_PATH]!.sessions[
      SESSION_NAME
    ]!.conversations.find((c) => c.id === CONVERSATION_ID)!;
    expect(conv.mcpRuntime?.lastApplyDisposition).toBe("deferred_to_next_turn");
    expect(conv.mcpRuntime?.pendingConfigHash).toBe(result.effectiveConfigHash);
  });
});

describe("applyAfterOverrideChange — ordering fence for concurrent overrides", () => {
  it("rejects a missing conversation before invoking the resolver", async () => {
    const { stateManager } = createTestHarness();
    seedWholeState(getStateDb(), stateWith());

    let resolverCalls = 0;
    const deps: McpRuntimeApplyDeps = {
      stateManager,
      getRuntime: () => undefined,
      resolvePortableForConversation: async () => {
        resolverCalls += 1;
        return {
          portable: portableWith([{ id: "s1" }]),
          effectiveConfigHash: "ignored",
        };
      },
      now: () => new Date("2026-04-21T00:00:00.000Z"),
    };
    const service = createMcpRuntimeApplyService(deps);

    await expect(
      service.applyAfterOverrideChange({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: "conv-does-not-exist",
        backend: "claude",
        changedServerKeys: ["s1"],
      }),
    ).rejects.toThrow(/not found/);

    // The focused existence pre-read runs BEFORE any resolver I/O (mirroring
    // applyAtTurnStart), so a missing conversation never touches the resolver.
    expect(resolverCalls).toBe(0);
  });

  it("serializes concurrent applies for one conversation: no stale resolve overlaps a newer one and the last-submitted wins", async () => {
    const { stateManager } = createTestHarness();
    seedWholeState(getStateDb(), stateWith());

    const portableA = portableWith([{ id: "sA" }]);
    const portableB = portableWith([{ id: "sB" }]);
    const hashB = computeEffectiveConfigHash(portableB);

    let releaseA: (() => void) | undefined;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    let call = 0;
    const runtime = makeFakeRuntime({ backend: "claude", isTurnActive: false });
    const deps: McpRuntimeApplyDeps = {
      stateManager,
      getRuntime: () => runtime,
      resolvePortableForConversation: async () => {
        call += 1;
        if (call === 1) {
          // Request A — submitted first — resolves slowly (held on the gate).
          await gateA;
          return { portable: portableA, effectiveConfigHash: "ignored" };
        }
        // Request B — submitted second — would resolve immediately, but the
        // per-conversation serializer holds it behind A.
        return { portable: portableB, effectiveConfigHash: "ignored" };
      },
      now: () => new Date("2026-04-21T00:00:00.000Z"),
    };
    // A and B share ONE service instance so they share its per-conversation chain.
    const service = createMcpRuntimeApplyService(deps);

    const aPromise = service.applyAfterOverrideChange({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      backend: "claude",
      changedServerKeys: ["sA"],
    });
    const bPromise = service.applyAfterOverrideChange({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      backend: "claude",
      changedServerKeys: ["sB"],
    });

    // While A is gated mid-resolve, B must not have STARTED resolving and the
    // runtime must not have been touched — the serializer prevents any overlap
    // in which a stale resolve could race a newer one.
    await new Promise((r) => setTimeout(r, 10));
    expect(call).toBe(1);
    expect(runtime.applyCalls).toHaveLength(0);

    // Release A: it applies fully, THEN B applies. Strict submission order.
    releaseA?.();
    await aPromise;
    await bPromise;

    expect(runtime.applyCalls.map((c) => c.servers[0]!.id)).toEqual([
      "sA",
      "sB",
    ]);

    const persisted = readWholeStateForTest(getStateDb());
    const conv = persisted.projects[PROJECT_PATH]!.sessions[
      SESSION_NAME
    ]!.conversations.find((c) => c.id === CONVERSATION_ID)!;
    // The last-submitted apply (B) wins the durable pending state.
    expect(conv.mcpRuntime?.pendingConfigHash).toBe(hashB);
    expect(conv.mcpRuntime?.pendingServerKeys).toEqual(["sB"]);
  });

  it("serializes applyAtTurnStart behind an in-flight applyAfterOverrideChange for the same conversation", async () => {
    const { stateManager } = createTestHarness();
    seedWholeState(getStateDb(), stateWith());

    let releaseOverride: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      releaseOverride = r;
    });
    let call = 0;
    const order: string[] = [];
    const runtime = makeFakeRuntime({ backend: "claude", isTurnActive: false });
    const deps: McpRuntimeApplyDeps = {
      stateManager,
      getRuntime: () => runtime,
      resolvePortableForConversation: async () => {
        call += 1;
        if (call === 1) {
          order.push("override:resolve");
          await gate;
          return {
            portable: portableWith([{ id: "sA" }]),
            effectiveConfigHash: "ignored",
          };
        }
        order.push("turnstart:resolve");
        return {
          portable: portableWith([{ id: "sB" }]),
          effectiveConfigHash: "ignored",
        };
      },
      now: () => new Date("2026-04-21T00:00:00.000Z"),
    };
    const service = createMcpRuntimeApplyService(deps);

    const overridePromise = service.applyAfterOverrideChange({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      backend: "claude",
      changedServerKeys: ["sA"],
    });
    const turnStartPromise = service.applyAtTurnStart({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      backend: "claude",
    });

    // Turn start shares the same per-conversation chain, so its resolve must NOT
    // run until the in-flight override apply finishes (the validator's
    // "applyAtTurnStart bypasses the fence" regression).
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["override:resolve"]);

    releaseOverride?.();
    await overridePromise;
    await turnStartPromise;

    expect(order).toEqual(["override:resolve", "turnstart:resolve"]);
  });
});

describe("applyAfterOverrideChange — resolves before entering the write queue", () => {
  it("resolves configuration outside the state lock so the pending-field write is a short section", async () => {
    const { stateManager } = createTestHarness();
    seedWholeState(getStateDb(), stateWith());

    const observations: Array<"start" | "resolve" | "write" | "end"> = [];
    const resolved: ResolvedPortableForConversation = {
      portable: portableWith([{ id: "s1" }]),
      effectiveConfigHash: "ignored",
    };
    const deps: McpRuntimeApplyDeps = {
      stateManager,
      getRuntime: () => undefined,
      async resolvePortableForConversation() {
        observations.push("resolve");
        // Simulate async file I/O — this must complete BEFORE the mutator opens
        // its critical section (no-slow-work-in-critical-section).
        await new Promise((r) => setTimeout(r, 5));
        return resolved;
      },
      now: () => new Date("2026-04-21T00:00:00.000Z"),
    };

    // Wrap the mutator boundary to observe ordering.
    const original = stateManager.mutateConversation.bind(stateManager);
    stateManager.mutateConversation = (async (...args: unknown[]) => {
      observations.push("start");
      // @ts-expect-error spread into original signature
      const result = await original(...args);
      observations.push("end");
      return result;
    }) as typeof stateManager.mutateConversation;

    const service = createMcpRuntimeApplyService(deps);
    await service.applyAfterOverrideChange({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      backend: "claude",
      changedServerKeys: ["s1"],
    });

    // Resolution completes entirely before the pending-field write opens its
    // critical section — the mutator no longer wraps the file I/O.
    expect(observations).toEqual(["resolve", "start", "end"]);
  });

  it("does not hold the write queue while configuration resolution runs", async () => {
    const { stateManager } = createTestHarness();
    seedWholeState(getStateDb(), stateWith());

    const order: string[] = [];
    let releaseResolve: (() => void) | undefined;
    const resolveGate = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const runtime = makeFakeRuntime({ backend: "claude" });
    const portable = portableWith([{ id: "s1" }]);
    const deps: McpRuntimeApplyDeps = {
      stateManager,
      getRuntime: () => runtime,
      resolvePortableForConversation: async () => {
        order.push("resolve:start");
        await resolveGate;
        order.push("resolve:end");
        return { portable, effectiveConfigHash: "ignored" };
      },
      now: () => new Date("2026-04-21T00:00:00.000Z"),
    };
    const service = createMcpRuntimeApplyService(deps);

    const applyPromise = service.applyAfterOverrideChange({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      backend: "claude",
      changedServerKeys: ["s1"],
    });

    // Resolution is in flight and gated. An unrelated write must be able to
    // acquire and release the SAME queue right now — proof the resolve runs
    // entirely outside the write queue.
    await withWriteQueue("unrelated", async () => {
      order.push("unrelated:commit");
    });
    releaseResolve?.();
    await applyPromise;

    expect(order.indexOf("unrelated:commit")).toBeLessThan(
      order.indexOf("resolve:end"),
    );
    // Sanity: it still applied once resolution completed.
    expect(runtime.applyCalls).toHaveLength(1);
  });
});

// ===========================================================================
// Task 10.2 — applyAtTurnStart
// ===========================================================================

describe("applyAtTurnStart — resolves before entering the write queue", () => {
  it("does not hold the write queue while configuration resolution runs (Design 3.4, criterion 5)", async () => {
    const { stateManager } = createTestHarness();
    seedWholeState(getStateDb(), stateWith());

    const order: string[] = [];
    let releaseResolve: (() => void) | undefined;
    const resolveGate = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const runtime = makeFakeRuntime({ backend: "claude" });
    const portable = portableWith([{ id: "s1" }]);
    const deps: McpRuntimeApplyDeps = {
      stateManager,
      getRuntime: () => runtime,
      resolvePortableForConversation: async () => {
        order.push("resolve:start");
        await resolveGate;
        order.push("resolve:end");
        return { portable, effectiveConfigHash: "ignored" };
      },
      now: () => new Date("2026-04-21T00:00:00.000Z"),
    };
    const service = createMcpRuntimeApplyService(deps);

    const applyPromise = service.applyAtTurnStart({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      backend: "claude",
    });

    // Resolution is in flight and gated. An unrelated write must be able to
    // acquire and release the SAME queue right now — proof the resolve runs
    // entirely outside the write queue.
    await withWriteQueue("unrelated", async () => {
      order.push("unrelated:commit");
    });
    releaseResolve?.();
    await applyPromise;

    expect(order.indexOf("unrelated:commit")).toBeLessThan(
      order.indexOf("resolve:end"),
    );
    // Sanity: it still applied once resolution completed.
    expect(runtime.applyCalls).toHaveLength(1);
  });
});

describe("applyAtTurnStart — no-op when hash already applied", () => {
  it("does not call the runtime when the computed hash equals lastAppliedConfigHash", async () => {
    const { stateManager } = createTestHarness();

    const portable = portableWith([{ id: "s1" }]);
    const hash = computeEffectiveConfigHash(portable);
    seedWholeState(
      getStateDb(),
      stateWith({
        mcpRuntime: {
          lastAppliedConfigHash: hash,
        },
      }),
    );

    const runtime = makeFakeRuntime({ backend: "claude" });
    const service = createMcpRuntimeApplyService(
      createDeps(stateManager, runtime, {
        portable,
        effectiveConfigHash: "ignored",
      }),
    );

    const result = await service.applyAtTurnStart({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      backend: "claude",
    });

    expect(result.disposition).toBe("applied_now");
    expect(result.effectiveConfigHash).toBe(hash);
    expect(runtime.applyCalls).toHaveLength(0);
  });

  it("leaves pending state untouched when a matching applied hash was seeded before the turn", async () => {
    const { stateManager } = createTestHarness();

    const portable = portableWith([{ id: "s1" }]);
    const hash = computeEffectiveConfigHash(portable);
    seedWholeState(
      getStateDb(),
      stateWith({
        mcpRuntime: {
          lastAppliedConfigHash: hash,
          pendingConfigHash: "newer-pending-hash",
          pendingServerKeys: ["s2"],
          lastApplyDisposition: "deferred_to_next_turn",
        },
      }),
    );

    const runtime = makeFakeRuntime({ backend: "claude" });
    const service = createMcpRuntimeApplyService(
      createDeps(stateManager, runtime, {
        portable,
        effectiveConfigHash: "ignored",
      }),
    );

    await service.applyAtTurnStart({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      backend: "claude",
    });

    const persisted = readWholeStateForTest(getStateDb());
    const conv = persisted.projects[PROJECT_PATH]!.sessions[
      SESSION_NAME
    ]!.conversations.find((c) => c.id === CONVERSATION_ID)!;

    expect(runtime.applyCalls).toHaveLength(0);
    expect(conv.mcpRuntime?.lastAppliedConfigHash).toBe(hash);
    expect(conv.mcpRuntime?.pendingConfigHash).toBe("newer-pending-hash");
    expect(conv.mcpRuntime?.pendingServerKeys).toEqual(["s2"]);
  });
});

describe("applyAtTurnStart — applies and writes lastAppliedConfigHash on success", () => {
  it("writes lastAppliedConfigHash and clears pending when the applied hash equals pendingConfigHash", async () => {
    const { stateManager } = createTestHarness();
    const portable = portableWith([{ id: "s1" }]);
    const hash = computeEffectiveConfigHash(portable);
    seedWholeState(
      getStateDb(),
      stateWith({
        mcpRuntime: {
          lastAppliedConfigHash: "old-applied",
          pendingConfigHash: hash,
          pendingServerKeys: ["s1"],
          lastApplyDisposition: "deferred_to_next_turn",
        },
      }),
    );

    const runtime = makeFakeRuntime({
      backend: "claude",
      applyResult: {
        disposition: "applied_now",
        droppedServerIds: [],
        droppedFields: [],
        errors: {},
      },
    });
    const service = createMcpRuntimeApplyService(
      createDeps(stateManager, runtime, {
        portable,
        effectiveConfigHash: "ignored",
      }),
    );

    const result = await service.applyAtTurnStart({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      backend: "claude",
    });

    expect(result.disposition).toBe("applied_now");
    expect(result.effectiveConfigHash).toBe(hash);
    expect(runtime.applyCalls).toHaveLength(1);

    const persisted = readWholeStateForTest(getStateDb());
    const conv = persisted.projects[PROJECT_PATH]!.sessions[
      SESSION_NAME
    ]!.conversations.find((c) => c.id === CONVERSATION_ID)!;

    expect(conv.mcpRuntime?.lastAppliedConfigHash).toBe(hash);
    // Pending cleared because applied hash equals pending hash
    expect(conv.mcpRuntime?.pendingConfigHash).toBeUndefined();
    expect(conv.mcpRuntime?.pendingServerKeys).toBeUndefined();
    expect(conv.mcpRuntime?.lastApplyDisposition).toBe("applied_now");
    expect(conv.mcpRuntime?.lastApplyError).toBeUndefined();
  });

  it("does NOT clear pending when the applied hash differs from the stored pendingConfigHash (race: newer PATCH arrived)", async () => {
    const { stateManager } = createTestHarness();
    const portable = portableWith([{ id: "s1" }]);
    const hash = computeEffectiveConfigHash(portable);
    seedWholeState(
      getStateDb(),
      stateWith({
        mcpRuntime: {
          pendingConfigHash: "newer-pending-hash",
          pendingServerKeys: ["s2"],
          lastApplyDisposition: "deferred_to_next_turn",
        },
      }),
    );

    const runtime = makeFakeRuntime({ backend: "claude" });
    const service = createMcpRuntimeApplyService(
      createDeps(stateManager, runtime, {
        portable,
        effectiveConfigHash: "ignored",
      }),
    );

    await service.applyAtTurnStart({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      backend: "claude",
    });

    const persisted = readWholeStateForTest(getStateDb());
    const conv = persisted.projects[PROJECT_PATH]!.sessions[
      SESSION_NAME
    ]!.conversations.find((c) => c.id === CONVERSATION_ID)!;

    // lastAppliedConfigHash reflects what was actually applied
    expect(conv.mcpRuntime?.lastAppliedConfigHash).toBe(hash);
    // But the newer pending survives for a future turn
    expect(conv.mcpRuntime?.pendingConfigHash).toBe("newer-pending-hash");
    expect(conv.mcpRuntime?.pendingServerKeys).toEqual(["s2"]);
  });
});

// ===========================================================================
// Task 10.3 — failure handling
// ===========================================================================

describe("applyAtTurnStart — apply failure preserves lastAppliedConfigHash", () => {
  it("keeps the previous applied hash and stores a sanitized error on apply throw", async () => {
    const { stateManager } = createTestHarness();
    const portable = portableWith([{ id: "s1" }]);
    const newHash = computeEffectiveConfigHash(portable);
    seedWholeState(
      getStateDb(),
      stateWith({
        mcpRuntime: {
          lastAppliedConfigHash: "previous-applied-hash",
        },
      }),
    );

    const runtime = makeFakeRuntime({
      backend: "claude",
      applyThrows: new Error("TOKEN=shhh/apply broke"),
    });
    const service = createMcpRuntimeApplyService(
      createDeps(stateManager, runtime, {
        portable,
        effectiveConfigHash: "ignored",
      }),
    );

    const result = await service.applyAtTurnStart({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      backend: "claude",
    });

    expect(result.disposition).toBe("rejected");
    expect(result.effectiveConfigHash).toBe(newHash);
    expect(result.error).toBeDefined();
    expect(result.error).not.toContain("shhh");
    expect(result.error).not.toContain("TOKEN=");

    const persisted = readWholeStateForTest(getStateDb());
    const conv = persisted.projects[PROJECT_PATH]!.sessions[
      SESSION_NAME
    ]!.conversations.find((c) => c.id === CONVERSATION_ID)!;

    expect(conv.mcpRuntime?.lastAppliedConfigHash).toBe(
      "previous-applied-hash",
    );
    expect(conv.mcpRuntime?.lastApplyDisposition).toBe("rejected");
    expect(conv.mcpRuntime?.lastApplyError).toBeDefined();
    expect(conv.mcpRuntime?.lastApplyError).not.toContain("shhh");
  });

  it("treats a 'rejected' disposition from the runtime the same as a throw", async () => {
    const { stateManager } = createTestHarness();
    const portable = portableWith([{ id: "s1" }]);
    seedWholeState(
      getStateDb(),
      stateWith({
        mcpRuntime: { lastAppliedConfigHash: "previous-applied-hash" },
      }),
    );

    const runtime = makeFakeRuntime({
      backend: "claude",
      applyResult: {
        disposition: "rejected",
        droppedServerIds: ["s1"],
        droppedFields: [],
        errors: { s1: "server unreachable" },
      },
    });
    const service = createMcpRuntimeApplyService(
      createDeps(stateManager, runtime, {
        portable,
        effectiveConfigHash: "ignored",
      }),
    );

    const result = await service.applyAtTurnStart({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      backend: "claude",
    });

    expect(result.disposition).toBe("rejected");

    const persisted = readWholeStateForTest(getStateDb());
    const conv = persisted.projects[PROJECT_PATH]!.sessions[
      SESSION_NAME
    ]!.conversations.find((c) => c.id === CONVERSATION_ID)!;

    expect(conv.mcpRuntime?.lastAppliedConfigHash).toBe(
      "previous-applied-hash",
    );
    expect(conv.mcpRuntime?.lastApplyDisposition).toBe("rejected");
  });
});

describe("applyAfterOverrideChange — apply failure preserves lastAppliedConfigHash", () => {
  it("runtime throw in the after-override-change path preserves lastAppliedConfigHash and surfaces a sanitized error", async () => {
    const { stateManager } = createTestHarness();
    seedWholeState(
      getStateDb(),
      stateWith({
        mcpRuntime: { lastAppliedConfigHash: "previous-applied-hash" },
      }),
    );

    const runtime = makeFakeRuntime({
      backend: "claude",
      isTurnActive: false,
      applyThrows: new Error("Bearer abc123 failed"),
    });
    const service = createMcpRuntimeApplyService(
      createDeps(stateManager, runtime, {
        portable: portableWith([{ id: "s1" }]),
        effectiveConfigHash: "ignored",
      }),
    );

    const result = await service.applyAfterOverrideChange({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      backend: "claude",
      changedServerKeys: ["s1"],
    });

    expect(result.disposition).toBe("rejected");
    expect(result.error).toBeDefined();
    expect(result.error).not.toContain("abc123");
    expect(result.error).not.toContain("Bearer");

    const persisted = readWholeStateForTest(getStateDb());
    const conv = persisted.projects[PROJECT_PATH]!.sessions[
      SESSION_NAME
    ]!.conversations.find((c) => c.id === CONVERSATION_ID)!;

    // After-override-change path NEVER writes lastAppliedConfigHash
    expect(conv.mcpRuntime?.lastAppliedConfigHash).toBe(
      "previous-applied-hash",
    );
    expect(conv.mcpRuntime?.lastApplyDisposition).toBe("rejected");
    expect(conv.mcpRuntime?.lastApplyError).toBeDefined();
    expect(conv.mcpRuntime?.lastApplyError).not.toContain("abc123");
  });
});
