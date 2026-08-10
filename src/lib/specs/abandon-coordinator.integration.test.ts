import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging")>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { _resetPublicationForTesting } from "@/lib/events/publication";
import { _resetForTesting as resetJobQueue } from "@/lib/jobs/queue";
import { resetGraphExecutionLifecycleCallbacksForTesting } from "@/lib/workflow-graph/execution-lifecycle-port";
import { _resetDeliveryGateEvaluatorForTesting } from "@/lib/workflows/merge/delivery-gate-port";

import {
  approveAndSignOffSpine,
  authorSpineDraft,
  createSpecSpineWorld,
  proposeSpineRevision,
  startLegacySpineExecution,
  startSpineExecution,
  startSpineWorkflowThroughProductionGate,
  type SpecSpineWorld,
} from "./spine-test-fixture";
import type { SpecExecutionRow } from "./schemas";

const SLUG = "spec-spine";

/**
 * The abandon coordinator end to end over the real spine composition
 * (design §10; ticket #47 note 9e5ba960). `spec abandon --execution` used to
 * touch spec state only and strand the workflow it launched — the orphan then
 * held the session's execution slot and refused every `cctl validate` call in
 * that session. These tests drive the production `abandon-execution` route and
 * assert the whole chain lands, that a fault at any phase boundary leaves the
 * reached phase durable, and that retrying the SAME command converges.
 */
