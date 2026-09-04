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

import {
  _resetPublicationForTesting,
  setPublicationBroadcastForTesting,
} from "@/lib/events/publication";
import { _resetForTesting as resetJobQueue } from "@/lib/jobs/queue";
import { resetGraphExecutionLifecycleCallbacksForTesting } from "@/lib/workflow-graph/execution-lifecycle-port";
import { _resetDeliveryGateEvaluatorForTesting } from "@/lib/workflows/merge/delivery-gate-port";

import type { DeliveryPlanBinding } from "./delivery-plan";
import type { Spec, SpecDeliveryPlanAttemptRow } from "./schemas";
import {
  approveAndSignOffSpine,
  authorSpineDeliveryPlanCharter,
  authorSpineDraft,
  createSpecSpineWorld,
  proposeSpineRevision,
  SPINE_PROJECT_PATH,
  SPINE_WORKFLOW_EXECUTION_ID,
  startSpineExecution,
  startSpineWorkflowThroughProductionGate,
  type AuthoredSpineSpec,
  type SpecSpineWorld,
} from "./spine-test-fixture";

const SLUG = "spec-spine";
const AGENT = {
  kind: "agent",
  conversationId: "conversation-spine",
  backend: "claude",
} as const;
const HUMAN = { kind: "human" } as const;

/**
 * `spec abandon --execution` is the exit an agent takes off a launched run
 * (I-13). Before this, only the capture path retired the attempt, so an
 * abandoned run left its attempt reading `launched` — `nextAct` said "the
 * immutable launch is running" and `spec start` refused "not signed off",
 * with the working exit (`spec plan open`) stated nowhere. These tests drive
 * the production route over the real coordinator, plan service and SQLite, so
 * what is proven is the durable attempt row rather than a fake's call log.
 */
