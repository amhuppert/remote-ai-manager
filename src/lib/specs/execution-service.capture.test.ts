import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createSpecDeliveryPlanRepo } from "@/lib/state-store/spec-delivery-plan-repo";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import {
  createWriteQueue,
  type WriteQueue,
} from "@/lib/state-store/write-queue";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

import {
  emptyDeliveryPlanDocument,
  type DeliveryPlanDocument,
} from "./delivery-plan";
import { createDeliveryPlanService } from "./delivery-plan-service";
import { loadDeliveryDelta } from "./delivery-delta-query";
import { classifyEarlierMergedDelivery } from "./delivery-gate";
import { createSpecEventsPublisher } from "./events";
import {
  createExecutionService,
  type ExecutionService,
  type ExecutionWorkflowDefinitions,
  type SpecWorkflowCleanupObservation,
  type SpecWorkflowCleanupTarget,
} from "./execution-service";
import {
  discoveredTaskSchema,
  type DeliveryPlanAttemptStatus,
  type DiscoveredTask,
} from "./schemas";

const PROJECT_PATH = "/repos/native-sdd-capture";
const SPEC_ID = "spec-capture";
const SPEC_SLUG = "native-sdd-capture";
const REVISION_ID = "revision-approved";
const EXECUTION_ID = "execution-running";
const WORKFLOW_EXECUTION_ID = "workflow-execution-1";
const SESSION_NAME = "session-capture";
const ATTEMPT_ID = "attempt-launched";
const NOW = "2026-07-30T10:00:00.000Z";
const AGENT = {
  kind: "agent",
  conversationId: "conversation-discovery",
} as const;

/** Capture never reaches definition storage; a call here would be a defect. */
const unusedWorkflowDefinitions: ExecutionWorkflowDefinitions = {
  findByOrigin: () => {
    throw new Error("workflow definitions are not part of scope capture");
  },
  create: () => {
    throw new Error("workflow definitions are not part of scope capture");
  },
  update: () => {
    throw new Error("workflow definitions are not part of scope capture");
  },
};

let fixture: PersistenceFixture;
let service: ExecutionService;
let plans: ReturnType<typeof createSpecDeliveryPlanRepo>;
let deliveryPlan: ReturnType<typeof createDeliveryPlanService>;
let idSequence: Map<string, number>;
let cleanupCalls: string[];
let workflowPlacement: SpecWorkflowCleanupObservation;
/** Set to make the coordinator's first observation fault, as a real one can. */
let observeFailure: string | null;
/**
 * Runs inside capture's own write-queue section, before its body. It stands in
 * for a concurrent abandon that committed between capture's guard and its
 * write — the exact interleaving a critical section has to exclude.
 */
let interposeOnCapture: (() => void) | null;

function discoveredTask(
  overrides: Partial<DiscoveredTask> = {},
): DiscoveredTask {
  return discoveredTaskSchema.parse({
    title: "Implement the discovered prerequisite",
    instructions: "Add the prerequisite in a future execution.",
    tracedRequirementElementIds: [],
    tracedDecisionElementIds: [],
    coveredCriterionElementIds: [],
    dependsOnTaskElementIds: [],
    ...overrides,
  });
}