describe("spec abandon coordinates the linked workflow's cleanup", () => {
  let world: SpecSpineWorld;

  beforeEach(() => {
    resetJobQueue();
    _resetDeliveryGateEvaluatorForTesting();
    resetGraphExecutionLifecycleCallbacksForTesting();
    world = createSpecSpineWorld();
  });

  afterEach(() => {
    resetJobQueue();
    _resetDeliveryGateEvaluatorForTesting();
    resetGraphExecutionLifecycleCallbacksForTesting();
    _resetPublicationForTesting();
  });

  async function liveExecution(): Promise<{ specExecutionId: string }> {
    const authored = await authorSpineDraft(world, SLUG);
    await proposeSpineRevision(world, SLUG, authored);
    await approveAndSignOffSpine(world, SLUG, authored);
    const started = await startSpineExecution(world, SLUG, authored);
    await startSpineWorkflowThroughProductionGate(world, started);
    // Precondition for every case below: a genuinely live linked run holding
    // the session's slot — the exact state the orphan bug left behind.
    expect(world.readActiveWorkflowExecution()).not.toBeNull();
    return { specExecutionId: started.specExecutionId };
  }

  function abandon(specExecutionId: string): Promise<Response> {
    return world.postAction(
      SLUG,
      "abandon-execution",
      {
        executionId: specExecutionId,
        reason: "superseded by a replanned run",
      },
      "agent",
    );
  }

  function row(specExecutionId: string): SpecExecutionRow {
    const found = world.repos.delivery.findExecutionById(specExecutionId);
    if (found === null) throw new Error("spec execution vanished");
    return found;
  }

  function cleanupEventKinds(specId: string): string[] {
    return world.repos.events
      .findBySpecId(specId)
      .map((event) => JSON.parse(event.payload_json) as { kind?: string })
      .map((payload) => payload.kind)
      .filter((kind): kind is string => typeof kind === "string");
  }

  it("aborts the workflow, releases the slot, and only then abandons", async () => {
    const { specExecutionId } = await liveExecution();

    const response = await abandon(specExecutionId);
    expect(response.status).toBe(200);

    const stored = row(specExecutionId);
    expect(stored.state).toBe("abandoned");
    expect(stored.cleanup_phase).toBeNull();
    expect(stored.cleanup_last_error).toBeNull();
    expect(stored.linked_workflow_execution_id).toBe(
      stored.workflow_execution_id,
    );
    // The orphan is gone: the run no longer holds the session's slot.
    expect(world.readActiveWorkflowExecution()).toBeNull();

    const kinds = cleanupEventKinds(stored.spec_id);
    expect(kinds).toContain("execution_cleanup_workflow_aborted");
    expect(kinds).toContain("execution_cleanup_slot_released");
    expect(kinds).toContain("execution_abandoned");
  });

  it("never reports success while the linked workflow is still live", async () => {
    const { specExecutionId } = await liveExecution();
    // The abort seam accepts the call but leaves the run live — the coordinator
    // must refuse rather than finalize over a run that still owns the slot.
    world.cleanupFaults.abortIsNoOp = true;

    const response = await abandon(specExecutionId);
    expect(response.status).not.toBe(200);
    // refusals-name-remedy: the refusal names the exact verb that unblocks it.
    const refusal = (await response.json()) as {
      instruction?: string;
      unmetConditions?: string[];
    };
    expect(refusal.instruction).toMatch(/cctl workflow live abort/);
    expect(refusal.unmetConditions?.join(" ")).toMatch(/still live/);

    const stored = row(specExecutionId);
    expect(stored.state).toBe("abandoning");
    expect(stored.state).not.toBe("abandoned");
    expect(world.readActiveWorkflowExecution()).not.toBeNull();
  });

  const boundaries: Array<{
    name: string;
    durablePhase: string;
    inject(): void;
  }> = [
    {
      name: "before abort",
      durablePhase: "abort_workflow",
      inject: () => {
        world.cleanupFaults.beforeOp = (op) => {
          if (op === "abort") throw new Error("injected abort fault");
        };
      },
    },
    {
      name: "after abort",
      durablePhase: "release_slot",
      inject: () => {
        let observed = 0;
        world.cleanupFaults.beforeOp = (op) => {
          if (op !== "observe") return;
          observed += 1;
          // The second observation is the one taken at `release_slot`, i.e.
          // immediately after the abort succeeded.
          if (observed === 2) throw new Error("injected post-abort fault");
        };
      },
    },
    {
      name: "after release",
      durablePhase: "finalize",
      inject: () => {
        let observed = 0;
        world.cleanupFaults.beforeOp = (op) => {
          if (op !== "observe") return;
          observed += 1;
          // The third observation is taken at `finalize`, after the slot was
          // already released.
          if (observed === 3) throw new Error("injected post-release fault");
        };
      },
    },
    {
      name: "before finalize",
      durablePhase: "finalize",
      inject: () => {
        let observed = 0;
        world.cleanupFaults.beforeOp = (op) => {
          if (op !== "observe") return;
          observed += 1;
          if (observed === 3) throw new Error("injected pre-finalize fault");
        };
      },
    },
  ];

  for (const boundary of boundaries) {
    it(`records the reached phase durably when it faults ${boundary.name}, and the same command converges on retry`, async () => {
      const { specExecutionId } = await liveExecution();
      boundary.inject();

      const faulted = await abandon(specExecutionId);
      expect(faulted.status).not.toBe(200);

      const parked = row(specExecutionId);
      expect(parked.state).toBe("abandoning");
      expect(parked.cleanup_phase).toBe(boundary.durablePhase);
      expect(parked.cleanup_last_error).not.toBeNull();
      expect(parked.cleanup_last_error_at).not.toBeNull();
      // The cleanup target is pinned on entry, so every retry releases the run
      // the abandonment accepted responsibility for.
      expect(parked.linked_workflow_execution_id).toBe(
        parked.workflow_execution_id,
      );

      // Retrying the SAME command resumes from the recorded phase.
      world.cleanupFaults.beforeOp = null;
      const retried = await abandon(specExecutionId);
      expect(retried.status).toBe(200);

      const settled = row(specExecutionId);
      expect(settled.state).toBe("abandoned");
      expect(settled.cleanup_phase).toBeNull();
      expect(settled.cleanup_last_error).toBeNull();
      expect(world.readActiveWorkflowExecution()).toBeNull();
    });
  }

  it("refuses rather than recording a phase the cleanup port did not perform", async () => {
    // The port reports honestly that it did nothing; the coordinator must not
    // write execution_cleanup_slot_released over that no-op.
    const { specExecutionId } = await liveExecution();
    world.cleanupFaults.abortIsNoOp = true;

    const response = await abandon(specExecutionId);
    expect(response.status).not.toBe(200);

    const stored = row(specExecutionId);
    expect(stored.state).toBe("abandoning");
    expect(cleanupEventKinds(stored.spec_id)).not.toContain(
      "execution_cleanup_slot_released",
    );
  });

  it("abandons directly when no workflow was ever launched", async () => {
    const authored = await authorSpineDraft(world, SLUG);
    await proposeSpineRevision(world, SLUG, authored);
    await approveAndSignOffSpine(world, SLUG, authored);
    const started = await startLegacySpineExecution(world, SLUG, authored);

    const response = await abandon(started.specExecutionId);
    expect(response.status).toBe(200);

    const stored = row(started.specExecutionId);
    expect(stored.state).toBe("abandoned");
    expect(stored.cleanup_phase).toBeNull();
    expect(cleanupEventKinds(stored.spec_id)).toContain(
      "execution_cleanup_skipped",
    );
  });
});
