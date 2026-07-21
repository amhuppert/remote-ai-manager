import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createConfigReader } from "@/lib/config/loader";
import { createStateStore as createStateManager } from "@/lib/state-store";
import { _createTestDb } from "@/lib/state-store/state-db";
import type { Db } from "@/lib/state-store/schemas";
import type { ManagerState } from "@/lib/projects/schemas";
import { seedWholeState } from "@/lib/shared/testing/whole-state-fixture";
import {
  createDefaultSessionWorkflowEnvelopeStore,
  createDefaultSessionWorkflowEnvelopeRepository,
} from "./default-session-workflow-envelope-store";
import type { WorkflowEnvelope } from "./workflow-envelope-vocabulary";

const PROJECT_PATH = "/projects/default-envelope-fixture";
const SESSION_NAME = "default-envelope-1";

let TEST_DIR: string;
let db: Db;

function buildEnvelope(
  overrides: Partial<WorkflowEnvelope> = {},
): WorkflowEnvelope {
  return {
    workflowId: "wf-default-1",
    workflowType: "collaboration",
    status: "running",
    phase: "round_1",
    createdAt: "2026-04-28T10:00:00.000Z",
    updatedAt: "2026-04-28T10:00:00.000Z",
    featureSnapshot: { round: 0 },
    ...overrides,
  };
}

function seedStateWithSession(): ManagerState {
  return {
    projects: {
      [PROJECT_PATH]: {
        rootPath: PROJECT_PATH,
        sessions: {
          [SESSION_NAME]: {
            sessionName: SESSION_NAME,
            worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
            branchName: `csm/${SESSION_NAME}`,
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
          },
        },
      },
    },
    archivedProjects: [],
    pinnedProjects: [],
  };
}

beforeEach(async () => {
  TEST_DIR = path.join(
    "/tmp",
    `cc-default-envelope-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(TEST_DIR, { recursive: true });
  db = _createTestDb({ inMemory: true });
  seedWholeState(db, seedStateWithSession());
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("createDefaultSessionWorkflowEnvelopeStore — production factory", () => {
  it("persists envelope mutations through the supplied state manager", async () => {
    const configReader = createConfigReader(TEST_DIR);
    const manager = createStateManager({
      db,
      readConfig: () => configReader.readConfig(),
    });

    const store = createDefaultSessionWorkflowEnvelopeStore({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      mutateEnvelopes: manager.mutateSessionWorkflowEnvelopes,
      getSession: manager.getSession,
    });

    await store.upsert("wf-default-1", () => buildEnvelope());

    const reloaded = createStateManager({
      db,
      readConfig: () => configReader.readConfig(),
    });
    const session = await reloaded.getSession(PROJECT_PATH, SESSION_NAME);
    expect(session?.workflowEnvelopes?.["wf-default-1"]).toBeDefined();

    const fresh = createDefaultSessionWorkflowEnvelopeStore({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      mutateEnvelopes: reloaded.mutateSessionWorkflowEnvelopes,
      getSession: reloaded.getSession,
    });
    const fetched = await fresh.read("wf-default-1");
    expect(fetched?.workflowId).toBe("wf-default-1");
    expect(fetched?.status).toBe("running");
  });

  it("repository factory wraps the store and exposes lifecycle queries", async () => {
    const configReader = createConfigReader(TEST_DIR);
    const manager = createStateManager({
      db,
      readConfig: () => configReader.readConfig(),
    });

    const repo = createDefaultSessionWorkflowEnvelopeRepository({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      mutateEnvelopes: manager.mutateSessionWorkflowEnvelopes,
      getSession: manager.getSession,
    });

    await repo.create(buildEnvelope({ workflowId: "wf-active" }));
    await repo.create(
      buildEnvelope({
        workflowId: "wf-done",
        status: "completed",
        completedAt: "2026-04-28T10:05:00.000Z",
      }),
    );

    const active = await repo.listActive();
    expect(active.map((e) => e.workflowId)).toEqual(["wf-active"]);

    const all = await repo.listAll();
    expect(all.map((e) => e.workflowId).sort()).toEqual([
      "wf-active",
      "wf-done",
    ]);
  });
});