function seedSpec(): void {
  const db = fixture.db;
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SPEC_ID,
    PROJECT_PATH,
    SPEC_SLUG,
    "Native SDD capture",
    '{"preset":"contract-bearing"}',
    null,
    null,
    NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, authoring_stage, based_on_revision_id,
       content_hash, proposed_at, approved_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    REVISION_ID,
    SPEC_ID,
    1,
    "approved",
    "plan",
    null,
    "hash-1",
    NOW,
    NOW,
    NOW,
  );

  const insertElement = db.prepare(
    `INSERT INTO spec_elements (
       id, spec_id, kind, number, parent_element_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertVersion = db.prepare(
    `INSERT INTO spec_element_versions (
       revision_id, element_id, position, payload_json, payload_hash,
       element_version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const elements = [
    {
      id: "requirement-1",
      kind: "requirement",
      number: 1,
      parent: null,
      payload: {
        kind: "requirement",
        statement: "Discovered work stays traceable.",
        priority: "must",
        risk: "high",
      },
    },
    {
      id: "criterion-1",
      kind: "criterion",
      number: 1,
      parent: "requirement-1",
      payload: {
        kind: "criterion",
        text: "Capture writes a discovery or nothing at all.",
        validationStrategy: { kinds: ["test_run"] },
      },
    },
  ];
  elements.forEach((element, position) => {
    insertElement.run(
      element.id,
      SPEC_ID,
      element.kind,
      element.number,
      element.parent,
      NOW,
    );
    insertVersion.run(
      REVISION_ID,
      element.id,
      position,
      JSON.stringify(element.payload),
      `hash-${element.id}`,
      1,
      NOW,
      NOW,
    );
  });

  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, execution_start_dial,
       workflow_definition_id, workflow_definition_revision,
       workflow_execution_id, linked_workflow_execution_id, session_name,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    EXECUTION_ID,
    SPEC_ID,
    REVISION_ID,
    JSON.stringify({
      selectedTaskIds: [],
      selectedCriterionIds: ["criterion-1"],
      exclusionDispositions: [],
    }),
    "running",
    "gate",
    "workflow-definition-1",
    1,
    WORKFLOW_EXECUTION_ID,
    WORKFLOW_EXECUTION_ID,
    SESSION_NAME,
    NOW,
    NOW,
  );
}

/** The launched plan the run is executing: one context owning the criterion. */
function launchedPlanDocument(): DeliveryPlanDocument {
  return {
    ...emptyDeliveryPlanDocument(),
    dispositions: [
      {
        criterionElementId: "criterion-1",
        disposition: "selected",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
      },
    ],
    contexts: [
      {
        contextId: "ctx-deliver",
        title: "Deliver the criterion",
        contextType: "delivery",
        criterionElementIds: ["criterion-1"],
        acceptanceContract: ["The criterion is observable in production."],
        proofPlan: [],
      },
    ],
    tasks: [
      {
        taskId: "task-deliver",
        contextId: "ctx-deliver",
        title: "Deliver the criterion",
        instructions: "Implement it.",
        order: 0,
        contributesToCriterionElementIds: ["criterion-1"],
      },
    ],
  };
}

