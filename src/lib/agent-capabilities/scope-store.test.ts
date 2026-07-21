import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ConversationState } from "@/lib/conversations/schemas";
import type { Logger } from "@/lib/logging";
import type { ManagerState } from "@/lib/projects/schemas";
import {
  readWholeStateForTest,
  seedWholeState,
} from "@/lib/shared/testing/whole-state-fixture";
import { createStateStore } from "@/lib/state-store";
import { _createTestDb } from "@/lib/state-store/state-db";
import {
  _resetForTesting as resetMutex,
  withWriteQueue,
} from "@/lib/state-store/write-queue";

import { createScopeCapabilityOverrideStore } from "./scope-store";

const SEED_TS = "2026-04-21T00:00:00.000Z";

const PROJECT_PATH = "/test/project-cap";
const SESSION_NAME = "test-session";
const CONVERSATION_ID = "conv-1";

const TEST_DIR = path.join("/tmp", "cc-agent-cap-scope-test-" + Date.now());

function createTestHarness() {
  const db: InstanceType<typeof Database> = _createTestDb({ inMemory: true });
  const state = createStateStore({ db });
  const store = createScopeCapabilityOverrideStore({ stateManager: state });
  return { db, state, store };
}

function createSqlHarness() {
  const db: InstanceType<typeof Database> = _createTestDb({ inMemory: true });
  const state = createStateStore({ db });
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
    agentBackend: "claude",
    backendRef: null,
    unread: false,
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
    pendingQueue: [],
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
                agentBackend: "claude",
                backendRef: null,
                unread: false,
                lastSeenAlignmentVersion: null,
                pendingAgentNotices: [],
                pendingQueue: [],
              },
            ],
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

