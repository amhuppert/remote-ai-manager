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
import { _createTestDb } from "@/lib/state-store/state-db";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import {
  createEvidenceMutationRecorder,
  createEvidenceService,
  type EvidenceServiceDeps,
} from "./evidence-service";
import { createSpecEventsPublisher } from "./events";

type Db = InstanceType<typeof Database>;

const SPEC_ID = "spec-evidence";
const REVISION_ID = "revision-evidence";
const OTHER_REVISION_ID = "revision-evidence-other";
const CRITERION_ID = "criterion-evidence";
const OTHER_CRITERION_ID = "criterion-other";
const TASK_ID = "task-evidence";
const EXECUTION_ID = "execution-evidence";
const PRIOR_EXECUTION_ID = "execution-evidence-prior";
const UNRELATED_EXECUTION_ID = "execution-evidence-unrelated";

function seedParents(db: Db): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(
    "/repos/evidence-service",
  );
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SPEC_ID,
    "/repos/evidence-service",
    "evidence-service",
    "Evidence service",
    '{"preset":"contract-bearing"}',
    null,
    null,
    "2026-07-18T12:00:00.000Z",
    "2026-07-18T12:00:00.000Z",
  );
  const insertElement = db.prepare(
    `INSERT INTO spec_elements (
       id, spec_id, kind, number, parent_element_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertElement.run(
    CRITERION_ID,
    SPEC_ID,
    "criterion",
    1,
    null,
    "2026-07-18T12:00:00.000Z",
  );
  insertElement.run(
    OTHER_CRITERION_ID,
    SPEC_ID,
    "criterion",
    2,
    null,
    "2026-07-18T12:00:00.000Z",
  );
  insertElement.run(
    TASK_ID,
    SPEC_ID,
    "task",
    1,
    null,
    "2026-07-18T12:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, based_on_revision_id, content_hash,
       proposed_at, approved_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    REVISION_ID,
    SPEC_ID,
    1,
    "approved",
    null,
    "sha256:evidence-revision",
    "2026-07-18T12:00:00.000Z",
    "2026-07-18T12:01:00.000Z",
    "2026-07-18T12:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, based_on_revision_id, content_hash,
       proposed_at, approved_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    OTHER_REVISION_ID,
    SPEC_ID,
    2,
    "approved",
    REVISION_ID,
    "sha256:evidence-revision-other",
    "2026-07-18T12:02:00.000Z",
    "2026-07-18T12:03:00.000Z",
    "2026-07-18T12:02:00.000Z",
  );
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_definition_id,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    EXECUTION_ID,
    SPEC_ID,
    REVISION_ID,
    JSON.stringify({
      selectedTaskIds: ["task-evidence"],
      selectedCriterionIds: [CRITERION_ID],
      exclusionDispositions: [
        { criterionId: OTHER_CRITERION_ID, disposition: "deferred" },
      ],
    }),
    "running",
    "workflow-definition-evidence",
    "workflow-execution-evidence",
    "evidence-session",
    null,
    null,
    "2026-07-18T12:02:00.000Z",
    "2026-07-18T12:02:00.000Z",
  );
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_definition_id,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    PRIOR_EXECUTION_ID,
    SPEC_ID,
    REVISION_ID,
    JSON.stringify({
      selectedTaskIds: [TASK_ID],
      selectedCriterionIds: [CRITERION_ID],
      exclusionDispositions: [],
    }),
    "delivered",
    "workflow-definition-evidence-prior",
    "workflow-execution-evidence-prior",
    "evidence-prior-session",
    "2026-07-18T12:01:30.000Z",
    null,
    "2026-07-18T12:00:30.000Z",
    "2026-07-18T12:01:30.000Z",
  );
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_definition_id,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    UNRELATED_EXECUTION_ID,
    SPEC_ID,
    OTHER_REVISION_ID,
    JSON.stringify({
      selectedTaskIds: [TASK_ID],
      selectedCriterionIds: [CRITERION_ID],
      exclusionDispositions: [],
    }),
    "running",
    "workflow-definition-evidence-unrelated",
    "workflow-execution-evidence-unrelated",
    "evidence-unrelated-session",
    null,
    null,
    "2026-07-18T12:03:30.000Z",
    "2026-07-18T12:03:30.000Z",
  );
}

describe("EvidenceService waivers and dispositions", () => {
  let db: Db;
  let deps: EvidenceServiceDeps;
  let ids: number;

  beforeEach(() => {
    db = _createTestDb();
    seedParents(db);
    ids = 0;
    deps = {
      repo: createSpecDeliveryRepo(db),
      nextId: (kind) => `${kind}-${++ids}`,
      now: () => "2026-07-18T12:10:00.000Z",
      routeWaiverRequestToHuman: vi.fn(async () => ({
        attentionId: "attention-waiver",
      })),
      getCriterionVersion: vi.fn(async (revisionId) => ({
        specId: SPEC_ID,
        revisionNumber: revisionId === REVISION_ID ? 1 : 2,
        payloadHash:
          revisionId === REVISION_ID
            ? "criterion-hash-approved"
            : "criterion-hash-changed",
      })),
      wasCriterionDeliveredByMergedExecution: vi.fn(async () => false),
      recordMutation: vi.fn(),
      runInImmediateTransaction: (operation) => operation(),
    };
  });

  it("6.7 durably records the actual actor for evidence-surface mutations", async () => {
    const events = createSpecEventsRepo(db);
    const specsRepo = createSpecsRepo(db, createWriteQueue());
    const recorder = createEvidenceMutationRecorder({
      eventsRepo: events,
      events: createSpecEventsPublisher({
        appendInTransaction: events.appendInTransaction,
        publish: () => ({ delivered: true }),
      }),
      findSpecById: (targetSpecId) =>
        specsRepo.findByIdInTransaction(targetSpecId),
      runInImmediateTransaction: (operation) =>
        db.transaction(operation).immediate(),
    });
    deps.recordMutation = recorder.recordMutation;
    deps.runInImmediateTransaction = recorder.runInImmediateTransaction;
    const service = createEvidenceService(deps);

    await service.grantWaiver({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      actor: { kind: "human" },
      reason: "Human waiver reason",
    });
    deps.wasCriterionDeliveredByMergedExecution = vi.fn(async () => true);
    await service.setDisposition({
      executionId: EXECUTION_ID,
      criterionElementId: CRITERION_ID,
      disposition: "delivered_elsewhere",
      deliveredByExecutionId: PRIOR_EXECUTION_ID,
      actor: { kind: "agent", conversationId: "conversation-evidence" },
    });

    const actorsByKind = new Map(
      events
        .findBySpecId(SPEC_ID)
        .map((event) => [
          (JSON.parse(event.payload_json) as { kind: string }).kind,
          JSON.parse(event.actor_json) as unknown,
        ]),
    );
    expect(actorsByKind.get("waiver-granted")).toEqual({ kind: "human" });
    expect(actorsByKind.get("criterion-disposition-saved")).toEqual({
      kind: "agent",
      conversationId: "conversation-evidence",
    });
  });

  it("rolls back evidence mutations when provenance persistence fails", async () => {
    deps.recordMutation = () => {
      throw new Error("event persistence failed");
    };
    deps.runInImmediateTransaction = (operation) =>
      db.transaction(operation).immediate();
    const service = createEvidenceService(deps);

    await expect(
      service.grantWaiver({
        specId: SPEC_ID,
        criterionElementId: CRITERION_ID,
        revisionId: REVISION_ID,
        actor: { kind: "human" },
        reason: "Human waiver reason",
      }),
    ).rejects.toThrow("event persistence failed");
    expect(
      deps.repo.findWaiverForCriterionRevision(CRITERION_ID, REVISION_ID),
    ).toBeNull();
  });

  it("14.2 refuses an agent waiver attempt as a required human act", async () => {
    const service = createEvidenceService(deps);

    const result = await service.grantWaiver({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      actor: { kind: "agent", conversationId: "conversation-evidence" },
      reason: "The test environment is unavailable.",
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "human_act_required",
        instruction:
          "Ask a human to grant the waiver with a reason in Spec Studio.",
      },
    });
  });

  it("14.3 lets an agent route a waiver request to human attention without granting it", async () => {
    const service = createEvidenceService(deps);
    const source = {
      kind: "agent" as const,
      conversationId: "conversation-evidence",
    };

    const result = await service.requestWaiver({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      source,
      reason: "The external validation environment is unavailable.",
    });

    expect(deps.routeWaiverRequestToHuman).toHaveBeenCalledWith({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      source,
      reason: "The external validation environment is unavailable.",
    });
    expect(result).toEqual({
      ok: true,
      value: { attentionId: "attention-waiver" },
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM spec_waivers").get(),
    ).toEqual({ count: 0 });
  });

  it.each(["notify", "off"] as const)(
    "14.3 lets %s policy route a waiver request but not grant it",
    async (dial) => {
      const service = createEvidenceService(deps);
      const source = { kind: "policy" as const, dial };

      const result = await service.requestWaiver({
        specId: SPEC_ID,
        criterionElementId: CRITERION_ID,
        revisionId: REVISION_ID,
        source,
        reason: "Delivery needs a human exception decision.",
      });

      expect(deps.routeWaiverRequestToHuman).toHaveBeenCalledWith(
        expect.objectContaining({ source }),
      );
      expect(result).toEqual({
        ok: true,
        value: { attentionId: "attention-waiver" },
      });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM spec_waivers").get(),
      ).toEqual({ count: 0 });
    },
  );

  it("14.2 refuses a human waiver without a reason", async () => {
    const service = createEvidenceService(deps);

    const result = await service.grantWaiver({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      actor: { kind: "human" },
      reason: "  ",
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "validation",
        unmetConditions: ["A waiver requires a reason."],
      },
    });
  });

  it("14.2 records one terminal, reasoned waiver per criterion revision", async () => {
    const service = createEvidenceService(deps);
    const input = {
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      actor: { kind: "human" } as const,
      reason: "The external validation environment is unavailable.",
    };

    const granted = await service.grantWaiver(input);
    const duplicate = await service.grantWaiver(input);

    expect(granted).toMatchObject({
      ok: true,
      value: { stale: 0, reason: input.reason },
    });
    expect(duplicate).toMatchObject({
      ok: false,
      refusal: { code: "gate_blocked" },
    });
    expect(deps.recordMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        specId: SPEC_ID,
        kind: "waiver-granted",
        actor: { kind: "human" },
      }),
    );
  });

  it("forwards the waiver-granted notice only after a successful grant commits", async () => {
    const waiverGranted = vi.fn();
    deps.waiverNotifier = { waiverGranted };
    const service = createEvidenceService(deps);

    const refused = await service.grantWaiver({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      actor: { kind: "agent", conversationId: "conversation-evidence" },
      reason: "Agents cannot grant waivers.",
    });
    expect(refused.ok).toBe(false);
    expect(waiverGranted).not.toHaveBeenCalled();

    const granted = await service.grantWaiver({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      actor: { kind: "human" },
      reason: "The external validation environment is unavailable.",
    });
    if (!granted.ok) throw new Error("waiver was refused");
    expect(waiverGranted).toHaveBeenCalledTimes(1);
    expect(waiverGranted).toHaveBeenCalledWith({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      criterionHandle: null,
      revisionId: REVISION_ID,
      waiverId: granted.value.id,
      occurredAt: granted.value.waived_at,
    });
  });

  it("14.5 marks a waiver stale when the criterion changes in a later revision", async () => {
    const service = createEvidenceService(deps);
    const granted = await service.grantWaiver({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      actor: { kind: "human" },
      reason: "The external validation environment is unavailable.",
    });
    if (!granted.ok) throw new Error("waiver was refused");

    const result = await service.markWaiverStaleForCriterionChange({
      waiverId: granted.value.id,
      laterRevisionId: "revision-evidence-2",
      actor: { kind: "agent", conversationId: "conversation-evidence" },
    });

    expect(result).toMatchObject({ ok: true, value: { stale: 1 } });
    expect(deps.repo.findWaiverById(granted.value.id)?.stale).toBe(1);
    expect(deps.recordMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        specId: SPEC_ID,
        kind: "waiver-staled",
        actor: {
          kind: "agent",
          conversationId: "conversation-evidence",
        },
      }),
    );
  });

  it("16.8 refuses moving a selected criterion into deferred scope after start", async () => {
    const service = createEvidenceService(deps);

    const result = await service.setDisposition({
      executionId: EXECUTION_ID,
      criterionElementId: CRITERION_ID,
      disposition: "deferred",
      actor: { kind: "agent", conversationId: "conversation-evidence" },
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "amendment_required",
        unmetConditions: [
          `Criterion ${CRITERION_ID} is pinned in scope for execution ${EXECUTION_ID}.`,
        ],
      },
    });
    expect(deps.recordMutation).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "criterion-disposition-saved" }),
    );
  });

  it("16.8 refuses expanding a deferred criterion into selected scope after start", async () => {
    const service = createEvidenceService(deps);

    const result = await service.setDisposition({
      executionId: EXECUTION_ID,
      criterionElementId: OTHER_CRITERION_ID,
      disposition: "in_scope",
      actor: { kind: "agent", conversationId: "conversation-evidence" },
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "amendment_required",
        unmetConditions: [
          `Criterion ${OTHER_CRITERION_ID} is pinned deferred for execution ${EXECUTION_ID}.`,
        ],
      },
    });
  });

  it("14.4 and 16.8 refuse waiving a criterion excluded at execution start", async () => {
    const service = createEvidenceService(deps);
    const waiver = await service.grantWaiver({
      specId: SPEC_ID,
      criterionElementId: OTHER_CRITERION_ID,
      revisionId: REVISION_ID,
      actor: { kind: "human" },
      reason: "This waiver must not change an excluded criterion.",
    });
    if (!waiver.ok) throw new Error("waiver was refused");

    const result = await service.setDisposition({
      executionId: EXECUTION_ID,
      criterionElementId: OTHER_CRITERION_ID,
      disposition: "waived",
      waiverId: waiver.value.id,
      actor: { kind: "human" },
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "amendment_required",
        unmetConditions: [
          `Criterion ${OTHER_CRITERION_ID} is pinned deferred for execution ${EXECUTION_ID}.`,
        ],
      },
    });
  });

  it("14.4 and 16.8 refuse delivered-elsewhere for a criterion excluded at execution start", async () => {
    deps.wasCriterionDeliveredByMergedExecution = vi.fn(async () => true);
    const service = createEvidenceService(deps);

    const result = await service.setDisposition({
      executionId: EXECUTION_ID,
      criterionElementId: OTHER_CRITERION_ID,
      disposition: "delivered_elsewhere",
      deliveredByExecutionId: PRIOR_EXECUTION_ID,
      actor: { kind: "agent", conversationId: "conversation-evidence" },
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "amendment_required",
        unmetConditions: [
          `Criterion ${OTHER_CRITERION_ID} is pinned deferred for execution ${EXECUTION_ID}.`,
        ],
      },
    });
    expect(deps.wasCriterionDeliveredByMergedExecution).not.toHaveBeenCalled();
  });

  it("14.1 points a waived disposition at its human waiver", async () => {
    const service = createEvidenceService(deps);
    const waiver = await service.grantWaiver({
      specId: SPEC_ID,
      criterionElementId: CRITERION_ID,
      revisionId: REVISION_ID,
      actor: { kind: "human" },
      reason: "The external validation environment is unavailable.",
    });
    if (!waiver.ok) throw new Error("waiver was refused");

    const result = await service.setDisposition({
      executionId: EXECUTION_ID,
      criterionElementId: CRITERION_ID,
      disposition: "waived",
      waiverId: waiver.value.id,
      actor: { kind: "human" },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        disposition: "waived",
        waiver_id: waiver.value.id,
        delivered_by_execution_id: null,
      },
    });
  });

  it("14.6 refuses delivered-elsewhere without an earlier merged delivery", async () => {
    const service = createEvidenceService(deps);

    const result = await service.setDisposition({
      executionId: EXECUTION_ID,
      criterionElementId: CRITERION_ID,
      disposition: "delivered_elsewhere",
      deliveredByExecutionId: PRIOR_EXECUTION_ID,
      actor: { kind: "agent", conversationId: "conversation-evidence" },
    });

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: "validation",
        unmetConditions: [
          `Execution ${PRIOR_EXECUTION_ID} is not an earlier successfully merged delivery of criterion ${CRITERION_ID}.`,
        ],
      },
    });
  });

  it("14.6 records delivered-elsewhere after verifying earlier merged delivery", async () => {
    deps.wasCriterionDeliveredByMergedExecution = vi.fn(async () => true);
    const service = createEvidenceService(deps);

    const result = await service.setDisposition({
      executionId: EXECUTION_ID,
      criterionElementId: CRITERION_ID,
      disposition: "delivered_elsewhere",
      deliveredByExecutionId: PRIOR_EXECUTION_ID,
      actor: { kind: "agent", conversationId: "conversation-evidence" },
    });

    expect(deps.wasCriterionDeliveredByMergedExecution).toHaveBeenCalledWith({
      executionId: PRIOR_EXECUTION_ID,
      criterionElementId: CRITERION_ID,
      beforeExecutionId: EXECUTION_ID,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        disposition: "delivered_elsewhere",
        delivered_by_execution_id: PRIOR_EXECUTION_ID,
      },
    });
  });
});
