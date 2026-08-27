import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type BetterSqlite3 from "better-sqlite3";
import { schemaCompatibilityBarrierPath } from "../schema-compatibility";
import { stableStringify } from "../serialization";
import { _createTestDbAtPath } from "../state-db";
import {
  GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION,
  generalizedModelSelection,
  preflightGeneralizedModelSelection,
} from "./0035-generalized-model-selection";

type Db = InstanceType<typeof BetterSqlite3>;

const SESSION_NAME = "legacy-session";
const CONVERSATION_ID = "legacy-conversation";

const openDbs: Db[] = [];
const tempDirs: string[] = [];

function replaceContextArtifactsWithLegacyTable(db: Db): void {
  db.exec(`
    DROP TABLE context_artifacts;
    CREATE TABLE context_artifacts (
      id                         TEXT PRIMARY KEY,
      kind                       TEXT NOT NULL,
      scope                      TEXT NOT NULL,
      project_path               TEXT NOT NULL,
      session_name               TEXT,
      conversation_id            TEXT NOT NULL,
      message_id                 TEXT,
      message_index              INTEGER,
      covered_start_seq          INTEGER NOT NULL,
      covered_end_seq            INTEGER NOT NULL,
      source_hash                TEXT NOT NULL,
      status                     TEXT NOT NULL,
      error                      TEXT,
      model_provider             TEXT NOT NULL,
      model                      TEXT NOT NULL,
      effort                     TEXT,
      schema_version             INTEGER NOT NULL,
      prompt_version             TEXT NOT NULL,
      normalizer_version         TEXT NOT NULL,
      created_by                 TEXT NOT NULL,
      created_by_conversation_id TEXT,
      payload_json               TEXT,
      created_at                 TEXT NOT NULL,
      updated_at                 TEXT NOT NULL
    );
    CREATE INDEX idx_context_artifacts_conversation
      ON context_artifacts (conversation_id, kind);
    CREATE INDEX idx_context_artifacts_scope
      ON context_artifacts (project_path, session_name);
    CREATE UNIQUE INDEX uq_context_artifacts_conversation_kind
      ON context_artifacts (conversation_id)
      WHERE kind = 'conversation_compaction';
    CREATE UNIQUE INDEX uq_context_artifacts_message
      ON context_artifacts (conversation_id, message_index)
      WHERE kind = 'message_compaction';
  `);
}

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeWorld(): {
  configDir: string;
  db: Db;
  projectPath: string;
  projectConfigPath: string;
  transcriptPath: string;
  workflowPath: string;
} {
  const configDir = mkdtempSync(
    path.join(os.tmpdir(), "cc-generalized-model-selection-"),
  );
  tempDirs.push(configDir);
  const db = _createTestDbAtPath(path.join(configDir, "command-center.db"));
  openDbs.push(db);
  replaceContextArtifactsWithLegacyTable(db);
  const projectPath = path.join(configDir, "project");
  mkdirSync(projectPath, { recursive: true });
  const projectConfigPath = path.join(projectPath, "CommandCenter.json");
  writeFileSync(
    projectConfigPath,
    JSON.stringify({
      agentBackends: { cursor: { supportedModels: ["composer-2.5"] } },
      compaction: {
        backend: "codex",
        conversationModel: "gpt-5.4",
        messageModel: "gpt-5.4-mini",
        effort: "high",
      },
    }),
  );

  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(projectPath);
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name, created_at,
       last_activity_at, workflow_envelopes
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    projectPath,
    SESSION_NAME,
    "/worktrees/legacy",
    "cc/legacy",
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
    JSON.stringify({
      "collab-1": {
        workflowType: "collaboration",
        status: "paused",
        featureSnapshot: {
          agents: {
            agent_one: {
              backend: "claude",
              model: "opus",
              effort: "high",
            },
            agent_two: {
              backend: "codex",
              model: "gpt-5.4",
              effort: "xhigh",
              fastMode: true,
            },
          },
        },
      },
    }),
  );

  const transcriptsDir = path.join(configDir, "transcripts");
  mkdirSync(transcriptsDir, { recursive: true });
  const transcriptPath = path.join(transcriptsDir, `${CONVERSATION_ID}.jsonl`);
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      timestamp: "2026-08-01T00:00:00.000Z",
      type: "user",
      role: "user",
      content: [{ type: "text", text: "hello" }],
      model: "gpt-5.4",
      effort: "xhigh",
      codexFastMode: true,
    })}\n${JSON.stringify({
      timestamp: "2026-08-01T00:00:01.000Z",
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
    })}\n`,
  );

  db.prepare(
    `INSERT INTO conversations (
       id, project_path, session_name, transcript_path, status, created_at,
       last_activity_at, agent_backend
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    CONVERSATION_ID,
    projectPath,
    SESSION_NAME,
    transcriptPath,
    "idle",
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
    "codex",
  );

  db.prepare(
    `INSERT INTO context_artifacts (
       id, kind, scope, project_path, session_name, conversation_id,
       message_id, message_index, covered_start_seq, covered_end_seq,
       source_hash, status, error, model_provider, model, effort,
       schema_version, prompt_version, normalizer_version, created_by,
       created_by_conversation_id, payload_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "artifact-legacy",
    "conversation_compaction",
    "session",
    projectPath,
    SESSION_NAME,
    CONVERSATION_ID,
    null,
    null,
    0,
    1,
    "source-hash",
    "complete",
    null,
    "codex",
    "gpt-5.4",
    "xhigh",
    1,
    "prompt-v1",
    "normalizer-v1",
    "user",
    null,
    null,
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
  );

  db.prepare(
    `INSERT INTO conversation_machine_snapshots (
       owner, conversation_id, snapshot_json, updated_at
     ) VALUES (?, ?, ?, ?)`,
  ).run(
    "session",
    CONVERSATION_ID,
    JSON.stringify({
      value: "executing",
      context: {
        agentBackend: "codex",
        activeTurn: {
          kind: "conversation_turn",
          modelId: "gpt-5.4",
          effort: "xhigh",
          codexFastMode: true,
        },
      },
    }),
    "2026-08-01T00:00:00.000Z",
  );

  db.prepare(
    `INSERT INTO graph_workflow_executions (
       project_path, session_name, execution_id, seed_definition_id,
       seed_definition_revision, started_at, status, definition_json,
       runtime_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    projectPath,
    SESSION_NAME,
    "execution-1",
    "definition-1",
    1,
    "2026-08-01T00:00:00.000Z",
    "paused",
    JSON.stringify({
      workingDefinition: {
        executionContexts: [
          {
            id: "implement",
            implementer: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
          },
        ],
      },
    }),
    JSON.stringify({}),
    "2026-08-01T00:00:00.000Z",
  );

  const workflowsDir = path.join(configDir, "workflows", "global.shared");
  mkdirSync(workflowsDir, { recursive: true });
  const workflowPath = path.join(workflowsDir, "definition-1.json");
  writeFileSync(
    workflowPath,
    JSON.stringify({
      id: "definition-1",
      definition: {
        workflowConfig: {
          implementer: {
            agent: {
              backend: "codex",
              model: "gpt-5.4",
              reasoningEffort: "high",
            },
          },
        },
      },
    }),
  );

  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      baseDir: "/repos",
      agentBackends: {
        claude: { model: "opus", reasoningEffort: "high" },
        codex: {
          model: "gpt-5.4",
          reasoningEffort: "xhigh",
          fastMode: true,
        },
        cursor: { model: "composer-2.5" },
      },
      compaction: {
        backend: "claude",
        conversationModel: "sonnet",
        messageModel: "sonnet",
        effort: "medium",
      },
      conversationNaming: {
        backend: "claude",
        model: "sonnet",
        effort: "low",
      },
      workflowDefaults: {
        implementer: {
          agent: {
            backend: "claude",
            model: "opus",
            reasoningEffort: "max",
          },
        },
      },
    }),
  );

  return {
    configDir,
    db,
    projectPath,
    projectConfigPath,
    transcriptPath,
    workflowPath,
  };
}

