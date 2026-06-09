import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConfigReader } from "@/lib/config/loader";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ManagerState } from "@/lib/projects/schemas";
import { createStateManager } from "@/lib/state-store";
import { _createTestDb } from "@/lib/state-store/state-db";
import { _resetForTesting as resetMutex } from "@/lib/state-store/write-queue";

import { createScopeCapabilityOverrideStore } from "./scope-store";

const PROJECT_PATH = "/test/project-cap";
const SESSION_NAME = "test-session";
const CONVERSATION_ID = "conv-1";

const TEST_DIR = path.join("/tmp", "cc-agent-cap-scope-test-" + Date.now());

function createTestHarness() {
  const configReader = createConfigReader(TEST_DIR);
  const state = createStateManager({
    readConfig: () => configReader.readConfig(),
  });
  const store = createScopeCapabilityOverrideStore({ stateManager: state });
  return { state, store };
}

function createSqlHarness() {
  const db: InstanceType<typeof Database> = _createTestDb({ inMemory: true });
  const state = createStateManager({ db });
  const store = createScopeCapabilityOverrideStore({ stateManager: state });
  return { db, state, store };
}

function projectConversation(id: string): ConversationState {
  return {
    id,
    scope: "project",
    name: null,
    transcriptPath: null,
    status: "awaiting",
    promptCount: 0,
    createdAt: "2026-04-21T00:00:00.000Z",
    lastActivityAt: "2026-04-21T00:00:00.000Z",
    source: "cc",
    summary: null,
    archived: false,
    open: true,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    machineSnapshot: null,
    agentBackend: "claude",
    backendRef: null,
    unread: false,
  };
}

