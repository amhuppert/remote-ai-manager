/**
 * Integration test for the production WorkflowEnvelopeStore wiring.
 *
 * Drives a fake durable workflow (initialize → update → mark paused → resume
 * → mark completed) through the production factory and verifies that every
 * mutation lands in the on-disk session-state JSON, and that a fresh state
 * manager (simulating a server restart) sees the same envelope state.
 *
 * No internal modules are mocked; the test composes the production factory
 * with a real `createStateManager` pointed at a temp config directory.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createConfigReader } from "@/lib/config";
import { createStateManager } from "@/lib/state";
import {
  _createTestDb,
  _installTestDb,
  _resetForTesting as _resetStateDb,
} from "@/lib/state-store/state-db";
import {
  createDefaultSessionWorkflowEnvelopeRepository,
  createDefaultSessionWorkflowEnvelopeStore,
} from "./default-session-workflow-envelope-store";
import type { WorkflowEnvelope } from "./workflow-envelope-vocabulary";

const PROJECT_PATH = "/projects/wiring-fixture";
const SESSION_NAME = "wiring-1";

let TEST_DIR: string;

function buildEnvelope(
  overrides: Partial<WorkflowEnvelope> = {},
): WorkflowEnvelope {
  return {
    workflowId: "wf-collab-1",
    workflowType: "collaboration",
    status: "running",
    phase: "round_1",
    createdAt: "2026-04-28T10:00:00.000Z",
    updatedAt: "2026-04-28T10:00:00.000Z",
    featureSnapshot: { brief: "design X", round: 0 },
    ...overrides,
  };
}

async function buildManager() {
  const configReader = createConfigReader(TEST_DIR);
  const manager = createStateManager({
    readConfig: () => configReader.readConfig(),
  });
  return manager;
}

async function seedSession() {
  const manager = await buildManager();
  await manager.updateSession(PROJECT_PATH, {
    sessionName: SESSION_NAME,
    worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
    branchName: `csm/${SESSION_NAME}`,
    createdAt: "2026-04-28T09:00:00.000Z",
    lastActivityAt: "2026-04-28T09:00:00.000Z",
    archived: false,
    finished: false,
    conversations: [],
    source: "cc",
    objective: null,
    creationMode: "fast",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    graphWorkflowExecutionHistory: [],
    referenceDocuments: [],
  });
}

beforeEach(async () => {
  TEST_DIR = path.join(
    "/tmp",
    `cc-envelope-wiring-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(TEST_DIR, { recursive: true });
  _installTestDb(_createTestDb({ inMemory: true }));
  await seedSession();
});

afterEach(async () => {
  _resetStateDb();
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("durable workflow wiring through production factory", () => {
  it("persists a full lifecycle (running → paused → running → completed) across restart", async () => {
    const before = await buildManager();
    const repo = createDefaultSessionWorkflowEnvelopeRepository({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      mutateSession: before.mutateSession,
      getSession: before.getSession,
    });

    await repo.create(buildEnvelope());
    await repo.update("wf-collab-1", {
      phase: "round_2",
      featureSnapshot: { brief: "design X", round: 2 },
    });
    await repo.markPaused("wf-collab-1", {
      pauseKind: "post_turn",
      gateKind: "human_approval",
      resumeToken: "tok-restart",
      reason: "user_input_required",
    });

    // Simulated process restart: a fresh state manager and a fresh repository
    // wired through the production factory must see the paused envelope.
    const afterRestart = await buildManager();
    const afterRepo = createDefaultSessionWorkflowEnvelopeRepository({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      mutateSession: afterRestart.mutateSession,
      getSession: afterRestart.getSession,
    });

    const paused = await afterRepo.get("wf-collab-1");
    expect(paused?.status).toBe("paused");
    expect(paused?.pause?.gateKind).toBe("human_approval");
    expect(paused?.pause?.resumeToken).toBe("tok-restart");

    await afterRepo.markRunning("wf-collab-1");
    await afterRepo.markCompleted("wf-collab-1");

    const finalManager = await buildManager();
    const finalRepo = createDefaultSessionWorkflowEnvelopeRepository({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      mutateSession: finalManager.mutateSession,
      getSession: finalManager.getSession,
    });
    const completed = await finalRepo.get("wf-collab-1");
    expect(completed?.status).toBe("completed");
    expect(completed?.completedAt).toBeDefined();
    expect(completed?.pause).toBeUndefined();

    const active = await finalRepo.listActive();
    expect(active).toEqual([]);
    const all = await finalRepo.listAll();
    expect(all.map((e) => e.workflowId)).toEqual(["wf-collab-1"]);
  });

  it("store factory writes are isolated to the supplied (projectPath, sessionName) and survive restart", async () => {
    const manager = await buildManager();
    const store = createDefaultSessionWorkflowEnvelopeStore({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      mutateSession: manager.mutateSession,
      getSession: manager.getSession,
    });

    await store.upsert("wf-A", () => buildEnvelope({ workflowId: "wf-A" }));
    await store.upsert("wf-B", () =>
      buildEnvelope({ workflowId: "wf-B", phase: "round_5" }),
    );

    const fresh = await buildManager();
    const session = await fresh.getSession(PROJECT_PATH, SESSION_NAME);
    const envelopes = session?.workflowEnvelopes ?? {};
    expect(Object.keys(envelopes).sort()).toEqual(["wf-A", "wf-B"]);

    const freshStore = createDefaultSessionWorkflowEnvelopeStore({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      mutateSession: fresh.mutateSession,
      getSession: fresh.getSession,
    });
    const list = await freshStore.listAll();
    expect(list.map((e) => e.workflowId).sort()).toEqual(["wf-A", "wf-B"]);
  });
});
