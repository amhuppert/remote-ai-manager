import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createConfigReader } from "@/lib/config/loader";
import { createStateStore as createStateManager } from "@/lib/state-store";
import {
  createSessionStateWorkflowEnvelopeStore,
  type WorkflowEnvelopeStore,
} from "./workflow-envelope-store";
import { createWorkflowEnvelopeRepository } from "./workflow-envelope-repository";
import type { WorkflowEnvelope } from "./workflow-envelope-vocabulary";

const PROJECT_PATH = "/projects/collab-fixture";
const SESSION_NAME = "collab-1";

let TEST_DIR: string;

function createTestStateManager() {
  const configReader = createConfigReader(TEST_DIR);
  return createStateManager({
    readConfig: () => configReader.readConfig(),
  });
}

async function seedSession(): Promise<void> {
  const { updateSession } = createTestStateManager();
  await updateSession(PROJECT_PATH, {
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
  });
}

function buildStore(): WorkflowEnvelopeStore {
  const stateManager = createTestStateManager();
  return createSessionStateWorkflowEnvelopeStore({
    mutateEnvelopes: stateManager.mutateSessionWorkflowEnvelopes,
    getSession: stateManager.getSession,
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
  });
}

function buildEnvelope(
  overrides: Partial<WorkflowEnvelope> = {},
): WorkflowEnvelope {
  return {
    workflowId: "wf-1",
    workflowType: "collaboration",
    status: "running",
    phase: "initial-proposals",
    createdAt: "2026-04-28T10:00:00.000Z",
    updatedAt: "2026-04-28T10:00:00.000Z",
    featureSnapshot: { round: 0 },
    ...overrides,
  };
}

