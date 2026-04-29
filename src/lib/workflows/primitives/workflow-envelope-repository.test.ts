import { describe, expect, it } from "vitest";
import { createInMemoryWorkflowEnvelopeStore } from "./workflow-envelope-store";
import { createWorkflowEnvelopeRepository } from "./workflow-envelope-repository";
import type {
  WorkflowEnvelope,
  WorkflowEnvelopePause,
} from "./workflow-envelope-vocabulary";

const T0 = "2026-04-28T10:00:00.000Z";
const T1 = "2026-04-28T10:05:00.000Z";
const T2 = "2026-04-28T10:10:00.000Z";

function clockSequence(...values: string[]): () => string {
  let i = 0;
  return () => {
    const value = values[i] ?? values[values.length - 1];
    if (i < values.length - 1) i++;
    return value!;
  };
}

function buildEnvelope(
  overrides: Partial<WorkflowEnvelope> = {},
): WorkflowEnvelope {
  return {
    workflowId: "wf-1",
    workflowType: "collaboration",
    status: "running",
    phase: "initial-proposals",
    createdAt: T0,
    updatedAt: T0,
    featureSnapshot: { round: 0 },
    ...overrides,
  };
}

describe("createWorkflowEnvelopeRepository — create + get", () => {
  it("persists a new envelope and exposes it via get()", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0),
    });
    await repo.create(buildEnvelope());
    const fetched = await repo.get("wf-1");
    expect(fetched?.workflowId).toBe("wf-1");
    expect(fetched?.status).toBe("running");
  });

  it("rejects creating an envelope when one already exists for the same workflowId", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0),
    });
    await repo.create(buildEnvelope());
    await expect(repo.create(buildEnvelope())).rejects.toThrow(
      /already exists/i,
    );
  });

  it("returns null for unknown workflow ids", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0),
    });
    expect(await repo.get("missing")).toBeNull();
  });
});

describe("createWorkflowEnvelopeRepository — update", () => {
  it("merges a partial patch into the stored envelope", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0, T1),
    });
    await repo.create(buildEnvelope());
    const updated = await repo.update("wf-1", {
      status: "paused",
      phase: "awaiting-user-input",
      featureSnapshot: { round: 1 },
      pause: {
        pauseKind: "mid_turn",
        gateKind: "ask_user",
        resumeToken: "tok-1",
      },
    });
    expect(updated.status).toBe("paused");
    expect(updated.phase).toBe("awaiting-user-input");
    expect(updated.featureSnapshot).toEqual({ round: 1 });
  });

  it("auto-stamps updatedAt from the injected clock on every update", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0, T1),
    });
    await repo.create(buildEnvelope());
    const updated = await repo.update("wf-1", { phase: "executing" });
    expect(updated.updatedAt).toBe(T1);
  });

  it("auto-stamps completedAt when transitioning to a terminal status", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0, T1),
    });
    await repo.create(buildEnvelope());
    const completed = await repo.update("wf-1", { status: "completed" });
    expect(completed.completedAt).toBe(T1);
  });

  it("auto-stamps completedAt for failed envelopes too", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0, T1),
    });
    await repo.create(buildEnvelope());
    const failed = await repo.update("wf-1", {
      status: "failed",
      errorSummary: "schema validation failed",
    });
    expect(failed.status).toBe("failed");
    expect(failed.completedAt).toBe(T1);
    expect(failed.errorSummary).toBe("schema validation failed");
  });

  it("preserves the existing completedAt when an explicit value is supplied", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0, T2),
    });
    await repo.create(buildEnvelope());
    const completed = await repo.update("wf-1", {
      status: "completed",
      completedAt: T1,
    });
    expect(completed.completedAt).toBe(T1);
  });

  it("rejects updates targeting an unknown workflow id", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0),
    });
    await expect(repo.update("ghost", { phase: "x" })).rejects.toThrow(
      /not found/i,
    );
  });

  it("rejects updates that would change immutable identity fields", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0, T1),
    });
    await repo.create(buildEnvelope());
    await expect(
      repo.update("wf-1", {
        workflowId: "wf-mutated",
      } as Partial<WorkflowEnvelope>),
    ).rejects.toThrow(/immutable/i);
    await expect(
      repo.update("wf-1", {
        workflowType: "graph_workflow",
      } as Partial<WorkflowEnvelope>),
    ).rejects.toThrow(/immutable/i);
    await expect(
      repo.update("wf-1", {
        createdAt: T1,
      } as Partial<WorkflowEnvelope>),
    ).rejects.toThrow(/immutable/i);
  });
});

