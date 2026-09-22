import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

import type {
  McpConfigViewResponse,
  McpOverrides,
  McpToolInventoryResult,
} from "@/lib/mcp/schemas";
import type { McpSourceDiscoveryResult } from "@/lib/mcp/types";
import { applyOperations } from "@/lib/mcp/overrides-patch";
import { resolveView } from "@/lib/mcp/resolver";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import {
  createGlobalOverrideStore,
  type GlobalOverrideStore,
} from "@/lib/mcp/global-store";
import type { ToolInventoryCache } from "@/lib/mcp/tool-discovery-cache";
import { createProjectsRepo } from "@/lib/state-store/projects-repo";
import { createSessionsRepo } from "@/lib/state-store/sessions-repo";
import { createConversationsRepo } from "@/lib/state-store/conversations-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createStateStore } from "@/lib/state-store/store";
import {
  createWriteQueue,
  withWriteQueue as moduleWriteQueue,
  _resetForTesting as resetModuleWriteQueue,
  type WriteQueue,
} from "@/lib/state-store/write-queue";

import {
  computeConfigEditHash,
  createMcpConfigMutationService,
} from "./config-mutation-service";

const PROJECT_PATH = "/projects/proj";
const SESSION_NAME = "sess";
const CONVERSATION_ID = "conv-1";
const GLOBAL_CONFIG_PATH = "/home/test/.config/cc/.mcp.json";

const CALC_DEF = {
  serverKey: "calc",
  nativeId: "calc",
  transport: "stdio" as const,
  config: { transport: "stdio" as const, command: "node" },
  sourceRefs: [
    { scope: "project" as const, filePath: `${PROJECT_PATH}/.mcp.json` },
  ],
  configSignature: "sig-calc",
  reserved: false,
  diagnostics: [],
};

function calcDiscovery(): McpSourceDiscoveryResult {
  return { servers: [CALC_DEF], diagnostics: [], sourceFiles: [] };
}

const noopGlobalStore: GlobalOverrideStore = {
  async read() {
    return { servers: {} };
  },
  async patch() {
    throw new Error("not used");
  },
  async replace() {
    throw new Error("not used");
  },
};

const GLOBAL_DEF = {
  serverKey: "gcalc",
  nativeId: "gcalc",
  transport: "stdio" as const,
  config: { transport: "stdio" as const, command: "node" },
  sourceRefs: [{ scope: "global" as const, filePath: GLOBAL_CONFIG_PATH }],
  configSignature: "sig-gcalc",
  reserved: false,
  diagnostics: [],
};

function globalDiscovery(): McpSourceDiscoveryResult {
  return { servers: [GLOBAL_DEF], diagnostics: [], sourceFiles: [] };
}

/**
 * In-memory analog of the real global override store: `patch` runs the
 * precondition on the FRESH overrides and then applies the operations —
 * exactly the read → precondition → apply → write order the scoped-config
 * store executes inside its serialized write lock. `throws` from the
 * precondition abort the patch without persisting.
 */
function inMemoryGlobalStore(
  initial: McpOverrides = { servers: {} },
): GlobalOverrideStore & { current(): McpOverrides } {
  let current: McpOverrides = initial;
  return {
    current: () => current,
    async read() {
      return current;
    },
    async patch({ operations, precondition }) {
      if (precondition) await precondition(current);
      const result = applyOperations(current, operations);
      current = result.overrides;
      return result;
    },
    async replace(next) {
      current = next;
    },
  };
}

interface Harness {
  db: InstanceType<typeof Database>;
  writeQueue: WriteQueue;
  store: ReturnType<typeof createStateStore>;
}

function createHarness(): Harness {
  const db = _createTestDb({ inMemory: true });
  const writeQueue = createWriteQueue();
  // Explicit repos so this test's seeds and the store share one cache lineage.
  const repos = {
    projects: createProjectsRepo(db),
    sessions: createSessionsRepo(db),
    conversations: createConversationsRepo(db),
  };
  const store = createStateStore({ db, writeQueue, repos });
  return { db, writeQueue, store };
}

