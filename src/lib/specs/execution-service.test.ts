import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import { deriveNotificationOutcomes } from "@/components/session/sidebar/active-work-adapters";
import { createNotificationsRepo } from "@/lib/notifications/repo";
import { createNotificationsService } from "@/lib/notifications/service";
import { createSpecApprovalNotifier } from "@/lib/notifications/spec-approvals";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createGraphWorkflowEventsRepo } from "@/lib/state-store/graph-workflow-events-repo";
import type {
  WorkflowDefinitionDraft,
  WorkflowDefinitionSummary,
} from "@/lib/workflow-graph/storage";
import type { WorkflowDefinitionRecord } from "@/lib/workflow-graph/definition-schemas";
import { graphWorkflowExecutionEventSchema } from "@/lib/workflow-graph/event-schemas";
import { readCompiledOriginMap } from "./compiler";
import { createEvidenceIngestService } from "./evidence-ingest";
import {
  createEvidenceService,
  type EvidenceServiceDeps,
} from "./evidence-service";
import type { ExecutionScope } from "./scope-validation";
import { createSpecEventsPublisher } from "./events";
import {
  createExecutionLifecycleCallbacks,
  createExecutionService,
  type ExecutionService,
  type ExecutionServiceDeps,
  type ExecutionWorkflowDefinitions,
} from "./execution-service";

type Db = InstanceType<typeof Database>;

const projectPath = "/repos/execution-service";
const specId = "spec-execution-service";
const revisionId = "revision-approved";
const proposedRevisionId = "revision-proposed";
const now = "2026-07-18T15:00:00.000Z";
const lifecycleContext = {
  projectPath,
  sessionName: "session-execution",
};