describe("createWorkflowEnvelopeRepository — listing queries", () => {
  it("listActive returns running and paused envelopes only", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0, T1, T2, T2),
    });
    await repo.create(buildEnvelope({ workflowId: "wf-running" }));
    await repo.create(
      buildEnvelope({
        workflowId: "wf-paused",
        status: "paused",
        pause: {
          pauseKind: "mid_turn",
          gateKind: "ask_user",
          resumeToken: "tok-paused",
        },
      }),
    );
    await repo.create(
      buildEnvelope({
        workflowId: "wf-completed",
        status: "completed",
        completedAt: T1,
      }),
    );
    await repo.create(
      buildEnvelope({
        workflowId: "wf-failed",
        status: "failed",
        completedAt: T1,
        errorSummary: "boom",
      }),
    );

    const active = await repo.listActive();
    const ids = active.map((e) => e.workflowId).sort();
    expect(ids).toEqual(["wf-paused", "wf-running"]);
  });

  it("listByStatus exposes completed and failed envelopes for UI/recovery queries", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0, T0, T0, T0),
    });
    await repo.create(buildEnvelope({ workflowId: "wf-r" }));
    await repo.create(
      buildEnvelope({
        workflowId: "wf-p",
        status: "paused",
        pause: {
          pauseKind: "post_turn",
          gateKind: "human_approval",
          resumeToken: "tok-p",
        },
      }),
    );
    await repo.create(
      buildEnvelope({
        workflowId: "wf-c",
        status: "completed",
        completedAt: T0,
      }),
    );
    await repo.create(
      buildEnvelope({
        workflowId: "wf-f",
        status: "failed",
        completedAt: T0,
        errorSummary: "x",
      }),
    );

    expect(
      (await repo.listByStatus("running")).map((e) => e.workflowId),
    ).toEqual(["wf-r"]);
    expect(
      (await repo.listByStatus("paused")).map((e) => e.workflowId),
    ).toEqual(["wf-p"]);
    expect(
      (await repo.listByStatus("completed")).map((e) => e.workflowId),
    ).toEqual(["wf-c"]);
    expect(
      (await repo.listByStatus("failed")).map((e) => e.workflowId),
    ).toEqual(["wf-f"]);
  });

  it("listAll surfaces every envelope regardless of status (restart discovery)", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0, T0, T0, T0),
    });
    await repo.create(buildEnvelope({ workflowId: "wf-1" }));
    await repo.create(
      buildEnvelope({
        workflowId: "wf-2",
        status: "paused",
        pause: {
          pauseKind: "mid_turn",
          gateKind: "ask_user",
          resumeToken: "tok-2",
        },
      }),
    );
    await repo.create(
      buildEnvelope({
        workflowId: "wf-3",
        status: "completed",
        completedAt: T0,
      }),
    );

    const all = await repo.listAll();
    expect(all.map((e) => e.workflowId).sort()).toEqual([
      "wf-1",
      "wf-2",
      "wf-3",
    ]);
  });
});