function seedProject(h: Harness): void {
  createProjectsRepo(h.db).upsert({ rootPath: PROJECT_PATH });
}

function seedSession(h: Harness): void {
  seedProject(h);
  createSessionsRepo(h.db).upsert(
    PROJECT_PATH,
    sessionStateSchema.parse({
      sessionName: SESSION_NAME,
      worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
      branchName: `csm/${SESSION_NAME}`,
      createdAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:00Z",
    }),
  );
}

function seedConversation(h: Harness): void {
  seedSession(h);
  createConversationsRepo(h.db).upsert(
    PROJECT_PATH,
    SESSION_NAME,
    conversationStateSchema.parse({
      id: CONVERSATION_ID,
      scope: "session",
      name: null,
      transcriptPath: null,
      status: "awaiting",
      promptCount: 0,
      createdAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:00Z",
      source: "cc",
      summary: null,
      archived: false,
      totalCostUsd: null,
      totalDurationMs: null,
      totalTurns: null,
      pendingQuestionId: null,
      pendingQuestions: null,
      pendingPromptText: null,
      forkedFrom: null,
      role: "iteration",
      activeTurnSource: null,
      contextTokens: null,
      contextWindowMax: null,
      debugMode: null,
      machineSnapshot: null,
      agentBackend: "claude",
      backendRef: null,
      unread: false,
      lastSeenAlignmentVersion: null,
      pendingAgentNotices: [],
      pendingQueue: [],
    }),
  );
}

function serviceFor(
  h: Harness,
  overrides: {
    discoverAllSources?: () => Promise<McpSourceDiscoveryResult>;
    toolInventoryCache?: ToolInventoryCache;
    globalStore?: GlobalOverrideStore;
  } = {},
) {
  return createMcpConfigMutationService({
    stateManager: h.store,
    globalStore: overrides.globalStore ?? noopGlobalStore,
    discoverAllSources:
      overrides.discoverAllSources ?? (async () => calcDiscovery()),
    globalConfigPath: () => GLOBAL_CONFIG_PATH,
    ...(overrides.toolInventoryCache
      ? { toolInventoryCache: overrides.toolInventoryCache }
      : {}),
  });
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
            {
              scope: "project" as const,
              filePath: `${PROJECT_PATH}/.mcp.json`,
            },
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
      discovered: [{ ...CALC_DEF, configSignature: "sig-a" }],
    });
    const second = computeConfigEditHash({
      view: baseView,
      discovered: [{ ...CALC_DEF, configSignature: "sig-b" }],
    });

    expect(first).not.toBe(second);
  });
});