function stateWithAllScopes(): ManagerState {
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
            conversations: [
              {
                id: CONVERSATION_ID,
                scope: "session",
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

describe("agent-capabilities / scope-store / project", () => {
  it("patches project agentCapabilityOverrides and returns changed item ids", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    const result = await store.patchProject(PROJECT_PATH, {
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:a", enabled: false },
      ],
    });

    expect(result.changedItemIds).toEqual(["skill:a"]);
    expect(
      result.overrides.cascades["claude-skills"]?.items["skill:a"]?.enabled,
    ).toBe(false);

    const persisted = await state.readState();
    expect(
      persisted.projects[PROJECT_PATH]?.agentCapabilityOverrides?.cascades[
        "claude-skills"
      ]?.items["skill:a"]?.enabled,
    ).toBe(false);
  });

  it("does not persist a resolved view — only the patched cascade is written", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    await store.patchProject(PROJECT_PATH, {
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:a", enabled: false },
      ],
    });

    const persisted = await state.readState();
    const cascades =
      persisted.projects[PROJECT_PATH]?.agentCapabilityOverrides?.cascades;
    expect(Object.keys(cascades ?? {})).toEqual(["claude-skills"]);
    expect(Object.keys(cascades?.["claude-skills"]?.items ?? {})).toEqual([
      "skill:a",
    ]);
  });

  it("writes each layer independently — a project edit does not touch session or conversation overrides", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    await store.patchProject(PROJECT_PATH, {
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:a", enabled: false },
      ],
    });

    const persisted = await state.readState();
    const session = persisted.projects[PROJECT_PATH]?.sessions[SESSION_NAME];
    expect(session?.agentCapabilityOverrides).toBeUndefined();
    expect(session?.conversations[0]?.agentCapabilityOverrides).toBeUndefined();
  });

  it("preserves existing overrides on other cascades when patching one cascade", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    await store.patchProject(PROJECT_PATH, {
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:a", enabled: false },
      ],
    });
    await store.patchProject(PROJECT_PATH, {
      cascadeKind: "codex-skills",
      operations: [
        { type: "set-item-enabled", itemId: "codex:a", enabled: true },
      ],
    });

    const persisted = await state.readState();
    const cascades =
      persisted.projects[PROJECT_PATH]?.agentCapabilityOverrides?.cascades;
    expect(cascades?.["claude-skills"]?.items["skill:a"]?.enabled).toBe(false);
    expect(cascades?.["codex-skills"]?.items["codex:a"]?.enabled).toBe(true);
  });

  it("prunes the cascade record after the only item is reset", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    await store.patchProject(PROJECT_PATH, {
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:a", enabled: false },
      ],
    });
    const result = await store.patchProject(PROJECT_PATH, {
      cascadeKind: "claude-skills",
      operations: [{ type: "reset-item", itemId: "skill:a" }],
    });
    expect(result.changedItemIds).toEqual(["skill:a"]);

    const persisted = await state.readState();
    expect(
      persisted.projects[PROJECT_PATH]?.agentCapabilityOverrides?.cascades[
        "claude-skills"
      ],
    ).toBeUndefined();
  });

  it("removes the agentCapabilityOverrides field once every cascade is empty", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    await store.patchProject(PROJECT_PATH, {
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:a", enabled: false },
      ],
    });
    await store.patchProject(PROJECT_PATH, {
      cascadeKind: "claude-skills",
      operations: [{ type: "reset-item", itemId: "skill:a" }],
    });

    const persisted = await state.readState();
    expect(
      persisted.projects[PROJECT_PATH]?.agentCapabilityOverrides,
    ).toBeUndefined();
  });

  it("throws when the project does not exist", async () => {
    const { state, store } = createTestHarness();
    await state.writeState({
      projects: {},
      archivedProjects: [],
      pinnedProjects: [],
    });

    await expect(
      store.patchProject("/missing", {
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:a", enabled: false },
        ],
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("preserves existing non-capability state records on read and write", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    await store.patchProject(PROJECT_PATH, {
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:a", enabled: false },
      ],
    });

    const persisted = await state.readState();
    const project = persisted.projects[PROJECT_PATH];
    expect(project?.rootPath).toBe(PROJECT_PATH);
    expect(project?.sessions[SESSION_NAME]).toBeDefined();
  });

  it("restores scoped overrides and conversation runtime apply state after state manager recreation", async () => {
    const { state, store } = createTestHarness();
    const initial = stateWithAllScopes();
    initial.projects[PROJECT_PATH]!.sessions[
      SESSION_NAME
    ]!.conversations[0]!.agentCapabilitiesRuntime = {
      cascades: {
        "claude-skills": {
          appliedHash: "runtime-hash",
          lastApplyStatus: "applied",
        },
      },
    };
    await state.writeState(initial);

    await store.patchProject(PROJECT_PATH, {
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:a", enabled: false },
      ],
    });
    await store.patchSession(PROJECT_PATH, SESSION_NAME, {
      cascadeKind: "claude-plugins",
      operations: [
        { type: "set-item-enabled", itemId: "plugin:a", enabled: false },
      ],
    });
    await store.patchConversation(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID, {
      cascadeKind: "claude-agents",
      operations: [
        { type: "set-item-enabled", itemId: "agent:a", enabled: false },
      ],
    });

    const restarted = createTestHarness();
    const restored = await restarted.state.readState();
    const session = restored.projects[PROJECT_PATH]?.sessions[SESSION_NAME];
    const conversation = session?.conversations[0];

    expect(
      restored.projects[PROJECT_PATH]?.agentCapabilityOverrides?.cascades[
        "claude-skills"
      ]?.items["skill:a"]?.enabled,
    ).toBe(false);
    expect(
      session?.agentCapabilityOverrides?.cascades["claude-plugins"]?.items[
        "plugin:a"
      ]?.enabled,
    ).toBe(false);
    expect(
      conversation?.agentCapabilityOverrides?.cascades["claude-agents"]?.items[
        "agent:a"
      ]?.enabled,
    ).toBe(false);
    expect(
      conversation?.agentCapabilitiesRuntime?.cascades["claude-skills"]
        ?.appliedHash,
    ).toBe("runtime-hash");
  });
});