describe("createWorkflowEnvelopeRepository — pause and recovery semantics", () => {
  function midTurnPause(
    overrides: Partial<WorkflowEnvelopePause> = {},
  ): WorkflowEnvelopePause {
    return {
      pauseKind: "mid_turn",
      gateKind: "ask_user",
      resumeToken: "ask-user-1",
      ...overrides,
    };
  }

  function postTurnPause(
    overrides: Partial<WorkflowEnvelopePause> = {},
  ): WorkflowEnvelopePause {
    return {
      pauseKind: "post_turn",
      gateKind: "human_approval",
      resumeToken: "approval-1",
      ...overrides,
    };
  }

  it("markPaused projects a mid-turn pause and survives a round-trip through get()", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0, T1),
    });
    await repo.create(buildEnvelope());
    await repo.markPaused("wf-1", midTurnPause());

    const fetched = await repo.get("wf-1");
    expect(fetched?.status).toBe("paused");
    expect(fetched?.pause?.pauseKind).toBe("mid_turn");
    expect(fetched?.pause?.gateKind).toBe("ask_user");
    expect(fetched?.pause?.resumeToken).toBe("ask-user-1");
    expect(fetched?.updatedAt).toBe(T1);
  });

  it("markPaused projects a post-turn pause distinctly from mid-turn", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0, T1),
    });
    await repo.create(buildEnvelope());
    await repo.markPaused("wf-1", postTurnPause());

    const fetched = await repo.get("wf-1");
    expect(fetched?.status).toBe("paused");
    expect(fetched?.pause?.pauseKind).toBe("post_turn");
    expect(fetched?.pause?.gateKind).toBe("human_approval");
  });

  it("markFailed projects status=failed with the shared failure summary", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0, T1),
    });
    await repo.create(buildEnvelope());
    await repo.markFailed("wf-1", "Codex backend unavailable after 3 retries");

    const fetched = await repo.get("wf-1");
    expect(fetched?.status).toBe("failed");
    expect(fetched?.errorSummary).toBe(
      "Codex backend unavailable after 3 retries",
    );
    expect(fetched?.completedAt).toBe(T1);
  });

  it("markRunning clears the pause projection on resume so the envelope cannot drift", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0, T1, T2),
    });
    await repo.create(buildEnvelope());
    await repo.markPaused("wf-1", midTurnPause());

    const resumed = await repo.markRunning("wf-1");
    expect(resumed.status).toBe("running");
    expect(resumed.pause).toBeUndefined();
    expect(resumed.updatedAt).toBe(T2);
  });

  it("markCompleted clears any pause projection and stamps completedAt", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0, T1, T2),
    });
    await repo.create(buildEnvelope());
    await repo.markPaused("wf-1", postTurnPause());

    const completed = await repo.markCompleted("wf-1");
    expect(completed.status).toBe("completed");
    expect(completed.pause).toBeUndefined();
    expect(completed.completedAt).toBe(T2);
  });

  it("update() rejects status=paused without a pause projection (invariant)", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0, T1),
    });
    await repo.create(buildEnvelope());
    await expect(repo.update("wf-1", { status: "paused" })).rejects.toThrow(
      /pause/i,
    );
  });

  it("update() rejects status=failed without a non-empty errorSummary (invariant)", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0, T1),
    });
    await repo.create(buildEnvelope());
    await expect(repo.update("wf-1", { status: "failed" })).rejects.toThrow(
      /errorSummary/i,
    );
  });

  it("update() preserves a previously-projected pause when only the snapshot changes", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0, T1, T2),
    });
    await repo.create(buildEnvelope());
    await repo.markPaused("wf-1", midTurnPause());
    const updated = await repo.update("wf-1", {
      featureSnapshot: { round: 99 },
    });
    expect(updated.status).toBe("paused");
    expect(updated.pause?.pauseKind).toBe("mid_turn");
    expect(updated.featureSnapshot).toEqual({ round: 99 });
  });
});

describe("createWorkflowEnvelopeRepository — atomic updates under concurrency", () => {
  it("serializes concurrent updates against the same workflow so neither write is lost (atomicity provided by the store)", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0, T1, T2),
    });
    await repo.create(buildEnvelope({ featureSnapshot: { counter: 0 } }));

    await Promise.all([
      repo.update("wf-1", { phase: "phase-A" }),
      repo.update("wf-1", { featureSnapshot: { counter: 1 } }),
    ]);

    const fetched = await repo.get("wf-1");
    expect(fetched?.phase).toBe("phase-A");
    expect(fetched?.featureSnapshot).toEqual({ counter: 1 });
  });
});

describe("createWorkflowEnvelopeRepository — parent-child relationships", () => {
  it("listChildren returns only envelopes whose parentWorkflowId matches", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0),
    });
    await repo.create(buildEnvelope({ workflowId: "parent-1" }));
    await repo.create(
      buildEnvelope({ workflowId: "child-1a", parentWorkflowId: "parent-1" }),
    );
    await repo.create(
      buildEnvelope({ workflowId: "child-1b", parentWorkflowId: "parent-1" }),
    );
    await repo.create(buildEnvelope({ workflowId: "parent-2" }));
    await repo.create(
      buildEnvelope({ workflowId: "child-2a", parentWorkflowId: "parent-2" }),
    );
    await repo.create(buildEnvelope({ workflowId: "orphan" }));

    const children = await repo.listChildren("parent-1");
    expect(children.map((e) => e.workflowId).sort()).toEqual([
      "child-1a",
      "child-1b",
    ]);
  });

  it("listChildren returns an empty list for workflows with no children", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0),
    });
    await repo.create(buildEnvelope({ workflowId: "lonely" }));
    expect(await repo.listChildren("lonely")).toEqual([]);
  });
});