beforeEach(async () => {
  TEST_DIR = path.join(
    "/tmp",
    `cc-envelope-session-state-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(TEST_DIR, { recursive: true });
  await seedSession();
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("createSessionStateWorkflowEnvelopeStore — durable session-state persistence", () => {
  it("persists envelopes through mutateSession so a fresh state manager (server restart) sees them", async () => {
    const beforeRestart = createWorkflowEnvelopeRepository({
      store: buildStore(),
    });
    await beforeRestart.create(buildEnvelope({ workflowId: "wf-running" }));
    await beforeRestart.create(
      buildEnvelope({
        workflowId: "wf-paused",
        status: "paused",
        pause: {
          pauseKind: "mid_turn",
          gateKind: "ask_user",
          resumeToken: "tok-survives-disk-reload",
        },
      }),
    );
    await beforeRestart.create(
      buildEnvelope({
        workflowId: "wf-failed",
        status: "failed",
        completedAt: "2026-04-28T10:01:00.000Z",
        errorSummary: "still readable after restart",
      }),
    );

    // Simulate a server restart: brand new state manager + brand new store
    // backed by the same on-disk JSON state file.
    const afterRestart = createWorkflowEnvelopeRepository({
      store: buildStore(),
    });

    const all = await afterRestart.listAll();
    expect(all.map((e) => e.workflowId).sort()).toEqual([
      "wf-failed",
      "wf-paused",
      "wf-running",
    ]);

    const paused = await afterRestart.get("wf-paused");
    expect(paused?.status).toBe("paused");
    expect(paused?.pause?.pauseKind).toBe("mid_turn");
    expect(paused?.pause?.gateKind).toBe("ask_user");
    expect(paused?.pause?.resumeToken).toBe("tok-survives-disk-reload");

    const failed = await afterRestart.get("wf-failed");
    expect(failed?.status).toBe("failed");
    expect(failed?.errorSummary).toBe("still readable after restart");
    expect(failed?.completedAt).toBe("2026-04-28T10:01:00.000Z");
  });

  it("serializes concurrent updates against the same workflow via the write queue so neither write is lost", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: buildStore(),
    });
    await repo.create(buildEnvelope({ featureSnapshot: { counter: 0 } }));

    await Promise.all([
      repo.update("wf-1", { phase: "phase-A" }),
      repo.update("wf-1", { featureSnapshot: { counter: 1 } }),
    ]);

    // Reload from disk through a fresh state manager to confirm the writes
    // landed atomically rather than racing in-memory caches.
    const reloaded = createWorkflowEnvelopeRepository({
      store: buildStore(),
    });
    const fetched = await reloaded.get("wf-1");
    expect(fetched?.phase).toBe("phase-A");
    expect(fetched?.featureSnapshot).toEqual({ counter: 1 });
  });

  it("delete removes the envelope from on-disk session state", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: buildStore(),
    });
    await repo.create(buildEnvelope({ workflowId: "wf-keep" }));
    await repo.create(buildEnvelope({ workflowId: "wf-drop" }));

    const store = buildStore();
    await store.delete("wf-drop");

    const reloaded = createWorkflowEnvelopeRepository({
      store: buildStore(),
    });
    const all = await reloaded.listAll();
    expect(all.map((e) => e.workflowId)).toEqual(["wf-keep"]);
  });

  it("listChildren survives a restart because parentWorkflowId lives in the durable envelope", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: buildStore(),
    });
    await repo.create(buildEnvelope({ workflowId: "parent-1" }));
    await repo.create(
      buildEnvelope({ workflowId: "child-1a", parentWorkflowId: "parent-1" }),
    );
    await repo.create(
      buildEnvelope({ workflowId: "child-1b", parentWorkflowId: "parent-1" }),
    );

    const reloaded = createWorkflowEnvelopeRepository({
      store: buildStore(),
    });
    const children = await reloaded.listChildren("parent-1");
    expect(children.map((e) => e.workflowId).sort()).toEqual([
      "child-1a",
      "child-1b",
    ]);
  });

  it("envelope writes from independent repository instances stay serialized via the write queue", async () => {
    const repoA = createWorkflowEnvelopeRepository({
      store: buildStore(),
    });
    const repoB = createWorkflowEnvelopeRepository({
      store: buildStore(),
    });
    await repoA.create(buildEnvelope({ featureSnapshot: { counter: 0 } }));

    await Promise.all([
      repoA.update("wf-1", { phase: "from-repo-A" }),
      repoB.update("wf-1", { featureSnapshot: { counter: 7 } }),
    ]);

    const reloaded = createWorkflowEnvelopeRepository({ store: buildStore() });
    const fetched = await reloaded.get("wf-1");
    expect(fetched?.phase).toBe("from-repo-A");
    expect(fetched?.featureSnapshot).toEqual({ counter: 7 });
  });

  it("rejects featureSnapshot: undefined before it ever reaches the JSON state file", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: buildStore(),
    });
    await expect(
      repo.create({
        workflowId: "wf-undef",
        workflowType: "collaboration",
        status: "running",
        phase: "initial-proposals",
        createdAt: "2026-04-28T10:00:00.000Z",
        updatedAt: "2026-04-28T10:00:00.000Z",
        // Explicit undefined would be silently dropped by JSON.stringify and
        // become a missing field after restart. The schema must block it.
        featureSnapshot: undefined,
      } as unknown as WorkflowEnvelope),
    ).rejects.toThrow(/featureSnapshot/i);

    const reloaded = createWorkflowEnvelopeRepository({ store: buildStore() });
    expect(await reloaded.get("wf-undef")).toBeNull();
  });

  it("rejects updates that would change a snapshot to undefined so JSON serialization can never strip it", async () => {
    const repo = createWorkflowEnvelopeRepository({ store: buildStore() });
    await repo.create(buildEnvelope({ featureSnapshot: { round: 0 } }));

    await expect(
      repo.update("wf-1", {
        featureSnapshot: undefined,
      } as Partial<WorkflowEnvelope>),
    ).rejects.toThrow(/featureSnapshot/i);

    const reloaded = createWorkflowEnvelopeRepository({ store: buildStore() });
    const fetched = await reloaded.get("wf-1");
    expect(fetched?.featureSnapshot).toEqual({ round: 0 });
  });

  it("preserves an explicit null snapshot through a JSON round-trip (restart-safe empty snapshot)", async () => {
    const repo = createWorkflowEnvelopeRepository({ store: buildStore() });
    await repo.create(buildEnvelope({ featureSnapshot: null }));

    const reloaded = createWorkflowEnvelopeRepository({ store: buildStore() });
    const fetched = await reloaded.get("wf-1");
    expect(fetched).not.toBeNull();
    expect(fetched!.featureSnapshot).toBeNull();
    expect("featureSnapshot" in (fetched as object)).toBe(true);
  });

  it("envelope writes interleave safely with other session-state mutations under the write queue", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: buildStore(),
    });
    await repo.create(buildEnvelope({ featureSnapshot: { counter: 0 } }));

    const stateManager = createTestStateManager();

    // The concurrent non-envelope write targets `targetBranch` rather than
    // `lastActivityAt`: the focused envelope setter restamps `lastActivityAt`
    // on every write (mirroring `setActiveGraphWorkflowExecution`), so a
    // manually-set timestamp would be legitimately overwritten by the later
    // envelope update. `targetBranch` is a field the focused envelope path never
    // touches, so it faithfully witnesses that the generic mutation landed and
    // was not lost when interleaved with the envelope writes.
    await Promise.all([
      repo.update("wf-1", { phase: "envelope-side" }),
      stateManager.mutateSession(
        PROJECT_PATH,
        SESSION_NAME,
        "concurrent-non-envelope-write",
        (session) => {
          session.targetBranch = "concurrent-branch";
        },
      ),
      repo.update("wf-1", { featureSnapshot: { counter: 42 } }),
    ]);

    const reloaded = createWorkflowEnvelopeRepository({ store: buildStore() });
    const fetched = await reloaded.get("wf-1");
    expect(fetched?.phase).toBe("envelope-side");
    expect(fetched?.featureSnapshot).toEqual({ counter: 42 });

    const session = await stateManager.getSession(PROJECT_PATH, SESSION_NAME);
    expect(session?.targetBranch).toBe("concurrent-branch");
  });
});
