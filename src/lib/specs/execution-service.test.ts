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
import { createSpecDeliveryPlanRepo } from "@/lib/state-store/spec-delivery-plan-repo";
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
import type { GraphWorkflowExecutionOrigin } from "@/lib/workflow-graph/schemas";
import { graphWorkflowExecutionEventSchema } from "@/lib/workflow-graph/event-schemas";
import {
  deliveryPlanDocumentSchema,
  pinnedSpecDocumentPath,
  type DeliveryPlanDocument,
} from "./delivery-plan";
import {
  deliveryPlanCompiledHash,
  materializeDeliveryPlan,
  readDeliveryPlanSourceMap,
} from "./delivery-plan-materializer";
import type { DeliveryPlanLaunchCandidate } from "./delivery-plan-service";
import type { CompiledOriginMapEntry } from "./compiler";
import type { SpecExecutionRow } from "./schemas";
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
  type SpecDeliveryPlanLaunchPort,
  type SpecWorkflowCleanupObservation,
} from "./execution-service";

type Db = InstanceType<typeof Database>;

/**
 * Where the abandon coordinator's cleanup port reports the linked run. Reset
 * per test to the post-abort resting state; a test that needs a live,
 * slot-owning run reassigns it.
 */
let workflowPlacement: SpecWorkflowCleanupObservation = {
  kind: "archived",
  status: "aborted",
};

const projectPath = "/repos/execution-service";
const specId = "spec-execution-service";
const revisionId = "revision-approved";
const proposedRevisionId = "revision-proposed";
const now = "2026-07-18T15:00:00.000Z";
const lifecycleContext = {
  projectPath,
  sessionName: "session-execution",
};

/**
 * The origin a template launch reports. Correlating a spec execution by the
 * definition revision it pinned is a template-only affordance, so it is the
 * origin — not a bare definition id — that these callbacks receive.
 */
function templateOrigin(
  definitionId: string,
  definitionRevision: number,
): GraphWorkflowExecutionOrigin {
  return {
    kind: "template",
    definitionId,
    definitionRevision,
    tier: "project",
  };
}

