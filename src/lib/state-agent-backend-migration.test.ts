import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  buildAgentBackendMigrationBackupPath,
  migrateLegacyAgentBackendState,
  migrateStateFileWithBackup,
} from "./state-agent-backend-migration";

function makeLegacyState() {
  return {
    projects: {
      "/proj": {
        rootPath: "/proj",
        roadmapItems: [],
        sessions: {
          "my-session": {
            sessionName: "my-session",
            worktreePath: "/proj/.worktrees/my-session",
            branchName: "cc/my-session",
            createdAt: "2024-01-01T00:00:00Z",
            lastActivityAt: "2024-01-01T00:00:00Z",
            archived: false,
            finished: false,
            conversations: [
              {
                id: "conv-1",
                name: "my-session 1",
                transcriptPath: null,
                status: "awaiting",
                promptCount: 1,
                createdAt: "2024-01-01T00:00:00Z",
                lastActivityAt: "2024-01-01T00:00:00Z",
                source: "cc",
                summary: null,
                archived: false,
                totalCostUsd: null,
                totalDurationMs: null,
                totalTurns: null,
                pendingQuestionId: null,
                pendingQuestions: null,
                forkedFrom: {
                  sourceConversationId: "conv-parent",
                  messageIndex: 3,
                  sourceClaudeSessionId: "sdk-parent",
                  forkPointAssistantUuid: "assistant-uuid-1",
                },
                role: null,
                contextTokens: null,
                contextWindowMax: null,
                debugMode: null,
                machineSnapshot: null,
                claudeSessionId: "sdk-conv-1",
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

describe("buildAgentBackendMigrationBackupPath", () => {
  it("increments the suffix when prior backups already exist", () => {
    const existing = new Set([
      "/tmp/state.json.agent-backend-migration.bak",
      "/tmp/state.json.agent-backend-migration.1.bak",
    ]);

    const backupPath = buildAgentBackendMigrationBackupPath(
      "/tmp/state.json",
      (candidate) => existing.has(candidate),
    );

    expect(backupPath).toBe("/tmp/state.json.agent-backend-migration.2.bak");
  });
});

describe("migrateLegacyAgentBackendState", () => {
  it("maps legacy Claude continuity fields into backend-neutral state", () => {
    const result = migrateLegacyAgentBackendState(makeLegacyState());
    const conversation =
      result.migratedState.projects["/proj"]!.sessions["my-session"]!
        .conversations[0]!;

    expect(result.changed).toBe(true);
    expect(conversation.agentBackend).toBe("claude");
    expect(conversation.backendRef).toEqual({
      backend: "claude",
      sessionId: "sdk-conv-1",
    });
    expect(conversation.forkedFrom).toEqual({
      sourceConversationId: "conv-parent",
      messageIndex: 3,
      sourceBackend: "claude",
      sourceBackendRef: {
        backend: "claude",
        sessionId: "sdk-parent",
      },
      forkLocator: "assistant-uuid-1",
    });
    expect(result.summary.conversationsUpdated).toBe(1);
    expect(result.summary.forksUpdated).toBe(1);
    expect(result.summary.legacyFieldsRemoved).toBe(3);
  });
});

describe("migrateStateFileWithBackup", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(
      path.join(os.tmpdir(), "cc-state-agent-backend-migration-"),
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("backs up the original state file before rewriting it", async () => {
    const stateFilePath = path.join(tempDir, "state.json");
    const originalRaw = JSON.stringify(makeLegacyState(), null, 2);

    await writeFile(stateFilePath, originalRaw, "utf-8");
    await writeFile(
      `${stateFilePath}.agent-backend-migration.bak`,
      "older backup",
      "utf-8",
    );

    const result = await migrateStateFileWithBackup(stateFilePath);

    expect(result.status).toBe("migrated");
    expect(result.backupPath).toBe(
      `${stateFilePath}.agent-backend-migration.1.bak`,
    );
    expect(existsSync(result.backupPath!)).toBe(true);
    await expect(readFile(result.backupPath!, "utf-8")).resolves.toBe(
      originalRaw,
    );

    const migratedRaw = await readFile(stateFilePath, "utf-8");
    const migratedState = JSON.parse(migratedRaw) as {
      projects: Record<
        string,
        {
          sessions: Record<
            string,
            { conversations: Array<Record<string, unknown>> }
          >;
        }
      >;
    };

    const conversation =
      migratedState.projects["/proj"]!.sessions["my-session"]!
        .conversations[0]!;
    expect(conversation["claudeSessionId"]).toBeUndefined();
    expect(conversation["backendRef"]).toEqual({
      backend: "claude",
      sessionId: "sdk-conv-1",
    });
  });

  it("skips backup creation when the state file is already migrated", async () => {
    const stateFilePath = path.join(tempDir, "state.json");
    const migrated =
      migrateLegacyAgentBackendState(makeLegacyState()).migratedState;

    await writeFile(stateFilePath, JSON.stringify(migrated, null, 2), "utf-8");

    const result = await migrateStateFileWithBackup(stateFilePath);

    expect(result.status).toBe("no_changes");
    expect(result.backupPath).toBeNull();
    expect(existsSync(`${stateFilePath}.agent-backend-migration.bak`)).toBe(
      false,
    );
  });
});
