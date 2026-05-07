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
import { createDefaultSessionWorkflowEnvelopeRepository } from "@/lib/workflows/primitives/default-session-workflow-envelope-store";
import { createWorkflowEnvelopesRouteHandlers } from "./workflow-envelopes-route-handlers";
import type { WorkflowEnvelope } from "@/lib/workflows/primitives/workflow-envelope-vocabulary";

const PROJECT_PATH = "/projects/route-fixture";
const PROJECT_NAME = "route-fixture";
const SESSION_NAME = "route-1";

let TEST_DIR: string;

function buildEnvelope(
  overrides: Partial<WorkflowEnvelope> = {},
): WorkflowEnvelope {
  return {
    workflowId: "wf-1",
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
    `cc-envelope-route-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(TEST_DIR, { recursive: true });
  _installTestDb(_createTestDb({ inMemory: true }));
  await seedSession();
});

afterEach(async () => {
  _resetStateDb();
  await rm(TEST_DIR, { recursive: true, force: true });
});

function buildHandlers() {
  return createWorkflowEnvelopesRouteHandlers({
    resolveProjectPath: async (name) =>
      name === PROJECT_NAME ? PROJECT_PATH : null,
    createRepository: async ({ projectPath, sessionName }) => {
      const manager = await buildManager();
      return createDefaultSessionWorkflowEnvelopeRepository({
        projectPath,
        sessionName,
        mutateSession: manager.mutateSession,
        getSession: manager.getSession,
      });
    },
  });
}

describe("GET /api/projects/[name]/sessions/[session]/workflow-envelopes", () => {
  it("returns only active envelopes by default and includes terminal envelopes when requested", async () => {
    const seedManager = await buildManager();
    const repo = createDefaultSessionWorkflowEnvelopeRepository({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      mutateSession: seedManager.mutateSession,
      getSession: seedManager.getSession,
    });
    await repo.create(buildEnvelope({ workflowId: "wf-running" }));
    await repo.create(
      buildEnvelope({
        workflowId: "wf-paused",
        status: "paused",
        pause: {
          pauseKind: "post_turn",
          gateKind: "human_approval",
          resumeToken: "tok-1",
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
    await repo.create(
      buildEnvelope({
        workflowId: "wf-failed",
        status: "failed",
        completedAt: "2026-04-28T10:06:00.000Z",
        errorSummary: "boom",
      }),
    );

    const handlers = buildHandlers();

    const activeOnly = await handlers.GET(makeRequest(""), {
      params: Promise.resolve({ name: PROJECT_NAME, session: SESSION_NAME }),
    });
    const activeBody = await activeOnly.json();
    expect(activeOnly.status).toBe(200);
    expect(
      (activeBody.envelopes as Array<{ workflowId: string }>)
        .map((e) => e.workflowId)
        .sort(),
    ).toEqual(["wf-paused", "wf-running"]);

    const includingTerminal = await handlers.GET(
      makeRequest("?includeTerminal=true"),
      {
        params: Promise.resolve({
          name: PROJECT_NAME,
          session: SESSION_NAME,
        }),
      },
    );
    const allBody = await includingTerminal.json();
    expect(
      (allBody.envelopes as Array<{ workflowId: string }>)
        .map((e) => e.workflowId)
        .sort(),
    ).toEqual(["wf-completed", "wf-failed", "wf-paused", "wf-running"]);
  });

  it("returns 404 when the project cannot be resolved", async () => {
    const handlers = buildHandlers();
    const response = await handlers.GET(makeRequest(""), {
      params: Promise.resolve({ name: "nope", session: SESSION_NAME }),
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toMatch(/project/i);
  });

  it("returns an empty list when the session has no envelopes yet", async () => {
    const handlers = buildHandlers();
    const response = await handlers.GET(makeRequest(""), {
      params: Promise.resolve({ name: PROJECT_NAME, session: SESSION_NAME }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.envelopes).toEqual([]);
  });

  it("decodes URL-encoded session names before repository lookup", async () => {
    const encodedSessionName = "session with spaces";
    const seedManager = await buildManager();
    await seedManager.updateSession(PROJECT_PATH, {
      sessionName: encodedSessionName,
      worktreePath: `${PROJECT_PATH}/.worktrees/${encodedSessionName}`,
      branchName: `csm/${encodedSessionName}`,
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
    const repo = createDefaultSessionWorkflowEnvelopeRepository({
      projectPath: PROJECT_PATH,
      sessionName: encodedSessionName,
      mutateSession: seedManager.mutateSession,
      getSession: seedManager.getSession,
    });
    await repo.create(buildEnvelope({ workflowId: "wf-encoded" }));

    const handlers = buildHandlers();
    const response = await handlers.GET(makeRequest(""), {
      params: Promise.resolve({
        name: PROJECT_NAME,
        session: encodeURIComponent(encodedSessionName),
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      (body.envelopes as Array<{ workflowId: string }>).map(
        (e) => e.workflowId,
      ),
    ).toEqual(["wf-encoded"]);
  });
});

function makeRequest(searchParams: string): Request {
  return new Request(
    `http://localhost/api/projects/x/sessions/y/workflow-envelopes${searchParams}`,
  );
}
