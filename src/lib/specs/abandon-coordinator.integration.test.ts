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
import { holdsExecutionLease } from "@/lib/workflow-graph/lifecycle-classifier";
import type { GraphWorkflowHaltReason } from "@/lib/workflow-graph/schemas";
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

  /**
   * The lease, not the row position, is what "the orphan is gone" means (D4):
   * the production abort seam transitions the run and stops, leaving a
   * lease-free record the next launch normalizes. Asserting an empty active row
   * would demand a relocation production does not perform here.
   */
  function expectLeaseReleased(): void {
    const active = world.readActiveWorkflowExecution();
    if (active === null) return;
    expect(
      holdsExecutionLease(active.status, active.haltReason, active.abandonment),
    ).toBe(false);
  }

  it("aborts the workflow — which releases the lease — and only then abandons", async () => {
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
    expect(world.readActiveWorkflowExecution()?.status).toBe("aborted");
    expectLeaseReleased();

    // One workflow act, not two: `aborted` releases the lease by itself, so
    // there is no separate slot-released phase to record.
    const kinds = cleanupEventKinds(stored.spec_id);
    expect(kinds).toContain("execution_cleanup_workflow_aborted");
    expect(kinds).not.toContain("execution_cleanup_slot_released");
    expect(kinds).toContain("execution_abandoned");
  });

  it("abandons a resumably halted run instead of aborting it, preserving the halt and its audit", async () => {
    // The act R4 reserves for a halt that still holds the lease. Aborting it
    // would answer the lease just as well and lose exactly what History needs:
    // the halt reason the run ended on, and a record of who ended its tenure.
    const { specExecutionId } = await liveExecution();
    const halt: GraphWorkflowHaltReason = {
      type: "execution_loop_failed",
      contextId: "context-plan",
      message: "the loop threw",
      cause: "unknown",
    };
    await world.haltWorkflowExecution(halt);
    const halted = world.readActiveWorkflowExecution();
    expect(
      holdsExecutionLease(
        halted!.status,
        halted!.haltReason,
        halted!.abandonment,
      ),
    ).toBe(true);

    const response = await abandon(specExecutionId);
    expect(response.status).toBe(200);

    const stored = row(specExecutionId);
    expect(stored.state).toBe("abandoned");
    expect(stored.cleanup_phase).toBeNull();
    // The audit says what actually happened to the linked run.
    const kinds = cleanupEventKinds(stored.spec_id);
    expect(kinds).toContain("execution_cleanup_workflow_abandoned");
    expect(kinds).not.toContain("execution_cleanup_workflow_aborted");
    // The run left the lease behind, not its halt disposition.
    expectLeaseReleased();
    const archived = world.readArchivedWorkflowExecution();
    expect(archived?.status).toBe("halted");
    expect(archived?.haltReason).toEqual(halt);
    expect(archived?.abandonment).toMatchObject({
      reason: "superseded by a replanned run",
    });
  });

  it("never reports success while a halted linked run still holds the lease", async () => {
    const { specExecutionId } = await liveExecution();
    await world.haltWorkflowExecution({
      type: "execution_loop_failed",
      contextId: "context-plan",
      message: "the loop threw",
      cause: "unknown",
    });
    world.cleanupFaults.abandonIsNoOp = true;

    const response = await abandon(specExecutionId);
    expect(response.status).not.toBe(200);
    const refusal = (await response.json()) as { instruction?: string };
    // refusals-name-remedy: the halt's remedy is abandon, never abort.
    expect(refusal.instruction).toMatch(/cctl workflow abandon/);

    expect(row(specExecutionId).state).toBe("abandoning");
  });

  it("never reports success while the linked workflow is still live", async () => {
    const { specExecutionId } = await liveExecution();
    // The abort seam accepts the call but leaves the run live — the coordinator
    // must refuse rather than finalize over a run that still holds the lease.
    world.cleanupFaults.abortIsNoOp = true;

    const response = await abandon(specExecutionId);
    expect(response.status).not.toBe(200);
    // refusals-name-remedy: the refusal names the exact verb that unblocks it.
    const refusal = (await response.json()) as {
      instruction?: string;
      unmetConditions?: string[];
    };
    expect(refusal.instruction).toMatch(/cctl workflow live abort/);
    expect(refusal.unmetConditions?.join(" ")).toMatch(
      /still holds this session's execution lease/,
    );

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
      durablePhase: "finalize",
      inject: () => {
        let observed = 0;
        world.cleanupFaults.beforeOp = (op) => {
          if (op !== "observe") return;
          observed += 1;
          // The second observation is the one taken at `finalize`, i.e.
          // immediately after the abort succeeded and released the lease.
          if (observed === 2) throw new Error("injected post-abort fault");
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
      expectLeaseReleased();
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