beforeEach(async () => {
  resetMutex();
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("agent-capabilities / scope-store / project", () => {
  it("patches project agentCapabilityOverrides and returns changed item ids", async () => {
    const { db, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

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

    const persisted = readWholeStateForTest(db);
    expect(
      persisted.projects[PROJECT_PATH]?.agentCapabilityOverrides?.cascades[
        "claude-skills"
      ]?.items["skill:a"]?.enabled,
    ).toBe(false);
  });

  it("does not persist a resolved view — only the patched cascade is written", async () => {
    const { db, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

    await store.patchProject(PROJECT_PATH, {
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:a", enabled: false },
      ],
    });

    const persisted = readWholeStateForTest(db);
    const cascades =
      persisted.projects[PROJECT_PATH]?.agentCapabilityOverrides?.cascades;
    expect(Object.keys(cascades ?? {})).toEqual(["claude-skills"]);
    expect(Object.keys(cascades?.["claude-skills"]?.items ?? {})).toEqual([
      "skill:a",
    ]);
  });

  it("writes each layer independently — a project edit does not touch session or conversation overrides", async () => {
    const { db, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

    await store.patchProject(PROJECT_PATH, {
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:a", enabled: false },
      ],
    });

    const persisted = readWholeStateForTest(db);
    const session = persisted.projects[PROJECT_PATH]?.sessions[SESSION_NAME];
    expect(session?.agentCapabilityOverrides).toBeUndefined();
    expect(session?.conversations[0]?.agentCapabilityOverrides).toBeUndefined();
  });

  it("preserves existing overrides on other cascades when patching one cascade", async () => {
    const { db, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

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

    const persisted = readWholeStateForTest(db);
    const cascades =
      persisted.projects[PROJECT_PATH]?.agentCapabilityOverrides?.cascades;
    expect(cascades?.["claude-skills"]?.items["skill:a"]?.enabled).toBe(false);
    expect(cascades?.["codex-skills"]?.items["codex:a"]?.enabled).toBe(true);
  });

  it("prunes the cascade record after the only item is reset", async () => {
    const { db, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

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

    const persisted = readWholeStateForTest(db);
    expect(
      persisted.projects[PROJECT_PATH]?.agentCapabilityOverrides?.cascades[
        "claude-skills"
      ],
    ).toBeUndefined();
  });

  it("removes the agentCapabilityOverrides field once every cascade is empty", async () => {
    const { db, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

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

    const persisted = readWholeStateForTest(db);
    expect(
      persisted.projects[PROJECT_PATH]?.agentCapabilityOverrides,
    ).toBeUndefined();
  });

  it("throws when the project does not exist", async () => {
    const { db, store } = createTestHarness();
    seedWholeState(db, {
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
    const { db, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

    await store.patchProject(PROJECT_PATH, {
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:a", enabled: false },
      ],
    });

    const persisted = readWholeStateForTest(db);
    const project = persisted.projects[PROJECT_PATH];
    expect(project?.rootPath).toBe(PROJECT_PATH);
    expect(project?.sessions[SESSION_NAME]).toBeDefined();
  });

  it("restores scoped overrides and conversation runtime apply state after state manager recreation", async () => {
    const { db, store } = createTestHarness();
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
    seedWholeState(db, initial);

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

    // Fresh repos over the same persisted db carry no in-memory cache or
    // write-queue, so a successful read proves the overrides and runtime apply
    // state survived to disk across a state-manager recreation.
    const restored = readWholeStateForTest(db);
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

describe("agent-capabilities / scope-store / project conflict check", () => {
  it("propagates a precondition conflict and writes nothing", async () => {
    const { db, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

    const conflict = new Error("hash conflict");
    await expect(
      store.patchProject(PROJECT_PATH, {
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:a", enabled: false },
        ],
        precondition: async () => {
          throw conflict;
        },
      }),
    ).rejects.toBe(conflict);

    const persisted = readWholeStateForTest(db);
    expect(
      persisted.projects[PROJECT_PATH]?.agentCapabilityOverrides,
    ).toBeUndefined();
  });

  it("re-runs the precondition and preserves both writes when a concurrent patch lands between resolve and commit", async () => {
    const { db, state, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

    let calls = 0;
    const precondition = async (): Promise<void> => {
      calls += 1;
      if (calls === 1) {
        // A concurrent writer commits AFTER we read `before`. Issuing this
        // focused write from inside the precondition would deadlock if the
        // precondition ran while holding the queue — so a clean commit here
        // also proves the precondition runs OUTSIDE the critical section.
        await state.mutateProjectAgentCapabilityOverrides<void>(
          PROJECT_PATH,
          "test.concurrent",
          () => ({
            write: true,
            overrides: {
              cascades: {
                "codex-skills": { items: { z: { enabled: true } } },
              },
            },
            result: undefined,
          }),
        );
      }
    };

    const result = await store.patchProject(PROJECT_PATH, {
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:a", enabled: false },
      ],
      precondition,
    });

    expect(calls).toBe(2);
    expect(result.changedItemIds).toEqual(["skill:a"]);

    const persisted = readWholeStateForTest(db);
    const cascades =
      persisted.projects[PROJECT_PATH]?.agentCapabilityOverrides?.cascades;
    // Neither write was lost: the concurrent codex-skills change survives and
    // our claude-skills patch merged onto it.
    expect(cascades?.["codex-skills"]?.items["z"]?.enabled).toBe(true);
    expect(cascades?.["claude-skills"]?.items["skill:a"]?.enabled).toBe(false);
  });

  it("commits on the happy path when the precondition passes", async () => {
    const { db, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

    let calls = 0;
    const result = await store.patchProject(PROJECT_PATH, {
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:a", enabled: false },
      ],
      precondition: async () => {
        calls += 1;
      },
    });

    expect(calls).toBe(1);
    expect(result.changedItemIds).toEqual(["skill:a"]);
    const persisted = readWholeStateForTest(db);
    expect(
      persisted.projects[PROJECT_PATH]?.agentCapabilityOverrides?.cascades[
        "claude-skills"
      ]?.items["skill:a"]?.enabled,
    ).toBe(false);
  });
});

describe("agent-capabilities / scope-store / session", () => {
  it("patches session overrides and returns changed item ids", async () => {
    const { db, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

    const result = await store.patchSession(PROJECT_PATH, SESSION_NAME, {
      cascadeKind: "claude-plugins",
      operations: [
        { type: "set-item-enabled", itemId: "plugin:p", enabled: false },
      ],
    });
    expect(result.changedItemIds).toEqual(["plugin:p"]);

    const persisted = readWholeStateForTest(db);
    const session = persisted.projects[PROJECT_PATH]?.sessions[SESSION_NAME];
    expect(
      session?.agentCapabilityOverrides?.cascades["claude-plugins"]?.items[
        "plugin:p"
      ]?.enabled,
    ).toBe(false);
  });

  it("does not touch project or conversation overrides", async () => {
    const { db, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

    await store.patchSession(PROJECT_PATH, SESSION_NAME, {
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:s", enabled: false },
      ],
    });

    const persisted = readWholeStateForTest(db);
    const project = persisted.projects[PROJECT_PATH];
    expect(project?.agentCapabilityOverrides).toBeUndefined();
    const conversation = project?.sessions[SESSION_NAME]?.conversations[0];
    expect(conversation?.agentCapabilityOverrides).toBeUndefined();
  });

  it("removes the field once every cascade is empty", async () => {
    const { db, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

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

    const persisted = readWholeStateForTest(db);
    const session = persisted.projects[PROJECT_PATH]?.sessions[SESSION_NAME];
    expect(session?.agentCapabilityOverrides).toBeUndefined();
  });

  it("throws when the session does not exist", async () => {
    const { db, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());
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
    const { db, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

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

    const persisted = readWholeStateForTest(db);
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
    const { db, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

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

    const persisted = readWholeStateForTest(db);
    const conversation =
      persisted.projects[PROJECT_PATH]?.sessions[SESSION_NAME]
        ?.conversations[0];
    expect(conversation?.agentCapabilityOverrides).toBeUndefined();
  });

  it("throws when the conversation does not exist", async () => {
    const { db, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());
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
        readWholeStateForTest(db).projects[PROJECT_PATH]
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
      const restarted = createStateStore({ db });
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
      seedWholeState(db, stateWithAllScopes());
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

      const sessionConversation =
        readWholeStateForTest(db).projects[PROJECT_PATH]?.sessions[SESSION_NAME]
          ?.conversations[0];
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

describe("agent-capabilities / scope-store / session conflict check", () => {
  it("propagates a precondition conflict and writes nothing", async () => {
    const { db, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

    const conflict = new Error("hash conflict");
    await expect(
      store.patchSession(PROJECT_PATH, SESSION_NAME, {
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:s", enabled: false },
        ],
        precondition: async () => {
          throw conflict;
        },
      }),
    ).rejects.toBe(conflict);

    const persisted = readWholeStateForTest(db);
    expect(
      persisted.projects[PROJECT_PATH]?.sessions[SESSION_NAME]
        ?.agentCapabilityOverrides,
    ).toBeUndefined();
  });

  it("re-runs the precondition and preserves both writes when a concurrent patch lands between resolve and commit", async () => {
    const { db, state, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

    let calls = 0;
    const precondition = async (): Promise<void> => {
      calls += 1;
      if (calls === 1) {
        // A concurrent writer commits AFTER we read `before`. Issuing this
        // focused write from inside the precondition would DEADLOCK if the
        // precondition ran while holding the write queue — so a clean commit
        // here also proves the precondition runs OUTSIDE the critical section.
        await state.mutateSession(
          PROJECT_PATH,
          SESSION_NAME,
          "test.concurrent",
          (session) => {
            session.agentCapabilityOverrides = {
              cascades: { "codex-skills": { items: { z: { enabled: true } } } },
            };
          },
        );
      }
    };

    const result = await store.patchSession(PROJECT_PATH, SESSION_NAME, {
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:s", enabled: false },
      ],
      precondition,
    });

    expect(calls).toBe(2);
    expect(result.changedItemIds).toEqual(["skill:s"]);

    const cascades =
      readWholeStateForTest(db).projects[PROJECT_PATH]?.sessions[SESSION_NAME]
        ?.agentCapabilityOverrides?.cascades;
    // Neither write was lost across the fence retry.
    expect(cascades?.["codex-skills"]?.items["z"]?.enabled).toBe(true);
    expect(cascades?.["claude-skills"]?.items["skill:s"]?.enabled).toBe(false);
  });
});

describe("agent-capabilities / scope-store / conversation conflict check", () => {
  it("propagates a precondition conflict and writes nothing", async () => {
    const { db, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

    const conflict = new Error("hash conflict");
    await expect(
      store.patchConversation(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID, {
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:c", enabled: false },
        ],
        precondition: async () => {
          throw conflict;
        },
      }),
    ).rejects.toBe(conflict);

    const persisted = readWholeStateForTest(db);
    expect(
      persisted.projects[PROJECT_PATH]?.sessions[SESSION_NAME]?.conversations[0]
        ?.agentCapabilityOverrides,
    ).toBeUndefined();
  });

  it("re-runs the precondition and preserves both writes when a concurrent patch lands between resolve and commit", async () => {
    const { db, state, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

    let calls = 0;
    const precondition = async (): Promise<void> => {
      calls += 1;
      if (calls === 1) {
        await state.mutateConversation(
          PROJECT_PATH,
          SESSION_NAME,
          CONVERSATION_ID,
          "test.concurrent",
          (conversation) => {
            conversation.agentCapabilityOverrides = {
              cascades: { "codex-skills": { items: { z: { enabled: true } } } },
            };
          },
        );
      }
    };

    const result = await store.patchConversation(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
      {
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:c", enabled: false },
        ],
        precondition,
      },
    );

    expect(calls).toBe(2);
    expect(result.changedItemIds).toEqual(["skill:c"]);

    const cascades =
      readWholeStateForTest(db).projects[PROJECT_PATH]?.sessions[SESSION_NAME]
        ?.conversations[0]?.agentCapabilityOverrides?.cascades;
    expect(cascades?.["codex-skills"]?.items["z"]?.enabled).toBe(true);
    expect(cascades?.["claude-skills"]?.items["skill:c"]?.enabled).toBe(false);
  });
});

describe("agent-capabilities / scope-store / project conversation conflict check", () => {
  it("re-runs the precondition and preserves both writes when a concurrent patch lands between resolve and commit", async () => {
    const { db, state, store } = createSqlHarness();
    try {
      await state.createProjectConversation(
        PROJECT_PATH,
        projectConversation("plc-1"),
      );

      let calls = 0;
      const precondition = async (): Promise<void> => {
        calls += 1;
        if (calls === 1) {
          await state.mutateProjectConversation(
            PROJECT_PATH,
            "plc-1",
            "test.concurrent",
            (conversation) => {
              conversation.agentCapabilityOverrides = {
                cascades: {
                  "codex-skills": { items: { z: { enabled: true } } },
                },
              };
            },
          );
        }
      };

      const result = await store.patchProjectConversation(
        PROJECT_PATH,
        "plc-1",
        {
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "skill:a", enabled: false },
          ],
          precondition,
        },
      );

      expect(calls).toBe(2);
      expect(result.changedItemIds).toEqual(["skill:a"]);

      const restored = await state.getProjectConversation(
        PROJECT_PATH,
        "plc-1",
      );
      const cascades = restored?.agentCapabilityOverrides?.cascades;
      expect(cascades?.["codex-skills"]?.items["z"]?.enabled).toBe(true);
      expect(cascades?.["claude-skills"]?.items["skill:a"]?.enabled).toBe(
        false,
      );
    } finally {
      db.close();
    }
  });
});

describe("agent-capabilities / scope-store / ancestor effective-hash fence", () => {
  it("session: a PROJECT ancestor change after the precondition surfaces a conflict, no stale commit", async () => {
    const { db, state, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

    const conflict = new Error("ancestor hash conflict");
    let calls = 0;
    const precondition = async (): Promise<void> => {
      calls += 1;
      if (calls === 1) {
        // The PROJECT ancestor override changes AFTER the child session
        // precondition validated — the effective hash the session patch was
        // fenced against moved. A target-only fence would miss this (the session
        // overrides are unchanged) and commit the stale patch.
        await state.mutateProjectAgentCapabilityOverrides<void>(
          PROJECT_PATH,
          "test.parent-change",
          () => ({
            write: true,
            overrides: {
              cascades: { "codex-skills": { items: { p: { enabled: true } } } },
            },
            result: undefined,
          }),
        );
        return;
      }
      // The re-run precondition recomputes the effective hash against the now-
      // changed ancestor and rejects — exactly what computeEffectiveHash does.
      throw conflict;
    };

    await expect(
      store.patchSession(PROJECT_PATH, SESSION_NAME, {
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:s", enabled: false },
        ],
        precondition,
      }),
    ).rejects.toBe(conflict);

    // The ancestor change forced the fence to miss and re-run the precondition.
    expect(calls).toBe(2);
    const persisted = readWholeStateForTest(db);
    const session = persisted.projects[PROJECT_PATH]?.sessions[SESSION_NAME];
    // The stale-hash session patch never committed.
    expect(session?.agentCapabilityOverrides).toBeUndefined();
    // The concurrent parent change did land.
    expect(
      persisted.projects[PROJECT_PATH]?.agentCapabilityOverrides?.cascades[
        "codex-skills"
      ]?.items["p"]?.enabled,
    ).toBe(true);
  });

  it("conversation: a SESSION ancestor change after the precondition surfaces a conflict, no stale commit", async () => {
    const { db, state, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

    const conflict = new Error("ancestor hash conflict");
    let calls = 0;
    const precondition = async (): Promise<void> => {
      calls += 1;
      if (calls === 1) {
        // The SESSION ancestor override changes after the conversation
        // precondition passed. The no-touch setter is used so the change itself
        // never restamps activity.
        await state.mutateSessionAgentCapabilityOverrides<void>(
          PROJECT_PATH,
          SESSION_NAME,
          "test.parent-change",
          () => ({
            write: true,
            overrides: {
              cascades: { "codex-skills": { items: { s: { enabled: true } } } },
            },
            result: undefined,
          }),
        );
        return;
      }
      throw conflict;
    };

    await expect(
      store.patchConversation(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID, {
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:c", enabled: false },
        ],
        precondition,
      }),
    ).rejects.toBe(conflict);

    expect(calls).toBe(2);
    const persisted = readWholeStateForTest(db);
    const session = persisted.projects[PROJECT_PATH]?.sessions[SESSION_NAME];
    expect(session?.conversations[0]?.agentCapabilityOverrides).toBeUndefined();
    expect(
      session?.agentCapabilityOverrides?.cascades["codex-skills"]?.items["s"]
        ?.enabled,
    ).toBe(true);
  });

  it("conversation: a PROJECT ancestor change after the precondition surfaces a conflict, no stale commit", async () => {
    const { db, state, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

    const conflict = new Error("ancestor hash conflict");
    let calls = 0;
    const precondition = async (): Promise<void> => {
      calls += 1;
      if (calls === 1) {
        // The PROJECT ancestor override changes after the conversation
        // precondition passed. The session-conversation effective hash spans
        // global → project → session → conversation, so the commit must fence
        // the PROJECT ancestor too — a target-only or project-omitting fence
        // would miss this (the conversation target is unchanged) and commit the
        // stale patch. Removing the `ancestors.project` check in
        // `patchConversationChecked` turns this test red — the commit would pass
        // the fence and return without re-running the precondition, so
        // `calls === 2` and the conflict rejection both fail (regression guard).
        await state.mutateProjectAgentCapabilityOverrides<void>(
          PROJECT_PATH,
          "test.parent-change",
          () => ({
            write: true,
            overrides: {
              cascades: { "codex-skills": { items: { p: { enabled: true } } } },
            },
            result: undefined,
          }),
        );
        return;
      }
      throw conflict;
    };

    await expect(
      store.patchConversation(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID, {
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:c", enabled: false },
        ],
        precondition,
      }),
    ).rejects.toBe(conflict);

    expect(calls).toBe(2);
    const persisted = readWholeStateForTest(db);
    const session = persisted.projects[PROJECT_PATH]?.sessions[SESSION_NAME];
    // The stale-hash conversation patch never committed.
    expect(session?.conversations[0]?.agentCapabilityOverrides).toBeUndefined();
    // The concurrent PROJECT ancestor change did land.
    expect(
      persisted.projects[PROJECT_PATH]?.agentCapabilityOverrides?.cascades[
        "codex-skills"
      ]?.items["p"]?.enabled,
    ).toBe(true);
  });

  it("project conversation: a PROJECT ancestor change after the precondition surfaces a conflict, no stale commit", async () => {
    const { db, state, store } = createSqlHarness();
    try {
      await state.createProjectConversation(
        PROJECT_PATH,
        projectConversation("plc-1"),
      );

      const conflict = new Error("ancestor hash conflict");
      let calls = 0;
      const precondition = async (): Promise<void> => {
        calls += 1;
        if (calls === 1) {
          await state.mutateProjectAgentCapabilityOverrides<void>(
            PROJECT_PATH,
            "test.parent-change",
            () => ({
              write: true,
              overrides: {
                cascades: {
                  "codex-skills": { items: { p: { enabled: true } } },
                },
              },
              result: undefined,
            }),
          );
          return;
        }
        throw conflict;
      };

      await expect(
        store.patchProjectConversation(PROJECT_PATH, "plc-1", {
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "skill:a", enabled: false },
          ],
          precondition,
        }),
      ).rejects.toBe(conflict);

      expect(calls).toBe(2);
      const restored = await state.getProjectConversation(
        PROJECT_PATH,
        "plc-1",
      );
      expect(restored?.agentCapabilityOverrides).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("agent-capabilities / scope-store / fence miss does not restamp activity", () => {
  it("conversation: a raced conflict leaves conversation and session lastActivityAt unchanged", async () => {
    const { db, state, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

    const conflict = new Error("hash conflict");
    let calls = 0;
    const precondition = async (): Promise<void> => {
      calls += 1;
      if (calls === 1) {
        // Change the conversation TARGET so the first commit's fence misses
        // (write:false) — the exact path the old generic mutateConversation
        // restamped conversation + session activity on.
        await state.mutateConversationAgentCapabilityOverrides<void>(
          PROJECT_PATH,
          SESSION_NAME,
          CONVERSATION_ID,
          "test.concurrent",
          () => ({
            write: true,
            overrides: {
              cascades: { "codex-skills": { items: { z: { enabled: true } } } },
            },
            result: undefined,
          }),
        );
        return;
      }
      throw conflict;
    };

    await expect(
      store.patchConversation(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID, {
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:c", enabled: false },
        ],
        precondition,
      }),
    ).rejects.toBe(conflict);
    expect(calls).toBe(2);

    const persisted = readWholeStateForTest(db);
    const session = persisted.projects[PROJECT_PATH]?.sessions[SESSION_NAME];
    // Neither the fence-miss commit nor the concurrent no-touch write restamped
    // activity — a config edit must not reorder the conversation or session.
    expect(session?.conversations[0]?.lastActivityAt).toBe(SEED_TS);
    expect(session?.lastActivityAt).toBe(SEED_TS);
  });

  it("project conversation: a raced conflict leaves the PLC lastActivityAt unchanged", async () => {
    const { db, state, store } = createSqlHarness();
    try {
      await state.createProjectConversation(
        PROJECT_PATH,
        projectConversation("plc-1"),
      );

      const conflict = new Error("hash conflict");
      let calls = 0;
      const precondition = async (): Promise<void> => {
        calls += 1;
        if (calls === 1) {
          // Change the PLC TARGET so the first commit's fence misses
          // (write:false) — the exact path the old restamping
          // mutateProjectConversation bumped the PLC's lastActivityAt on. The
          // no-touch focused setter must leave it unchanged.
          await state.mutateProjectConversationAgentCapabilityOverrides<void>(
            PROJECT_PATH,
            "plc-1",
            "test.concurrent",
            () => ({
              write: true,
              overrides: {
                cascades: {
                  "codex-skills": { items: { z: { enabled: true } } },
                },
              },
              result: undefined,
            }),
          );
          return;
        }
        throw conflict;
      };

      await expect(
        store.patchProjectConversation(PROJECT_PATH, "plc-1", {
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "skill:a", enabled: false },
          ],
          precondition,
        }),
      ).rejects.toBe(conflict);
      expect(calls).toBe(2);

      const restored = await state.getProjectConversation(
        PROJECT_PATH,
        "plc-1",
      );
      // Neither the fence-miss commit nor the concurrent no-touch write restamped
      // the PLC — a config edit must not reorder a project conversation.
      expect(restored?.lastActivityAt).toBe(SEED_TS);
    } finally {
      db.close();
    }
  });
});

describe("agent-capabilities / scope-store / logging ordering", () => {
  it("emits logPatch only AFTER the focused write queue releases (queue-exit-before-log)", async () => {
    const { db, state } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

    const order: string[] = [];
    const spyLogger: Logger = {
      debug() {},
      warn() {},
      error() {},
      info(message: string) {
        order.push(`log:${message}`);
      },
    };
    const store = createScopeCapabilityOverrideStore({
      stateManager: state,
      logger: spyLogger,
    });

    const patchP = store.patchProject(PROJECT_PATH, {
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:a", enabled: false },
      ],
    });
    // Enqueue an unrelated write directly behind the patch's sync commit. If
    // logPatch ran INSIDE the critical section it would fire before this marker;
    // because it runs only after the queue releases, the marker runs first.
    const markerP = withWriteQueue("ordering-marker", async () => {
      order.push("marker");
    });
    await Promise.all([patchP, markerP]);

    expect(order).toEqual(["marker", "log:project.patch"]);
  });
});

describe("agent-capabilities / scope-store / serialization", () => {
  it("serializes concurrent patches through the state mutex (no lost updates)", async () => {
    const { db, store } = createTestHarness();
    seedWholeState(db, stateWithAllScopes());

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

    const persisted = readWholeStateForTest(db);
    const items =
      persisted.projects[PROJECT_PATH]?.agentCapabilityOverrides?.cascades[
        "claude-skills"
      ]?.items;
    expect(items?.["a"]?.enabled).toBe(true);
    expect(items?.["b"]?.enabled).toBe(false);
    expect(items?.["c"]?.enabled).toBe(true);
  });
});
