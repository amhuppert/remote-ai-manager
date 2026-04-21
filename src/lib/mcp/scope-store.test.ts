import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConfigReader } from "@/lib/config";
import type { ManagerState } from "@/lib/schemas";
import { createStateManager } from "@/lib/state";
import { _resetForTesting as resetMutex } from "@/lib/state-mutex";

import { createScopeOverrideStore } from "./scope-store";

const PROJECT_PATH = "/test/project";
const SESSION_NAME = "test-session";
const CONVERSATION_ID = "conv-1";

const TEST_DIR = path.join("/tmp", "cc-mcp-scope-test-" + Date.now());

function createTestHarness() {
  const configReader = createConfigReader(TEST_DIR);
  const state = createStateManager({
    readConfig: () => configReader.readConfig(),
  });
  const store = createScopeOverrideStore({ stateManager: state });
  return { state, store };
}

function stateWithAllScopes(): ManagerState {
  return {
    projects: {
      [PROJECT_PATH]: {
        rootPath: PROJECT_PATH,
        roadmapItems: [],
        sessions: {
          [SESSION_NAME]: {
            sessionName: SESSION_NAME,
            worktreePath: "/tmp/wt",
            branchName: "csm/test",
            createdAt: "2026-04-21T00:00:00.000Z",
            lastActivityAt: "2026-04-21T00:00:00.000Z",
            archived: false,
            finished: false,
            conversations: [
              {
                id: CONVERSATION_ID,
                name: null,
                transcriptPath: null,
                status: "awaiting",
                promptCount: 0,
                createdAt: "2026-04-21T00:00:00.000Z",
                lastActivityAt: "2026-04-21T00:00:00.000Z",
                source: "cc",
                summary: null,
                archived: false,
                totalCostUsd: null,
                totalDurationMs: null,
                totalTurns: null,
                pendingQuestionId: null,
                pendingQuestions: null,
                forkedFrom: null,
                role: "iteration",
                contextTokens: null,
                contextWindowMax: null,
                debugMode: null,
                machineSnapshot: null,
                agentBackend: "claude",
                backendRef: null,
              },
            ],
            source: "cc",
            objective: null,
            creationMode: "fast",
            tddEnabled: true,
            targetBranch: "main",
            parentSessionName: null,
            graphWorkflowExecution: null,
            graphWorkflowExecutionHistory: [],
            referenceDocuments: [],
          },
        },
      },
    },
    archivedProjects: [],
    pinnedProjects: [],
  };
}

beforeEach(async () => {
  resetMutex();
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ===========================================================================
// Project scope
// ===========================================================================

describe("scope-store / project", () => {
  it("patches project mcpOverrides and returns changed server keys", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    const result = await store.patchProject(PROJECT_PATH, [
      { type: "set-server-enabled", serverKey: "kagi", enabled: false },
    ]);

    expect(result.changedServerKeys).toEqual(["kagi"]);
    expect(result.overrides.servers.kagi?.enabled).toBe(false);

    const persisted = await state.readState();
    expect(
      persisted.projects[PROJECT_PATH]?.mcpOverrides?.servers.kagi?.enabled,
    ).toBe(false);
  });

  it("stores only diffs; omits servers without overrides", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    await store.patchProject(PROJECT_PATH, [
      { type: "set-server-enabled", serverKey: "a", enabled: false },
    ]);

    const persisted = await state.readState();
    const keys = Object.keys(
      persisted.projects[PROJECT_PATH]?.mcpOverrides?.servers ?? {},
    );
    expect(keys).toEqual(["a"]);
  });

  it("removes the server record after reset-server (pruning empty records)", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    await store.patchProject(PROJECT_PATH, [
      { type: "set-server-enabled", serverKey: "a", enabled: false },
    ]);
    const result = await store.patchProject(PROJECT_PATH, [
      { type: "reset-server", serverKey: "a" },
    ]);
    expect(result.changedServerKeys).toEqual(["a"]);

    const persisted = await state.readState();
    expect(
      persisted.projects[PROJECT_PATH]?.mcpOverrides?.servers.a,
    ).toBeUndefined();
  });

  it("removes the mcpOverrides field entirely once the servers record is empty", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    await store.patchProject(PROJECT_PATH, [
      { type: "set-server-enabled", serverKey: "a", enabled: false },
    ]);
    await store.patchProject(PROJECT_PATH, [
      { type: "reset-server", serverKey: "a" },
    ]);

    const persisted = await state.readState();
    expect(persisted.projects[PROJECT_PATH]?.mcpOverrides).toBeUndefined();
  });

  it("throws when the project does not exist", async () => {
    const { state, store } = createTestHarness();
    await state.writeState({
      projects: {},
      archivedProjects: [],
      pinnedProjects: [],
    });

    await expect(
      store.patchProject("/missing", [
        { type: "set-server-enabled", serverKey: "a", enabled: true },
      ]),
    ).rejects.toThrow(/not found/i);
  });

  it("returns empty changed keys when the patch is a no-op", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    await store.patchProject(PROJECT_PATH, [
      { type: "set-server-enabled", serverKey: "a", enabled: false },
    ]);
    const second = await store.patchProject(PROJECT_PATH, [
      { type: "set-server-enabled", serverKey: "a", enabled: false },
    ]);
    expect(second.changedServerKeys).toEqual([]);
  });
});