describe("createMcpConfigMutationService — project scope", () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
    seedProject(h);
  });
  afterEach(() => {
    h.db.close();
  });

  it("succeeds when expectedEffectiveConfigHash matches and persists to disk", async () => {
    const service = serviceFor(h);

    const current = await service.patchProject({
      projectName: "proj",
      projectPath: PROJECT_PATH,
      operations: [],
    });
    if (!current.ok) throw new Error("expected current hash");

    const result = await service.patchProject({
      projectName: "proj",
      projectPath: PROJECT_PATH,
      operations: [
        { type: "set-server-enabled", serverKey: "calc", enabled: false },
      ],
      expectedEffectiveConfigHash: current.effectiveConfigHash,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changedServerKeys).toEqual(["calc"]);

    // Durability: reload through a FRESH store over the same DB.
    const reloaded = createStateStore({ db: h.db });
    expect(
      (await reloaded.getProjectMcpOverrides(PROJECT_PATH))?.servers.calc
        ?.enabled,
    ).toBe(false);
  });

  it("returns a conflict when expectedEffectiveConfigHash does not match and writes nothing", async () => {
    const service = serviceFor(h);

    const result = await service.patchProject({
      projectName: "proj",
      projectPath: PROJECT_PATH,
      operations: [
        { type: "set-server-enabled", serverKey: "calc", enabled: false },
      ],
      expectedEffectiveConfigHash: "stale-hash",
    });

    expect(result).toEqual({ ok: false, reason: "conflict" });
    const reloaded = createStateStore({ db: h.db });
    expect(await reloaded.getProjectMcpOverrides(PROJECT_PATH)).toBeUndefined();
  });

  it("throws when the project does not exist", async () => {
    const service = serviceFor(h);
    await expect(
      service.patchProject({
        projectName: "missing",
        projectPath: "/missing",
        operations: [
          { type: "set-server-enabled", serverKey: "calc", enabled: false },
        ],
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("matches the hash a GET-style view computes when tool inventories are populated", async () => {
    const inventory: McpToolInventoryResult = {
      state: "ready",
      tools: [{ name: "add" }, { name: "subtract" }],
      diagnostics: [],
    };
    const cache: ToolInventoryCache = {
      peek: () => inventory,
      refresh: async () => inventory,
      getOrFetch: async () => inventory,
      markStale: () => {},
      onCompletion: () => () => {},
    };
    const service = serviceFor(h, { toolInventoryCache: cache });

    const externalView = resolveView({
      level: "project",
      overrides: { global: { servers: {} } },
      discovered: [CALC_DEF],
      discoveryDiagnostics: [],
      toolInventories: { calc: inventory },
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
      projectName: "proj",
    });
    const externalHash = computeConfigEditHash({
      view: externalView,
      discovered: [CALC_DEF],
    });

    const result = await service.patchProject({
      projectName: "proj",
      projectPath: PROJECT_PATH,
      operations: [
        { type: "set-server-enabled", serverKey: "calc", enabled: false },
      ],
      expectedEffectiveConfigHash: externalHash,
    });

    expect(result.ok).toBe(true);
  });

  it("resolves configuration BEFORE entering the write queue — the hold excludes discovery", async () => {
    const order: string[] = [];
    let releaseDiscovery: (() => void) | undefined;
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const service = serviceFor(h, {
      discoverAllSources: async () => {
        order.push("discover:start");
        await discoveryGate;
        order.push("discover:end");
        return calcDiscovery();
      },
    });

    const patchPromise = service.patchProject({
      projectName: "proj",
      projectPath: PROJECT_PATH,
      operations: [
        { type: "set-server-enabled", serverKey: "calc", enabled: false },
      ],
    });

    // While discovery is still pending, an unrelated write must be able to
    // acquire and release the same queue — proof the patch is NOT holding it.
    await h.writeQueue.withWriteQueue("unrelated", async () => {
      order.push("unrelated:commit");
    });
    releaseDiscovery?.();
    await patchPromise;

    expect(order.indexOf("unrelated:commit")).toBeLessThan(
      order.indexOf("discover:end"),
    );
  });
});

describe("createMcpConfigMutationService — session scope", () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
    seedSession(h);
  });
  afterEach(() => {
    h.db.close();
  });

  it("persists a session override through a real reload", async () => {
    const service = serviceFor(h);
    const result = await service.patchSession({
      projectName: "proj",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      operations: [
        { type: "set-server-enabled", serverKey: "calc", enabled: false },
      ],
    });
    expect(result.ok).toBe(true);

    const reloaded = createStateStore({ db: h.db });
    const session = await reloaded.getSession(PROJECT_PATH, SESSION_NAME);
    expect(session?.mcpOverrides?.servers.calc?.enabled).toBe(false);
  });

  it("returns conflict on a stale expected hash without writing", async () => {
    const service = serviceFor(h);
    const result = await service.patchSession({
      projectName: "proj",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      operations: [
        { type: "set-server-enabled", serverKey: "calc", enabled: false },
      ],
      expectedEffectiveConfigHash: "stale-hash",
    });
    expect(result).toEqual({ ok: false, reason: "conflict" });
    const reloaded = createStateStore({ db: h.db });
    const session = await reloaded.getSession(PROJECT_PATH, SESSION_NAME);
    expect(session?.mcpOverrides).toBeUndefined();
  });

  it("throws when the session does not exist", async () => {
    const service = serviceFor(h);
    await expect(
      service.patchSession({
        projectName: "proj",
        projectPath: PROJECT_PATH,
        sessionName: "missing",
        operations: [
          { type: "set-server-enabled", serverKey: "calc", enabled: false },
        ],
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("createMcpConfigMutationService — conversation scope", () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
    seedConversation(h);
  });
  afterEach(() => {
    h.db.close();
  });

  it("persists a conversation override through a real reload", async () => {
    const service = serviceFor(h);
    const result = await service.patchConversation({
      projectPath: PROJECT_PATH,
      target: sessionConversationTarget("proj", SESSION_NAME, CONVERSATION_ID),
      operations: [
        { type: "set-server-enabled", serverKey: "calc", enabled: false },
      ],
    });
    expect(result.ok).toBe(true);

    const reloaded = createStateStore({ db: h.db });
    const conversation = await reloaded.getConversation(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );
    expect(conversation?.mcpOverrides?.servers.calc?.enabled).toBe(false);
  });

  it("throws when the conversation does not exist", async () => {
    const service = serviceFor(h);
    await expect(
      service.patchConversation({
        projectPath: PROJECT_PATH,
        target: sessionConversationTarget("proj", SESSION_NAME, "missing"),
        operations: [
          { type: "set-server-enabled", serverKey: "calc", enabled: false },
        ],
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("a successful override edit is a focused column write — it does not restamp conversation or session activity", async () => {
    const service = serviceFor(h);
    const result = await service.patchConversation({
      projectPath: PROJECT_PATH,
      target: sessionConversationTarget("proj", SESSION_NAME, CONVERSATION_ID),
      operations: [
        { type: "set-server-enabled", serverKey: "calc", enabled: false },
      ],
    });
    expect(result.ok).toBe(true);

    // An override edit is a config change, not activity: the focused
    // `mcp_overrides`-only write must leave both the conversation's and the
    // owning session's `lastActivityAt` at their seeded value.
    const reloaded = createStateStore({ db: h.db });
    const conversation = await reloaded.getConversation(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );
    const session = await reloaded.getSession(PROJECT_PATH, SESSION_NAME);
    expect(conversation?.mcpOverrides?.servers.calc?.enabled).toBe(false);
    expect(conversation?.lastActivityAt).toBe("2026-01-01T00:00:00Z");
    expect(session?.lastActivityAt).toBe("2026-01-01T00:00:00Z");
  });

  it("a conflict writes no override and restamps no activity", async () => {
    const service = serviceFor(h);
    const result = await service.patchConversation({
      projectPath: PROJECT_PATH,
      target: sessionConversationTarget("proj", SESSION_NAME, CONVERSATION_ID),
      operations: [
        { type: "set-server-enabled", serverKey: "calc", enabled: false },
      ],
      expectedEffectiveConfigHash: "stale-hash",
    });
    expect(result).toEqual({ ok: false, reason: "conflict" });

    const reloaded = createStateStore({ db: h.db });
    const conversation = await reloaded.getConversation(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );
    const session = await reloaded.getSession(PROJECT_PATH, SESSION_NAME);
    expect(conversation?.mcpOverrides).toBeUndefined();
    expect(conversation?.lastActivityAt).toBe("2026-01-01T00:00:00Z");
    expect(session?.lastActivityAt).toBe("2026-01-01T00:00:00Z");
  });
});

describe("createMcpConfigMutationService — global scope", () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  it("applies the operation and returns the next effective-config hash", async () => {
    const globalStore = inMemoryGlobalStore();
    const service = serviceFor(h, {
      globalStore,
      discoverAllSources: async () => globalDiscovery(),
    });

    const result = await service.patchGlobal({
      operations: [
        { type: "set-server-enabled", serverKey: "gcalc", enabled: false },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changedServerKeys).toContain("gcalc");
      expect(result.effectiveConfigHash).not.toBe("");
    }
    // The write actually landed in the store.
    expect(globalStore.current().servers.gcalc).toBeDefined();
  });

  it("rejects a stale expectedEffectiveConfigHash without persisting", async () => {
    const globalStore = inMemoryGlobalStore();
    const service = serviceFor(h, {
      globalStore,
      discoverAllSources: async () => globalDiscovery(),
    });

    const result = await service.patchGlobal({
      operations: [
        { type: "set-server-enabled", serverKey: "gcalc", enabled: false },
      ],
      expectedEffectiveConfigHash: "stale-hash-that-does-not-match",
    });

    expect(result).toEqual({ ok: false, reason: "conflict" });
    // The conflict fence aborted the patch — nothing was written.
    expect(globalStore.current().servers.gcalc).toBeUndefined();
  });

  it("rejects a stale expectedEffectiveConfigHash through the REAL file-backed store without persisting", async () => {
    // The in-memory fake above proves the service's conflict wiring; this case
    // proves the production adapter — `createGlobalOverrideStore` forwarding the
    // precondition into the scoped file store's write lock — actually fences a
    // stale hash on the freshly-serialized on-disk state. A fake store cannot
    // catch a regression that drops the forwarding.
    const tmp = await mkdtemp(path.join(tmpdir(), "cfg-mut-global-"));
    const globalFilePath = path.join(tmp, "mcp-global.json");
    try {
      const globalStore = createGlobalOverrideStore({
        filePath: globalFilePath,
      });
      const service = serviceFor(h, {
        globalStore,
        discoverAllSources: async () => globalDiscovery(),
      });

      // Seed committed on-disk state so the precondition has fresh state to read.
      const seed = await service.patchGlobal({
        operations: [
          { type: "set-server-enabled", serverKey: "gcalc", enabled: false },
        ],
      });
      expect(seed.ok).toBe(true);
      const afterSeed = await readFile(globalFilePath, "utf-8");

      const result = await service.patchGlobal({
        operations: [
          { type: "set-server-enabled", serverKey: "gcalc", enabled: true },
        ],
        expectedEffectiveConfigHash: "stale-hash-that-does-not-match",
      });

      expect(result).toEqual({ ok: false, reason: "conflict" });
      // The fence ran inside the file store's lock and aborted the write: the
      // on-disk file is byte-identical and the stale flip never landed.
      expect(await readFile(globalFilePath, "utf-8")).toEqual(afterSeed);
      expect((await globalStore.read()).servers.gcalc).toEqual({
        enabled: false,
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("accepts a matching expectedEffectiveConfigHash (fence passes on the fresh hash)", async () => {
    const globalStore = inMemoryGlobalStore();
    const service = serviceFor(h, {
      globalStore,
      discoverAllSources: async () => globalDiscovery(),
    });

    const first = await service.patchGlobal({
      operations: [
        { type: "set-server-enabled", serverKey: "gcalc", enabled: false },
      ],
    });
    expect(first.ok).toBe(true);
    const currentHash = first.ok ? first.effectiveConfigHash : "";

    const second = await service.patchGlobal({
      operations: [
        { type: "set-server-enabled", serverKey: "gcalc", enabled: true },
      ],
      expectedEffectiveConfigHash: currentHash,
    });

    expect(second.ok).toBe(true);
  });

  it("does not hold the state-store write queue while configuration discovery runs", async () => {
    // patchGlobal reaches for the process-global write queue (the same one the
    // state store serializes all DB writes through in production); resetting it
    // here isolates the gate from any prior test.
    resetModuleWriteQueue();

    const order: string[] = [];
    let releaseDiscovery: (() => void) | undefined;
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const service = serviceFor(h, {
      globalStore: inMemoryGlobalStore(),
      discoverAllSources: async () => {
        order.push("discover:start");
        await discoveryGate;
        order.push("discover:end");
        return globalDiscovery();
      },
    });

    const patchPromise = service.patchGlobal({
      operations: [
        { type: "set-server-enabled", serverKey: "gcalc", enabled: false },
      ],
    });

    // While discovery is still pending, an unrelated write must be able to
    // acquire and release the same global queue — proof patchGlobal is NOT
    // holding it across the file I/O.
    await moduleWriteQueue("unrelated", async () => {
      order.push("unrelated:commit");
    });
    releaseDiscovery?.();
    await patchPromise;

    expect(order.indexOf("unrelated:commit")).toBeLessThan(
      order.indexOf("discover:end"),
    );
  });
});