describe("spec abandon --execution retires the launched attempt", () => {
  let world: SpecSpineWorld;

  beforeEach(() => {
    resetJobQueue();
    _resetDeliveryGateEvaluatorForTesting();
    resetGraphExecutionLifecycleCallbacksForTesting();
    world = createSpecSpineWorld();
    setPublicationBroadcastForTesting(() => ({ delivered: true }));
  });

  afterEach(() => {
    resetJobQueue();
    _resetDeliveryGateEvaluatorForTesting();
    resetGraphExecutionLifecycleCallbacksForTesting();
    _resetPublicationForTesting();
  });

  function deferredBinding(authored: AuthoredSpineSpec): DeliveryPlanBinding {
    return {
      dispositions: [authored.criterionOneId, authored.criterionTwoId].map(
        (criterionElementId) => ({
          criterionElementId,
          disposition: "deferred" as const,
          deliveredByExecutionId: null,
        }),
      ),
      claims: [],
    };
  }

  async function spineSpec(): Promise<Spec> {
    const spec = await world.repos.specs.resolve(SPINE_PROJECT_PATH, SLUG);
    if (spec === null) throw new Error("the spine spec vanished");
    return spec;
  }

  /**
   * A live run whose delivery-plan attempt records the launch, which is the
   * shape `spec start` leaves behind and the one the fixture's direct insert
   * does not.
   */
  async function launchedAttempt(): Promise<{
    specExecutionId: string;
    attemptId: string;
    revisionId: string;
  }> {
    const authored = await authorSpineDraft(world, SLUG);
    await proposeSpineRevision(world, SLUG, authored);
    await approveAndSignOffSpine(world, SLUG, authored);
    const started = await startSpineExecution(world, SLUG, authored);
    await startSpineWorkflowThroughProductionGate(world, started);

    const spec = await spineSpec();
    const plans = world.services.deliveryPlan;
    const opened = await plans.open({ spec, actor: AGENT });
    if (!opened.ok) throw new Error(opened.refusal.unmetConditions.join(" "));
    await authorSpineDeliveryPlanCharter(
      world,
      opened.value.attempt.workflowDefinitionId,
    );
    const edited = await plans.edit({
      spec,
      expectedDraftRevision: opened.value.attempt.draftRevision,
      binding: deferredBinding(authored),
      actor: AGENT,
    });
    if (!edited.ok) throw new Error(edited.refusal.unmetConditions.join(" "));
    const proposed = await plans.propose({ spec, actor: AGENT });
    if (!proposed.ok)
      throw new Error(proposed.refusal.unmetConditions.join(" "));
    const candidateId = proposed.value.attempt.candidateId;
    const candidateHash = proposed.value.attempt.candidateHash;
    if (candidateId === null || candidateHash === null) {
      throw new Error("the proposal froze no candidate");
    }
    const candidate = { candidateId, candidateHash };
    const signed = await plans.signOff({
      spec,
      ...candidate,
      actor: HUMAN,
      approver: "Alex",
    });
    if (!signed.ok) throw new Error(signed.refusal.unmetConditions.join(" "));
    const launched = await plans.recordLaunch({
      spec,
      executionId: started.specExecutionId,
      candidate,
      actor: AGENT,
    });
    if (!launched.ok)
      throw new Error(launched.refusal.unmetConditions.join(" "));

    return {
      specExecutionId: started.specExecutionId,
      attemptId: launched.value.attempt.id,
      revisionId: authored.draftRevisionId,
    };
  }

  const REASON = "the plan was superseded";

  function abandon(workflowExecutionId: string): Promise<Response> {
    return world.postAction(
      SLUG,
      "abandon-execution",
      { executionId: workflowExecutionId, reason: REASON },
      "agent",
    );
  }

  function attempt(attemptId: string): SpecDeliveryPlanAttemptRow {
    const found = world.repos.deliveryPlans.findAttemptById(attemptId);
    if (found === null) throw new Error("the plan attempt vanished");
    return found;
  }

  /**
   * Abandon transitions durably recorded against one attempt. Counted from the
   * audit rows rather than the status, because an idempotent retirement and a
   * double-recorded one leave the SAME status behind.
   */
  function abandonTransitions(attemptId: string): { reason: unknown }[] {
    const rows = world.db
      .prepare(
        "SELECT payload_json FROM spec_events WHERE event_type = 'spec-delivery-plan-transitioned'",
      )
      .all() as { payload_json: string }[];
    return rows.flatMap((row) => {
      const payload: unknown = JSON.parse(row.payload_json);
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("attemptId" in payload) ||
        payload.attemptId !== attemptId ||
        !("transition" in payload) ||
        typeof payload.transition !== "object" ||
        payload.transition === null ||
        !("kind" in payload.transition) ||
        payload.transition.kind !== "abandon"
      ) {
        return [];
      }
      const transition: Record<string, unknown> = payload.transition;
      return [{ reason: transition["reason"] }];
    });
  }

  it("records exactly one abandon transition on the launched attempt", async () => {
    const { attemptId } = await launchedAttempt();

    expect((await abandon(SPINE_WORKFLOW_EXECUTION_ID)).status).toBe(200);

    const retired = attempt(attemptId);
    expect(retired.status).toBe("abandoned");
    // The reason the caller gave rides the durable transition, so the audit
    // says WHY the attempt was retired and not merely that it was.
    expect(abandonTransitions(attemptId)).toEqual([{ reason: REASON }]);
  });

  it("records no second transition when the coordinator resumes from a parked phase", async () => {
    const { specExecutionId, attemptId } = await launchedAttempt();
    // Park the coordinator at `finalize`: the abort already released the
    // lease, so the retry re-enters the one phase that retires the attempt.
    let observed = 0;
    world.cleanupFaults.beforeOp = (op) => {
      if (op !== "observe") return;
      observed += 1;
      if (observed === 2) throw new Error("injected post-abort fault");
    };
    expect((await abandon(SPINE_WORKFLOW_EXECUTION_ID)).status).not.toBe(200);
    const parked = world.repos.delivery.findExecutionById(specExecutionId);
    expect(parked?.cleanup_phase).toBe("finalize");

    world.cleanupFaults.beforeOp = null;
    expect((await abandon(SPINE_WORKFLOW_EXECUTION_ID)).status).toBe(200);
    expect((await abandon(SPINE_WORKFLOW_EXECUTION_ID)).status).not.toBe(200);

    expect(attempt(attemptId).status).toBe("abandoned");
    expect(abandonTransitions(attemptId)).toHaveLength(1);
  });

  it("refuses a spec-side execution row id and names the workflow execution id", async () => {
    const { specExecutionId, attemptId } = await launchedAttempt();

    const response = await abandon(specExecutionId);

    expect(response.status).not.toBe(200);
    const body: unknown = await response.json();
    expect(JSON.stringify(body)).toContain(SPINE_WORKFLOW_EXECUTION_ID);
    expect(JSON.stringify(body)).toContain("spec_side_execution_id");
    expect(attempt(attemptId).status).toBe("launched");
  });

  it("keeps the gate_blocked refusal for an already-terminal execution", async () => {
    const { specExecutionId, attemptId } = await launchedAttempt();
    expect((await abandon(SPINE_WORKFLOW_EXECUTION_ID)).status).toBe(200);

    const second = await abandon(SPINE_WORKFLOW_EXECUTION_ID);

    expect(second.status).not.toBe(200);
    const body = JSON.stringify(await second.json());
    expect(body).toContain("gate_blocked");
    // The public boundary resolves the caller's workflow execution id into the
    // internal row id before the coordinator runs, so the refusal has to
    // re-derive the addressable id from the row rather than echo its input.
    expect(body).toContain(SPINE_WORKFLOW_EXECUTION_ID);
    expect(body).not.toContain(`"${specExecutionId}"`);
    expect(body).not.toContain(`Execution ${specExecutionId} `);
    expect(abandonTransitions(attemptId)).toHaveLength(1);
  });

  it("refuses a start after the abandon by naming the open verb, not the sign-off", async () => {
    const { revisionId } = await launchedAttempt();
    expect((await abandon(SPINE_WORKFLOW_EXECUTION_ID)).status).toBe(200);

    const started = await world.postAction(
      SLUG,
      "start-execution",
      { revisionId, sessionName: null },
      "agent",
    );

    expect(started.status).not.toBe(200);
    const body = JSON.stringify(await started.json());
    expect(body).toContain(`cctl spec plan open ${SLUG}`);
    expect(body).not.toContain("not signed off");
  });

  it("records exactly one transition when a blocking capture abandons the run", async () => {
    const { attemptId } = await launchedAttempt();

    const response = await world.postAction(
      SLUG,
      "capture-scope-amendment",
      {
        executionId: SPINE_WORKFLOW_EXECUTION_ID,
        discoveredTask: {
          title: "Handle the discovered migration",
          instructions: "Write the migration the run uncovered.",
          tracedRequirementElementIds: [],
          tracedDecisionElementIds: [],
          coveredCriterionElementIds: [],
          dependsOnTaskElementIds: [],
        },
        blockingReason: "the discovery blocks the run",
      },
      "agent",
    );

    expect(response.status).toBe(200);
    expect(attempt(attemptId).status).toBe("abandoned");
    expect(abandonTransitions(attemptId)).toHaveLength(1);
  });
});
