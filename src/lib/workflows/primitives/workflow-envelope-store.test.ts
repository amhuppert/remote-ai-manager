import { describe, expect, it } from "vitest";
import { createInMemoryWorkflowEnvelopeStore } from "./workflow-envelope-store";
import type { WorkflowEnvelope } from "./workflow-envelope-vocabulary";

const T0 = "2026-04-28T10:00:00.000Z";
const T1 = "2026-04-28T10:05:00.000Z";

function buildEnvelope(
  overrides: Partial<WorkflowEnvelope> = {},
): WorkflowEnvelope {
  return {
    workflowId: "wf-1",
    workflowType: "graph_workflow",
    status: "running",
    phase: "executing",
    createdAt: T0,
    updatedAt: T0,
    featureSnapshot: { activeContextId: "ctx-1" },
    ...overrides,
  };
}

describe("createInMemoryWorkflowEnvelopeStore", () => {
  it("returns null when no envelope exists for the workflow id", async () => {
    const store = createInMemoryWorkflowEnvelopeStore();
    expect(await store.read("missing-wf")).toBeNull();
  });

  it("upsert persists a new envelope visible via read()", async () => {
    const store = createInMemoryWorkflowEnvelopeStore();
    const envelope = buildEnvelope();
    await store.upsert(envelope.workflowId, () => envelope);
    const read = await store.read(envelope.workflowId);
    expect(read).toEqual(envelope);
  });

  it("validates envelope shape on upsert so invalid envelopes never persist", async () => {
    const store = createInMemoryWorkflowEnvelopeStore();
    await expect(
      store.upsert(
        "wf-1",
        () =>
          ({
            ...buildEnvelope(),
            workflowId: "",
          }) as unknown as WorkflowEnvelope,
      ),
    ).rejects.toThrow();
    expect(await store.read("wf-1")).toBeNull();
  });

  it("rejects mutators that return an envelope with a different workflowId", async () => {
    const store = createInMemoryWorkflowEnvelopeStore();
    await expect(
      store.upsert("wf-1", () => buildEnvelope({ workflowId: "wf-2" })),
    ).rejects.toThrow(/workflowId/i);
  });

  it("clones state on read so external mutations cannot leak into the store", async () => {
    const store = createInMemoryWorkflowEnvelopeStore();
    await store.upsert("wf-1", () =>
      buildEnvelope({ featureSnapshot: { round: 0 } }),
    );
    const read = (await store.read("wf-1"))!;
    (read.featureSnapshot as { round: number }).round = 99;
    const reread = (await store.read("wf-1"))!;
    expect(reread.featureSnapshot).toEqual({ round: 0 });
  });

  it("upsert receives the prior envelope so callers can merge atomically", async () => {
    const store = createInMemoryWorkflowEnvelopeStore();
    await store.upsert("wf-1", () => buildEnvelope({ updatedAt: T0 }));
    const result = await store.upsert("wf-1", (existing) => {
      expect(existing).not.toBeNull();
      return {
        ...existing!,
        updatedAt: T1,
        status: "paused",
        phase: "awaiting-user-input",
        pause: {
          pauseKind: "mid_turn",
          gateKind: "ask_user",
          resumeToken: "tok-1",
        },
      };
    });
    expect(result.status).toBe("paused");
    expect(result.updatedAt).toBe(T1);
    const read = await store.read("wf-1");
    expect(read?.phase).toBe("awaiting-user-input");
  });

  it("serializes concurrent upserts on the same workflowId so neither write is lost", async () => {
    const store = createInMemoryWorkflowEnvelopeStore();
    await store.upsert("wf-1", () =>
      buildEnvelope({ featureSnapshot: { counter: 0 } }),
    );

    await Promise.all([
      store.upsert("wf-1", async (existing) => {
        await new Promise<void>((r) => setTimeout(r, 5));
        return {
          ...existing!,
          updatedAt: T1,
          featureSnapshot: {
            counter:
              ((existing!.featureSnapshot as { counter: number }).counter ??
                0) + 1,
          },
        };
      }),
      store.upsert("wf-1", async (existing) => {
        await new Promise<void>((r) => setTimeout(r, 1));
        return {
          ...existing!,
          updatedAt: T1,
          featureSnapshot: {
            counter:
              ((existing!.featureSnapshot as { counter: number }).counter ??
                0) + 1,
          },
        };
      }),
    ]);

    const read = await store.read("wf-1");
    expect(read?.featureSnapshot).toEqual({ counter: 2 });
  });

  it("removes envelopes via delete()", async () => {
    const store = createInMemoryWorkflowEnvelopeStore();
    await store.upsert("wf-1", () => buildEnvelope());
    await store.delete("wf-1");
    expect(await store.read("wf-1")).toBeNull();
  });

  it("lists all stored envelopes for restart discovery", async () => {
    const store = createInMemoryWorkflowEnvelopeStore();
    await store.upsert("wf-1", () => buildEnvelope({ workflowId: "wf-1" }));
    await store.upsert("wf-2", () =>
      buildEnvelope({
        workflowId: "wf-2",
        status: "completed",
        completedAt: T1,
      }),
    );
    await store.upsert("wf-3", () =>
      buildEnvelope({
        workflowId: "wf-3",
        status: "failed",
        completedAt: T1,
        errorSummary: "boom",
      }),
    );

    const all = await store.listAll();
    expect(all.map((e) => e.workflowId).sort()).toEqual([
      "wf-1",
      "wf-2",
      "wf-3",
    ]);
  });
});