describe("createWorkflowEnvelopeRepository — restart discovery", () => {
  it("a fresh repository instance over the same store sees envelopes written by an earlier instance", async () => {
    const store = createInMemoryWorkflowEnvelopeStore();
    const before = createWorkflowEnvelopeRepository({
      store,
      now: clockSequence(T0, T0, T0),
    });
    await before.create(buildEnvelope({ workflowId: "wf-running" }));
    await before.create(
      buildEnvelope({
        workflowId: "wf-paused",
        status: "paused",
        pause: {
          pauseKind: "mid_turn",
          gateKind: "ask_user",
          resumeToken: "tok-survives-restart",
        },
      }),
    );
    await before.create(
      buildEnvelope({
        workflowId: "wf-failed",
        status: "failed",
        completedAt: T0,
        errorSummary: "still visible after restart",
      }),
    );

    const after = createWorkflowEnvelopeRepository({
      store,
      now: clockSequence(T1),
    });
    const allAfterRestart = await after.listAll();
    expect(allAfterRestart.map((e) => e.workflowId).sort()).toEqual([
      "wf-failed",
      "wf-paused",
      "wf-running",
    ]);

    const pausedAfterRestart = await after.get("wf-paused");
    expect(pausedAfterRestart?.pause?.resumeToken).toBe("tok-survives-restart");

    const failedAfterRestart = await after.get("wf-failed");
    expect(failedAfterRestart?.errorSummary).toBe(
      "still visible after restart",
    );
  });

  it("listActive reads through the store on every call so newly written envelopes appear without repo reinstantiation", async () => {
    const store = createInMemoryWorkflowEnvelopeStore();
    const repo = createWorkflowEnvelopeRepository({
      store,
      now: clockSequence(T0, T1),
    });
    await repo.create(buildEnvelope({ workflowId: "wf-1" }));
    expect((await repo.listActive()).map((e) => e.workflowId)).toEqual([
      "wf-1",
    ]);

    await repo.create(buildEnvelope({ workflowId: "wf-2" }));
    expect((await repo.listActive()).map((e) => e.workflowId).sort()).toEqual([
      "wf-1",
      "wf-2",
    ]);
  });
});

describe("createWorkflowEnvelopeRepository — large snapshot fallback to artifact references", () => {
  it("accepts an artifact-reference-shaped featureSnapshot in place of an inline payload", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0),
    });
    const referenceSnapshot = {
      kind: "artifact_reference" as const,
      artifactId: "art-collab-round-7",
      relativePath: ".cc/graph-workflow-docs/collab-round-7-snapshot.json",
    };
    await repo.create(
      buildEnvelope({
        workflowId: "wf-large",
        featureSnapshot: referenceSnapshot,
      }),
    );

    const fetched = await repo.get("wf-large");
    expect(fetched?.featureSnapshot).toEqual(referenceSnapshot);
  });

  it("preserves snapshot identity when migrating an inline snapshot to an artifact reference via update()", async () => {
    const repo = createWorkflowEnvelopeRepository({
      store: createInMemoryWorkflowEnvelopeStore(),
      now: clockSequence(T0, T1),
    });
    await repo.create(
      buildEnvelope({
        featureSnapshot: { rounds: Array.from({ length: 25 }, (_, i) => i) },
      }),
    );

    const reference = {
      kind: "artifact_reference" as const,
      artifactId: "art-overflow-1",
      relativePath: ".cc/workflow/wf-1/snapshot.json",
    };
    const updated = await repo.update("wf-1", { featureSnapshot: reference });

    expect(updated.featureSnapshot).toEqual(reference);
    const fetched = await repo.get("wf-1");
    expect(fetched?.featureSnapshot).toEqual(reference);
  });
});