describe("agent-capabilities / scope-store / session", () => {
  it("patches session overrides and returns changed item ids", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    const result = await store.patchSession(PROJECT_PATH, SESSION_NAME, {
      cascadeKind: "claude-plugins",
      operations: [
        { type: "set-item-enabled", itemId: "plugin:p", enabled: false },
      ],
    });
    expect(result.changedItemIds).toEqual(["plugin:p"]);

    const persisted = await state.readState();
    const session = persisted.projects[PROJECT_PATH]?.sessions[SESSION_NAME];
    expect(
      session?.agentCapabilityOverrides?.cascades["claude-plugins"]?.items[
        "plugin:p"
      ]?.enabled,
    ).toBe(false);
  });

  it("does not touch project or conversation overrides", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    await store.patchSession(PROJECT_PATH, SESSION_NAME, {
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:s", enabled: false },
      ],
    });

    const persisted = await state.readState();
    const project = persisted.projects[PROJECT_PATH];
    expect(project?.agentCapabilityOverrides).toBeUndefined();
    const conversation = project?.sessions[SESSION_NAME]?.conversations[0];
    expect(conversation?.agentCapabilityOverrides).toBeUndefined();
  });

  it("removes the field once every cascade is empty", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    await store.patchSession(PROJECT_PATH, SESSION_NAME, {
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:s", enabled: false },
      ],
    });
    await store.patchSession(PROJECT_PATH, SESSION_NAME, {
      cascadeKind: "claude-skills",
      operations: [{ type: "reset-item", itemId: "skill:s" }],
    });

    const persisted = await state.readState();
    const session = persisted.projects[PROJECT_PATH]?.sessions[SESSION_NAME];
    expect(session?.agentCapabilityOverrides).toBeUndefined();
  });

  it("throws when the session does not exist", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());
    await expect(
      store.patchSession(PROJECT_PATH, "missing", {
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:s", enabled: false },
        ],
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("agent-capabilities / scope-store / conversation", () => {
  it("patches conversation overrides and returns changed item ids", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    const result = await store.patchConversation(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
      {
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:c", enabled: false },
        ],
      },
    );
    expect(result.changedItemIds).toEqual(["skill:c"]);

    const persisted = await state.readState();
    const conversation =
      persisted.projects[PROJECT_PATH]?.sessions[SESSION_NAME]
        ?.conversations[0];
    expect(
      conversation?.agentCapabilityOverrides?.cascades["claude-skills"]?.items[
        "skill:c"
      ]?.enabled,
    ).toBe(false);
  });

  it("removes the field once empty", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    await store.patchConversation(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID, {
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:c", enabled: false },
      ],
    });
    await store.patchConversation(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID, {
      cascadeKind: "claude-skills",
      operations: [{ type: "reset-item", itemId: "skill:c" }],
    });

    const persisted = await state.readState();
    const conversation =
      persisted.projects[PROJECT_PATH]?.sessions[SESSION_NAME]
        ?.conversations[0];
    expect(conversation?.agentCapabilityOverrides).toBeUndefined();
  });

  it("throws when the conversation does not exist", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());
    await expect(
      store.patchConversation(PROJECT_PATH, SESSION_NAME, "missing", {
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:c", enabled: false },
        ],
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("agent-capabilities / scope-store / project conversation", () => {
  it("patches only the selected project conversation and prunes reset overrides", async () => {
    const { db, state, store } = createSqlHarness();
    try {
      await state.createProjectConversation(
        PROJECT_PATH,
        projectConversation("plc-1"),
      );
      await state.createProjectConversation(
        PROJECT_PATH,
        projectConversation("plc-2"),
      );
      await store.patchProject(PROJECT_PATH, {
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:a", enabled: true },
        ],
      });

      const result = await store.patchProjectConversation(
        PROJECT_PATH,
        "plc-1",
        {
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "skill:a", enabled: false },
          ],
        },
      );

      expect(result.changedItemIds).toEqual(["skill:a"]);
      const selected = await state.getProjectConversation(
        PROJECT_PATH,
        "plc-1",
      );
      const other = await state.getProjectConversation(PROJECT_PATH, "plc-2");
      expect(
        selected?.agentCapabilityOverrides?.cascades["claude-skills"]?.items[
          "skill:a"
        ]?.enabled,
      ).toBe(false);
      expect(other?.agentCapabilityOverrides).toBeUndefined();

      const reset = await store.patchProjectConversation(
        PROJECT_PATH,
        "plc-1",
        {
          cascadeKind: "claude-skills",
          operations: [{ type: "reset-item", itemId: "skill:a" }],
        },
      );

      expect(reset.changedItemIds).toEqual(["skill:a"]);
      expect(
        (await state.getProjectConversation(PROJECT_PATH, "plc-1"))
          ?.agentCapabilityOverrides,
      ).toBeUndefined();
      expect(
        (await state.readState()).projects[PROJECT_PATH]
          ?.agentCapabilityOverrides?.cascades["claude-skills"]?.items[
          "skill:a"
        ]?.enabled,
      ).toBe(true);
      expect(
        (
          db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
      expect(
        (
          db.prepare(`SELECT COUNT(*) AS n FROM conversations`).get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("restores a PLC override and PLC runtime apply state after state manager recreation (Req 14.1, 14.2, 18.4)", async () => {
    const { db, state, store } = createSqlHarness();
    try {
      await state.createProjectConversation(
        PROJECT_PATH,
        projectConversation("plc-1"),
      );

      await store.patchProjectConversation(PROJECT_PATH, "plc-1", {
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:a", enabled: false },
        ],
      });
      await state.mutateProjectConversation(
        PROJECT_PATH,
        "plc-1",
        "test.seed-runtime",
        (conversation) => {
          conversation.agentCapabilitiesRuntime = {
            cascades: {
              "claude-skills": {
                appliedHash: "plc-applied-hash",
                pendingHash: "plc-pending-hash",
                pendingItemIds: ["skill:a"],
                lastApplyStatus: "staged-idle",
              },
            },
          };
        },
      );

      // Simulate restart: a fresh state manager over the same persisted db has
      // no in-memory caches/write-queue carried over, so a successful read here
      // proves the override AND runtime apply state survived to disk.
      const restarted = createStateManager({ db });
      const restored = await restarted.getProjectConversation(
        PROJECT_PATH,
        "plc-1",
      );

      expect(
        restored?.agentCapabilityOverrides?.cascades["claude-skills"]?.items[
          "skill:a"
        ]?.enabled,
      ).toBe(false);
      const restoredRuntime =
        restored?.agentCapabilitiesRuntime?.cascades["claude-skills"];
      expect(restoredRuntime?.appliedHash).toBe("plc-applied-hash");
      expect(restoredRuntime?.pendingHash).toBe("plc-pending-hash");
      expect(restoredRuntime?.pendingItemIds).toEqual(["skill:a"]);
      expect(restoredRuntime?.lastApplyStatus).toBe("staged-idle");

      // The restored PLC must not have synthesized a session row.
      expect(
        (
          db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
      expect(
        (
          db.prepare(`SELECT COUNT(*) AS n FROM conversations`).get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("keeps project conversations separate from same-id session conversations", async () => {
    const { db, state, store } = createSqlHarness();
    try {
      await state.writeState(stateWithAllScopes());
      await state.createProjectConversation(
        PROJECT_PATH,
        projectConversation(CONVERSATION_ID),
      );

      await store.patchConversation(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        {
          cascadeKind: "claude-skills",
          operations: [
            {
              type: "set-item-enabled",
              itemId: "skill:session",
              enabled: false,
            },
          ],
        },
      );
      await store.patchProjectConversation(PROJECT_PATH, CONVERSATION_ID, {
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:project", enabled: true },
        ],
      });

      const sessionConversation = (await state.readState()).projects[
        PROJECT_PATH
      ]?.sessions[SESSION_NAME]?.conversations[0];
      const projectConversationRecord = await state.getProjectConversation(
        PROJECT_PATH,
        CONVERSATION_ID,
      );

      expect(
        sessionConversation?.agentCapabilityOverrides?.cascades["claude-skills"]
          ?.items["skill:session"]?.enabled,
      ).toBe(false);
      expect(
        sessionConversation?.agentCapabilityOverrides?.cascades["claude-skills"]
          ?.items["skill:project"],
      ).toBeUndefined();
      expect(
        projectConversationRecord?.agentCapabilityOverrides?.cascades[
          "claude-skills"
        ]?.items["skill:project"]?.enabled,
      ).toBe(true);
      expect(
        projectConversationRecord?.agentCapabilityOverrides?.cascades[
          "claude-skills"
        ]?.items["skill:session"],
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("agent-capabilities / scope-store / serialization", () => {
  it("serializes concurrent patches through the state mutex (no lost updates)", async () => {
    const { state, store } = createTestHarness();
    await state.writeState(stateWithAllScopes());

    await Promise.all([
      store.patchProject(PROJECT_PATH, {
        cascadeKind: "claude-skills",
        operations: [{ type: "set-item-enabled", itemId: "a", enabled: true }],
      }),
      store.patchProject(PROJECT_PATH, {
        cascadeKind: "claude-skills",
        operations: [{ type: "set-item-enabled", itemId: "b", enabled: false }],
      }),
      store.patchProject(PROJECT_PATH, {
        cascadeKind: "claude-skills",
        operations: [{ type: "set-item-enabled", itemId: "c", enabled: true }],
      }),
    ]);

    const persisted = await state.readState();
    const items =
      persisted.projects[PROJECT_PATH]?.agentCapabilityOverrides?.cascades[
        "claude-skills"
      ]?.items;
    expect(items?.["a"]?.enabled).toBe(true);
    expect(items?.["b"]?.enabled).toBe(false);
    expect(items?.["c"]?.enabled).toBe(true);
  });
});