function seedAttempt(
  status: DeliveryPlanAttemptStatus,
  launchedExecutionId: string | null,
): void {
  fixture.db
    .prepare(
      `INSERT INTO spec_delivery_plan_attempts (
         id, spec_id, pinned_revision_id, delta_basis_execution_id, status,
         draft_revision, content_json, proposed_snapshot_id, approval_json,
         prelaunch_json, launched_execution_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ATTEMPT_ID,
      SPEC_ID,
      REVISION_ID,
      null,
      status,
      1,
      JSON.stringify(launchedPlanDocument()),
      null,
      null,
      null,
      launchedExecutionId,
      NOW,
      NOW,
    );
}

/**
 * The production queue, with a hook that fires inside capture's own section.
 * The queue is the seam a concurrent writer contends on, so interposing here
 * is what lets a single-threaded test exercise the interleaving at all.
 */
function interposingWriteQueue(inner: WriteQueue): WriteQueue {
  return {
    withWriteQueue(label, fn) {
      return inner.withWriteQueue(label, fn);
    },
    withWriteQueueSync(label, fn, ...reject) {
      return inner.withWriteQueueSync(
        label,
        () => {
          if (label.startsWith("spec-capture[")) interposeOnCapture?.();
          return fn();
        },
        ...reject,
      );
    },
    tryWithWriteQueue(label, fn) {
      return inner.tryWithWriteQueue(label, fn);
    },
    _resetForTesting() {
      inner._resetForTesting();
    },
  };
}

function executionState(): string | undefined {
  return (
    fixture.db
      .prepare("SELECT state FROM spec_executions WHERE id = ?")
      .get(EXECUTION_ID) as { state: string } | undefined
  )?.state;
}

async function requireSpec() {
  const spec = await fixture.specs.findById(SPEC_ID);
  if (spec === null) throw new Error("the seeded spec vanished");
  return spec;
}

function discoveryRows(): Array<{
  id: string;
  execution_id: string;
  attempt_id: string | null;
  blocking_reason: string | null;
  discovered_task_json: string;
}> {
  return fixture.db
    .prepare(
      "SELECT * FROM spec_delivery_discoveries WHERE spec_id = ? ORDER BY id",
    )
    .all(SPEC_ID) as Array<{
    id: string;
    execution_id: string;
    attempt_id: string | null;
    blocking_reason: string | null;
    discovered_task_json: string;
  }>;
}

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  seedSpec();
  idSequence = new Map();
  cleanupCalls = [];
  workflowPlacement = { kind: "active", status: "running", leaseHeld: true };
  observeFailure = null;
  interposeOnCapture = null;

  const eventsRepo = createSpecEventsRepo(fixture.db);
  plans = createSpecDeliveryPlanRepo(fixture.db, {
    appendEvent: (event) => eventsRepo.appendInTransaction(event),
  });
  const delivery = createSpecDeliveryRepo(fixture.db);
  const events = createSpecEventsPublisher({
    appendInTransaction: eventsRepo.appendInTransaction,
    publish: () => ({ delivered: true }),
  });
  const reviewRepo = createSpecReviewRepo(fixture.db);
  let nextPlanId = 0;

  // The real plan service over the same database: a fake here would let the
  // blocking path report a replacement attempt that never seeded anything.
  deliveryPlan = createDeliveryPlanService({
    plans,
    reviewRepo,
    events,
    runInTransaction<T>(operation: () => T): T {
      return fixture.db.transaction(operation).immediate();
    },
    async currentApprovedRevision(specId) {
      const approved = (await fixture.specs.listRevisions(specId))
        .filter((revision) => revision.state === "approved")
        .sort((left, right) => right.number - left.number)[0];
      return approved === undefined
        ? null
        : fixture.specs.getRevisionSnapshot(approved.id);
    },
    revisionSnapshot: (revisionId) =>
      fixture.specs.getRevisionSnapshot(revisionId),
    deliveryDelta({ spec, pinned, sinceExecutionId }) {
      return loadDeliveryDelta(
        {
          getRevisionSnapshot: (revisionId) =>
            fixture.specs.getRevisionSnapshot(revisionId),
          findExecutionsBySpecId:
            delivery.findExecutionsBySpecId.bind(delivery),
          findCriterionDispositionsByExecution:
            delivery.findCriterionDispositionsByExecution.bind(delivery),
          findProofVerdictsByCriterionRevision:
            delivery.findProofVerdictsByCriterionRevision.bind(delivery),
          findWaiverById: delivery.findWaiverById.bind(delivery),
        },
        {
          spec,
          currentApprovedSnapshot: pinned,
          ...(sinceExecutionId === null ? {} : { sinceExecutionId }),
        },
      );
    },
    async capturedDiscoveries({ specId }) {
      return plans.findDiscoveriesBySpecId(specId).map((row) => {
        const task = discoveredTaskSchema.parse(
          JSON.parse(row.discovered_task_json),
        );
        return {
          discoveryId: row.id,
          title: task.title,
          instructions: task.instructions,
          coveredCriterionElementIds: task.coveredCriterionElementIds,
        };
      });
    },
    latestLegacyDeliverySource: async () => null,
    classifyDeliveredElsewhere: ({
      claim,
      criterionElementId,
      deliveredByExecutionId,
    }) =>
      classifyEarlierMergedDelivery(
        {
          findExecutionById: delivery.findExecutionById.bind(delivery),
          findCriterionDisposition:
            delivery.findCriterionDisposition.bind(delivery),
        },
        { id: claim.id, spec_id: claim.specId, created_at: claim.createdAt },
        {
          criterion_element_id: criterionElementId,
          delivered_by_execution_id: deliveredByExecutionId,
        },
      ),
    compilationContext: async () => null,
    nextId: () => `plan-id-${(nextPlanId += 1)}`,
    now: () => NOW,
  });

  service = createExecutionService({
    specsRepo: fixture.specs,
    deliveryRepo: delivery,
    linksRepo: createSpecLinksRepo(fixture.db),
    eventsRepo,
    reviewRepo,
    events,
    workflowDefinitions: unusedWorkflowDefinitions,
    writeQueue: interposingWriteQueue(createWriteQueue()),
    ingestExecutionEvidence: async () => undefined,
    sessionExists: async () => true,
    getWorkflowExecutionStatus: async () => null,
    getPublishedMerge: async () => null,
    plansRepo: plans,
    deliveryPlanCapture: {
      async openSeededReplacement({ spec, actor }) {
        const opened = await deliveryPlan.open({
          spec,
          seedFromLast: true,
          actor,
        });
        return opened.ok
          ? { ok: true, value: { attemptId: opened.value.attempt.id } }
          : opened;
      },
    },
    // The production abandon coordinator drives these ports; recording the
    // calls is how the test proves it ran rather than a local abort. The
    // placement moves the way a real run's does — aborted but still
    // slot-owning, then archived — so every phase is re-observed for real.
    workflowCleanup: {
      async observe(target: SpecWorkflowCleanupTarget) {
        expect(target.workflowExecutionId).toBe(WORKFLOW_EXECUTION_ID);
        if (observeFailure !== null) throw new Error(observeFailure);
        return workflowPlacement;
      },
      async abort(target) {
        cleanupCalls.push(`abort:${target.workflowExecutionId}`);
        // `aborted` releases the lease on its own — there is no second act.
        workflowPlacement = { kind: "archived", status: "aborted" };
        return { ok: true };
      },
      async abandon(target) {
        cleanupCalls.push(`abandon:${target.workflowExecutionId}`);
        // The audited act relocates the run itself, halt disposition intact.
        workflowPlacement = { kind: "archived", status: "halted" };
        return { ok: true };
      },
    },
    nextId: (kind) => {
      const next = (idSequence.get(kind) ?? 0) + 1;
      idSequence.set(kind, next);
      return `${kind}-${next}`;
    },
    now: () => NOW,
    runInImmediateTransaction<T>(fn: () => T): T {
      return fixture.db.transaction(fn).immediate();
    },
  });
});

afterEach(() => {
  fixture.close();
});

describe("spec capture — prelaunch redirect", () => {
  it("creates nothing and names `spec plan edit` for a draft attempt", async () => {
    seedAttempt("draft", null);

    const captured = await service.captureScopeAmendment({
      specId: SPEC_ID,
      actor: AGENT,
      discoveredTask: discoveredTask(),
    });

    if (captured.ok) throw new Error("expected the capture to be refused");
    expect(captured.refusal.instruction).toContain(
      `cctl spec plan edit ${SPEC_SLUG} --file <plan.json>`,
    );
    expect(captured.refusal.instruction).not.toContain("plan reopen");
    expect(discoveryRows()).toEqual([]);
  });

  it.each(["proposed", "approved", "parked"] as const)(
    "creates nothing and names `spec plan reopen` for a %s attempt",
    async (status) => {
      seedAttempt(status, null);

      const captured = await service.captureScopeAmendment({
        specId: SPEC_ID,
        actor: AGENT,
        discoveredTask: discoveredTask(),
      });

      if (captured.ok) throw new Error("expected the capture to be refused");
      expect(captured.refusal.instruction).toContain(
        `cctl spec plan reopen ${SPEC_SLUG} --reason <why>`,
      );
      expect(discoveryRows()).toEqual([]);
    },
  );

  it("redirects even when a stale --execution names the earlier run", async () => {
    seedAttempt("draft", null);

    const captured = await service.captureScopeAmendment({
      specId: SPEC_ID,
      executionId: EXECUTION_ID,
      actor: AGENT,
      discoveredTask: discoveredTask(),
    });

    if (captured.ok) throw new Error("expected the capture to be refused");
    expect(captured.refusal.instruction).toContain("cctl spec plan edit");
    expect(discoveryRows()).toEqual([]);
  });
});

describe("spec capture — post-launch non-blocking", () => {
  beforeEach(() => {
    seedAttempt("launched", EXECUTION_ID);
  });

  it("records a durable discovery linked to the running execution", async () => {
    const captured = await service.captureScopeAmendment({
      specId: SPEC_ID,
      actor: AGENT,
      discoveredTask: discoveredTask({
        tracedRequirementElementIds: ["requirement-1"],
        coveredCriterionElementIds: ["criterion-1"],
      }),
    });

    if (!captured.ok) throw new Error("expected the capture to succeed");
    expect(captured.value).toMatchObject({
      restartRequired: false,
      replacement: null,
      discovery: { executionId: EXECUTION_ID, attemptId: ATTEMPT_ID },
    });
    // Reloaded from SQLite, not from the returned object: the point of the
    // record is that it survives the process that wrote it.
    expect(discoveryRows()).toMatchObject([
      {
        id: captured.value.discovery.id,
        execution_id: EXECUTION_ID,
        attempt_id: ATTEMPT_ID,
        blocking_reason: null,
      },
    ]);
  });

  it("leaves the run's pinned scope and launched definition untouched", async () => {
    const before = fixture.db
      .prepare(
        `SELECT scope_json, revision_id, state, workflow_definition_id,
                workflow_definition_revision
         FROM spec_executions WHERE id = ?`,
      )
      .get(EXECUTION_ID);
    const planBefore = plans.findAttemptById(ATTEMPT_ID)?.content_json;

    await service.captureScopeAmendment({
      specId: SPEC_ID,
      actor: AGENT,
      discoveredTask: discoveredTask(),
    });
    await service.captureScopeAmendment({
      specId: SPEC_ID,
      actor: AGENT,
      discoveredTask: discoveredTask({ title: "A second discovery" }),
    });

    expect(
      fixture.db
        .prepare(
          `SELECT scope_json, revision_id, state, workflow_definition_id,
                  workflow_definition_revision
           FROM spec_executions WHERE id = ?`,
        )
        .get(EXECUTION_ID),
    ).toEqual(before);
    expect(plans.findAttemptById(ATTEMPT_ID)?.content_json).toBe(planBefore);
  });

  /**
   * The guard reads the run's state, then the write happens. If those are not
   * one critical section, an abandon landing between them leaves a discovery
   * recorded against a run the receipt then calls running.
   */
  it("refuses when a concurrent abandon lands between the guard and the write", async () => {
    interposeOnCapture = () => {
      fixture.db
        .prepare("UPDATE spec_executions SET state = 'abandoning' WHERE id = ?")
        .run(EXECUTION_ID);
    };

    const captured = await service.captureScopeAmendment({
      specId: SPEC_ID,
      actor: AGENT,
      discoveredTask: discoveredTask(),
    });

    expect(captured.ok).toBe(false);
    expect(discoveryRows()).toEqual([]);
  });

  it("refuses a discovered task naming an element the pinned revision lacks, writing nothing", async () => {
    const captured = await service.captureScopeAmendment({
      specId: SPEC_ID,
      actor: AGENT,
      discoveredTask: discoveredTask({
        coveredCriterionElementIds: ["criterion-vanished"],
      }),
    });

    expect(captured).toMatchObject({
      ok: false,
      refusal: { code: "dangling_reference" },
    });
    if (captured.ok) throw new Error("expected the capture to be refused");
    expect(captured.refusal.details?.references).toMatchObject([
      {
        code: "missing_target",
        field: "coveredCriterionElementIds",
        targetId: "criterion-vanished",
        expectedKind: "criterion",
      },
    ]);
    expect(discoveryRows()).toEqual([]);
    expect(
      fixture.db
        .prepare(
          "SELECT COUNT(*) AS total FROM spec_events WHERE payload_json LIKE '%discovery_captured%'",
        )
        .get(),
    ).toEqual({ total: 0 });
  });

  it("keeps empty id arrays legal at capture time", async () => {
    const captured = await service.captureScopeAmendment({
      specId: SPEC_ID,
      actor: AGENT,
      discoveredTask: discoveredTask(),
    });

    expect(captured.ok).toBe(true);
    expect(discoveryRows()).toHaveLength(1);
  });

  it("hands the discovery to the next seeded plan as work on the owning context", async () => {
    const captured = await service.captureScopeAmendment({
      specId: SPEC_ID,
      actor: AGENT,
      discoveredTask: discoveredTask({
        coveredCriterionElementIds: ["criterion-1"],
      }),
    });
    if (!captured.ok) throw new Error("expected the capture to succeed");

    // The production seeded open — exactly what `cctl spec plan open --seed-from
    // last` performs — over the discovery the capture left behind.
    const opened = await deliveryPlan.open({
      spec: await requireSpec(),
      seedFromLast: true,
      actor: AGENT,
    });
    if (!opened.ok) throw new Error("the seeded open was refused");

    expect(opened.value.document.tasks.map((task) => task.title)).toEqual([
      "Deliver the criterion",
      "Implement the discovered prerequisite",
    ]);
    // The owned discovery lands on the context that owns its criterion.
    expect(
      opened.value.document.tasks.find(
        (task) => task.title === "Implement the discovered prerequisite",
      )?.contextId,
    ).toBe("ctx-deliver");
  });

  it("does not place the same discovery twice across successive seeded plans", async () => {
    await service.captureScopeAmendment({
      specId: SPEC_ID,
      actor: AGENT,
      discoveredTask: discoveredTask({
        coveredCriterionElementIds: ["criterion-1"],
      }),
    });
    const first = await deliveryPlan.open({
      spec: await requireSpec(),
      seedFromLast: true,
      actor: AGENT,
    });
    if (!first.ok) throw new Error("the first seeded open was refused");
    // The attempt has to reach `launched` before it is the plan the next open
    // carries forward, which is the state a real second run opens against.
    fixture.db
      .prepare(
        "UPDATE spec_delivery_plan_attempts SET status = 'launched', launched_execution_id = ? WHERE id = ?",
      )
      .run(EXECUTION_ID, first.value.attempt.id);

    const second = await deliveryPlan.open({
      spec: await requireSpec(),
      seedFromLast: true,
      actor: AGENT,
    });
    if (!second.ok) throw new Error("the second seeded open was refused");

    expect(
      second.value.document.tasks.filter(
        (task) => task.title === "Implement the discovered prerequisite",
      ),
    ).toHaveLength(1);
  });
});