async function runMigration(world: {
  configDir: string;
  db: Db;
}): Promise<void> {
  await generalizedModelSelection.up({
    name: generalizedModelSelection.name,
    context: { db: world.db, configDir: world.configDir },
  });
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function seedLegacyWorkflowPadding(
  configDir: string,
  directoryName: string,
  count = 40,
): string {
  const workflowsDir = path.join(configDir, "workflows", directoryName);
  mkdirSync(workflowsDir, { recursive: true });
  const legacyWorkflow = {
    definition: {
      workflowConfig: {
        implementer: {
          agent: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
        },
      },
    },
  };
  for (let index = 0; index < count; index++) {
    writeFileSync(
      path.join(workflowsDir, `padding-${String(index).padStart(2, "0")}.json`),
      JSON.stringify(legacyWorkflow),
    );
  }
  return workflowsDir;
}

const LIVE_DELIVERY_PLAN_STATUSES = [
  "draft",
  "proposed",
  "approved",
  "parked",
  "launched",
] as const;

function legacyDeliveryPlanDocument(input: {
  holder: "attempt" | "snapshot";
  model?: string;
}): Record<string, unknown> {
  const opaqueProviderPayload = {
    model: "provider-owned-model",
    effort: "provider-owned-effort",
    codexFastMode: "provider-owned-fast-mode",
  };
  const legacyAgent = {
    backend: "claude",
    model: input.model ?? "sonnet",
    reasoningEffort: "medium",
  };
  return {
    schemaVersion: 2,
    launch: {
      name: `Legacy ${input.holder} launch`,
      description: null,
      definition: {
        schemaVersion: 1,
        workflowConfig:
          input.holder === "attempt"
            ? { implementer: { agent: legacyAgent } }
            : {},
        executionContexts:
          input.holder === "snapshot"
            ? [
                {
                  id: "implement",
                  implementer: legacyAgent,
                  outputSchema: {
                    examples: [structuredClone(opaqueProviderPayload)],
                  },
                },
              ]
            : [],
      },
      layout: {
        workflowId: `legacy-${input.holder}`,
        contextPositions: {},
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    },
    binding: {
      dispositions: [],
      claims: [],
      opaqueProviderPayload,
    },
  };
}

/**
 * The frozen candidate envelope a snapshot row actually stores: the plan
 * document is nested under `document`, and `candidate_hash` signs the whole
 * envelope's canonical bytes.
 */
function legacyCandidateRecord(input: {
  specId: string;
  attemptId: string;
  candidateId: string;
  pinnedRevisionId: string;
}): Record<string, unknown> {
  return {
    protocol: "native-sdd-delivery-candidate/v2",
    schemaVersion: 2,
    specId: input.specId,
    attemptId: input.attemptId,
    candidateId: input.candidateId,
    pinnedRevisionId: input.pinnedRevisionId,
    draftRevision: 1,
    document: legacyDeliveryPlanDocument({ holder: "snapshot" }),
  };
}

function candidateHashOfBytes(candidateBytes: string): string {
  return `sha256:${createHash("sha256").update(candidateBytes).digest("hex")}`;
}

function seedDeliveryPlanDocuments(
  db: Db,
  projectPath: string,
): {
  liveAttemptIds: string[];
  liveSnapshotIds: string[];
  archivedAttemptId: string;
  archivedSnapshotId: string;
  terminalLaunchAttemptId: string;
  terminalLaunchSnapshotId: string;
  seededCandidateHashes: Record<string, string>;
  approvedAttemptId: string;
  parkedAttemptId: string;
  launchedAttemptId: string;
} {
  const timestamp = "2026-08-02T00:00:00.000Z";
  const specId = "spec-model-selection-migration";
  const revisionId = "revision-model-selection-migration";
  const actor = '{"kind":"agent","conversationId":"migration-test"}';
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    specId,
    projectPath,
    "model-selection-migration",
    "Model selection migration",
    '{"preset":"contract-bearing"}',
    timestamp,
    timestamp,
  );
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, authoring_stage, content_hash, created_at
     ) VALUES (?, ?, 1, 'approved', 'plan', ?, ?)`,
  ).run(revisionId, specId, "a".repeat(64), timestamp);

  const insertAttempt = db.prepare(
    `INSERT INTO spec_delivery_plan_attempts (
       id, spec_id, pinned_revision_id, status, draft_revision, content_json,
       proposed_snapshot_id, approval_json, prelaunch_json, created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSnapshot = db.prepare(
    `INSERT INTO spec_delivery_plan_snapshots (
       id, attempt_id, candidate_id, candidate_hash, draft_revision,
       content_json, pinned_revision_id, proposed_at, proposed_by_json
     ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  );
  const seededCandidateHashes: Record<string, string> = {};
  const seedSnapshot = (input: {
    snapshotId: string;
    attemptId: string;
    candidateId: string;
  }): string => {
    const candidateBytes = stableStringify(
      legacyCandidateRecord({
        specId,
        attemptId: input.attemptId,
        candidateId: input.candidateId,
        pinnedRevisionId: revisionId,
      }),
    );
    const candidateHash = candidateHashOfBytes(candidateBytes);
    seededCandidateHashes[input.snapshotId] = candidateHash;
    insertSnapshot.run(
      input.snapshotId,
      input.attemptId,
      input.candidateId,
      candidateHash,
      candidateBytes,
      revisionId,
      timestamp,
      actor,
    );
    return candidateHash;
  };

  const liveAttemptIds: string[] = [];
  const liveSnapshotIds: string[] = [];
  // Every live status carries its frozen snapshot, and the statuses that bind
  // a candidate carry the binding a re-signed snapshot has to keep coherent.
  for (const status of LIVE_DELIVERY_PLAN_STATUSES) {
    const attemptId = `attempt-${status}`;
    const snapshotId = `snapshot-${status}`;
    const candidateId = `candidate-${status}`;
    liveAttemptIds.push(attemptId);
    liveSnapshotIds.push(snapshotId);
    insertAttempt.run(
      attemptId,
      specId,
      revisionId,
      status,
      JSON.stringify(legacyDeliveryPlanDocument({ holder: "attempt" })),
      null,
      null,
      null,
      timestamp,
      timestamp,
    );
    const candidateHash = seedSnapshot({ snapshotId, attemptId, candidateId });
    const binds = status === "approved" || status === "launched";
    db.prepare(
      `UPDATE spec_delivery_plan_attempts
       SET proposed_snapshot_id = ?, approval_json = ?, prelaunch_json = ?
       WHERE id = ?`,
    ).run(
      status === "draft" ? null : snapshotId,
      binds
        ? stableStringify({
            candidateId,
            candidateHash,
            snapshotId,
            approvedAt: timestamp,
            approvedBy: JSON.parse(actor) as unknown,
          })
        : null,
      status === "parked"
        ? stableStringify({
            parkedAt: timestamp,
            parkedBy: JSON.parse(actor) as unknown,
            reason: null,
            candidate: { candidateId, candidateHash },
            approvedAtPark: false,
          })
        : null,
      attemptId,
    );
  }

  const archivedAttemptId = "attempt-abandoned";
  const archivedSnapshotId = "snapshot-abandoned";
  insertAttempt.run(
    archivedAttemptId,
    specId,
    revisionId,
    "abandoned",
    JSON.stringify(legacyDeliveryPlanDocument({ holder: "attempt" })),
    archivedSnapshotId,
    null,
    null,
    timestamp,
    timestamp,
  );
  seedSnapshot({
    snapshotId: archivedSnapshotId,
    attemptId: archivedAttemptId,
    candidateId: "candidate-abandoned",
  });

  const terminalExecutionId = "execution-delivered-archive";
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'delivered', ?, ?)`,
  ).run(
    terminalExecutionId,
    specId,
    revisionId,
    '{"kind":"full"}',
    timestamp,
    timestamp,
  );
  const terminalLaunchAttemptId = "attempt-launched-delivered";
  const terminalLaunchSnapshotId = "snapshot-launched-delivered";
  db.prepare(
    `INSERT INTO spec_delivery_plan_attempts (
       id, spec_id, pinned_revision_id, status, draft_revision, content_json,
       launched_execution_id, created_at, updated_at
     ) VALUES (?, ?, ?, 'launched', 1, ?, ?, ?, ?)`,
  ).run(
    terminalLaunchAttemptId,
    specId,
    revisionId,
    JSON.stringify(legacyDeliveryPlanDocument({ holder: "attempt" })),
    terminalExecutionId,
    timestamp,
    timestamp,
  );
  seedSnapshot({
    snapshotId: terminalLaunchSnapshotId,
    attemptId: terminalLaunchAttemptId,
    candidateId: "candidate-launched-delivered",
  });

  return {
    liveAttemptIds,
    liveSnapshotIds,
    archivedAttemptId,
    archivedSnapshotId,
    terminalLaunchAttemptId,
    terminalLaunchSnapshotId,
    seededCandidateHashes,
    approvedAttemptId: "attempt-approved",
    parkedAttemptId: "attempt-parked",
    launchedAttemptId: "attempt-launched",
  };
}

describe("0035 generalized model selection cutover", () => {
  it("atomically migrates every resumable holder to complete model selections", async () => {
    const world = makeWorld();

    await runMigration(world);

    const config = readJson(path.join(world.configDir, "config.json"));
    expect(config).toMatchObject({
      agentBackends: {
        claude: {
          modelSelection: {
            modelId: "opus",
            parameters: { effort: "high" },
          },
        },
        codex: {
          modelSelection: {
            modelId: "gpt-5.4",
            parameters: { reasoning: "xhigh", fast: "true" },
          },
        },
        cursor: {
          modelSelection: {
            modelId: "composer-2.5",
            parameters: { fast: "true" },
          },
        },
      },
      compaction: {
        backend: "claude",
        conversationModelSelection: {
          modelId: "sonnet",
          parameters: { effort: "medium" },
        },
        messageModelSelection: {
          modelId: "sonnet",
          parameters: { effort: "medium" },
        },
      },
      conversationNaming: {
        backend: "claude",
        modelSelection: {
          modelId: "sonnet",
          parameters: { effort: "low" },
        },
      },
      workflowDefaults: {
        implementer: {
          agent: {
            backend: "claude",
            modelSelection: {
              modelId: "opus",
              parameters: { effort: "max" },
            },
          },
        },
      },
    });

    const workflow = readJson(world.workflowPath);
    expect(workflow).toMatchObject({
      definition: {
        workflowConfig: {
          implementer: {
            agent: {
              backend: "codex",
              modelSelection: {
                modelId: "gpt-5.4",
                parameters: { reasoning: "high", fast: "false" },
              },
            },
          },
        },
      },
    });

    expect(readJson(world.projectConfigPath)).toMatchObject({
      agentBackends: { cursor: { supportedModels: ["composer-2.5"] } },
      compaction: {
        backend: "codex",
        conversationModelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
        messageModelSelection: {
          modelId: "gpt-5.4-mini",
          parameters: { reasoning: "high", fast: "false" },
        },
      },
    });

    const transcriptLines = readFileSync(world.transcriptPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(transcriptLines[0]).toMatchObject({
      modelSelection: {
        modelId: "gpt-5.4",
        parameters: { reasoning: "xhigh", fast: "true" },
      },
    });
    expect(transcriptLines[0]).not.toHaveProperty("model");
    expect(transcriptLines[0]).not.toHaveProperty("effort");
    expect(transcriptLines[0]).not.toHaveProperty("codexFastMode");

    const snapshotRow = world.db
      .prepare(
        `SELECT snapshot_json FROM conversation_machine_snapshots
         WHERE owner = 'session' AND conversation_id = ?`,
      )
      .get(CONVERSATION_ID) as { snapshot_json: string };
    const snapshot = JSON.parse(snapshotRow.snapshot_json) as {
      context: { activeTurn: Record<string, unknown> };
    };
    expect(snapshot.context.activeTurn).toMatchObject({
      modelSelection: {
        modelId: "gpt-5.4",
        parameters: { reasoning: "xhigh", fast: "true" },
      },
    });
    expect(snapshot.context.activeTurn).not.toHaveProperty("modelId");
    expect(snapshot.context.activeTurn).not.toHaveProperty("effort");
    expect(snapshot.context.activeTurn).not.toHaveProperty("codexFastMode");

    const executionRow = world.db
      .prepare(
        `SELECT definition_json FROM graph_workflow_executions
         WHERE project_path = ? AND session_name = ?`,
      )
      .get(world.projectPath, SESSION_NAME) as { definition_json: string };
    expect(JSON.parse(executionRow.definition_json)).toMatchObject({
      workingDefinition: {
        executionContexts: [
          {
            implementer: {
              backend: "claude",
              modelSelection: {
                modelId: "sonnet",
                parameters: { effort: "medium" },
              },
            },
          },
        ],
      },
    });

    const sessionRow = world.db
      .prepare(
        `SELECT workflow_envelopes FROM sessions
         WHERE project_path = ? AND session_name = ?`,
      )
      .get(world.projectPath, SESSION_NAME) as { workflow_envelopes: string };
    expect(JSON.parse(sessionRow.workflow_envelopes)).toMatchObject({
      "collab-1": {
        featureSnapshot: {
          agents: {
            agent_one: {
              backend: "claude",
              modelSelection: {
                modelId: "opus",
                parameters: { effort: "high" },
              },
            },
            agent_two: {
              backend: "codex",
              modelSelection: {
                modelId: "gpt-5.4",
                parameters: { reasoning: "xhigh", fast: "true" },
              },
            },
          },
        },
      },
    });

    const artifactColumns = (
      world.db.prepare("PRAGMA table_info(context_artifacts)").all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name);
    expect(artifactColumns).toContain("backend");
    expect(artifactColumns).toContain("model_selection_json");
    expect(artifactColumns).not.toContain("model_provider");
    expect(artifactColumns).not.toContain("model");
    expect(artifactColumns).not.toContain("effort");
    expect(
      world.db
        .prepare(
          `SELECT backend, model_selection_json
           FROM context_artifacts WHERE id = ?`,
        )
        .get("artifact-legacy"),
    ).toEqual({
      backend: "codex",
      model_selection_json: JSON.stringify({
        modelId: "gpt-5.4",
        parameters: { fast: "false", reasoning: "xhigh" },
      }),
    });

    expect(
      existsSync(
        schemaCompatibilityBarrierPath(
          world.configDir,
          GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION,
        ),
      ),
    ).toBe(true);
    expect(
      world.db
        .prepare("SELECT description FROM schema_migrations WHERE version = ?")
        .get(GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION),
    ).toEqual({ description: "generalized model selection" });

    const bytesAfterFirstRun = {
      config: readFileSync(path.join(world.configDir, "config.json"), "utf8"),
      projectConfig: readFileSync(world.projectConfigPath, "utf8"),
      workflow: readFileSync(world.workflowPath, "utf8"),
      transcript: readFileSync(world.transcriptPath, "utf8"),
      snapshot: snapshotRow.snapshot_json,
      execution: executionRow.definition_json,
      envelopes: sessionRow.workflow_envelopes,
    };

    await runMigration(world);

    expect({
      config: readFileSync(path.join(world.configDir, "config.json"), "utf8"),
      projectConfig: readFileSync(world.projectConfigPath, "utf8"),
      workflow: readFileSync(world.workflowPath, "utf8"),
      transcript: readFileSync(world.transcriptPath, "utf8"),
      snapshot: (
        world.db
          .prepare(
            "SELECT snapshot_json FROM conversation_machine_snapshots WHERE owner = 'session' AND conversation_id = ?",
          )
          .get(CONVERSATION_ID) as { snapshot_json: string }
      ).snapshot_json,
      execution: (
        world.db
          .prepare(
            "SELECT definition_json FROM graph_workflow_executions WHERE project_path = ? AND session_name = ?",
          )
          .get(world.projectPath, SESSION_NAME) as { definition_json: string }
      ).definition_json,
      envelopes: (
        world.db
          .prepare(
            "SELECT workflow_envelopes FROM sessions WHERE project_path = ? AND session_name = ?",
          )
          .get(world.projectPath, SESSION_NAME) as {
          workflow_envelopes: string;
        }
      ).workflow_envelopes,
    }).toEqual(bytesAfterFirstRun);
  });

  it("migrates only the transcript entry selection and preserves nested provider payloads", async () => {
    const world = makeWorld();
    const content = [
      {
        type: "tool_use",
        id: "tool-1",
        name: "configure_provider",
        input: {
          provider: {
            model: "provider-model-v2",
            effort: "adaptive",
            fast: "auto",
          },
          request: {
            modelId: "request-model-id",
            effort: "provider-default",
            fast: false,
          },
        },
      },
    ];
    const raw = {
      type: "response.completed",
      response: {
        model: "provider-response-model",
        effort: "provider-effort",
        fast: true,
        metadata: {
          backend: "codex",
          modelId: "provider-metadata-model-id",
          effort: "metadata-effort",
          fast: false,
        },
      },
    };
    writeFileSync(
      world.transcriptPath,
      `${JSON.stringify({
        timestamp: "2026-08-01T00:00:00.000Z",
        type: "user",
        role: "user",
        content,
        raw,
        model: "gpt-5.4",
        effort: "xhigh",
        codexFastMode: true,
      })}\n`,
    );

    await runMigration(world);

    const migrated = JSON.parse(
      readFileSync(world.transcriptPath, "utf8").trim(),
    ) as Record<string, unknown>;
    expect(migrated.modelSelection).toEqual({
      modelId: "gpt-5.4",
      parameters: { fast: "true", reasoning: "xhigh" },
    });
    expect(migrated.content).toEqual(content);
    expect(migrated.raw).toEqual(raw);
  });

  it("migrates a transcript effort recorded against a Claude model that has no effort parameter", async () => {
    const world = makeWorld();
    world.db
      .prepare("UPDATE conversations SET agent_backend = ? WHERE id = ?")
      .run("claude", CONVERSATION_ID);
    writeFileSync(
      world.transcriptPath,
      `${JSON.stringify({
        timestamp: "2026-08-01T00:00:00.000Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "test" }],
        model: "haiku",
        effort: "xhigh",
      })}\n`,
    );

    await runMigration(world);

    const migrated = JSON.parse(
      readFileSync(world.transcriptPath, "utf8").trim(),
    ) as Record<string, unknown>;
    expect(migrated.modelSelection).toEqual({
      modelId: "haiku",
      parameters: {},
    });
    expect(migrated).not.toHaveProperty("effort");
  });

  it("migrates documented holders while preserving opaque config, snapshot, and workflow payloads", async () => {
    const world = makeWorld();
    const opaqueProviderPayload = {
      backend: "codex",
      model: "gpt-5.4",
      effort: "high",
      fast: true,
      providerMetadata: {
        modelId: "provider-metadata-model",
        effort: "high",
        fast: false,
      },
    };

    const configPath = path.join(world.configDir, "config.json");
    const config = readJson(configPath);
    const agentBackends = config.agentBackends as Record<
      string,
      Record<string, unknown>
    >;
    const codexBackend = agentBackends["codex"];
    if (codexBackend === undefined) {
      throw new Error("Migration fixture is missing the Codex backend profile");
    }
    codexBackend["providerOptions"] = {
      requestTemplate: structuredClone(opaqueProviderPayload),
    };
    writeFileSync(configPath, JSON.stringify(config));

    const snapshotRow = world.db
      .prepare(
        `SELECT snapshot_json FROM conversation_machine_snapshots
         WHERE owner = 'session' AND conversation_id = ?`,
      )
      .get(CONVERSATION_ID) as { snapshot_json: string };
    const snapshot = JSON.parse(snapshotRow.snapshot_json) as {
      context: { activeTurn: Record<string, unknown> };
    };
    snapshot.context.activeTurn.outputFormat = {
      type: "json_schema",
      schema: {
        type: "object",
        examples: [structuredClone(opaqueProviderPayload)],
      },
    };
    world.db
      .prepare(
        `UPDATE conversation_machine_snapshots
         SET snapshot_json = ?
         WHERE owner = 'session' AND conversation_id = ?`,
      )
      .run(JSON.stringify(snapshot), CONVERSATION_ID);

    const workflow = readJson(world.workflowPath);
    const definition = workflow.definition as Record<string, unknown>;
    definition.executionContexts = [
      {
        id: "structured-output",
        implementer: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
        outputSchema: {
          type: "object",
          examples: [structuredClone(opaqueProviderPayload)],
        },
      },
    ];
    writeFileSync(world.workflowPath, JSON.stringify(workflow));

    const runtime = {
      contextStates: {
        "structured-output": {
          output: structuredClone(opaqueProviderPayload),
        },
      },
    };
    world.db
      .prepare(
        `UPDATE graph_workflow_executions
         SET runtime_json = ?
         WHERE project_path = ? AND session_name = ?`,
      )
      .run(JSON.stringify(runtime), world.projectPath, SESSION_NAME);

    const workflowLanes = {
      background: {
        providerResult: structuredClone(opaqueProviderPayload),
      },
    };
    world.db
      .prepare(
        `UPDATE sessions
         SET workflow_lanes = ?
         WHERE project_path = ? AND session_name = ?`,
      )
      .run(JSON.stringify(workflowLanes), world.projectPath, SESSION_NAME);

    await runMigration(world);

    const migratedConfig = readJson(configPath);
    const migratedCodexBackend = (
      migratedConfig.agentBackends as Record<string, Record<string, unknown>>
    )["codex"];
    if (migratedCodexBackend === undefined) {
      throw new Error("Migrated config is missing the Codex backend profile");
    }
    expect(
      (migratedCodexBackend["providerOptions"] as Record<string, unknown>)
        .requestTemplate,
    ).toEqual(opaqueProviderPayload);

    const migratedSnapshotRow = world.db
      .prepare(
        `SELECT snapshot_json FROM conversation_machine_snapshots
         WHERE owner = 'session' AND conversation_id = ?`,
      )
      .get(CONVERSATION_ID) as { snapshot_json: string };
    const migratedSnapshot = JSON.parse(migratedSnapshotRow.snapshot_json) as {
      context: { activeTurn: Record<string, unknown> };
    };
    expect(migratedSnapshot.context.activeTurn).toMatchObject({
      modelSelection: {
        modelId: "gpt-5.4",
        parameters: { fast: "true", reasoning: "xhigh" },
      },
    });
    expect(
      (
        (
          migratedSnapshot.context.activeTurn.outputFormat as Record<
            string,
            unknown
          >
        ).schema as Record<string, unknown>
      ).examples,
    ).toEqual([opaqueProviderPayload]);

    const migratedWorkflow = readJson(world.workflowPath);
    const migratedContexts = (
      migratedWorkflow.definition as {
        executionContexts: Array<Record<string, unknown>>;
      }
    ).executionContexts;
    expect(migratedContexts[0]?.implementer).toEqual({
      backend: "claude",
      modelSelection: {
        modelId: "sonnet",
        parameters: { effort: "medium" },
      },
    });
    expect(
      (migratedContexts[0]?.outputSchema as Record<string, unknown>).examples,
    ).toEqual([opaqueProviderPayload]);

    const executionRow = world.db
      .prepare(
        `SELECT runtime_json FROM graph_workflow_executions
         WHERE project_path = ? AND session_name = ?`,
      )
      .get(world.projectPath, SESSION_NAME) as { runtime_json: string };
    expect(JSON.parse(executionRow.runtime_json)).toEqual(runtime);

    const sessionRow = world.db
      .prepare(
        `SELECT workflow_lanes FROM sessions
         WHERE project_path = ? AND session_name = ?`,
      )
      .get(world.projectPath, SESSION_NAME) as { workflow_lanes: string };
    expect(JSON.parse(sessionRow.workflow_lanes)).toEqual(workflowLanes);
  });

  it("uses the frozen compaction defaults when legacy fields are omitted", async () => {
    const world = makeWorld();
    const configPath = path.join(world.configDir, "config.json");
    const config = readJson(configPath);
    config.compaction = { conversationModel: "sonnet" };
    writeFileSync(configPath, JSON.stringify(config));

    await runMigration(world);

    expect(readJson(configPath).compaction).toEqual({
      conversationModelSelection: {
        modelId: "sonnet",
        parameters: { effort: "medium" },
      },
      messageModelSelection: {
        modelId: "sonnet",
        parameters: { effort: "medium" },
      },
    });
  });

  it("uses the frozen naming backend and effort defaults when they are omitted", async () => {
    const world = makeWorld();
    const configPath = path.join(world.configDir, "config.json");
    const config = readJson(configPath);
    config.conversationNaming = { model: "sonnet" };
    writeFileSync(configPath, JSON.stringify(config));

    await runMigration(world);

    expect(readJson(configPath).conversationNaming).toEqual({
      modelSelection: {
        modelId: "sonnet",
        parameters: { effort: "low" },
      },
    });
  });

  it("preserves the materialized historical naming default for a model without effort", async () => {
    const world = makeWorld();
    const configPath = path.join(world.configDir, "config.json");
    const config = readJson(configPath);
    config.conversationNaming = {
      enabled: true,
      backend: "claude",
      model: "haiku",
      effort: "low",
      timeoutMs: null,
    };
    writeFileSync(configPath, JSON.stringify(config));

    await runMigration(world);

    expect(readJson(configPath).conversationNaming).toEqual({
      enabled: true,
      backend: "claude",
      modelSelection: { modelId: "haiku", parameters: {} },
      timeoutMs: null,
    });
  });

  it("preflights holder counts without changing files, the database, the barrier, or the ledger", async () => {
    const world = makeWorld();
    const filesBefore = {
      config: readFileSync(path.join(world.configDir, "config.json"), "utf8"),
      projectConfig: readFileSync(world.projectConfigPath, "utf8"),
      transcript: readFileSync(world.transcriptPath, "utf8"),
      workflow: readFileSync(world.workflowPath, "utf8"),
    };
    const databaseBefore = world.db.serialize();

    await expect(
      preflightGeneralizedModelSelection({
        db: world.db,
        configDir: world.configDir,
      }),
    ).resolves.toEqual({
      configCount: 2,
      snapshotCount: 1,
      transcriptCount: 1,
      workflowCount: 3,
      contextArtifactCount: 1,
    });

    expect({
      config: readFileSync(path.join(world.configDir, "config.json"), "utf8"),
      projectConfig: readFileSync(world.projectConfigPath, "utf8"),
      transcript: readFileSync(world.transcriptPath, "utf8"),
      workflow: readFileSync(world.workflowPath, "utf8"),
    }).toEqual(filesBefore);
    expect(world.db.serialize()).toEqual(databaseBefore);
    expect(
      existsSync(
        schemaCompatibilityBarrierPath(
          world.configDir,
          GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION,
        ),
      ),
    ).toBe(false);
    expect(
      world.db
        .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
        .get(GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION),
    ).toBeUndefined();
  });

  it("accepts an already-canonical selection regardless of parameter insertion order", async () => {
    const world = makeWorld();
    const configPath = path.join(world.configDir, "config.json");
    const config = readJson(configPath);
    const agentBackends = config.agentBackends as Record<
      string,
      Record<string, unknown>
    >;
    agentBackends.codex = {
      modelSelection: {
        modelId: "gpt-5.4",
        parameters: { fast: "true", reasoning: "xhigh" },
      },
    };
    writeFileSync(configPath, JSON.stringify(config));

    await expect(runMigration(world)).resolves.toBeUndefined();
  });

  it("preserves an all-null legacy active-turn selection as the atomic no-selection sentinel", async () => {
    const world = makeWorld();
    const row = world.db
      .prepare(
        `SELECT snapshot_json FROM conversation_machine_snapshots
         WHERE owner = 'session' AND conversation_id = ?`,
      )
      .get(CONVERSATION_ID) as { snapshot_json: string };
    const snapshot = JSON.parse(row.snapshot_json) as {
      context: { activeTurn: Record<string, unknown> };
    };
    snapshot.context.activeTurn = {
      kind: "conversation_turn",
      modelId: null,
      effort: null,
      codexFastMode: null,
    };
    world.db
      .prepare(
        `UPDATE conversation_machine_snapshots
         SET snapshot_json = ?
         WHERE owner = 'session' AND conversation_id = ?`,
      )
      .run(JSON.stringify(snapshot), CONVERSATION_ID);

    await runMigration(world);

    const migratedRow = world.db
      .prepare(
        `SELECT snapshot_json FROM conversation_machine_snapshots
         WHERE owner = 'session' AND conversation_id = ?`,
      )
      .get(CONVERSATION_ID) as { snapshot_json: string };
    const activeTurn = (
      JSON.parse(migratedRow.snapshot_json) as {
        context: { activeTurn: Record<string, unknown> };
      }
    ).context.activeTurn;
    expect(activeTurn).toEqual({
      kind: "conversation_turn",
      modelSelection: null,
    });
  });

  it("allows overlapping workers to finish after an identical stale plan was already applied", async () => {
    const world = makeWorld();

    await expect(
      Promise.all([runMigration(world), runMigration(world)]),
    ).resolves.toEqual([undefined, undefined]);

    const artifactColumns = (
      world.db.prepare("PRAGMA table_info(context_artifacts)").all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name);
    expect(artifactColumns).toContain("model_selection_json");
    expect(artifactColumns).not.toContain("model_provider");
    expect(
      world.db
        .prepare("SELECT description FROM schema_migrations WHERE version = ?")
        .get(GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION),
    ).toEqual({ description: "generalized model selection" });
  });

  it("refuses to overwrite divergent file bytes written after preflight", async () => {
    const world = makeWorld();
    const workflowsDir = seedLegacyWorkflowPadding(
      world.configDir,
      "zz-witness",
    );
    const divergentPath = path.join(workflowsDir, "zz-divergent.json");
    writeFileSync(
      divergentPath,
      readFileSync(path.join(workflowsDir, "padding-00.json"), "utf8"),
    );
    const divergentBytes = JSON.stringify({
      id: "operator-edit",
      definition: {},
    });
    const barrierPath = schemaCompatibilityBarrierPath(
      world.configDir,
      GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION,
    );

    const migration = runMigration(world);
    const writeDivergence = (async () => {
      await vi.waitFor(() => expect(existsSync(barrierPath)).toBe(true), {
        timeout: 5_000,
        interval: 1,
      });
      writeFileSync(divergentPath, divergentBytes);
    })();

    await expect(Promise.all([migration, writeDivergence])).rejects.toThrow(
      `lost its preflight witness for ${divergentPath}`,
    );
    expect(readFileSync(divergentPath, "utf8")).toBe(divergentBytes);
    expect(
      world.db
        .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
        .get(GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION),
    ).toBeUndefined();
  });

  it("preflights and migrates discoverable repositories that are absent from the projects table", async () => {
    const world = makeWorld();
    const baseDir = path.join(world.configDir, "repos");
    const undiscoveredProjectPath = path.join(baseDir, "not-yet-persisted");
    const undiscoveredConfigPath = path.join(
      undiscoveredProjectPath,
      "CommandCenter.json",
    );
    mkdirSync(path.join(undiscoveredProjectPath, ".git"), { recursive: true });
    writeFileSync(
      undiscoveredConfigPath,
      JSON.stringify({
        compaction: {
          backend: "codex",
          conversationModel: "gpt-5.4",
          messageModel: "gpt-5.4-mini",
          effort: "high",
        },
      }),
    );
    const globalConfigPath = path.join(world.configDir, "config.json");
    const globalConfig = readJson(globalConfigPath);
    globalConfig.baseDir = baseDir;
    writeFileSync(globalConfigPath, JSON.stringify(globalConfig));

    expect(
      world.db
        .prepare("SELECT 1 FROM projects WHERE root_path = ?")
        .get(undiscoveredProjectPath),
    ).toBeUndefined();
    await expect(
      preflightGeneralizedModelSelection({
        db: world.db,
        configDir: world.configDir,
      }),
    ).resolves.toMatchObject({ configCount: 3 });

    await runMigration(world);

    expect(readJson(undiscoveredConfigPath).compaction).toEqual({
      backend: "codex",
      conversationModelSelection: {
        modelId: "gpt-5.4",
        parameters: { fast: "false", reasoning: "high" },
      },
      messageModelSelection: {
        modelId: "gpt-5.4-mini",
        parameters: { fast: "false", reasoning: "high" },
      },
    });
  });

  it("accepts an already-atomic non-default Cursor variant", async () => {
    const world = makeWorld();
    const configPath = path.join(world.configDir, "config.json");
    const config = readJson(configPath);
    const agentBackends = config.agentBackends as Record<
      string,
      Record<string, unknown>
    >;
    agentBackends.cursor = {
      modelSelection: {
        modelId: "grok-4.6",
        parameters: { effort: "low", fast: "false" },
      },
    };
    writeFileSync(configPath, JSON.stringify(config));

    await expect(runMigration(world)).resolves.toBeUndefined();
    expect(
      (
        readJson(configPath).agentBackends as Record<
          string,
          Record<string, unknown>
        >
      ).cursor,
    ).toEqual(agentBackends.cursor);
  });

  it("canonicalizes a unique Cursor alias in an already-atomic selection", async () => {
    const world = makeWorld();
    const configPath = path.join(world.configDir, "config.json");
    const config = readJson(configPath);
    const agentBackends = config.agentBackends as Record<
      string,
      Record<string, unknown>
    >;
    agentBackends.cursor = {
      modelSelection: {
        modelId: "composer-latest",
        parameters: { fast: "false" },
      },
    };
    writeFileSync(configPath, JSON.stringify(config));

    await runMigration(world);

    expect(
      (
        readJson(configPath).agentBackends as Record<
          string,
          Record<string, unknown>
        >
      ).cursor,
    ).toEqual({
      modelSelection: {
        modelId: "composer-2.5",
        parameters: { fast: "false" },
      },
    });
  });

  it("canonicalizes a unique Cursor alias in an already-atomic context artifact", async () => {
    const world = makeWorld();
    await runMigration(world);
    world.db
      .prepare(
        `UPDATE context_artifacts
         SET backend = 'cursor', model_selection_json = ?
         WHERE id = 'artifact-legacy'`,
      )
      .run(
        JSON.stringify({
          modelId: "composer-latest",
          parameters: { fast: "false" },
        }),
      );

    await expect(
      preflightGeneralizedModelSelection({
        db: world.db,
        configDir: world.configDir,
      }),
    ).resolves.toMatchObject({ contextArtifactCount: 1 });
    await expect(
      Promise.all([runMigration(world), runMigration(world)]),
    ).resolves.toEqual([undefined, undefined]);

    expect(
      world.db
        .prepare(
          `SELECT backend, model_selection_json
           FROM context_artifacts WHERE id = 'artifact-legacy'`,
        )
        .get(),
    ).toEqual({
      backend: "cursor",
      model_selection_json: JSON.stringify({
        modelId: "composer-2.5",
        parameters: { fast: "false" },
      }),
    });
  });

  it("refuses a divergent atomic context-artifact row after preflight", async () => {
    const world = makeWorld();
    await runMigration(world);
    world.db
      .prepare(
        `UPDATE context_artifacts
         SET backend = 'cursor', model_selection_json = ?
         WHERE id = 'artifact-legacy'`,
      )
      .run(
        JSON.stringify({
          modelId: "composer-latest",
          parameters: { fast: "false" },
        }),
      );
    seedLegacyWorkflowPadding(world.configDir, "zz-context-cas");
    const barrierPath = schemaCompatibilityBarrierPath(
      world.configDir,
      GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION,
    );
    rmSync(barrierPath, { force: true });
    world.db
      .prepare("DELETE FROM schema_migrations WHERE version = ?")
      .run(GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION);
    const divergentSelection = JSON.stringify({
      modelId: "composer-2.5",
      parameters: { fast: "true" },
    });

    const migration = runMigration(world);
    const writeDivergence = (async () => {
      await vi.waitFor(() => expect(existsSync(barrierPath)).toBe(true), {
        timeout: 5_000,
        interval: 1,
      });
      world.db
        .prepare(
          `UPDATE context_artifacts SET model_selection_json = ?
           WHERE id = 'artifact-legacy'`,
        )
        .run(divergentSelection);
    })();

    await expect(Promise.all([migration, writeDivergence])).rejects.toThrow(
      "lost its preflight witness for context_artifacts.id=artifact-legacy",
    );
    expect(
      world.db
        .prepare(
          "SELECT model_selection_json FROM context_artifacts WHERE id = 'artifact-legacy'",
        )
        .get(),
    ).toEqual({ model_selection_json: divergentSelection });
    expect(
      world.db
        .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
        .get(GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION),
    ).toBeUndefined();
  });

  it("refuses an already-atomic Cursor selection that is not one exact variant", async () => {
    const world = makeWorld();
    const configPath = path.join(world.configDir, "config.json");
    const config = readJson(configPath);
    const agentBackends = config.agentBackends as Record<
      string,
      Record<string, unknown>
    >;
    agentBackends.cursor = {
      modelSelection: {
        modelId: "grok-4.6",
        parameters: { effort: "low", fast: "sometimes" },
      },
    };
    writeFileSync(configPath, JSON.stringify(config));

    await expect(runMigration(world)).rejects.toMatchObject({
      holder: `${configPath}.agentBackends.cursor`,
      reasonCode: "invalid_model_selection",
    });
    expect(
      existsSync(
        schemaCompatibilityBarrierPath(
          world.configDir,
          GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION,
        ),
      ),
    ).toBe(false);
  });

  it("refuses extra properties inside an otherwise valid atomic selection", async () => {
    const world = makeWorld();
    const configPath = path.join(world.configDir, "config.json");
    const config = readJson(configPath);
    const agentBackends = config.agentBackends as Record<
      string,
      Record<string, unknown>
    >;
    agentBackends.cursor = {
      modelSelection: {
        modelId: "grok-4.6",
        parameters: { effort: "low", fast: "false" },
        legacy: true,
      },
    };
    writeFileSync(configPath, JSON.stringify(config));

    await expect(runMigration(world)).rejects.toMatchObject({
      holder: `${configPath}.agentBackends.cursor`,
      reasonCode: "invalid_model_selection",
    });
    expect(
      existsSync(
        schemaCompatibilityBarrierPath(
          world.configDir,
          GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION,
        ),
      ),
    ).toBe(false);
  });

  it("migrates delivery-plan launch definitions for every live status while preserving abandoned archives and opaque payloads", async () => {
    const world = makeWorld();
    const seeded = seedDeliveryPlanDocuments(world.db, world.projectPath);
    const archivedBefore = {
      attempt: (
        world.db
          .prepare(
            "SELECT content_json FROM spec_delivery_plan_attempts WHERE id = ?",
          )
          .get(seeded.archivedAttemptId) as { content_json: string }
      ).content_json,
      snapshot: (
        world.db
          .prepare(
            "SELECT content_json FROM spec_delivery_plan_snapshots WHERE id = ?",
          )
          .get(seeded.archivedSnapshotId) as { content_json: string }
      ).content_json,
      terminalLaunchAttempt: (
        world.db
          .prepare(
            "SELECT content_json FROM spec_delivery_plan_attempts WHERE id = ?",
          )
          .get(seeded.terminalLaunchAttemptId) as { content_json: string }
      ).content_json,
      terminalLaunchSnapshot: (
        world.db
          .prepare(
            "SELECT content_json FROM spec_delivery_plan_snapshots WHERE id = ?",
          )
          .get(seeded.terminalLaunchSnapshotId) as { content_json: string }
      ).content_json,
    };
    const databaseBeforePreflight = world.db.serialize();

    await expect(
      preflightGeneralizedModelSelection({
        db: world.db,
        configDir: world.configDir,
      }),
    ).resolves.toMatchObject({ workflowCount: 13 });
    expect(world.db.serialize()).toEqual(databaseBeforePreflight);
    expect(
      existsSync(
        schemaCompatibilityBarrierPath(
          world.configDir,
          GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION,
        ),
      ),
    ).toBe(false);

    await runMigration(world);

    const opaqueProviderPayload = {
      model: "provider-owned-model",
      effort: "provider-owned-effort",
      codexFastMode: "provider-owned-fast-mode",
    };
    for (const attemptId of seeded.liveAttemptIds) {
      const row = world.db
        .prepare(
          "SELECT content_json FROM spec_delivery_plan_attempts WHERE id = ?",
        )
        .get(attemptId) as { content_json: string };
      const document = JSON.parse(row.content_json) as {
        launch: {
          definition: {
            workflowConfig: {
              implementer: { agent: Record<string, unknown> };
            };
          };
        };
        binding: { opaqueProviderPayload: unknown };
      };
      expect(
        document.launch.definition.workflowConfig.implementer.agent,
      ).toEqual({
        backend: "claude",
        modelSelection: {
          modelId: "sonnet",
          parameters: { effort: "medium" },
        },
      });
      expect(document.binding.opaqueProviderPayload).toEqual(
        opaqueProviderPayload,
      );
    }
    for (const snapshotId of seeded.liveSnapshotIds) {
      const row = world.db
        .prepare(
          `SELECT content_json, candidate_hash, candidate_id
           FROM spec_delivery_plan_snapshots WHERE id = ?`,
        )
        .get(snapshotId) as {
        content_json: string;
        candidate_hash: string;
        candidate_id: string;
      };
      const record = JSON.parse(row.content_json) as {
        protocol: string;
        specId: string;
        attemptId: string;
        candidateId: string;
        pinnedRevisionId: string;
        draftRevision: number;
        document: {
          launch: {
            definition: {
              executionContexts: Array<{
                implementer: Record<string, unknown>;
                outputSchema: { examples: unknown[] };
              }>;
            };
          };
          binding: { opaqueProviderPayload: unknown };
        };
      };
      // The envelope around the migrated document is carried verbatim.
      expect(record.protocol).toBe("native-sdd-delivery-candidate/v2");
      expect(record.candidateId).toBe(row.candidate_id);
      expect(record.draftRevision).toBe(1);
      const definition = record.document.launch.definition;
      expect(definition.executionContexts[0]?.implementer).toEqual({
        backend: "claude",
        modelSelection: {
          modelId: "sonnet",
          parameters: { effort: "medium" },
        },
      });
      expect(definition.executionContexts[0]?.outputSchema.examples).toEqual([
        opaqueProviderPayload,
      ]);
      expect(record.document.binding.opaqueProviderPayload).toEqual(
        opaqueProviderPayload,
      );
      // Re-expressed bytes are re-signed, so the launch-time integrity check
      // still hashes the stored bytes to the stored candidate hash.
      expect(row.candidate_hash).toBe(candidateHashOfBytes(row.content_json));
      expect(row.candidate_hash).not.toBe(
        seeded.seededCandidateHashes[snapshotId],
      );
      expect(row.content_json).toBe(
        stableStringify(JSON.parse(row.content_json)),
      );
    }
    // Every stored binding of the old hash moves with it: an approval or a
    // prelaunch hold left on the pre-migration hash would silently refuse the
    // launch it already authorized.
    for (const attemptId of [
      seeded.approvedAttemptId,
      seeded.launchedAttemptId,
    ]) {
      const attempt = world.db
        .prepare(
          `SELECT approval_json, proposed_snapshot_id
           FROM spec_delivery_plan_attempts WHERE id = ?`,
        )
        .get(attemptId) as {
        approval_json: string;
        proposed_snapshot_id: string;
      };
      const approval = JSON.parse(attempt.approval_json) as {
        candidateId: string;
        candidateHash: string;
        snapshotId: string;
      };
      const snapshot = world.db
        .prepare(
          "SELECT candidate_hash FROM spec_delivery_plan_snapshots WHERE id = ?",
        )
        .get(attempt.proposed_snapshot_id) as { candidate_hash: string };
      expect(approval.candidateHash).toBe(snapshot.candidate_hash);
      expect(approval.snapshotId).toBe(attempt.proposed_snapshot_id);
    }
    const parked = world.db
      .prepare(
        `SELECT prelaunch_json, proposed_snapshot_id
         FROM spec_delivery_plan_attempts WHERE id = ?`,
      )
      .get(seeded.parkedAttemptId) as {
      prelaunch_json: string;
      proposed_snapshot_id: string;
    };
    expect(
      (
        JSON.parse(parked.prelaunch_json) as {
          candidate: { candidateHash: string };
        }
      ).candidate.candidateHash,
    ).toBe(
      (
        world.db
          .prepare(
            "SELECT candidate_hash FROM spec_delivery_plan_snapshots WHERE id = ?",
          )
          .get(parked.proposed_snapshot_id) as { candidate_hash: string }
      ).candidate_hash,
    );
    expect(
      (
        world.db
          .prepare(
            "SELECT content_json FROM spec_delivery_plan_attempts WHERE id = ?",
          )
          .get(seeded.archivedAttemptId) as { content_json: string }
      ).content_json,
    ).toBe(archivedBefore.attempt);
    expect(
      (
        world.db
          .prepare(
            "SELECT content_json FROM spec_delivery_plan_snapshots WHERE id = ?",
          )
          .get(seeded.archivedSnapshotId) as { content_json: string }
      ).content_json,
    ).toBe(archivedBefore.snapshot);
    expect(
      (
        world.db
          .prepare(
            "SELECT content_json FROM spec_delivery_plan_attempts WHERE id = ?",
          )
          .get(seeded.terminalLaunchAttemptId) as { content_json: string }
      ).content_json,
    ).toBe(archivedBefore.terminalLaunchAttempt);
    expect(
      (
        world.db
          .prepare(
            "SELECT content_json FROM spec_delivery_plan_snapshots WHERE id = ?",
          )
          .get(seeded.terminalLaunchSnapshotId) as { content_json: string }
      ).content_json,
    ).toBe(archivedBefore.terminalLaunchSnapshot);
    // Archived candidates are never re-signed: their frozen bytes and the hash
    // over them both stand exactly as proposed.
    for (const snapshotId of [
      seeded.archivedSnapshotId,
      seeded.terminalLaunchSnapshotId,
    ]) {
      expect(
        (
          world.db
            .prepare(
              "SELECT candidate_hash FROM spec_delivery_plan_snapshots WHERE id = ?",
            )
            .get(snapshotId) as { candidate_hash: string }
        ).candidate_hash,
      ).toBe(seeded.seededCandidateHashes[snapshotId]);
    }

    const liveRowsAfterFirstRun = world.db
      .prepare(
        `SELECT 'attempt' AS kind, id, content_json
         FROM spec_delivery_plan_attempts WHERE status != 'abandoned'
         UNION ALL
         SELECT 'snapshot' AS kind, snapshots.id, snapshots.content_json
         FROM spec_delivery_plan_snapshots AS snapshots
         JOIN spec_delivery_plan_attempts AS attempts
           ON attempts.id = snapshots.attempt_id
         WHERE attempts.status != 'abandoned'
         ORDER BY kind, id`,
      )
      .all();
    await runMigration(world);
    expect(
      world.db
        .prepare(
          `SELECT 'attempt' AS kind, id, content_json
           FROM spec_delivery_plan_attempts WHERE status != 'abandoned'
           UNION ALL
           SELECT 'snapshot' AS kind, snapshots.id, snapshots.content_json
           FROM spec_delivery_plan_snapshots AS snapshots
           JOIN spec_delivery_plan_attempts AS attempts
             ON attempts.id = snapshots.attempt_id
           WHERE attempts.status != 'abandoned'
           ORDER BY kind, id`,
        )
        .all(),
    ).toEqual(liveRowsAfterFirstRun);
  });

  it("migrates resumable legacy collaboration agent settings and leaves completed archive snapshots opaque", async () => {
    const world = makeWorld();
    const opaqueProviderPayload = {
      model: "provider-model",
      effort: "provider-effort",
      codexFastMode: "provider-fast",
    };
    const featureSnapshot = (
      primaryAgentBackend: "claude" | "codex",
      codexFastMode: boolean,
    ) => ({
      mode: "asymmetric",
      brief: "resume this collaboration",
      primaryAgentBackend,
      agentModelSettings: {
        claude: { model: "fable", effort: "max" },
        codex: { model: "gpt-5.5", effort: "xhigh" },
      },
      codexFastMode,
      providerPayload: structuredClone(opaqueProviderPayload),
    });
    const completedFeatureSnapshot = {
      ...featureSnapshot("claude", true),
      agentModelSettings: {
        malformed: { model: "archived-provider-model" },
      },
      codexFastMode: "archived-provider-fast",
    };
    const envelopes = {
      running: {
        workflowType: "collaboration",
        status: "running",
        featureSnapshot: featureSnapshot("codex", true),
      },
      paused: {
        workflowType: "collaboration",
        status: "paused",
        featureSnapshot: featureSnapshot("claude", true),
      },
      failed: {
        workflowType: "collaboration",
        status: "failed",
        featureSnapshot: featureSnapshot("codex", false),
      },
      completed: {
        workflowType: "collaboration",
        status: "completed",
        featureSnapshot: completedFeatureSnapshot,
      },
      unrelated: {
        workflowType: "provider-owned-workflow",
        status: "paused",
        featureSnapshot: {
          agentModelSettings: { opaque: true },
          codexFastMode: "opaque",
        },
      },
    };
    world.db
      .prepare(
        `UPDATE sessions SET workflow_envelopes = ?
         WHERE project_path = ? AND session_name = ?`,
      )
      .run(JSON.stringify(envelopes), world.projectPath, SESSION_NAME);

    await runMigration(world);

    const row = world.db
      .prepare(
        `SELECT workflow_envelopes FROM sessions
         WHERE project_path = ? AND session_name = ?`,
      )
      .get(world.projectPath, SESSION_NAME) as { workflow_envelopes: string };
    const migrated = JSON.parse(row.workflow_envelopes) as Record<
      string,
      { featureSnapshot: Record<string, unknown> }
    >;
    expect(migrated.running?.featureSnapshot.agents).toEqual({
      agent_one: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.5",
          parameters: { fast: "true", reasoning: "xhigh" },
        },
      },
      agent_two: {
        backend: "claude",
        modelSelection: {
          modelId: "fable",
          parameters: { effort: "max" },
        },
      },
    });
    expect(migrated.paused?.featureSnapshot.agents).toEqual({
      agent_one: {
        backend: "claude",
        modelSelection: {
          modelId: "fable",
          parameters: { effort: "max" },
        },
      },
      agent_two: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.5",
          parameters: { fast: "true", reasoning: "xhigh" },
        },
      },
    });
    expect(migrated.failed?.featureSnapshot.agents).toEqual({
      agent_one: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.5",
          parameters: { fast: "false", reasoning: "xhigh" },
        },
      },
      agent_two: {
        backend: "claude",
        modelSelection: {
          modelId: "fable",
          parameters: { effort: "max" },
        },
      },
    });
    for (const workflowId of ["running", "paused", "failed"] as const) {
      expect(migrated[workflowId]?.featureSnapshot).not.toHaveProperty(
        "agentModelSettings",
      );
      expect(migrated[workflowId]?.featureSnapshot).not.toHaveProperty(
        "codexFastMode",
      );
      expect(migrated[workflowId]?.featureSnapshot.providerPayload).toEqual(
        opaqueProviderPayload,
      );
    }
    expect(migrated.completed?.featureSnapshot).toEqual(
      completedFeatureSnapshot,
    );
    expect(migrated.unrelated).toEqual(envelopes.unrelated);
  });

  it("refuses a paused collaboration whose legacy settings cannot become an exact frozen selection", async () => {
    const world = makeWorld();
    const sessionRow = world.db
      .prepare(
        `SELECT rowid AS rowid FROM sessions
         WHERE project_path = ? AND session_name = ?`,
      )
      .get(world.projectPath, SESSION_NAME) as { rowid: number };
    world.db
      .prepare(
        `UPDATE sessions SET workflow_envelopes = ?
         WHERE project_path = ? AND session_name = ?`,
      )
      .run(
        JSON.stringify({
          "paused-invalid": {
            workflowType: "collaboration",
            status: "paused",
            featureSnapshot: {
              primaryAgentBackend: "claude",
              agentModelSettings: {
                claude: { model: "unknown-claude-model", effort: "high" },
                codex: { model: "gpt-5.5", effort: "xhigh" },
              },
              codexFastMode: true,
            },
          },
        }),
        world.projectPath,
        SESSION_NAME,
      );
    const databaseBefore = world.db.serialize();

    await expect(
      preflightGeneralizedModelSelection({
        db: world.db,
        configDir: world.configDir,
      }),
    ).rejects.toMatchObject({
      holder: `sessions.rowid=${sessionRow.rowid}.workflow_envelopes.paused-invalid.featureSnapshot.agentModelSettings.claude`,
      reasonCode: "unknown_model",
    });
    expect(world.db.serialize()).toEqual(databaseBefore);
    expect(
      existsSync(
        schemaCompatibilityBarrierPath(
          world.configDir,
          GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION,
        ),
      ),
    ).toBe(false);
  });

  it("refuses an unconvertible live holder at its durable location without preflight or migration writes", async () => {
    const world = makeWorld();
    seedDeliveryPlanDocuments(world.db, world.projectPath);
    const unconvertible = {
      ...legacyCandidateRecord({
        specId: "spec-model-selection-migration",
        attemptId: "attempt-proposed",
        candidateId: "candidate-proposed",
        pinnedRevisionId: "revision-model-selection-migration",
      }),
      document: legacyDeliveryPlanDocument({
        holder: "snapshot",
        model: "unknown-claude-model",
      }),
    };
    world.db
      .prepare(
        `UPDATE spec_delivery_plan_snapshots SET content_json = ?
         WHERE id = 'snapshot-proposed'`,
      )
      .run(stableStringify(unconvertible));
    const databaseBefore = world.db.serialize();
    const configBefore = readFileSync(
      path.join(world.configDir, "config.json"),
      "utf8",
    );

    await expect(
      preflightGeneralizedModelSelection({
        db: world.db,
        configDir: world.configDir,
      }),
    ).rejects.toMatchObject({
      holder:
        "spec_delivery_plan_snapshots.id=snapshot-proposed.content_json.document.launch.definition.executionContexts[0].implementer",
      reasonCode: "unknown_model",
    });
    expect(world.db.serialize()).toEqual(databaseBefore);

    await expect(runMigration(world)).rejects.toMatchObject({
      holder:
        "spec_delivery_plan_snapshots.id=snapshot-proposed.content_json.document.launch.definition.executionContexts[0].implementer",
      reasonCode: "unknown_model",
    });
    expect(world.db.serialize()).toEqual(databaseBefore);
    expect(
      readFileSync(path.join(world.configDir, "config.json"), "utf8"),
    ).toBe(configBefore);
    expect(
      existsSync(
        schemaCompatibilityBarrierPath(
          world.configDir,
          GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION,
        ),
      ),
    ).toBe(false);
    expect(
      world.db
        .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
        .get(GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION),
    ).toBeUndefined();
  });

  it("refuses an unconvertible context-artifact row before publishing the barrier", async () => {
    const world = makeWorld();
    world.db
      .prepare(
        `UPDATE context_artifacts
         SET model_provider = 'claude', model = 'unknown-claude-model'
         WHERE id = 'artifact-legacy'`,
      )
      .run();

    await expect(runMigration(world)).rejects.toMatchObject({
      holder: "context_artifacts.id=artifact-legacy",
      reasonCode: "unknown_model",
    });

    expect(
      existsSync(
        schemaCompatibilityBarrierPath(
          world.configDir,
          GENERALIZED_MODEL_SELECTION_SCHEMA_VERSION,
        ),
      ),
    ).toBe(false);
    const columns = (
      world.db.prepare("PRAGMA table_info(context_artifacts)").all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name);
    expect(columns).toContain("model_provider");
    expect(columns).not.toContain("model_selection_json");
  });
});
