/**
 * Startup recovery path tests for the WorkflowEnvelope primitive.
 *
 * Simulates a process restart: write active envelopes through one repository
 * instance, drop in-memory state, run recovery, assert that envelopes whose
 * in-memory worker is missing are transitioned into a recoverable terminal
 * state (failed with errorSummary noting the restart). Already-paused
 * envelopes stay paused because the pause projection is itself recoverable.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createConfigReader } from "@/lib/config/loader";
import { createStateManager } from "@/lib/state-store";
import {
  _createTestDb,
  _installTestDb,
  _resetForTesting as _resetStateDb,
} from "@/lib/state-store/state-db";
import { createDefaultSessionWorkflowEnvelopeRepository } from "./default-session-workflow-envelope-store";
import { recoverActiveWorkflowEnvelopes } from "./recover-workflow-envelopes";
import type { WorkflowEnvelope } from "./workflow-envelope-vocabulary";

const PROJECT_PATH = "/projects/recovery-fixture";
const SESSION_NAME = "recovery-1";

let TEST_DIR: string;

function buildEnvelope(
  overrides: Partial<WorkflowEnvelope> = {},
): WorkflowEnvelope {
  return {
    workflowId: "wf-running-1",
    workflowType: "collaboration",
    status: "running",
    phase: "round_1",
    createdAt: "2026-04-28T10:00:00.000Z",
    updatedAt: "2026-04-28T10:00:00.000Z",
    featureSnapshot: { round: 0 },
    ...overrides,
  };
}

async function buildManager() {
  const configReader = createConfigReader(TEST_DIR);
  return createStateManager({
    readConfig: () => configReader.readConfig(),
  });
}

async function seedSession(sessionName: string) {
  const manager = await buildManager();
  await manager.updateSession(PROJECT_PATH, {
    sessionName,
    worktreePath: `${PROJECT_PATH}/.worktrees/${sessionName}`,
    branchName: `csm/${sessionName}`,
    createdAt: "2026-04-28T09:00:00.000Z",
    lastActivityAt: "2026-04-28T09:00:00.000Z",
    archived: false,
    finished: false,
    conversations: [],
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    referenceDocuments: [],
  });
}

beforeEach(async () => {
  TEST_DIR = path.join(
    "/tmp",
    `cc-envelope-recovery-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(TEST_DIR, { recursive: true });
  _installTestDb(_createTestDb({ inMemory: true }));
  await seedSession(SESSION_NAME);
});

afterEach(async () => {
  _resetStateDb();
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("recoverActiveWorkflowEnvelopes", () => {
  it("transitions running envelopes with no in-memory worker to failed with a process-restart errorSummary", async () => {
    const before = await buildManager();
    const repo = createDefaultSessionWorkflowEnvelopeRepository({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      mutateEnvelopes: before.mutateSessionWorkflowEnvelopes,
      getSession: before.getSession,
    });
    await repo.create(buildEnvelope({ workflowId: "wf-running" }));
    await repo.create(
      buildEnvelope({
        workflowId: "wf-paused",
        status: "paused",
        pause: {
          pauseKind: "post_turn",
          gateKind: "human_approval",
          resumeToken: "tok-paused",
        },
      }),
    );
    await repo.create(
      buildEnvelope({
        workflowId: "wf-completed",
        status: "completed",
        completedAt: "2026-04-28T10:05:00.000Z",
      }),
    );

    // Process restart: brand-new state manager, no in-memory workers exist.
    const afterRestart = await buildManager();
    const summary = await recoverActiveWorkflowEnvelopes({
      readState: afterRestart.readState,
      createRepository: ({ projectPath, sessionName }) =>
        createDefaultSessionWorkflowEnvelopeRepository({
          projectPath,
          sessionName,
          mutateEnvelopes: afterRestart.mutateSessionWorkflowEnvelopes,
          getSession: afterRestart.getSession,
        }),
      isWorkerActive: () => false,
    });

    expect(summary.scanned).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.preservedPaused).toBe(1);

    const verifyManager = await buildManager();
    const verifyRepo = createDefaultSessionWorkflowEnvelopeRepository({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      mutateEnvelopes: verifyManager.mutateSessionWorkflowEnvelopes,
      getSession: verifyManager.getSession,
    });

    const recovered = await verifyRepo.get("wf-running");
    expect(recovered?.status).toBe("failed");
    expect(recovered?.errorSummary).toMatch(/process restart/i);

    const stillPaused = await verifyRepo.get("wf-paused");
    expect(stillPaused?.status).toBe("paused");
    expect(stillPaused?.pause?.resumeToken).toBe("tok-paused");

    const stillCompleted = await verifyRepo.get("wf-completed");
    expect(stillCompleted?.status).toBe("completed");
  });

  it("leaves running envelopes untouched when their worker is reported active", async () => {
    const before = await buildManager();
    const repo = createDefaultSessionWorkflowEnvelopeRepository({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      mutateEnvelopes: before.mutateSessionWorkflowEnvelopes,
      getSession: before.getSession,
    });
    await repo.create(
      buildEnvelope({ workflowId: "wf-still-running", phase: "round_3" }),
    );

    const afterRestart = await buildManager();
    const summary = await recoverActiveWorkflowEnvelopes({
      readState: afterRestart.readState,
      createRepository: ({ projectPath, sessionName }) =>
        createDefaultSessionWorkflowEnvelopeRepository({
          projectPath,
          sessionName,
          mutateEnvelopes: afterRestart.mutateSessionWorkflowEnvelopes,
          getSession: afterRestart.getSession,
        }),
      isWorkerActive: (workflowId) => workflowId === "wf-still-running",
    });

    expect(summary.failed).toBe(0);
    expect(summary.preservedRunning).toBe(1);

    const verifyManager = await buildManager();
    const verifyRepo = createDefaultSessionWorkflowEnvelopeRepository({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      mutateEnvelopes: verifyManager.mutateSessionWorkflowEnvelopes,
      getSession: verifyManager.getSession,
    });
    const fetched = await verifyRepo.get("wf-still-running");
    expect(fetched?.status).toBe("running");
    expect(fetched?.phase).toBe("round_3");
  });

  it("returns zero counts for sessions with no envelopes", async () => {
    const manager = await buildManager();
    const summary = await recoverActiveWorkflowEnvelopes({
      readState: manager.readState,
      createRepository: ({ projectPath, sessionName }) =>
        createDefaultSessionWorkflowEnvelopeRepository({
          projectPath,
          sessionName,
          mutateEnvelopes: manager.mutateSessionWorkflowEnvelopes,
          getSession: manager.getSession,
        }),
      isWorkerActive: () => false,
    });
    expect(summary).toEqual({
      scanned: 0,
      failed: 0,
      preservedPaused: 0,
      preservedRunning: 0,
      movedToPaused: 0,
    });
  });
});