describe("spec capture — post-launch blocking", () => {
  beforeEach(() => {
    seedAttempt("launched", EXECUTION_ID);
  });

  it("abandons through the coordinator and opens the seeded replacement", async () => {
    const pinnedPlan = plans.findAttemptById(ATTEMPT_ID)?.content_json;
    const captured = await service.captureScopeAmendment({
      specId: SPEC_ID,
      actor: AGENT,
      discoveredTask: discoveredTask({
        coveredCriterionElementIds: ["criterion-1"],
      }),
      blockingReason: "The prerequisite blocks every remaining task.",
    });

    if (!captured.ok) throw new Error("expected the capture to succeed");
    expect(captured.value.restartRequired).toBe(true);
    expect(captured.value.replacement).toMatchObject({
      abandonedExecutionId: EXECUTION_ID,
    });
    const attemptId = captured.value.replacement?.replacementAttemptId ?? "";
    expect(attemptId).not.toBe(ATTEMPT_ID);
    // The pinned run's own plan is never rewritten — the replacement is a new
    // attempt, which is what keeps `exact-approval` true of the retired run.
    expect(plans.findAttemptById(ATTEMPT_ID)?.content_json).toBe(pinnedPlan);

    // The production coordinator ran: one workflow act — the abort, which
    // releases the session's lease by itself — and then finalize.
    expect(cleanupCalls).toEqual([`abort:${WORKFLOW_EXECUTION_ID}`]);
    expect(
      fixture.db
        .prepare(
          "SELECT state, abandoned_reason FROM spec_executions WHERE id = ?",
        )
        .get(EXECUTION_ID),
    ).toEqual({
      state: "abandoned",
      abandoned_reason: "The prerequisite blocks every remaining task.",
    });

    const seeded = plans.findAttemptById(attemptId);
    expect(seeded).toMatchObject({ status: "draft", spec_id: SPEC_ID });
    const document = JSON.parse(seeded?.content_json ?? "{}") as {
      tasks: Array<{ title: string }>;
    };
    expect(document.tasks.map((task) => task.title)).toContain(
      "Implement the discovered prerequisite",
    );
    expect(discoveryRows()).toMatchObject([
      {
        execution_id: EXECUTION_ID,
        blocking_reason: "The prerequisite blocks every remaining task.",
      },
    ]);
  });

  /**
   * A cleanup fault leaves the run mid-abandon with the discovery already
   * durable. That is a reachable state, so it needs a stated way out: the
   * coordinator's own "retry this command" is wrong here, because retrying
   * `spec capture` now meets the not-running guard instead of resuming.
   */
  it("names the resume act when the abandon coordinator faults mid-cleanup", async () => {
    observeFailure = "the workflow store is unreachable";

    const captured = await service.captureScopeAmendment({
      specId: SPEC_ID,
      actor: AGENT,
      discoveredTask: discoveredTask(),
      blockingReason: "The prerequisite blocks every remaining task.",
    });

    if (captured.ok) throw new Error("expected the capture to be refused");
    // The discovery survives the fault — it is the work the replacement owes.
    const rows = discoveryRows();
    expect(rows).toMatchObject([
      {
        execution_id: EXECUTION_ID,
        blocking_reason: "The prerequisite blocks every remaining task.",
      },
    ]);
    expect(executionState()).toBe("abandoning");
    expect(captured.refusal.instruction).toContain(
      `cctl spec abandon --execution ${EXECUTION_ID}`,
    );
    expect(captured.refusal.instruction).toContain(
      `cctl spec plan open ${SPEC_SLUG} --seed-from last`,
    );
    // Naming the durable discovery is what stops a re-capture of the same work.
    expect(captured.refusal.instruction).toContain(rows[0]?.id ?? "<missing>");
  });

  it("resumes rather than replans when a later capture meets the stuck run", async () => {
    observeFailure = "the workflow store is unreachable";
    await service.captureScopeAmendment({
      specId: SPEC_ID,
      actor: AGENT,
      discoveredTask: discoveredTask(),
      blockingReason: "The prerequisite blocks every remaining task.",
    });
    expect(executionState()).toBe("abandoning");

    const retried = await service.captureScopeAmendment({
      specId: SPEC_ID,
      actor: AGENT,
      discoveredTask: discoveredTask({ title: "Something else" }),
    });

    if (retried.ok) throw new Error("expected the retry to be refused");
    expect(retried.refusal.instruction).toContain(
      `cctl spec abandon --execution ${EXECUTION_ID}`,
    );
    // Only one discovery: the retry captured nothing.
    expect(discoveryRows()).toHaveLength(1);
  });

  it("refuses an empty blocking reason and captures nothing", async () => {
    const captured = await service.captureScopeAmendment({
      specId: SPEC_ID,
      actor: AGENT,
      discoveredTask: discoveredTask(),
      blockingReason: "   ",
    });

    expect(captured.ok).toBe(false);
    expect(discoveryRows()).toEqual([]);
    expect(cleanupCalls).toEqual([]);
  });
});