describe("ExecutionService start", () => {
  let db: Db;
  let deps: ExecutionServiceDeps;
  let service: ExecutionService;
  let definitions: InMemoryWorkflowDefinitions;
  let approvedLaunch: DeliveryPlanLaunchCandidate;
  let startGate: ReturnType<typeof deliveryPlanExecutionGate>;
  let nextId: number;

  beforeEach(() => {
    workflowPlacement = { kind: "archived", status: "aborted" };
    db = _createTestDb();
    seedSpec(db);
    const writeQueue = createWriteQueue();
    definitions = new InMemoryWorkflowDefinitions();
    approvedLaunch = approvedDeliveryPlanLaunch();
    startGate = deliveryPlanExecutionGate();
    nextId = 0;
    const eventsRepo = createSpecEventsRepo(db);
    deps = {
      specsRepo: createSpecsRepo(db, writeQueue),
      deliveryRepo: createSpecDeliveryRepo(db),
      linksRepo: createSpecLinksRepo(db),
      eventsRepo,
      reviewRepo: createSpecReviewRepo(db),
      plansRepo: createSpecDeliveryPlanRepo(db, {
        appendEvent: (event) => eventsRepo.appendInTransaction(event),
      }),
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
      // The abandon coordinator's forward seam. The default models a run that
      // already aborted and auto-released its slot — the state the reverse
      // abort hook reports into — so cleanup skips forward to finalize. Tests
      // that need a live, slot-owning run set `workflowPlacement` themselves.
      workflowCleanup: {
        observe: async () => workflowPlacement,
        abort: async () => {
          workflowPlacement = { kind: "archived", status: "aborted" };
          return { ok: true };
        },
        // Only a lease-holding HALT routes to abandon, and these flows model a
        // running run — reaching it here would mean the table mis-dispatched.
        abandon: async () => {
          throw new Error("abandon is not the act these flows exercise");
        },
      },
      nextId: (kind) => `${kind}-${++nextId}`,
      now: () => now,
      runInImmediateTransaction<T>(fn: () => T): T {
        return db.transaction(fn).immediate();
      },
      deliveryPlanLaunch: approvedDeliveryPlanPort(() => approvedLaunch),
      executionStartGate: startGate,
    };
    service = createExecutionService(deps);
  });

  it("refuses a session name that does not resolve before recording anything", async () => {
    const result = await service.start({
      specId,
      revisionId,
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

  it("refuses a spec with no delivery-plan attempt and names the importer remedy", async () => {
    deps.deliveryPlanLaunch = {
      resolveLaunch: async () => ({
        kind: "refused",
        refusal: {
          code: "not_found",
          unmetConditions: ["Spec native-sdd has no delivery plan attempt."],
          instruction:
            "Open one with `cctl spec plan open native-sdd --seed-from last`.",
        },
      }),
      park: async () => ({ ok: true, value: parkedPlanNextAct() }),
      recordLaunch: async () => ({ ok: true, value: null }),
    };
    service = createExecutionService(deps);

    const result = await service.start(startInput());

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "not_found",
      },
    });
    if (result.ok) throw new Error("start should require a delivery plan");
    expect(result.refusal.instruction).toContain(
      "cctl spec plan open native-sdd --seed-from last",
    );
    expect(definitions.records).toHaveLength(0);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM spec_executions").get(),
    ).toEqual({ count: 0 });
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

    expect(result.definition.definition.approvalRequired).toBe(false);
    expect(result.definition.definition.origin?.sourceUri).toBe(
      approvedLaunch.definition.origin?.sourceUri,
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

  it("launches the stored candidate unchanged when the current gate policy differs", async () => {
    db.prepare("UPDATE specs SET gate_policy_json = ? WHERE id = ?").run(
      '{"preset":"fast-path"}',
      specId,
    );

    const result = await service.start(startInput());

    expect(result).toMatchObject({
      ok: true,
      definition: { definition: { approvalRequired: false } },
    });
    if (!result.ok) throw new Error("start was refused");
    expect(deliveryPlanCompiledHash(result.definition.definition)).toBe(
      approvedLaunch.candidate.compiledDefinitionHash,
    );
  });

  it("reuses an inert definition carrying the exact approved candidate", async () => {
    await definitions.create(definitionDraft(approvedLaunch.definition));
    expect(definitions.records).toHaveLength(1);

    const retry = await service.start(startInput());
    expect(retry).toMatchObject({ ok: true });
    expect(definitions.records).toHaveLength(1);
    expect(definitions.createCount).toBe(1);
    expect(definitions.updateCount).toBe(0);
  });

  it("replaces a changed inert definition with the approved candidate bytes", async () => {
    await definitions.create(definitionDraft(approvedLaunch.definition));
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

  it("pins the plan's own revision, not the newer one the request named", async () => {
    // A revision approved after the attempt opened is what the CLI resolves
    // and sends. The launch persists the plan's pin, so reading the request's
    // revision for the number would pair an old id with a newer number.
    insertRevision(db, "revision-newer", 3, "approved");

    await service.start({
      specId,
      revisionId: "revision-newer",
      actor: { kind: "agent" as const, conversationId: "conversation-start" },
      sessionName: "session-execution",
      projectName: "execution-service",
    });

    // The definition carries the pinned revision's number, and the execution
    // row carries the pinned revision's id — the two now agree.
    expect(definitions.records[0]?.name).toContain("revision 1");
    const row = db
      .prepare("SELECT revision_id FROM spec_executions WHERE spec_id = ?")
      .get(specId) as { revision_id: string };
    expect(row.revision_id).toBe(revisionId);
  });

  it("seeds the pinned spec into the launched run so every lane can read the contract it is judged against", async () => {
    // The plan's rank-1 source of truth is the materialized pinned spec, so a
    // launch that carried no seeded document would point all nine validators
    // at a path no lane worktree has.
    insertRevision(db, "revision-newer", 3, "approved");

    const result = await service.start({
      specId,
      revisionId: "revision-newer",
      actor: { kind: "agent" as const, conversationId: "conversation-start" },
      sessionName: "session-execution",
      projectName: "execution-service",
    });

    expect(result).toMatchObject({ ok: true });
    expect(startGate.launchApprovedDefinition).toHaveBeenCalledOnce();
    expect(startGate.launchApprovedDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        seededDocuments: [
          expect.objectContaining({
            relativePath: pinnedSpecDocumentPath("native-sdd"),
            // The plan pins revision 1 while the request named revision 3, so
            // the rendered bytes prove the seed follows the pin, not head.
            contents: expect.stringContaining("- Revision: 1"),
          }),
        ],
      }),
    );
  });

  it("retires the execution it created when the plan rejects the candidate at launch", async () => {
    // Plan mutations do not share the start path's write queue, so a reopen
    // landing while the definition is being persisted rejects the candidate
    // after the execution row already exists. Leaving that row ACTIVE would
    // block every retry, so it must be retired audibly.
    deps.deliveryPlanLaunch = {
      resolveLaunch: async () => ({
        kind: "ready",
        value: approvedLaunch,
      }),
      park: async () => ({ ok: true, value: parkedPlanNextAct() }),
      recordLaunch: async () => ({
        ok: false,
        refusal: {
          code: "integrity_mismatch",
          unmetConditions: ["The attempt no longer carries that candidate."],
          instruction: "Re-propose and sign the fresh candidate off.",
        },
      }),
    };
    service = createExecutionService(deps);

    const result = await service.start({
      specId,
      revisionId,
      actor: { kind: "agent" as const, conversationId: "conversation-start" },
      sessionName: "session-execution",
      projectName: "execution-service",
    });

    expect(result.ok).toBe(false);
    // No active execution survives to block the retry.
    const rows = db
      .prepare(
        "SELECT state, abandoned_reason FROM spec_executions WHERE spec_id = ?",
      )
      .all(specId) as Array<{ state: string; abandoned_reason: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("abandoned");
    expect(rows[0]?.abandoned_reason).toContain(
      "The attempt no longer carries that candidate.",
    );
    // The retirement is audited rather than silent.
    const kinds = (
      db
        .prepare(
          "SELECT payload_json FROM spec_events WHERE event_type = 'spec-execution-changed'",
        )
        .all() as Array<{ payload_json: string }>
    ).map((row) => (JSON.parse(row.payload_json) as { kind: string }).kind);
    expect(kinds).toContain("execution_abandoned");
    if (result.ok) throw new Error("the launch should have been refused");
    expect(result.refusal.instruction).toContain("Nothing is running");
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
      templateOrigin(started.definition.id, started.definition.revision),
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
      templateOrigin(started.definition.id, started.definition.revision),
    );
    await callbacks.markRunning(
      { ...lifecycleContext, sessionName: "another-session" },
      "workflow-wrong-session",
      templateOrigin(started.definition.id, started.definition.revision),
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
      templateOrigin(started.definition.id, started.definition.revision),
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
      templateOrigin(started.definition.id, started.definition.revision),
    );
    await callbacks.markRunning(
      { ...lifecycleContext, sessionName: "another-session" },
      "workflow-linked-scope",
      templateOrigin(started.definition.id, started.definition.revision),
    );

    expect(
      deps.deliveryRepo.findExecutionById(started.execution.id),
    ).toMatchObject({ state: "definition_review" });

    await callbacks.markRunning(
      lifecycleContext,
      "workflow-linked-scope",
      templateOrigin(started.definition.id, started.definition.revision),
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
      templateOrigin(started.definition.id, started.definition.revision + 1),
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
        templateOrigin("definition-unrelated", 1),
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
      templateOrigin(started.definition.id, started.definition.revision),
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
      templateOrigin("definition-unrelated", 1),
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
      templateOrigin(started.definition.id, started.definition.revision + 1),
    );
    await expect(
      callbacks.admitDefinitionApproval(
        lifecycleContext,
        "workflow-parked-wrong-revision",
        templateOrigin(started.definition.id, started.definition.revision + 1),
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
        templateOrigin(started.definition.id, started.definition.revision),
      ),
    ).resolves.toEqual({ ok: true });
    await callbacks.markRunning(
      lifecycleContext,
      "workflow-linked-without-revision",
      templateOrigin(started.definition.id, started.definition.revision),
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
      templateOrigin(started.definition.id, started.definition.revision),
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
      templateOrigin(started.definition.id, started.definition.revision),
    );

    expect(admitted).toEqual({
      ok: false,
      code: "revision_not_approved",
      unmetConditions: ["The pinned revision is no longer approved."],
      instruction: "Sign off the revision first.",
    });
    // A refusal is the graph's signal to hand the reservation back and restore
    // the park byte for byte, so it may leave nothing of its own behind — not
    // even the link (charter `reserve-before-side-effects`).
    expect(
      deps.deliveryRepo.findExecutionById(started.execution.id),
    ).toMatchObject({ workflow_execution_id: null });
  });

  it("writes nothing when the execution-start gate is absent from the composition", async () => {
    const started = await service.start(startInput());
    if (!started.ok) throw new Error("start was refused");
    const callbacks = createExecutionLifecycleCallbacks({
      ...deps,
      lifecycleGate: undefined,
    });

    const admitted = await callbacks.admitDefinitionApproval(
      lifecycleContext,
      "workflow-parked-unwired",
      templateOrigin(started.definition.id, started.definition.revision),
    );

    expect(admitted).toMatchObject({ ok: false, code: "gate_blocked" });
    expect(
      deps.deliveryRepo.findExecutionById(started.execution.id),
    ).toMatchObject({ workflow_execution_id: null });
  });

  it.each(["abandoned", "delivered"] as const)(
    "redirects a terminal %s execution to the seeded delivery-plan path",
    async (state) => {
      const started = await service.start(startInput());
      if (!started.ok) throw new Error("start was refused");
      const linked = await service.linkWorkflowExecution(
        started.execution.id,
        `workflow-terminal-${state}`,
      );
      if (!linked.ok) throw new Error("could not link terminal fixture");
      db.prepare("UPDATE spec_executions SET state = ? WHERE id = ?").run(
        state,
        started.execution.id,
      );
      const workflowExecutionId = deps.deliveryRepo.findExecutionById(
        started.execution.id,
      )?.workflow_execution_id;
      if (workflowExecutionId === null || workflowExecutionId === undefined) {
        throw new Error("started execution was not linked to its workflow");
      }
      const callbacks = createExecutionLifecycleCallbacks(deps);

      const admitted = await callbacks.admitDefinitionApproval(
        lifecycleContext,
        workflowExecutionId,
        templateOrigin(started.definition.id, started.definition.revision),
      );

      expect(admitted).toMatchObject({ ok: false, code: "gate_blocked" });
      if (admitted.ok) throw new Error("expected a terminal refusal");
      expect(admitted.instruction).toContain(
        "cctl spec plan open native-sdd --seed-from last",
      );
      expect(admitted.instruction).toContain("cctl spec start native-sdd");
    },
  );

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
      templateOrigin(started.definition.id, started.definition.revision),
    );
    // A replayed report must not duplicate the event or the notice.
    await callbacks.markRunning(
      lifecycleContext,
      "workflow-notify-run",
      templateOrigin(started.definition.id, started.definition.revision),
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
      templateOrigin(started.definition.id, started.definition.revision),
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
    const sourceMap = readDeliveryPlanSourceMap(definitionRecord.definition);
    const contextId = sourceMap.contexts.find((entry) =>
      entry.criterionElementIds.includes("criterion-1"),
    )?.contextId;
    if (contextId === undefined) throw new Error("origin context missing");
    const originMap: CompiledOriginMapEntry[] = [
      {
        contextId,
        taskElementId: "task-1",
        taskHandle: "native-sdd/T1",
        touchedPaths: [],
        criterionElementIds: ["criterion-1"],
        criterionHandles: ["native-sdd/R1.1"],
        validationStrategies: {
          "criterion-1": { kinds: ["validator_verdict"] },
        },
        criterionBriefs: {
          "criterion-1": "The execution pin is immutable.",
        },
      },
    ];
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
        const record = workflowEvents.findRecordById(
          projectPath,
          "session-execution",
          expectedExecution.workflowExecutionId ?? "",
          ref.eventId,
        );
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
      resolveProjectPath: async () => projectPath,
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

  it("completes an abandonment whose cleanup ports re-enter the shared write queue", async () => {
    // Regression guard for a real deadlock. The production cleanup ports drive
    // the graph-workflow setters, which acquire the SAME shared write queue,
    // and that queue is a single non-reentrant FIFO. A coordinator that held
    // the queue across these awaits hung on the first live abandonment; this
    // port reproduces that shape exactly, so a regression times out here.
    const running = await startRunning();
    const queueAcquisitionsInsidePorts: string[] = [];
    deps.workflowCleanup = {
      observe: async () => workflowPlacement,
      async abort() {
        await deps.writeQueue.withWriteQueueSync("workflow-abort-write", () => {
          queueAcquisitionsInsidePorts.push("abort");
        });
        // `aborted` releases the lease on its own, so the coordinator's next
        // observation sees a lease-free run with nothing left to do.
        workflowPlacement = {
          kind: "active",
          status: "aborted",
          leaseHeld: false,
        };
        workflowPlacement = { kind: "archived", status: "aborted" };
        return { ok: true };
      },
      abandon: async () => {
        throw new Error("abandon is not the act this flow exercises");
      },
    };
    workflowPlacement = { kind: "active", status: "running", leaseHeld: true };
    service = createExecutionService(deps);

    const abandoned = await service.abandonExecution({
      executionId: running.id,
      reason: "superseded by a replanned run",
      actor: { kind: "human" },
    });

    expect(abandoned.ok).toBe(true);
    expect(queueAcquisitionsInsidePorts).toEqual(["abort"]);
    expect(deps.deliveryRepo.findExecutionById(running.id)).toMatchObject({
      state: "abandoned",
      cleanup_phase: null,
    });
  });

  it("parks instead of recording a phase its cleanup port did not perform", async () => {
    const running = await startRunning();
    deps.workflowCleanup = {
      observe: async () => workflowPlacement,
      // Accepts the call but reports honestly that it changed nothing.
      abort: async () => ({ ok: false, reason: "nothing to abort" }),
      abandon: async () => ({ ok: false, reason: "nothing to abandon" }),
    };
    workflowPlacement = { kind: "active", status: "running", leaseHeld: true };
    service = createExecutionService(deps);

    const abandoned = await service.abandonExecution({
      executionId: running.id,
      reason: "superseded by a replanned run",
      actor: { kind: "human" },
    });

    expect(abandoned.ok).toBe(false);
    expect(deps.deliveryRepo.findExecutionById(running.id)).toMatchObject({
      state: "abandoning",
      cleanup_phase: "abort_workflow",
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

  it("16.9 captures discovered work without changing the running pin", async () => {
    const running = await startRunning();
    const originalScope = running.scope_json;
    // Capture judges the discovery against the execution's pinned revision, so
    // it keeps working while a later revision is under review: it is not an
    // ordinary authoring continuation and must not take that refusal.
    expect(
      db
        .prepare("SELECT state FROM spec_revisions WHERE id = ?")
        .get(proposedRevisionId),
    ).toEqual({ state: "proposed" });

    const captured = await service.captureScopeAmendment({
      specId,
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
    if (!captured.ok) throw new Error("capture was refused");

    expect(captured.value).toMatchObject({
      discovery: {
        executionId: running.id,
        attemptId: null,
        title: "Implement the discovered prerequisite",
      },
      restartRequired: false,
      replacement: null,
    });
    expect(deps.deliveryRepo.findExecutionById(running.id)?.scope_json).toBe(
      originalScope,
    );
  });

  function startInput() {
    return {
      specId,
      revisionId,
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
    launchApprovedDefinition: ReturnType<typeof vi.fn>;
    findPendingDefinitionApproval: ReturnType<typeof vi.fn>;
    ensurePendingDefinitionApproval: ReturnType<typeof vi.fn>;
    approveWorkflowDefinition: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    workflowPlacement = { kind: "archived", status: "aborted" };
    db = _createTestDb();
    seedSpec(db);
    const writeQueue = createWriteQueue();
    const eventsRepo = createSpecEventsRepo(db);
    let nextId = 0;
    gate = {
      launchApprovedDefinition: vi.fn(async () => ({
        ok: true as const,
        workflowExecutionId: "workflow-execution-launched",
      })),
      findPendingDefinitionApproval: vi.fn(async () => ({
        executionId: "workflow-execution-pending",
        origin: {
          kind: "template" as const,
          definitionId: "workflow-definition-historical",
          definitionRevision: 1,
          tier: "project" as const,
        },
      })),
      ensurePendingDefinitionApproval: vi.fn(async () => ({
        ok: true as const,
        park: {
          executionId: "workflow-execution-launched",
          origin: {
            kind: "template" as const,
            definitionId: "workflow-definition-historical",
            definitionRevision: 1,
            tier: "project" as const,
          },
        },
      })),
      approveWorkflowDefinition: vi.fn(async () => ({ ok: true as const })),
    };
    deps = {
      specsRepo: createSpecsRepo(db, writeQueue),
      deliveryRepo: createSpecDeliveryRepo(db),
      linksRepo: createSpecLinksRepo(db),
      eventsRepo,
      reviewRepo: createSpecReviewRepo(db),
      plansRepo: createSpecDeliveryPlanRepo(db, {
        appendEvent: (event) => eventsRepo.appendInTransaction(event),
      }),
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
      workflowCleanup: {
        observe: async () => workflowPlacement,
        abort: async () => {
          workflowPlacement = { kind: "archived", status: "aborted" };
          return { ok: true };
        },
        // Only a lease-holding HALT routes to abandon, and these flows model a
        // running run — reaching it here would mean the table mis-dispatched.
        abandon: async () => {
          throw new Error("abandon is not the act these flows exercise");
        },
      },
      nextId: (kind) => `${kind}-${++nextId}`,
      now: () => now,
      runInImmediateTransaction<T>(fn: () => T): T {
        return db.transaction(fn).immediate();
      },
      executionStartGate: gate,
      deliveryPlanLaunch: approvedDeliveryPlanPort(approvedDeliveryPlanLaunch),
    };
    service = createExecutionService(deps);
  });

  function startedExecutionId(
    sessionName: string | null = "session-execution",
  ): string {
    const execution = historicalExecutionRow(
      "execution-historical-definition-review",
      sessionName,
    );
    deps.deliveryRepo.insertExecution(execution);
    return execution.id;
  }

  it("launches the prepared definition before recording exactly one human approval when no workflow execution is pending", async () => {
    const executionId = await startedExecutionId();
    const definitionId =
      deps.deliveryRepo.findExecutionById(executionId)?.workflow_definition_id;
    if (definitionId === null || definitionId === undefined) {
      throw new Error("started execution has no prepared workflow definition");
    }
    gate.findPendingDefinitionApproval.mockResolvedValue(null);

    const result = await service.approveExecutionStart({
      specId,
      executionId,
      actor: { kind: "human" },
      projectName: "repo-project",
    });

    expect(result).toMatchObject({ ok: true, value: { id: executionId } });
    expect(gate.ensurePendingDefinitionApproval).toHaveBeenCalledOnce();
    expect(gate.ensurePendingDefinitionApproval).toHaveBeenCalledWith({
      projectName: "repo-project",
      sessionName: "session-execution",
      definitionId,
      definitionRevision: 1,
      // A human Studio grant carries no conversation, so the launched run is
      // explicitly unowned rather than silently missing an owner.
      ownerConversationId: null,
      // The grant path resolves the execution's own pin, so a run parked for
      // definition approval reaches its lanes with the same pinned spec a
      // directly launched run does.
      seededDocuments: [
        expect.objectContaining({
          relativePath: ".cc/graph-workflow-docs/spec/native-sdd.md",
          contents: expect.stringContaining("- Revision: 1"),
        }),
      ],
    });
    expect(gate.approveWorkflowDefinition).toHaveBeenCalledOnce();
    expect(gate.approveWorkflowDefinition).toHaveBeenCalledWith({
      projectName: "repo-project",
      sessionName: "session-execution",
      workflowExecutionId: "workflow-execution-launched",
    });
    // The launch precedes the decision: an admission may only be recorded when
    // a parked workflow execution is there to consume it.
    const ensureOrder =
      gate.ensurePendingDefinitionApproval.mock.invocationCallOrder[0];
    const approveOrder =
      gate.approveWorkflowDefinition.mock.invocationCallOrder[0];
    expect(ensureOrder).toBeDefined();
    expect(approveOrder).toBeDefined();
    expect(ensureOrder ?? 0).toBeLessThan(approveOrder ?? 0);
  });

  it("refuses an agent approval as a human act without touching the gate ports", async () => {
    const executionId = await startedExecutionId();

    const result = await service.approveExecutionStart({
      specId,
      executionId,
      actor: { kind: "agent", conversationId: "conversation-start" },
      projectName: "repo-project",
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "human_act_required" },
    });
    expect(gate.ensurePendingDefinitionApproval).not.toHaveBeenCalled();
    expect(gate.approveWorkflowDefinition).not.toHaveBeenCalled();
  });

  it("decides the parked run's definition only after confirming the park", async () => {
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
      projectName: "repo-project",
    });

    expect(result).toMatchObject({ ok: true, value: { id: executionId } });
    expect(gate.findPendingDefinitionApproval).toHaveBeenCalledWith({
      projectName: "repo-project",
      sessionName: "session-execution",
    });
    expect(gate.ensurePendingDefinitionApproval).not.toHaveBeenCalled();
    expect(gate.approveWorkflowDefinition).toHaveBeenCalledWith({
      projectName: "repo-project",
      sessionName: "session-execution",
      workflowExecutionId: "workflow-execution-pending",
    });
    // The pending probe must precede the decision: the act may only be offered
    // to a parked workflow execution that is there to consume it.
    const probeOrder =
      gate.findPendingDefinitionApproval.mock.invocationCallOrder[0];
    const approveOrder =
      gate.approveWorkflowDefinition.mock.invocationCallOrder[0];
    expect(probeOrder).toBeDefined();
    expect(approveOrder).toBeDefined();
    expect(probeOrder ?? 0).toBeLessThan(approveOrder ?? 0);
  });

  /**
   * The session holds ONE lease, but the run holding it is not necessarily the
   * run this approval is for. A park is addressed by session, so the Studio act
   * has to establish that the park it found is the compiled definition of the
   * execution the human asked to start — otherwise approving execution A starts
   * whatever unrelated run B happens to hold the session, while A stays
   * unapproved.
   */
  it("refuses when the session's park belongs to an unrelated one-off run", async () => {
    const executionId = await startedExecutionId();
    gate.findPendingDefinitionApproval.mockResolvedValue({
      executionId: "workflow-execution-one-off",
      origin: { kind: "one_off", planName: "Investigate the flake" },
    });

    const result = await service.approveExecutionStart({
      specId,
      executionId,
      actor: { kind: "human" },
      projectName: "repo-project",
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "gate_blocked" },
    });
    expect(gate.approveWorkflowDefinition).not.toHaveBeenCalled();
    expect(gate.ensurePendingDefinitionApproval).not.toHaveBeenCalled();
  });

  it("refuses when the session's park is another spec execution's definition", async () => {
    const executionId = await startedExecutionId();
    gate.findPendingDefinitionApproval.mockResolvedValue({
      executionId: "workflow-execution-other",
      origin: {
        kind: "template",
        definitionId: "workflow-definition-of-another-execution",
        definitionRevision: 4,
        tier: "project",
      },
    });

    const result = await service.approveExecutionStart({
      specId,
      executionId,
      actor: { kind: "human" },
      projectName: "repo-project",
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "gate_blocked" },
    });
    expect(gate.approveWorkflowDefinition).not.toHaveBeenCalled();
  });

  it("approves the park already linked to this execution even when its definition pin moved", async () => {
    const executionId = await startedExecutionId();
    await service.linkWorkflowExecution(
      executionId,
      "workflow-execution-linked",
    );
    gate.findPendingDefinitionApproval.mockResolvedValue({
      executionId: "workflow-execution-linked",
      origin: {
        kind: "template",
        definitionId: "workflow-definition-superseded",
        definitionRevision: 9,
        tier: "project",
      },
    });

    const result = await service.approveExecutionStart({
      specId,
      executionId,
      actor: { kind: "human" },
      projectName: "repo-project",
    });

    // A link is the stronger correlation: this execution already owns that run,
    // whatever the definition pin says now.
    expect(result).toMatchObject({ ok: true });
    expect(gate.approveWorkflowDefinition).toHaveBeenCalledWith({
      projectName: "repo-project",
      sessionName: "session-execution",
      workflowExecutionId: "workflow-execution-linked",
    });
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

  it("records nothing and refuses when no workflow execution awaits definition approval", async () => {
    const executionId = await startedExecutionId();
    gate.approveWorkflowDefinition.mockResolvedValue({
      ok: false,
      reason: "no_active_execution",
    });

    const result = await service.approveExecutionStart({
      specId,
      executionId,
      actor: { kind: "human" },
      projectName: "repo-project",
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: "gate_blocked" },
    });
    if (result.ok) throw new Error("expected refusal");
    // The remedy has to be true: nothing was recorded, so the relaunched run is
    // approved from scratch rather than resumed on a half-made decision.
    expect(result.refusal.instruction).toMatch(/nothing was recorded/i);
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
      projectName: "repo-project",
    });

    expect(result).toMatchObject({ ok: true, value: { id: executionId } });
  });

  it("refuses missing and foreign-spec executions before touching the gate", async () => {
    const missing = await service.approveExecutionStart({
      specId,
      executionId: "execution-unknown",
      actor: { kind: "human" },
      projectName: "repo-project",
    });
    const foreignExecutionId = startedExecutionId();
    const foreign = await service.approveExecutionStart({
      specId: "spec-other",
      executionId: foreignExecutionId,
      actor: { kind: "human" },
      projectName: "repo-project",
    });

    expect(missing).toMatchObject({
      ok: false,
      refusal: { code: "not_found" },
    });
    expect(foreign).toMatchObject({
      ok: false,
      refusal: { code: "validation" },
    });
    expect(gate.findPendingDefinitionApproval).not.toHaveBeenCalled();
    expect(gate.approveWorkflowDefinition).not.toHaveBeenCalled();
  });

  it("refuses when the execution has no session to start the workflow in", async () => {
    const executionId = startedExecutionId(null);

    const result = await service.approveExecutionStart({
      specId,
      executionId,
      actor: { kind: "human" },
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
    expect(gate.findPendingDefinitionApproval).not.toHaveBeenCalled();
    expect(gate.ensurePendingDefinitionApproval).not.toHaveBeenCalled();
    expect(gate.approveWorkflowDefinition).not.toHaveBeenCalled();
    if (result.ok) throw new Error("expected a legacy execution refusal");
    expect(result.refusal.instruction).toContain(
      "cctl spec plan open native-sdd --seed-from last",
    );
    expect(result.refusal.instruction).toContain("cctl spec start native-sdd");
  });
});

describe("ExecutionService abandon clears open spec attention (runtime wiring)", () => {
  let db: Db;
  let service: ExecutionService;
  let deliveryRepo: ReturnType<typeof createSpecDeliveryRepo>;
  let notificationsRepo: ReturnType<typeof createNotificationsRepo>;
  let notifier: ReturnType<typeof createSpecApprovalNotifier>;

  beforeEach(() => {
    workflowPlacement = { kind: "archived", status: "aborted" };
    db = _createTestDb();
    seedSpec(db);
    const writeQueue = createWriteQueue();
    const eventsRepo = createSpecEventsRepo(db);
    deliveryRepo = createSpecDeliveryRepo(db);
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
      deliveryRepo,
      linksRepo: createSpecLinksRepo(db),
      eventsRepo,
      reviewRepo: createSpecReviewRepo(db),
      plansRepo: createSpecDeliveryPlanRepo(db, {
        appendEvent: (event) => eventsRepo.appendInTransaction(event),
      }),
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
      scope: "item",
      outstandingSubjects: [subject],
      signOffOutstanding: true,
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

  function startExecution() {
    const execution = historicalExecutionRow(
      "execution-historical-attention",
      "session-execution",
    );
    deliveryRepo.insertExecution(execution);
    return execution;
  }

  it("abandonExecution resolves execution-scoped requests and waiver requests but leaves authoring reviews open", async () => {
    const execution = startExecution();
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
    startExecution();
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

function approvedDeliveryPlanLaunch(): DeliveryPlanLaunchCandidate {
  const materialized = materializeDeliveryPlan({
    spec: { id: specId, slug: "native-sdd", name: "Native SDD" },
    attemptId: "attempt-approved",
    pinnedRevisionId: revisionId,
    draftRevision: 1,
    document: approvedPlanDocument(),
    criteria: [
      {
        criterionElementId: "criterion-1",
        handle: "native-sdd/R1.1",
        text: "The execution pin is immutable.",
        validationStrategy: { kinds: ["validator_verdict"] },
      },
      {
        criterionElementId: "criterion-2",
        handle: "native-sdd/R1.2",
        text: "Task dependencies remain closed.",
        validationStrategy: { kinds: ["validator_verdict"] },
      },
      {
        criterionElementId: "criterion-3",
        handle: "native-sdd/R1.3",
        text: "Every selected criterion has task coverage.",
        validationStrategy: { kinds: ["test_run"] },
      },
    ],
    registeredValidationCommandNames: [],
    defaults: { approvalRequired: false, workflowConfig: {} },
  });
  if (!materialized.ok) {
    throw new Error(materialized.refusal.instruction);
  }
  return {
    attemptId: "attempt-approved",
    pinnedRevisionId: revisionId,
    candidate: {
      candidateId: "candidate-approved",
      planHash: materialized.value.planHash,
      compiledDefinitionHash: materialized.value.compiledDefinitionHash,
    },
    definition: materialized.value.definition,
    scope: fullScope(),
    dispositions: ["criterion-1", "criterion-2", "criterion-3"].map(
      (criterionElementId) => ({
        criterionElementId,
        disposition: "in_scope" as const,
        deliveredByExecutionId: null,
      }),
    ),
  };
}

function approvedPlanDocument(): DeliveryPlanDocument {
  return deliveryPlanDocumentSchema.parse({
    dispositions: ["criterion-1", "criterion-2", "criterion-3"].map(
      (criterionElementId) => ({
        criterionElementId,
        disposition: "selected",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
      }),
    ),
    contexts: [
      {
        contextId: "delivery",
        title: "Deliver the approved execution",
        contextType: "delivery",
        criterionElementIds: ["criterion-1", "criterion-2", "criterion-3"],
        acceptanceContract: [
          "The approved execution pin and its evidence remain durable.",
        ],
        proofPlan: [
          {
            criterionElementId: "criterion-1",
            evidenceKinds: ["validator_verdict"],
            note: "Validate the immutable execution pin.",
          },
          {
            criterionElementId: "criterion-2",
            evidenceKinds: ["validator_verdict"],
            note: "Validate the authored dependency contract.",
          },
          {
            criterionElementId: "criterion-3",
            evidenceKinds: ["test_run"],
            note: "Run the selected coverage checks.",
          },
        ],
      },
    ],
    tasks: [
      {
        taskId: "task-1",
        contextId: "delivery",
        title: "Prepare execution",
        instructions: "Prepare the pinned execution.",
        order: 0,
        contributesToCriterionElementIds: ["criterion-1"],
      },
      {
        taskId: "task-2",
        contextId: "delivery",
        title: "Respect dependencies",
        instructions: "Start after task one.",
        order: 1,
        contributesToCriterionElementIds: ["criterion-2"],
      },
      {
        taskId: "task-3",
        contextId: "delivery",
        title: "Validate coverage",
        instructions: "Validate selected criterion coverage.",
        order: 2,
        contributesToCriterionElementIds: ["criterion-3"],
      },
    ],
    edges: [],
    wiring: [],
    policyOverrides: [],
    touchedSurfaces: ["src/lib/specs/execution-service.ts"],
    governance: {
      mission: "Launch exactly the delivery plan a human approved.",
      charterInvariants: [],
      sourcesOfTruth: [
        {
          rank: 1,
          id: "approved-plan",
          label: "Approved delivery plan",
          type: "spec",
          locator: "spec-plan://spec-execution-service/attempt-approved",
          description: "The candidate bytes approved for this launch.",
          appliesTo: null,
          accessPolicy: "worktree-relative",
        },
      ],
      validationCommandNames: [],
    },
  });
}

function approvedDeliveryPlanPort(
  readLaunch: () => DeliveryPlanLaunchCandidate,
): SpecDeliveryPlanLaunchPort {
  return {
    resolveLaunch: async () => ({
      kind: "ready",
      value: structuredClone(readLaunch()),
    }),
    park: async () => ({ ok: true, value: parkedPlanNextAct() }),
    recordLaunch: async () => ({ ok: true, value: null }),
  };
}

function parkedPlanNextAct() {
  return {
    nextAct: {
      actor: "agent" as const,
      command: "cctl spec start native-sdd",
      reason: "The parked candidate is ready to launch.",
    },
  };
}

function deliveryPlanExecutionGate(): NonNullable<
  ExecutionServiceDeps["executionStartGate"]
> & { launchApprovedDefinition: ReturnType<typeof vi.fn> } {
  return {
    launchApprovedDefinition: vi.fn(async () => ({
      ok: true as const,
      workflowExecutionId: "workflow-execution-launched",
    })),
    findPendingDefinitionApproval: vi.fn(async () => null),
    ensurePendingDefinitionApproval: vi.fn(async () => ({
      ok: true as const,
      park: {
        executionId: "workflow-execution-pending",
        origin: {
          kind: "template" as const,
          definitionId: "workflow-definition-historical",
          definitionRevision: 1,
          tier: "project" as const,
        },
      },
    })),
    approveWorkflowDefinition: vi.fn(async () => ({ ok: true as const })),
  };
}

function definitionDraft(
  definition: DeliveryPlanLaunchCandidate["definition"],
): WorkflowDefinitionDraft {
  return {
    name: "Native SDD revision 1",
    description: null,
    definition: structuredClone(definition),
    layout: {
      workflowId: "compiled-spec-definition",
      contextPositions: { delivery: { x: 0, y: 0 } },
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  };
}

function historicalExecutionRow(
  id: string,
  sessionName: string | null,
): SpecExecutionRow {
  return {
    id,
    spec_id: specId,
    revision_id: revisionId,
    scope_json: JSON.stringify(fullScope()),
    state: "definition_review",
    execution_start_dial: "gate",
    workflow_definition_id: "workflow-definition-historical",
    workflow_definition_revision: 1,
    workflow_execution_id: null,
    session_name: sessionName,
    delivered_at: null,
    abandoned_reason: null,
    cleanup_phase: null,
    linked_workflow_execution_id: null,
    cleanup_last_error: null,
    cleanup_last_error_at: null,
    created_at: now,
    updated_at: now,
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