// ===========================================================================
// Session scope
// ===========================================================================

describe("scope-store / session", () => {
  it("patches session mcpOverrides and returns changed keys", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    const result = await store.patchSession(PROJECT_PATH, SESSION_NAME, [
      {
        type: "set-tool-enabled",
        serverKey: "playwright",
        toolName: "navigate",
        enabled: false,
      },
    ]);
    expect(result.changedServerKeys).toEqual(["playwright"]);

    const persisted = await state.readState();
    const session = persisted.projects[PROJECT_PATH]?.sessions[SESSION_NAME];
    expect(
      session?.mcpOverrides?.servers.playwright?.tools?.navigate?.enabled,
    ).toBe(false);
  });

  it("does not touch project or conversation overrides", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    await store.patchSession(PROJECT_PATH, SESSION_NAME, [
      { type: "set-server-enabled", serverKey: "s", enabled: false },
    ]);

    const persisted = await state.readState();
    const project = persisted.projects[PROJECT_PATH];
    expect(project?.mcpOverrides).toBeUndefined();
    const conversation = project?.sessions[SESSION_NAME]?.conversations[0];
    expect(conversation?.mcpOverrides).toBeUndefined();
  });

  it("removes mcpOverrides when it becomes empty after reset-server", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    await store.patchSession(PROJECT_PATH, SESSION_NAME, [
      { type: "set-server-enabled", serverKey: "s", enabled: false },
    ]);
    await store.patchSession(PROJECT_PATH, SESSION_NAME, [
      { type: "reset-server", serverKey: "s" },
    ]);

    const persisted = await state.readState();
    const session = persisted.projects[PROJECT_PATH]?.sessions[SESSION_NAME];
    expect(session?.mcpOverrides).toBeUndefined();
  });

  it("throws when the session does not exist", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());
    await expect(
      store.patchSession(PROJECT_PATH, "missing", [
        { type: "set-server-enabled", serverKey: "a", enabled: true },
      ]),
    ).rejects.toThrow(/not found/i);
  });
});

// ===========================================================================
// Conversation scope
// ===========================================================================

describe("scope-store / conversation", () => {
  it("patches conversation mcpOverrides and returns changed keys", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    const result = await store.patchConversation(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
      [
        { type: "set-server-enabled", serverKey: "ctx", enabled: false },
        {
          type: "set-tool-enabled",
          serverKey: "ctx",
          toolName: "x",
          enabled: true,
        },
      ],
    );
    expect(result.changedServerKeys).toEqual(["ctx"]);

    const persisted = await state.readState();
    const conversation =
      persisted.projects[PROJECT_PATH]?.sessions[SESSION_NAME]
        ?.conversations[0];
    expect(conversation?.mcpOverrides?.servers.ctx?.enabled).toBe(false);
    expect(conversation?.mcpOverrides?.servers.ctx?.tools?.x?.enabled).toBe(
      true,
    );
  });

  it("removes the mcpOverrides field once empty", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    await store.patchConversation(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID, [
      { type: "set-server-enabled", serverKey: "z", enabled: false },
    ]);
    await store.patchConversation(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID, [
      { type: "reset-server", serverKey: "z" },
    ]);

    const persisted = await state.readState();
    const conversation =
      persisted.projects[PROJECT_PATH]?.sessions[SESSION_NAME]
        ?.conversations[0];
    expect(conversation?.mcpOverrides).toBeUndefined();
  });

  it("throws when the conversation does not exist", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());
    await expect(
      store.patchConversation(PROJECT_PATH, SESSION_NAME, "missing", [
        { type: "set-server-enabled", serverKey: "a", enabled: true },
      ]),
    ).rejects.toThrow(/not found/i);
  });
});

// ===========================================================================
// Serialization / ordering
// ===========================================================================

describe("scope-store / serialization", () => {
  it("serializes concurrent patches through the state mutex (no lost updates)", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    await Promise.all([
      store.patchProject(PROJECT_PATH, [
        { type: "set-server-enabled", serverKey: "a", enabled: true },
      ]),
      store.patchProject(PROJECT_PATH, [
        { type: "set-server-enabled", serverKey: "b", enabled: false },
      ]),
      store.patchProject(PROJECT_PATH, [
        { type: "set-server-enabled", serverKey: "c", enabled: true },
      ]),
    ]);

    const persisted = await state.readState();
    const servers = persisted.projects[PROJECT_PATH]?.mcpOverrides?.servers;
    expect(servers?.a?.enabled).toBe(true);
    expect(servers?.b?.enabled).toBe(false);
    expect(servers?.c?.enabled).toBe(true);
  });
});