describe("spec capture — legacy run with no attempt", () => {
  it("captures against the named execution when the spec has no attempt", async () => {
    const captured = await service.captureScopeAmendment({
      specId: SPEC_ID,
      executionId: EXECUTION_ID,
      actor: AGENT,
      discoveredTask: discoveredTask(),
    });

    if (!captured.ok) throw new Error("expected the capture to succeed");
    expect(captured.value.discovery.attemptId).toBeNull();
    expect(discoveryRows()).toMatchObject([{ attempt_id: null }]);
  });

  it("names the plan verbs when neither an attempt nor an execution is given", async () => {
    const captured = await service.captureScopeAmendment({
      specId: SPEC_ID,
      actor: AGENT,
      discoveredTask: discoveredTask(),
    });

    if (captured.ok) throw new Error("expected the capture to be refused");
    expect(captured.refusal.instruction).toContain(
      `cctl spec plan open ${SPEC_SLUG} --seed-from last`,
    );
    expect(discoveryRows()).toEqual([]);
  });
});

describe("spec capture — unknown spec", () => {
  it("refuses a spec that does not exist and writes nothing", async () => {
    const captured = await service.captureScopeAmendment({
      specId: "spec-that-never-existed",
      actor: AGENT,
      discoveredTask: discoveredTask(),
    });

    expect(captured).toMatchObject({
      ok: false,
      refusal: { code: "not_found" },
    });
    expect(discoveryRows()).toEqual([]);
  });
});
