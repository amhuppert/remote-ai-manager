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
import { createConfigReader } from "@/lib/config/loader";
import { createStateStore as createStateManager } from "@/lib/state-store";
import { getStateDb } from "@/lib/state-store/store";
import type { ManagerState } from "@/lib/projects/schemas";
import { seedWholeState } from "@/lib/shared/testing/whole-state-fixture";
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
import { collaborationFeatureSnapshotSchema } from "@/lib/workflows/collaboration/feature-snapshot";
import { parseSessionContextForExecution } from "@/lib/workflows/collaboration/session-context";
import { buildAgentProfileSnapshot } from "@/lib/agent-profiles/composer";
import { computeContentHash } from "@/lib/agent-profiles/hashing";

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
    `cc-envelope-wiring-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(TEST_DIR, { recursive: true });
  _installTestDb(_createTestDb({ inMemory: true }));
  seedWholeState(getStateDb(), seedStateWithSession());
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
      mutateEnvelopes: before.mutateSessionWorkflowEnvelopes,
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
      mutateEnvelopes: afterRestart.mutateSessionWorkflowEnvelopes,
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
      mutateEnvelopes: finalManager.mutateSessionWorkflowEnvelopes,
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

  it("round-trips a maximal collaboration feature snapshot, including the captured session context, across restart", async () => {
    // Maximal on the fields the collaboration feature owns: a digest-mode
    // charter (version + hash + text + immutable snapshot path) AND a linked
    // ticket block, so neither branch of the captured context is proven only
    // by its null case.
    const sessionContext = {
      alignment: {
        version: 11,
        contentHash: "b4d9f0a1c2e3",
        text: "## Alignment charter\n\nSee `.cc/session-alignment/snapshots/b4d9f0a1c2e3.md`.",
        snapshotPath: ".cc/session-alignment/snapshots/b4d9f0a1c2e3.md",
      },
      activeTicketBlock:
        "<active-ticket>\nidentifier: wiring-fixture#8\ntitle: Charter parity\nstatus: In progress\nattachments: none\n</active-ticket>",
    };
    // Both generations of per-agent settings: the legacy backend-keyed blob
    // (still decoded for display on old envelopes) AND the typed per-flow-agent
    // map, whose agent entries carry full profile snapshots for byte-for-byte
    // replay on resume.
    const agents = {
      agent_one: {
        backend: "claude",
        modelSelection: {
          modelId: "fable",
          parameters: { effort: "max" },
        },
        profileSnapshot: buildAgentProfileSnapshot({
          tier: "project",
          id: "conversation-reviewer",
          name: "Conversation Reviewer",
          revision: 4,
          sourceContentHash: computeContentHash("review as staffed"),
          instructions: "review as staffed",
        }),
      },
      agent_two: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.6-sol",
          parameters: { reasoning: "xhigh", fast: "true" },
        },
        profileSnapshot: buildAgentProfileSnapshot({
          tier: "global",
          id: "critic",
          name: "Critic",
          revision: 2,
          sourceContentHash: computeContentHash("criticize constructively"),
          instructions: "criticize constructively",
        }),
      },
    };
    const featureSnapshot = {
      origin: "user",
      mode: "asymmetric",
      brief: "design X",
      primaryAgentBackend: "claude",
      primaryBackend: "claude",
      secondaryBackend: "codex",
      agentModelSettings: {
        claude: { model: "opus", effort: "high" },
        codex: { model: "gpt-5.6", effort: "medium" },
      },
      agents,
      negotiationRounds: 5,
      negotiationRoundsCompleted: 2,
      autonomousResolutionThreshold: "major",
      sessionContext,
      userAnswersByQuestionId: { q1: "ship it" },
      conversationId: "conv-max",
    };

    const before = await buildManager();
    const repo = createDefaultSessionWorkflowEnvelopeRepository({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      mutateEnvelopes: before.mutateSessionWorkflowEnvelopes,
      getSession: before.getSession,
    });
    await repo.create(buildEnvelope({ workflowId: "wf-max", featureSnapshot }));
    await repo.markPaused("wf-max", {
      pauseKind: "post_turn",
      gateKind: "human_approval",
      resumeToken: "tok-max",
    });

    const afterRestart = await buildManager();
    const afterRepo = createDefaultSessionWorkflowEnvelopeRepository({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      mutateEnvelopes: afterRestart.mutateSessionWorkflowEnvelopes,
      getSession: afterRestart.getSession,
    });

    const reloaded = await afterRepo.get("wf-max");
    expect(reloaded?.featureSnapshot).toEqual(featureSnapshot);

    // The reloaded blob must satisfy both the storage decoder (display) and
    // the strict execution parser (resume), not just deep-equal the input.
    const decoded = collaborationFeatureSnapshotSchema.parse(
      reloaded?.featureSnapshot,
    );
    expect(decoded.origin).toBe("user");
    if (decoded.origin !== "user") return;
    expect(decoded.sessionContext).toEqual(sessionContext);
    expect(parseSessionContextForExecution(decoded.sessionContext)).toEqual(
      sessionContext,
    );
    // Resume replays the persisted per-agent settings — including each lane's
    // rendered profile block — byte-for-byte.
    expect(decoded.agents).toEqual(agents);
  });

  it("store factory writes are isolated to the supplied (projectPath, sessionName) and survive restart", async () => {
    const manager = await buildManager();
    const store = createDefaultSessionWorkflowEnvelopeStore({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      mutateEnvelopes: manager.mutateSessionWorkflowEnvelopes,
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
      mutateEnvelopes: fresh.mutateSessionWorkflowEnvelopes,
      getSession: fresh.getSession,
    });
    const list = await freshStore.listAll();
    expect(list.map((e) => e.workflowId).sort()).toEqual(["wf-A", "wf-B"]);
  });
});