describe("ExecutionService start", () => {
  let db: Db;
  let deps: ExecutionServiceDeps;
  let service: ExecutionService;
  let definitions: InMemoryWorkflowDefinitions;
  let nextId: number;

  beforeEach(() => {
    db = _createTestDb();
    seedSpec(db);
    const writeQueue = createWriteQueue();
    definitions = new InMemoryWorkflowDefinitions();
    nextId = 0;
    const eventsRepo = createSpecEventsRepo(db);
    deps = {
      specsRepo: createSpecsRepo(db, writeQueue),
      deliveryRepo: createSpecDeliveryRepo(db),
      linksRepo: createSpecLinksRepo(db),
      eventsRepo,
      reviewRepo: createSpecReviewRepo(db),
      events: createSpecEventsPublisher({
        appendInTransaction: eventsRepo.appendInTransaction,
        publish: () => ({ delivered: true }),
      }),
      workflowDefinitions: definitions,
      writeQueue,
      ingestExecutionEvidence: vi.fn(async () => undefined),
      sessionExists: async (sessionName) => sessionName === "session-execution",
      getWorkflowExecutionStatus: vi.fn(async () => null),
      getPublishedMerge: vi.fn(async () => null),
      nextId: (kind) => `${kind}-${++nextId}`,
      now: () => now,
      runInImmediateTransaction<T>(fn: () => T): T {
        return db.transaction(fn).immediate();
      },
    };
    service = createExecutionService(deps);
  });

  it("refuses a session name that does not resolve before recording anything", async () => {
    const result = await service.start({
      specId,
      revisionId,
      scope: fullScope(),
      actor: { kind: "agent", conversationId: "conversation-start" },
      sessionName: "no-such-session",
    });

    // The alternative is a durable execution pinned to a session the server
    // cannot resolve, which dead-ends one command later as a bare
    // "Session not found" from `workflow start`.
    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "not_found" },
    });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.refusal.instruction).toContain("session");
    expect(definitions.records).toHaveLength(0);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM spec_executions").get(),
    ).toEqual({ count: 0 });
  });

  it("16.3 refuses a revision that is not Approved before preparing a definition", async () => {
    const result = await service.start({
      specId,
      revisionId: proposedRevisionId,
      scope: fullScope(),
      actor: { kind: "human" },
      sessionName: "session-execution",
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "revision_not_approved" },
    });
    expect(definitions.records).toHaveLength(0);
  });

  it("3.10 refuses execution start for an abandoned spec before preparing a definition", async () => {
    db.prepare(
      "UPDATE specs SET abandoned_at = ?, abandoned_reason = ? WHERE id = ?",
    ).run(now, "Terminal product decision.", specId);

    const result = await service.start(startInput());

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "gate_blocked" },
    });
    expect(definitions.records).toHaveLength(0);
    expect(
      db
        .prepare("SELECT id FROM spec_executions WHERE spec_id = ?")
        .all(specId),
    ).toHaveLength(0);
  });

  it.each([
    {
      label: "missing dependency",
      scope: {
        selectedTaskIds: ["task-2"],
        selectedCriterionIds: ["criterion-2"],
        exclusionDispositions: [
          { criterionId: "criterion-1", disposition: "deferred" as const },
          { criterionId: "criterion-3", disposition: "deferred" as const },
        ],
      },
      message: "native-sdd/T2 requires selected dependency native-sdd/T1.",
    },
    {
      label: "uncovered selected criterion",
      scope: {
        selectedTaskIds: ["task-1"],
        selectedCriterionIds: ["criterion-2"],
        exclusionDispositions: [
          { criterionId: "criterion-1", disposition: "deferred" as const },
          { criterionId: "criterion-3", disposition: "deferred" as const },
        ],
      },
      message:
        "Selected criterion native-sdd/R1.2 has no selected covering task.",
    },
    {
      label: "missing exclusion disposition",
      scope: {
        selectedTaskIds: ["task-1"],
        selectedCriterionIds: ["criterion-1"],
        exclusionDispositions: [
          { criterionId: "criterion-3", disposition: "deferred" as const },
        ],
      },
      message:
        "Excluded criterion native-sdd/R1.2 needs a deferred, delivered_elsewhere, or waived disposition.",
    },
    {
      label: "undefined smaller unit",
      scope: {
        selectedTaskIds: ["task-unknown"],
        selectedCriterionIds: [],
        exclusionDispositions: [
          { criterionId: "criterion-1", disposition: "deferred" as const },
          { criterionId: "criterion-2", disposition: "deferred" as const },
          { criterionId: "criterion-3", disposition: "deferred" as const },
        ],
      },
      message: "Selected task task-unknown is not in the approved plan.",
    },
  ])("16.4-16.7 refuses $label", async ({ scope, message }) => {
    const result = await service.start({
      specId,
      revisionId,
      scope,
      actor: { kind: "human" },
      sessionName: "session-execution",
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "invalid_scope",
        unmetConditions: expect.arrayContaining([message]),
      },
    });
    expect(definitions.records).toHaveLength(0);
  });

  it("16.2 enforces one active execution inside the step-2 transaction", async () => {
    const [first, second] = await Promise.all([
      service.start(startInput()),
      service.start(startInput()),
    ]);

    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].find((result) => !result.ok)).toMatchObject({
      ok: false,
      refusal: { code: "execution_active" },
    });
    expect(
      db
        .prepare("SELECT id FROM spec_executions WHERE spec_id = ?")
        .all(specId),
    ).toHaveLength(1);
    expect(definitions.records).toHaveLength(1);
  });

  it("17.2-17.3 prepares the definition first and commits the complete pinned start atomically", async () => {
    const result = await service.start(startInput());
    if (!result.ok) throw new Error("start was refused");

    expect(result.definition.definition.approvalRequired).toBe(true);
    expect(result.definition.definition.origin?.sourceUri).toMatch(
      /^spec-execution:\/\/spec-execution-service\/revisions\/revision-approved\?scope=[a-f0-9]{64}$/,
    );
    expect(result.execution).toMatchObject({
      spec_id: specId,
      revision_id: revisionId,
      state: "definition_review",
      workflow_definition_id: result.definition.id,
      workflow_execution_id: null,
    });
    expect(
      db
        .prepare(
          `SELECT criterion_element_id, disposition
             FROM spec_criterion_dispositions
            WHERE execution_id = ?
            ORDER BY criterion_element_id`,
        )
        .all(result.execution.id),
    ).toEqual([
      { criterion_element_id: "criterion-1", disposition: "in_scope" },
      { criterion_element_id: "criterion-2", disposition: "in_scope" },
      { criterion_element_id: "criterion-3", disposition: "in_scope" },
    ]);
    expect(deps.linksRepo.findBySpecId(specId)).toHaveLength(1);
    expect(deps.eventsRepo.findBySpecId(specId)).toHaveLength(1);
  });

  it("17.3 leaves definition approval off when the execution-start dial is Notify", async () => {
    db.prepare("UPDATE specs SET gate_policy_json = ? WHERE id = ?").run(
      '{"preset":"fast-path"}',
      specId,
    );

    const result = await service.start(startInput());

    expect(result).toMatchObject({
      ok: true,
      definition: { definition: { approvalRequired: false } },
    });
  });

  it("reuses the inert orphan definition after a crash between steps", async () => {
    let crash = true;
    deps.afterDefinitionPrepared = async () => {
      if (!crash) return;
      crash = false;
      throw new Error("simulated crash after definition write");
    };
    service = createExecutionService(deps);

    await expect(service.start(startInput())).rejects.toThrow(
      "simulated crash after definition write",
    );
    expect(definitions.records).toHaveLength(1);
    expect(
      db
        .prepare("SELECT id FROM spec_executions WHERE spec_id = ?")
        .all(specId),
    ).toHaveLength(0);

    const retry = await service.start(startInput());
    expect(retry).toMatchObject({ ok: true });
    expect(definitions.records).toHaveLength(1);
    expect(definitions.createCount).toBe(1);
    expect(definitions.updateCount).toBe(0);
  });

  it("replaces a changed inert orphan by the same origin key before retry commit", async () => {
    let crash = true;
    deps.afterDefinitionPrepared = async () => {
      if (!crash) return;
      crash = false;
      throw new Error("simulated crash after definition write");
    };
    service = createExecutionService(deps);
    await expect(service.start(startInput())).rejects.toThrow(
      "simulated crash after definition write",
    );
    definitions.records[0]!.definition.executionContexts[0]!.title =
      "Changed orphan title";

    const retry = await service.start(startInput());

    expect(retry).toMatchObject({ ok: true });
    expect(definitions.records).toHaveLength(1);
    expect(definitions.createCount).toBe(1);
    expect(definitions.updateCount).toBe(1);
    expect(
      definitions.records[0]?.definition.executionContexts[0]?.title,
    ).not.toBe("Changed orphan title");
  });

  it("rolls back execution, dispositions, links, and events together", async () => {
    deps.linksRepo = {
      ...deps.linksRepo,
      insertLink() {
        throw new Error("link write failed");
      },
    };
    service = createExecutionService(deps);

    await expect(service.start(startInput())).rejects.toThrow(
      "link write failed",
    );
    expect(
      db
        .prepare("SELECT id FROM spec_executions WHERE spec_id = ?")
        .all(specId),
    ).toHaveLength(0);
    expect(
      db.prepare("SELECT * FROM spec_criterion_dispositions").all(),
    ).toEqual([]);
    expect(db.prepare("SELECT * FROM spec_links").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM spec_events").all()).toEqual([]);
  });

  it("16.8 exposes no pin mutation path and caller mutations cannot change the stored pin", async () => {
    const input = startInput();
    const result = await service.start(input);
    if (!result.ok) throw new Error("start was refused");

    input.scope.selectedTaskIds.splice(0);
    input.scope.selectedCriterionIds.splice(0);
    expect(
      JSON.parse(
        deps.deliveryRepo.findExecutionById(result.execution.id)?.scope_json ??
          "null",
      ),
    ).toEqual(fullScope());
    expect(service).not.toHaveProperty("updatePin");
  });

  it("3.5 marks a linked workflow execution running idempotently and ignores unlinked callbacks", async () => {
    const started = await service.start(startInput());
    if (!started.ok) throw new Error("start was refused");
    await service.linkWorkflowExecution(
      started.execution.id,
      "workflow-execution-1",
    );

    const first = await service.markRunning("workflow-execution-1");
    const replay = await service.markRunning("workflow-execution-1");
    const unlinked = await service.markRunning("workflow-execution-unlinked");

    expect(first).toMatchObject({ ok: true, value: { state: "running" } });
    expect(replay).toEqual(first);
    expect(unlinked).toEqual({ ok: true, value: null });
    expect(
      deps.eventsRepo
        .findBySpecId(specId)
        .filter((event) =>
          event.payload_json.includes('"kind":"execution_running"'),
        ),
    ).toHaveLength(1);
  });

  it("links the started workflow execution to the awaiting spec execution by compiled definition id and marks it running", async () => {
    const started = await service.start(startInput());
    if (!started.ok) throw new Error("start was refused");
    const callbacks = createExecutionLifecycleCallbacks(deps);

    await callbacks.markRunning(
      lifecycleContext,
      "workflow-execution-from-start",
      started.definition.id,
      started.definition.revision,
    );

    expect(
      deps.deliveryRepo.findExecutionById(started.execution.id),
    ).toMatchObject({
      state: "running",
      workflow_execution_id: "workflow-execution-from-start",
    });
    expect(
      deps.eventsRepo
        .findBySpecId(specId)
        .filter((event) =>
          event.payload_json.includes('"kind":"workflow_execution_linked"'),
        ),
    ).toHaveLength(1);
  });

  it("does not claim an unlinked spec execution from another project or session", async () => {
    const started = await service.start(startInput());
    if (!started.ok) throw new Error("start was refused");
    const callbacks = createExecutionLifecycleCallbacks(deps);

    await callbacks.markRunning(
      { ...lifecycleContext, projectPath: "/repos/another-project" },
      "workflow-wrong-project",
      started.definition.id,
      started.definition.revision,
    );
    await callbacks.markRunning(
      { ...lifecycleContext, sessionName: "another-session" },
      "workflow-wrong-session",
      started.definition.id,
      started.definition.revision,
    );

    expect(
      deps.deliveryRepo.findExecutionById(started.execution.id),
    ).toMatchObject({
      state: "definition_review",
      workflow_execution_id: null,
    });

    await callbacks.markRunning(
      lifecycleContext,
      "workflow-exact-scope",
      started.definition.id,
      started.definition.revision,
    );

    expect(
      deps.deliveryRepo.findExecutionById(started.execution.id),
    ).toMatchObject({
      state: "running",
      workflow_execution_id: "workflow-exact-scope",
    });
  });

  it("does not advance an already-linked spec execution from another project or session", async () => {
    const started = await service.start(startInput());
    if (!started.ok) throw new Error("start was refused");
    const callbacks = createExecutionLifecycleCallbacks(deps);
    await service.linkWorkflowExecution(
      started.execution.id,
      "workflow-linked-scope",
    );

    await callbacks.markRunning(
      { ...lifecycleContext, projectPath: "/repos/another-project" },
      "workflow-linked-scope",
      started.definition.id,
      started.definition.revision,
    );
    await callbacks.markRunning(
      { ...lifecycleContext, sessionName: "another-session" },
      "workflow-linked-scope",
      started.definition.id,
      started.definition.revision,
    );

    expect(
      deps.deliveryRepo.findExecutionById(started.execution.id),
    ).toMatchObject({ state: "definition_review" });

    await callbacks.markRunning(
      lifecycleContext,
      "workflow-linked-scope",
      started.definition.id,
      started.definition.revision,
    );

    expect(
      deps.deliveryRepo.findExecutionById(started.execution.id),
    ).toMatchObject({ state: "running" });
  });

  it("does not link a workflow execution from a different revision of the prepared definition", async () => {
    const started = await service.start(startInput());
    if (!started.ok) throw new Error("start was refused");
    const callbacks = createExecutionLifecycleCallbacks(deps);

    await callbacks.markRunning(
      lifecycleContext,
      "workflow-execution-wrong-revision",
      started.definition.id,
      started.definition.revision + 1,
    );

    expect(
      deps.deliveryRepo.findExecutionById(started.execution.id),
    ).toMatchObject({
      state: "definition_review",
      workflow_execution_id: null,
    });
  });

  it("leaves non-spec workflow starts untouched when no spec execution awaits the definition", async () => {
    const callbacks = createExecutionLifecycleCallbacks(deps);

    await expect(
      callbacks.markRunning(
        lifecycleContext,
        "workflow-unrelated",
        "definition-unrelated",
        1,
      ),
    ).resolves.toBeUndefined();

    expect(
      db
        .prepare("SELECT id FROM spec_executions WHERE spec_id = ?")
        .all(specId),
    ).toHaveLength(0);
  });

  it("links the parked workflow execution and opens the execution-start approval request when a start awaits definition approval", async () => {
    const started = await service.start(startInput());
    if (!started.ok) throw new Error("start was refused");
    const requestApproval = vi.fn(async () => {});
    const callbacks = createExecutionLifecycleCallbacks({
      ...deps,
      lifecycleGate: {
        requestApproval,
        grantApproval: vi.fn(async () => ({
          ok: true as const,
          value: { id: "approval-x" },
        })),
      },
    });

    await callbacks.awaitingDefinitionApproval(
      lifecycleContext,
      "workflow-parked-1",
      started.definition.id,
      started.definition.revision,
    );

    expect(
      deps.deliveryRepo.findExecutionById(started.execution.id),
    ).toMatchObject({
      state: "definition_review",
      workflow_execution_id: "workflow-parked-1",
    });
    expect(requestApproval).toHaveBeenCalledWith({
      specId,
      revisionId,
      executionId: started.execution.id,
      actor: { kind: "agent", conversationId: "workflow:workflow-parked-1" },
    });
  });

  it("ignores parked workflow executions for definitions no spec execution awaits", async () => {
    const requestApproval = vi.fn(async () => {});
    const callbacks = createExecutionLifecycleCallbacks({
      ...deps,
      lifecycleGate: {
        requestApproval,
        grantApproval: vi.fn(async () => ({
          ok: true as const,
          value: { id: "approval-x" },
        })),
      },
    });

    await callbacks.awaitingDefinitionApproval(
      lifecycleContext,
      "workflow-unrelated",
      "definition-unrelated",
      1,
    );

    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("does not claim a parked workflow from a different revision of the prepared definition", async () => {
    const started = await service.start(startInput());
    if (!started.ok) throw new Error("start was refused");
    const requestApproval = vi.fn(async () => {});
    const grantApproval = vi.fn(async () => ({
      ok: true as const,
      value: { id: "approval-x" },
    }));
    const callbacks = createExecutionLifecycleCallbacks({
      ...deps,
      lifecycleGate: { requestApproval, grantApproval },
    });

    await callbacks.awaitingDefinitionApproval(
      lifecycleContext,
      "workflow-parked-wrong-revision",
      started.definition.id,
      started.definition.revision + 1,
    );
    await expect(
      callbacks.admitDefinitionApproval(
        lifecycleContext,
        "workflow-parked-wrong-revision",
        started.definition.id,
        started.definition.revision + 1,
      ),
    ).resolves.toEqual({ ok: true });

    expect(requestApproval).not.toHaveBeenCalled();
    expect(grantApproval).not.toHaveBeenCalled();
    expect(
      deps.deliveryRepo.findExecutionById(started.execution.id),
    ).toMatchObject({ workflow_execution_id: null });
  });

  it("correlates an already-linked workflow when its historical definition revision is unavailable", async () => {
    const started = await service.start(startInput());
    if (!started.ok) throw new Error("start was refused");
    await service.linkWorkflowExecution(
      started.execution.id,
      "workflow-linked-without-revision",
    );
    db.prepare(
      `UPDATE spec_executions
       SET workflow_definition_revision = NULL
       WHERE id = ?`,
    ).run(started.execution.id);
    const grantApproval = vi.fn(async () => ({
      ok: true as const,
      value: { id: "approval-linked" },
    }));
    const callbacks = createExecutionLifecycleCallbacks({
      ...deps,
      lifecycleGate: {
        requestApproval: vi.fn(async () => {}),
        grantApproval,
      },
    });

    await expect(
      callbacks.admitDefinitionApproval(
        lifecycleContext,
        "workflow-linked-without-revision",
        started.definition.id,
        started.definition.revision,
      ),
    ).resolves.toEqual({ ok: true });
    await callbacks.markRunning(
      lifecycleContext,
      "workflow-linked-without-revision",
      started.definition.id,
      started.definition.revision,
    );

    expect(grantApproval).toHaveBeenCalledOnce();
    expect(
      deps.deliveryRepo.findExecutionById(started.execution.id),
    ).toMatchObject({
      state: "running",
      workflow_execution_id: "workflow-linked-without-revision",
    });
  });

  it("records the execution-scoped grant through the lifecycle gate when the definition is approved from the workflow surface", async () => {
    const started = await service.start(startInput());
    if (!started.ok) throw new Error("start was refused");
    const grantApproval = vi.fn(async () => ({
      ok: true as const,
      value: { id: "approval-from-workflow" },
    }));
    const callbacks = createExecutionLifecycleCallbacks({
      ...deps,
      lifecycleGate: {
        requestApproval: vi.fn(async () => {}),
        grantApproval,
      },
    });

    const admitted = await callbacks.admitDefinitionApproval(
      lifecycleContext,
      "workflow-parked-2",
      started.definition.id,
      started.definition.revision,
    );

    expect(admitted).toEqual({ ok: true });
    expect(grantApproval).toHaveBeenCalledWith({
      specId,
      revisionId,
      executionId: started.execution.id,
      actor: { kind: "human" },
      approver: "operator",
    });
    // The park-time link happened as part of admission, so the run the
    // approval starts is the linked spec execution.
    expect(
      deps.deliveryRepo.findExecutionById(started.execution.id),
    ).toMatchObject({ workflow_execution_id: "workflow-parked-2" });
  });

  it("refuses the definition approval machine-readably when the spec-side grant refuses", async () => {
    const started = await service.start(startInput());
    if (!started.ok) throw new Error("start was refused");
    const callbacks = createExecutionLifecycleCallbacks({
      ...deps,
      lifecycleGate: {
        requestApproval: vi.fn(async () => {}),
        grantApproval: vi.fn(async () => ({
          ok: false as const,
          refusal: {
            code: "revision_not_approved" as const,
            unmetConditions: ["The pinned revision is no longer approved."],
            instruction: "Sign off the revision first.",
          },
        })),
      },
    });

    const admitted = await callbacks.admitDefinitionApproval(
      lifecycleContext,
      "workflow-parked-3",
      started.definition.id,
      started.definition.revision,
    );

    expect(admitted).toEqual({
      ok: false,
      code: "revision_not_approved",
      unmetConditions: ["The pinned revision is no longer approved."],
      instruction: "Sign off the revision first.",
    });
  });

  it("admits definition approvals for definitions no spec execution prepared", async () => {
    const callbacks = createExecutionLifecycleCallbacks(deps);

    await expect(
      callbacks.admitDefinitionApproval(
        lifecycleContext,
        "workflow-unrelated",
        "definition-unrelated",
        1,
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("records a notify-policy execution_start admission when a Notify-dial run reaches running", async () => {
    db.prepare("UPDATE specs SET gate_policy_json = ? WHERE id = ?").run(
      '{"preset":"fast-path"}',
      specId,
    );
    const started = await service.start(startInput());
    if (!started.ok) throw new Error("start was refused");
    const callbacks = createExecutionLifecycleCallbacks(deps);

    await callbacks.markRunning(
      lifecycleContext,
      "workflow-notify-run",
      started.definition.id,
      started.definition.revision,
    );
    // A second report must not duplicate the admission row.
    await service.markRunning("workflow-notify-run");

    const admissions = deps.reviewRepo
      .findGateAdmissionsByRevision(revisionId)
      .filter((admission) => admission.gate === "execution_start");
    expect(admissions).toHaveLength(1);
    expect(admissions[0]).toMatchObject({
      basis: "notify_policy",
      execution_id: started.execution.id,
      approval_id: null,
    });
  });

  it("11.2/19.1 commits the execution_start policy admission with its typed gate event and posts one post-hoc notice", async () => {
    db.prepare("UPDATE specs SET gate_policy_json = ? WHERE id = ?").run(
      '{"preset":"fast-path"}',
      specId,
    );
    const policyAdmitted = vi.fn();
    const started = await service.start(startInput());
    if (!started.ok) throw new Error("start was refused");
    const callbacks = createExecutionLifecycleCallbacks({
      ...deps,
      policyNotifier: { policyAdmitted },
    });

    await callbacks.markRunning(
      lifecycleContext,
      "workflow-notify-run",
      started.definition.id,
      started.definition.revision,
    );
    // A replayed report must not duplicate the event or the notice.
    await callbacks.markRunning(
      lifecycleContext,
      "workflow-notify-run",
      started.definition.id,
      started.definition.revision,
    );

    const admissionEvents = deps.eventsRepo
      .findBySpecId(specId)
      .filter(
        (event) =>
          event.event_type === "spec-approval-changed" &&
          event.payload_json.includes(
            '"kind":"execution-start-policy-admitted"',
          ),
      )
      .map(
        (event) => JSON.parse(event.payload_json) as Record<string, unknown>,
      );
    expect(admissionEvents).toHaveLength(1);
    expect(admissionEvents[0]).toMatchObject({
      gate: "execution_start",
      basis: "notify_policy",
      executionId: started.execution.id,
      revisionId,
    });
    expect(policyAdmitted).toHaveBeenCalledTimes(1);
    expect(policyAdmitted).toHaveBeenCalledWith(
      expect.objectContaining({
        specId,
        gate: "execution_start",
        basis: "notify_policy",
        executionId: started.execution.id,
        revisionId,
      }),
    );
  });

  it("records an off-policy execution_start admission with its gate event but no post-hoc notice", async () => {
    db.prepare("UPDATE specs SET gate_policy_json = ? WHERE id = ?").run(
      '{"preset":"fast-path","overrides":{"execution_start":"off"}}',
      specId,
    );
    const policyAdmitted = vi.fn();
    const started = await service.start(startInput());
    if (!started.ok) throw new Error("start was refused");
    const callbacks = createExecutionLifecycleCallbacks({
      ...deps,
      policyNotifier: { policyAdmitted },
    });

    await callbacks.markRunning(
      lifecycleContext,
      "workflow-off-run",
      started.definition.id,
      started.definition.revision,
    );

    const admissionEvents = deps.eventsRepo
      .findBySpecId(specId)
      .filter(
        (event) =>
          event.event_type === "spec-approval-changed" &&
          event.payload_json.includes(
            '"kind":"execution-start-policy-admitted"',
          ),
      )
      .map(
        (event) => JSON.parse(event.payload_json) as Record<string, unknown>,
      );
    expect(admissionEvents).toHaveLength(1);
    expect(admissionEvents[0]).toMatchObject({ basis: "off_policy" });
    expect(policyAdmitted).not.toHaveBeenCalled();
  });

  it("18.6 marks Delivered only on publish success and replays the same merge hash safely", async () => {
    const running = await startRunning();
    deps.getPublishedMerge = vi.fn(async () => ({
      mergeHash: "merge-sha-1",
      deliveryGatePassed: true,
    }));

    const first = await service.markDelivered(running.id, "merge-sha-1");
    const replay = await service.markDelivered(running.id, "merge-sha-1");

    expect(first).toMatchObject({ ok: true, value: { state: "delivered" } });
    expect(replay).toEqual(first);
    expect(
      deps.linksRepo
        .findBySpecId(specId)
        .filter((link) => link.object_kind === "merge_job"),
    ).toHaveLength(1);
    expect(
      db
        .prepare(
          `SELECT delivered_by_execution_id
             FROM spec_criterion_dispositions
            WHERE execution_id = ?
            ORDER BY criterion_element_id`,
        )
        .all(running.id),
    ).toEqual([
      { delivered_by_execution_id: running.id },
      { delivered_by_execution_id: running.id },
      { delivered_by_execution_id: running.id },
    ]);
    expect(deps.ingestExecutionEvidence).toHaveBeenCalledWith(running.id);
  });

  it("F24 pins the delivery ordering: a followerless final validation is materialized unstamped by the time Delivered commits", async () => {
    const running = await startRunning();
    const workflowExecutionId = `workflow-${running.id}`;
    db.prepare(
      `INSERT INTO sessions (
         project_path, session_name, worktree_path, branch_name, created_at,
         last_activity_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(projectPath, "session-execution", "/wt/execution", "exec", now, now);
    const workflowEvents = createGraphWorkflowEventsRepo(db);
    const definitionRecord = definitions.records[0];
    if (definitionRecord === undefined) throw new Error("definition missing");
    const originMap = readCompiledOriginMap(definitionRecord.definition);
    const contextId = originMap.find((entry) =>
      entry.criterionElementIds.includes("criterion-1"),
    )?.contextId;
    if (contextId === undefined) throw new Error("origin context missing");
    // A validator passed the context, but its lane commit never arrived (e.g.
    // nothing to commit) — the sealing outcome stays undecidable while the
    // run lives.
    workflowEvents.appendMany(
      projectPath,
      "session-execution",
      workflowExecutionId,
      now,
      [
        graphWorkflowExecutionEventSchema.parse({
          occurredAt: now,
          event: {
            type: "graph-workflow-validation-result",
            projectName: "execution-service",
            sessionName: "session-execution",
            executionId: workflowExecutionId,
            contextId,
            validatorType: "context",
            pass: true,
            summary: "The pinned criterion holds.",
          },
        }),
      ],
    );

    const evidenceService = createEvidenceService({
      repo: deps.deliveryRepo,
      ingestExecutionEvidence: async () => undefined,
      nextId: () => `evidence-${++nextId}`,
      now: () => now,
      async getApprovedCriterion(targetRevisionId, criterionElementId) {
        const snapshot =
          await deps.specsRepo.getRevisionSnapshot(targetRevisionId);
        if (snapshot?.revision.state !== "approved") return null;
        const criterion = snapshot.elements.find(
          (item) =>
            item.element.id === criterionElementId &&
            item.version.payload.kind === "criterion",
        );
        return criterion?.version.payload.kind === "criterion"
          ? {
              specId: snapshot.revision.specId,
              validationStrategy: criterion.version.payload.validationStrategy,
            }
          : null;
      },
      gitObjectExists: async () => false,
      async workflowEventExists(ref, expectedExecution) {
        const record = workflowEvents.findRecordById(ref.eventId);
        return (
          record !== null &&
          record.executionId === expectedExecution.workflowExecutionId &&
          "contextId" in record.event &&
          record.event.contextId === ref.contextId
        );
      },
      mergeValidationFactExists: async () => false,
      isEvidenceFresh: async () => true,
      routeStrategyInadequacy: async () => undefined,
      routeWaiverRequestToHuman: async () => ({ attentionId: "unused" }),
      getTaskClaimContext: async () => null,
      getCriterionVersion: async () => null,
      wasCriterionDeliveredByMergedExecution: async () => false,
      recordMutation: () => undefined,
      runInImmediateTransaction: (operation) => operation(),
    } satisfies EvidenceServiceDeps);
    // The publish-time delivery lands while the graph workflow itself is
    // still running (the final-publish task completes before the run does),
    // so neither the workflow status nor the pre-flip spec state is terminal.
    deps.getWorkflowExecutionStatus = vi.fn(async () => "running" as const);
    const ingest = createEvidenceIngestService({
      repo: deps.deliveryRepo,
      workflowEvents,
      evidenceService,
      writeQueue: deps.writeQueue,
      validatedTreeHash: async () => "unused-tree",
      loadOriginMap: async () => originMap,
      getWorkflowExecutionStatus: deps.getWorkflowExecutionStatus,
    });
    deps.ingestExecutionEvidence = (executionId) =>
      ingest.ingestAuthoritatively(executionId);
    deps.getPublishedMerge = vi.fn(async () => ({
      mergeHash: "merge-sha-final",
      deliveryGatePassed: true,
    }));
    service = createExecutionService(deps);

    const result = await service.markDelivered(running.id, "merge-sha-final");

    expect(result).toMatchObject({ ok: true, value: { state: "delivered" } });
    const rows = db
      .prepare(
        `SELECT kind, criterion_element_id, evaluated_state_json
           FROM spec_evidence ORDER BY kind ASC`,
      )
      .all() as Array<{
      kind: string;
      criterion_element_id: string;
      evaluated_state_json: string;
    }>;
    expect(rows.map((row) => [row.kind, row.criterion_element_id])).toEqual([
      ["validator_verdict", "criterion-1"],
    ]);
    // Honest-stale: no sealing commit ever named the validated sha.
    expect(JSON.parse(rows[0]!.evaluated_state_json)).toEqual({
      relevantPaths: [],
    });
  });

  it("adapts workflow lifecycle callbacks to the linked immutable spec execution", async () => {
    const running = await startRunning();
    deps.getPublishedMerge = vi.fn(async () => ({
      mergeHash: "merge-sha-callback",
      deliveryGatePassed: true,
    }));
    const callbacks = createExecutionLifecycleCallbacks(deps);

    const workflowExecutionId = `workflow-${running.id}`;
    await callbacks.markRunning(lifecycleContext, workflowExecutionId);
    await callbacks.markDelivered(workflowExecutionId, "merge-sha-callback");

    expect(deps.deliveryRepo.findExecutionById(running.id)).toMatchObject({
      state: "delivered",
      delivered_at: now,
    });
  });

  it("18.6 refuses Delivered until the linked workflow has the same successfully published gate-passed merge", async () => {
    const running = await startRunning();

    const unpublished = await service.markDelivered(
      running.id,
      "merge-unverified",
    );
    deps.getPublishedMerge = vi.fn(async () => ({
      mergeHash: "merge-other",
      deliveryGatePassed: true,
    }));
    const mismatched = await service.markDelivered(
      running.id,
      "merge-unverified",
    );
    deps.getPublishedMerge = vi.fn(async () => ({
      mergeHash: "merge-unverified",
      deliveryGatePassed: false,
    }));
    const gateBypassed = await service.markDelivered(
      running.id,
      "merge-unverified",
    );

    for (const result of [unpublished, mismatched, gateBypassed]) {
      expect(result).toMatchObject({
        ok: false,
        refusal: { code: "gate_blocked" },
      });
    }
    expect(deps.deliveryRepo.findExecutionById(running.id)).toMatchObject({
      state: "running",
      delivered_at: null,
    });
    expect(
      deps.linksRepo
        .findBySpecId(specId)
        .filter((link) => link.object_kind === "merge_job"),
    ).toHaveLength(0);
    expect(deps.ingestExecutionEvidence).not.toHaveBeenCalled();
  });

  it("reconciles lost workflow-start and publish callbacks on status reads", async () => {
    const started = await service.start(startInput());
    if (!started.ok) throw new Error("start was refused");
    await service.linkWorkflowExecution(
      started.execution.id,
      "workflow-execution-reconcile",
    );
    deps.getWorkflowExecutionStatus = vi.fn(async () => "completed" as const);
    deps.getPublishedMerge = vi.fn(async () => null);
    service = createExecutionService(deps);

    const running = await service.getStatus(started.execution.id);
    expect(running).toMatchObject({
      ok: true,
      // The lane already completed; the spec execution stays running until
      // the delivering merge, and the pair reports both positions.
      value: { execution: { state: "running" }, workflowStatus: "completed" },
    });
    expect(deps.ingestExecutionEvidence).toHaveBeenCalledTimes(1);
    expect(deps.ingestExecutionEvidence).toHaveBeenCalledWith(
      started.execution.id,
    );

    deps.getPublishedMerge = vi.fn(async () => ({
      mergeHash: "merge-reconciled",
      deliveryGatePassed: true,
    }));
    service = createExecutionService(deps);
    const delivered = await service.getStatus(started.execution.id);
    expect(delivered).toMatchObject({
      ok: true,
      value: { execution: { state: "delivered" } },
    });
  });

  it("abandons the linked active execution when the workflow reports an abort", async () => {
    const running = await startRunning();
    const callbacks = createExecutionLifecycleCallbacks(deps);

    await callbacks.executionAborted(`workflow-${running.id}`);

    expect(deps.deliveryRepo.findExecutionById(running.id)).toMatchObject({
      state: "abandoned",
      abandoned_reason: "The linked graph workflow execution was aborted.",
    });
  });

  it("ignores abort reports for unlinked or already-terminal executions", async () => {
    const callbacks = createExecutionLifecycleCallbacks(deps);
    await expect(
      callbacks.executionAborted("workflow-unknown"),
    ).resolves.toBeUndefined();

    const running = await startRunning();
    await service.abandonExecution({
      executionId: running.id,
      reason: "Stopped by hand.",
      actor: { kind: "human" },
    });
    await callbacks.executionAborted(`workflow-${running.id}`);

    expect(deps.deliveryRepo.findExecutionById(running.id)).toMatchObject({
      state: "abandoned",
      abandoned_reason: "Stopped by hand.",
    });
  });

  it("abandons the execution on status reads when the linked workflow was aborted", async () => {
    const running = await startRunning();
    deps.getWorkflowExecutionStatus = vi.fn(async () => "aborted" as const);
    service = createExecutionService(deps);

    const result = await service.getStatus(running.id);

    expect(result).toMatchObject({
      ok: true,
      value: {
        execution: {
          state: "abandoned",
          abandoned_reason: "The linked graph workflow execution was aborted.",
        },
      },
    });
    const abandonEvents = deps.eventsRepo
      .findBySpecId(specId)
      .filter(
        (event) =>
          event.event_type === "spec-execution-changed" &&
          event.payload_json.includes('"kind":"execution_abandoned"'),
      );
    expect(abandonEvents).toHaveLength(1);
    expect(JSON.parse(abandonEvents[0]?.actor_json ?? "{}")).toEqual({
      kind: "system",
    });
  });

  it("abandons a definition_review execution whose linked workflow was aborted without promoting it", async () => {
    const started = await service.start(startInput());
    if (!started.ok) throw new Error("start was refused");
    await service.linkWorkflowExecution(
      started.execution.id,
      "workflow-aborted-in-review",
    );
    deps.getWorkflowExecutionStatus = vi.fn(async () => "aborted" as const);
    service = createExecutionService(deps);

    const result = await service.getStatus(started.execution.id);

    expect(result).toMatchObject({
      ok: true,
      value: { execution: { state: "abandoned" } },
    });
    const runningEvents = deps.eventsRepo
      .findBySpecId(specId)
      .filter((event) =>
        event.payload_json.includes('"kind":"execution_running"'),
      );
    expect(runningEvents).toHaveLength(0);
  });

  it("abandons the execution on status reads when the linked workflow no longer exists", async () => {
    const running = await startRunning();
    deps.getWorkflowExecutionStatus = vi.fn(async () => null);
    service = createExecutionService(deps);

    const result = await service.getStatus(running.id);

    expect(result).toMatchObject({
      ok: true,
      value: {
        execution: {
          state: "abandoned",
          abandoned_reason:
            "The linked graph workflow execution no longer exists.",
        },
      },
    });
  });

  it("keeps the execution active while the linked workflow is halted", async () => {
    const running = await startRunning();
    deps.getWorkflowExecutionStatus = vi.fn(async () => "halted" as const);
    service = createExecutionService(deps);

    const result = await service.getStatus(running.id);

    expect(result).toMatchObject({
      ok: true,
      value: { execution: { state: "running" }, workflowStatus: "halted" },
    });
  });

  it("3.10 requires an abandon reason and keeps execution abandonment terminal", async () => {
    const running = await startRunning();

    const blank = await service.abandonExecution({
      executionId: running.id,
      reason: "  ",
      actor: { kind: "human" },
    });
    expect(blank).toMatchObject({
      ok: false,
      refusal: { code: "validation" },
    });

    const abandoned = await service.abandonExecution({
      executionId: running.id,
      reason: "The discovered prerequisite blocks this run.",
      actor: { kind: "human" },
    });
    expect(abandoned).toMatchObject({
      ok: true,
      value: {
        state: "abandoned",
        abandoned_reason: "The discovered prerequisite blocks this run.",
      },
    });
    await expect(
      service.markDelivered(running.id, "merge-after-abandon"),
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: "gate_blocked" },
    });
  });

  it("3.10 requires a reason to abandon the spec and terminalizes its active execution", async () => {
    const running = await startRunning();

    await expect(
      service.abandonSpec({
        specId,
        reason: "",
        actor: { kind: "human" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: "validation" },
    });
    const abandoned = await service.abandonSpec({
      specId,
      reason: "The product direction was withdrawn.",
      actor: { kind: "human" },
    });

    expect(abandoned).toMatchObject({
      ok: true,
      value: { abandonedReason: "The product direction was withdrawn." },
    });
    expect(deps.deliveryRepo.findExecutionById(running.id)).toMatchObject({
      state: "abandoned",
      abandoned_reason: "The product direction was withdrawn.",
    });
  });

  it("16.9 captures discovered work in an amendment draft without changing the running pin", async () => {
    const running = await startRunning();
    const originalScope = running.scope_json;

    const amendment = await service.captureScopeAmendment({
      executionId: running.id,
      actor: { kind: "agent", conversationId: "conversation-discovery" },
      discoveredTask: {
        title: "Implement the discovered prerequisite",
        instructions: "Add the prerequisite in a future execution.",
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: ["criterion-1"],
        dependsOnTaskElementIds: [],
      },
    });
    if (!amendment.ok) throw new Error("amendment was refused");

    expect(amendment.value.revision).toMatchObject({
      state: "draft",
      basedOnRevisionId: revisionId,
    });
    expect(amendment.value.task.version.payload).toMatchObject({
      kind: "task",
      title: "Implement the discovered prerequisite",
    });
    expect(deps.deliveryRepo.findExecutionById(running.id)?.scope_json).toBe(
      originalScope,
    );
  });

  function startInput() {
    return {
      specId,
      revisionId,
      scope: fullScope(),
      actor: { kind: "agent" as const, conversationId: "conversation-start" },
      sessionName: "session-execution",
    };
  }

  async function startRunning() {
    const started = await service.start(startInput());
    if (!started.ok) throw new Error("start was refused");
    await service.linkWorkflowExecution(
      started.execution.id,
      `workflow-${started.execution.id}`,
    );
    const running = await service.markRunning(
      `workflow-${started.execution.id}`,
    );
    if (!running.ok || running.value === null) {
      throw new Error("execution did not start running");
    }
    return running.value;
  }
});

describe("ExecutionService execution-start gate", () => {
  let db: Db;
  let deps: ExecutionServiceDeps;
  let service: ExecutionService;
  let gate: {
    hasPendingDefinitionApproval: ReturnType<typeof vi.fn>;
    ensurePendingDefinitionApproval: ReturnType<typeof vi.fn>;
    grantApproval: ReturnType<typeof vi.fn>;
    approveWorkflowDefinition: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    db = _createTestDb();
    seedSpec(db);
    const writeQueue = createWriteQueue();
    const eventsRepo = createSpecEventsRepo(db);
    let nextId = 0;
    gate = {
      hasPendingDefinitionApproval: vi.fn(
        async () => "workflow-execution-pending",
      ),
      ensurePendingDefinitionApproval: vi.fn(async () => ({
        ok: true as const,
        workflowExecutionId: "workflow-execution-launched",
      })),
      grantApproval: vi.fn(async () => ({
        ok: true as const,
        value: { id: "approval-grant-1" },
      })),
      approveWorkflowDefinition: vi.fn(async () => ({ ok: true as const })),
    };
    deps = {
      specsRepo: createSpecsRepo(db, writeQueue),
      deliveryRepo: createSpecDeliveryRepo(db),
      linksRepo: createSpecLinksRepo(db),
      eventsRepo,
      reviewRepo: createSpecReviewRepo(db),
      events: createSpecEventsPublisher({
        appendInTransaction: eventsRepo.appendInTransaction,
        publish: () => ({ delivered: true }),
      }),
      workflowDefinitions: new InMemoryWorkflowDefinitions(),
      writeQueue,
      ingestExecutionEvidence: vi.fn(async () => undefined),
      sessionExists: async (sessionName) => sessionName === "session-execution",
      getWorkflowExecutionStatus: vi.fn(async () => null),
      getPublishedMerge: vi.fn(async () => null),
      nextId: (kind) => `${kind}-${++nextId}`,
      now: () => now,
      runInImmediateTransaction<T>(fn: () => T): T {
        return db.transaction(fn).immediate();
      },
      executionStartGate: gate,
    };
    service = createExecutionService(deps);
  });

  function startInput() {
    return {
      specId,
      revisionId,
      scope: fullScope(),
      actor: { kind: "agent" as const, conversationId: "conversation-start" },
      sessionName: "session-execution",
    };
  }

  async function startedExecutionId(): Promise<string> {
    const started = await service.start(startInput());
    if (!started.ok) throw new Error("start was refused");
    return started.execution.id;
  }

  it("does not touch the gate ports at spec start — the approval request opens when the workflow parks", async () => {
    await startedExecutionId();

    expect(gate.hasPendingDefinitionApproval).not.toHaveBeenCalled();
    expect(gate.ensurePendingDefinitionApproval).not.toHaveBeenCalled();
    expect(gate.grantApproval).not.toHaveBeenCalled();
    expect(gate.approveWorkflowDefinition).not.toHaveBeenCalled();
  });

  it("launches the prepared definition before recording exactly one human approval when no workflow execution is pending", async () => {
    const executionId = await startedExecutionId();
    const definitionId =
      deps.deliveryRepo.findExecutionById(executionId)?.workflow_definition_id;
    if (definitionId === null || definitionId === undefined) {
      throw new Error("started execution has no prepared workflow definition");
    }
    gate.hasPendingDefinitionApproval.mockResolvedValue(null);

    const result = await service.approveExecutionStart({
      specId,
      executionId,
      actor: { kind: "human" },
      approver: "operator",
      projectName: "repo-project",
    });

    expect(result).toMatchObject({ ok: true, value: { id: executionId } });
    expect(gate.ensurePendingDefinitionApproval).toHaveBeenCalledOnce();
    expect(gate.ensurePendingDefinitionApproval).toHaveBeenCalledWith({
      projectName: "repo-project",
      sessionName: "session-execution",
      definitionId,
      definitionRevision: 1,
    });
    expect(gate.grantApproval).toHaveBeenCalledOnce();
    expect(gate.grantApproval).toHaveBeenCalledWith({
      specId,
      revisionId,
      executionId,
      actor: { kind: "human" },
      approver: "operator",
    });
    expect(gate.approveWorkflowDefinition).toHaveBeenCalledOnce();
    expect(gate.approveWorkflowDefinition).toHaveBeenCalledWith({
      projectName: "repo-project",
      sessionName: "session-execution",
      definitionId,
      definitionRevision: 1,
      workflowExecutionId: "workflow-execution-launched",
    });
    const ensureOrder =
      gate.ensurePendingDefinitionApproval.mock.invocationCallOrder[0];
    const grantOrder = gate.grantApproval.mock.invocationCallOrder[0];
    const approveOrder =
      gate.approveWorkflowDefinition.mock.invocationCallOrder[0];
    expect(ensureOrder).toBeDefined();
    expect(grantOrder).toBeDefined();
    expect(approveOrder).toBeDefined();
    expect(ensureOrder ?? 0).toBeLessThan(grantOrder ?? 0);
    expect(grantOrder ?? 0).toBeLessThan(approveOrder ?? 0);
  });

  it("refuses an agent approval as a human act without touching the gate ports", async () => {
    const executionId = await startedExecutionId();

    const result = await service.approveExecutionStart({
      specId,
      executionId,
      actor: { kind: "agent", conversationId: "conversation-start" },
      approver: "operator",
      projectName: "repo-project",
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "human_act_required" },
    });
    expect(gate.ensurePendingDefinitionApproval).not.toHaveBeenCalled();
    expect(gate.grantApproval).not.toHaveBeenCalled();
    expect(gate.approveWorkflowDefinition).not.toHaveBeenCalled();
  });

  it("grants the human approval and approves the workflow definition only after confirming a parked run", async () => {
    const executionId = await startedExecutionId();
    const definitionId =
      deps.deliveryRepo.findExecutionById(executionId)?.workflow_definition_id;
    if (definitionId === null || definitionId === undefined) {
      throw new Error("started execution has no prepared workflow definition");
    }

    const result = await service.approveExecutionStart({
      specId,
      executionId,
      actor: { kind: "human" },
      approver: "operator",
      projectName: "repo-project",
    });

    expect(result).toMatchObject({ ok: true, value: { id: executionId } });
    expect(gate.hasPendingDefinitionApproval).toHaveBeenCalledWith({
      projectName: "repo-project",
      sessionName: "session-execution",
      definitionId,
      definitionRevision: 1,
    });
    expect(gate.ensurePendingDefinitionApproval).not.toHaveBeenCalled();
    expect(gate.grantApproval).toHaveBeenCalledWith({
      specId,
      revisionId,
      executionId,
      actor: { kind: "human" },
      approver: "operator",
    });
    expect(gate.approveWorkflowDefinition).toHaveBeenCalledWith({
      projectName: "repo-project",
      sessionName: "session-execution",
      definitionId,
      definitionRevision: 1,
      workflowExecutionId: "workflow-execution-pending",
    });
    // The pending probe must precede the grant: an admission may only land
    // when a parked workflow execution is there to unblock.
    const probeOrder =
      gate.hasPendingDefinitionApproval.mock.invocationCallOrder[0];
    const grantOrder = gate.grantApproval.mock.invocationCallOrder[0];
    expect(probeOrder).toBeDefined();
    expect(grantOrder).toBeDefined();
    expect(probeOrder ?? 0).toBeLessThan(grantOrder ?? 0);
  });

  it("maps a workflow-side gate refusal to the machine-readable refusal", async () => {
    const executionId = await startedExecutionId();
    gate.approveWorkflowDefinition.mockResolvedValue({
      ok: false,
      reason: "gate_refused",
      refusal: {
        code: "revision_not_approved",
        unmetConditions: ["The pinned revision is no longer approved."],
        instruction: "Sign off the revision, then approve again.",
      },
    });

    const result = await service.approveExecutionStart({
      specId,
      executionId,
      actor: { kind: "human" },
      approver: "operator",
      projectName: "repo-project",
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "revision_not_approved",
        unmetConditions: ["The pinned revision is no longer approved."],
      },
    });
  });

  it("propagates a grant refusal without approving the workflow definition", async () => {
    const executionId = await startedExecutionId();
    gate.grantApproval.mockResolvedValue({
      ok: false,
      refusal: {
        code: "gate_blocked",
        unmetConditions: ["The execution-start gate refused."],
        instruction: "Sign off the revision first.",
      },
    });

    const result = await service.approveExecutionStart({
      specId,
      executionId,
      actor: { kind: "human" },
      approver: "operator",
      projectName: "repo-project",
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "gate_blocked" },
    });
    expect(gate.approveWorkflowDefinition).not.toHaveBeenCalled();
  });

  it("keeps the recorded approval but refuses when no workflow execution awaits definition approval", async () => {
    const executionId = await startedExecutionId();
    gate.approveWorkflowDefinition.mockResolvedValue({
      ok: false,
      reason: "no_active_execution",
    });

    const result = await service.approveExecutionStart({
      specId,
      executionId,
      actor: { kind: "human" },
      approver: "operator",
      projectName: "repo-project",
    });

    expect(gate.grantApproval).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "gate_blocked" },
    });
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusal.instruction).toMatch(/approval stays recorded/i);
  });

  it("treats an already-decided definition approval as success", async () => {
    const executionId = await startedExecutionId();
    gate.approveWorkflowDefinition.mockResolvedValue({
      ok: false,
      reason: "already_decided",
    });

    const result = await service.approveExecutionStart({
      specId,
      executionId,
      actor: { kind: "human" },
      approver: "operator",
      projectName: "repo-project",
    });

    expect(result).toMatchObject({ ok: true, value: { id: executionId } });
  });

  it("refuses an unknown execution and a spec mismatch", async () => {
    const missing = await service.approveExecutionStart({
      specId,
      executionId: "execution-unknown",
      actor: { kind: "human" },
      approver: "operator",
      projectName: "repo-project",
    });

    expect(missing).toMatchObject({
      ok: false,
      refusal: { code: "not_found" },
    });
    expect(gate.grantApproval).not.toHaveBeenCalled();
  });

  it("refuses when the execution has no session to start the workflow in", async () => {
    const started = await service.start({
      ...startInput(),
      sessionName: null,
    });
    if (!started.ok) throw new Error("start was refused");

    const result = await service.approveExecutionStart({
      specId,
      executionId: started.execution.id,
      actor: { kind: "human" },
      approver: "operator",
      projectName: "repo-project",
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "gate_blocked" },
    });
    expect(gate.approveWorkflowDefinition).not.toHaveBeenCalled();
  });

  it("refuses a legacy execution whose workflow definition revision is unknown", async () => {
    const executionId = await startedExecutionId();
    db.prepare(
      "UPDATE spec_executions SET workflow_definition_revision = NULL WHERE id = ?",
    ).run(executionId);

    const result = await service.approveExecutionStart({
      specId,
      executionId,
      actor: { kind: "human" },
      approver: "operator",
      projectName: "repo-project",
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "gate_blocked",
        unmetConditions: [
          "The execution predates immutable workflow-definition revision pins.",
        ],
      },
    });
    expect(gate.hasPendingDefinitionApproval).not.toHaveBeenCalled();
    expect(gate.ensurePendingDefinitionApproval).not.toHaveBeenCalled();
    expect(gate.grantApproval).not.toHaveBeenCalled();
    expect(gate.approveWorkflowDefinition).not.toHaveBeenCalled();
  });
});

describe("ExecutionService abandon clears open spec attention (runtime wiring)", () => {
  let db: Db;
  let service: ExecutionService;
  let notificationsRepo: ReturnType<typeof createNotificationsRepo>;
  let notifier: ReturnType<typeof createSpecApprovalNotifier>;

  beforeEach(() => {
    db = _createTestDb();
    seedSpec(db);
    const writeQueue = createWriteQueue();
    const eventsRepo = createSpecEventsRepo(db);
    notificationsRepo = createNotificationsRepo(db);
    const notifications = createNotificationsService({
      repo: () => notificationsRepo,
      publish: () => ({ delivered: true }),
      dispatchPush: () => undefined,
    });
    notifier = createSpecApprovalNotifier({
      createSpecNotification(input) {
        notifications.createSpecNotification(input);
      },
      findSpecNotificationsBySpecId(targetSpecId) {
        return notificationsRepo.findSpecNotificationsBySpecId(targetSpecId);
      },
      getProjectDisplayName: () => "execution-service-project",
    });
    let nextId = 0;
    service = createExecutionService({
      specsRepo: createSpecsRepo(db, writeQueue),
      deliveryRepo: createSpecDeliveryRepo(db),
      linksRepo: createSpecLinksRepo(db),
      eventsRepo,
      reviewRepo: createSpecReviewRepo(db),
      events: createSpecEventsPublisher({
        appendInTransaction: eventsRepo.appendInTransaction,
        publish: () => ({ delivered: true }),
      }),
      workflowDefinitions: new InMemoryWorkflowDefinitions(),
      writeQueue,
      ingestExecutionEvidence: async () => undefined,
      sessionExists: async (sessionName) => sessionName === "session-execution",
      getWorkflowExecutionStatus: async () => null,
      getPublishedMerge: async () => null,
      nextId: (kind) => `${kind}-${++nextId}`,
      now: () => now,
      runInImmediateTransaction<T>(fn: () => T): T {
        return db.transaction(fn).immediate();
      },
      attentionNotifier: notifier,
    });
  });

  function openRequest(
    gate: "requirements" | "execution_start" | "delivery",
    subject: string,
    gateRequestId: string,
  ): void {
    notifier.approvalRequested({
      specId,
      specSlug: "native-sdd",
      specName: "Native SDD",
      projectPath,
      gate,
      subject,
      gateRequestId,
      occurredAt: now,
    });
  }

  function openWaiverRequest(attentionId: string): void {
    notifier.waiverRequested({
      specId,
      specSlug: "native-sdd",
      specName: "Native SDD",
      projectPath,
      criterionElementId: "criterion-1",
      revisionId,
      attentionId,
      reason: "Cannot validate before the deadline.",
      occurredAt: now,
    });
  }

  function specRows() {
    return notificationsRepo.findSpecNotificationsBySpecId(specId);
  }

  async function startExecution() {
    const started = await service.start({
      specId,
      revisionId,
      scope: fullScope(),
      actor: { kind: "agent" as const, conversationId: "conversation-start" },
      sessionName: "session-execution",
    });
    if (!started.ok) throw new Error("start was refused");
    return started.execution;
  }

  it("abandonExecution resolves execution-scoped requests and waiver requests but leaves authoring reviews open", async () => {
    const execution = await startExecution();
    openRequest("requirements", "R1", "request-requirements");
    openRequest("execution_start", "execution_start", "request-start");
    openRequest("delivery", "T1", "request-delivery");
    openWaiverRequest("attention-waiver");

    const abandoned = await service.abandonExecution({
      executionId: execution.id,
      reason: "The approach was superseded.",
      actor: { kind: "human" },
    });
    expect(abandoned.ok).toBe(true);

    const rows = specRows();
    const resolvedRequestIds = rows
      .filter((row) => row.type === "spec-attention-resolved")
      .map((row) => row.gateRequestId)
      .sort();
    expect(resolvedRequestIds).toEqual([
      "attention-waiver",
      "request-delivery",
      "request-start",
    ]);

    const outcomes = deriveNotificationOutcomes(rows, []);
    expect(outcomes.needsAction).toHaveLength(1);
    expect(outcomes.needsAction[0]).toMatchObject({
      phase: "Requirements approval required",
    });
  });

  it("abandonSpec clears every open request, and replays never duplicate resolutions", async () => {
    await startExecution();
    openRequest("requirements", "R1", "request-requirements");
    openRequest("delivery", "T1", "request-delivery");
    openWaiverRequest("attention-waiver");

    const abandoned = await service.abandonSpec({
      specId,
      reason: "The product direction was withdrawn.",
      actor: { kind: "human" },
    });
    expect(abandoned.ok).toBe(true);
    expect(deriveNotificationOutcomes(specRows(), []).needsAction).toHaveLength(
      0,
    );
    const resolvedCount = specRows().filter(
      (row) => row.type === "spec-attention-resolved",
    ).length;
    expect(resolvedCount).toBe(3);

    // A direct replay of the clearing act converges on the same rows.
    notifier.specAttentionCleared({
      specId,
      scope: "spec",
      reason: "The product direction was withdrawn.",
      occurredAt: now,
    });
    expect(
      specRows().filter((row) => row.type === "spec-attention-resolved"),
    ).toHaveLength(3);
  });
});

class InMemoryWorkflowDefinitions implements ExecutionWorkflowDefinitions {
  records: WorkflowDefinitionRecord[] = [];
  createCount = 0;
  updateCount = 0;

  async findByOrigin(sourceUri: string) {
    return (
      this.records.find(
        (record) => record.definition.origin?.sourceUri === sourceUri,
      ) ?? null
    );
  }

  async create(draft: WorkflowDefinitionDraft) {
    this.createCount += 1;
    const record = definitionRecord(
      `workflow-definition-${this.createCount}`,
      draft,
      1,
    );
    this.records.push(record);
    return record;
  }

  async update(workflowId: string, draft: WorkflowDefinitionDraft) {
    this.updateCount += 1;
    const index = this.records.findIndex((record) => record.id === workflowId);
    if (index === -1) throw new Error("workflow definition not found");
    const current = this.records[index]!;
    const record = definitionRecord(workflowId, draft, current.revision + 1);
    this.records[index] = record;
    return record;
  }

  async list(): Promise<WorkflowDefinitionSummary[]> {
    return this.records.map((record) => ({
      id: record.id,
      name: record.name,
      description: record.description,
      revision: record.revision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      parameters: record.definition.parameters,
      prerequisites: record.definition.prerequisites,
    }));
  }
}

function definitionRecord(
  id: string,
  draft: WorkflowDefinitionDraft,
  revision: number,
): WorkflowDefinitionRecord {
  return {
    id,
    name: draft.name,
    description: draft.description,
    schemaVersion: 1,
    revision,
    definition: draft.definition,
    layout: { ...draft.layout, workflowId: id },
    createdAt: now,
    updatedAt: now,
  };
}

function fullScope(): ExecutionScope {
  return {
    selectedTaskIds: ["task-1", "task-2", "task-3"],
    selectedCriterionIds: ["criterion-1", "criterion-2", "criterion-3"],
    exclusionDispositions: [],
  };
}

function seedSpec(db: Db): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(projectPath);
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    specId,
    projectPath,
    "native-sdd",
    "Native SDD",
    '{"preset":"contract-bearing"}',
    null,
    null,
    now,
    now,
  );
  insertRevision(db, revisionId, 1, "approved");
  insertRevision(db, proposedRevisionId, 2, "proposed");

  insertElement(db, "requirement-1", "requirement", 1, null, 0, {
    kind: "requirement",
    statement: "Execution start pins an approved contract.",
    priority: "must",
    risk: "high",
  });
  insertElement(db, "criterion-1", "criterion", 1, "requirement-1", 1, {
    kind: "criterion",
    text: "The execution pin is immutable.",
    validationStrategy: { kinds: ["validator_verdict"] },
  });
  insertElement(db, "criterion-2", "criterion", 2, "requirement-1", 2, {
    kind: "criterion",
    text: "Task dependencies remain closed.",
    validationStrategy: { kinds: ["validator_verdict"] },
  });
  insertElement(db, "criterion-3", "criterion", 3, "requirement-1", 3, {
    kind: "criterion",
    text: "Every selected criterion has task coverage.",
    validationStrategy: { kinds: ["test_run"] },
  });
  insertElement(db, "task-1", "task", 1, null, 4, {
    kind: "task",
    title: "Prepare execution",
    instructions: "Prepare the pinned execution.",
    tracedRequirementElementIds: ["requirement-1"],
    tracedDecisionElementIds: [],
    coveredCriterionElementIds: ["criterion-1"],
    dependsOnTaskElementIds: [],
  });
  insertElement(db, "task-2", "task", 2, null, 5, {
    kind: "task",
    title: "Respect dependencies",
    instructions: "Start after task one.",
    tracedRequirementElementIds: ["requirement-1"],
    tracedDecisionElementIds: [],
    coveredCriterionElementIds: ["criterion-2"],
    dependsOnTaskElementIds: ["task-1"],
  });
  insertElement(db, "task-3", "task", 3, null, 6, {
    kind: "task",
    title: "Validate coverage",
    instructions: "Validate selected criterion coverage.",
    tracedRequirementElementIds: ["requirement-1"],
    tracedDecisionElementIds: [],
    coveredCriterionElementIds: ["criterion-3"],
    dependsOnTaskElementIds: [],
  });
}

function insertRevision(
  db: Db,
  id: string,
  number: number,
  state: "approved" | "proposed",
): void {
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, based_on_revision_id, content_hash,
       proposed_at, approved_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    specId,
    number,
    state,
    null,
    `hash-${id}`,
    now,
    state === "approved" ? now : null,
    now,
  );
}

function insertElement(
  db: Db,
  id: string,
  kind: string,
  number: number,
  parentElementId: string | null,
  position: number,
  payload: unknown,
): void {
  db.prepare(
    `INSERT INTO spec_elements (
       id, spec_id, kind, number, parent_element_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, specId, kind, number, parentElementId, now);
  for (const targetRevisionId of [revisionId, proposedRevisionId]) {
    db.prepare(
      `INSERT INTO spec_element_versions (
         revision_id, element_id, position, payload_json, payload_hash,
         element_version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      targetRevisionId,
      id,
      position,
      JSON.stringify(payload),
      `hash-${targetRevisionId}-${id}`,
      1,
      now,
      now,
    );
  }
}
