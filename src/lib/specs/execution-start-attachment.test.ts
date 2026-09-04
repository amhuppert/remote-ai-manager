import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";

import { createSpecDeliveryPlanRepo } from "@/lib/state-store/spec-delivery-plan-repo";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecExecutionBindingRepo } from "@/lib/state-store/spec-execution-binding-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { stableStringify } from "@/lib/state-store/serialization";
import {
  createCapturingLogger,
  type CapturingLogger,
} from "@/lib/shared/testing/capturing-logger";
import { createSpecEventsPublisher } from "./events";
import { prepareSpecExecutionStartAttachment } from "./execution-start-attachment";
import type { Spec } from "./schemas";

type Db = InstanceType<typeof Database>;

const SPEC_ID = "spec-start-attachment";
const REVISION_ID = "revision-start-attachment";
const ATTEMPT_ID = "attempt-start-attachment";
const SNAPSHOT_ID = "snapshot-start-attachment";
const CANDIDATE_ID = "candidate-start-attachment";
const CANDIDATE_HASH = `sha256:${"c".repeat(64)}`;
const SPEC_EXECUTION_ID = "spec-execution-start-attachment";
const WORKFLOW_EXECUTION_ID = "workflow-execution-start-attachment";
const NOW = "2026-08-15T13:00:00.000Z";

let db: Db;

const spec: Spec = {
  id: SPEC_ID,
  projectPath: "/repo/spec-start-attachment",
  slug: "spec-start-attachment",
  name: "Spec start attachment",
  gatePolicy: { preset: "contract-bearing" },
  abandonedAt: null,
  abandonedReason: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function seedParents(): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(
    spec.projectPath,
  );
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SPEC_ID,
    spec.projectPath,
    spec.slug,
    spec.name,
    stableStringify(spec.gatePolicy),
    NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, created_at
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(REVISION_ID, SPEC_ID, 1, "approved", NOW);
  db.prepare(
    `INSERT INTO spec_elements (
       id, spec_id, kind, number, parent_element_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("criterion-start-attachment", SPEC_ID, "criterion", 1, null, NOW);
  db.prepare(
    `INSERT INTO spec_delivery_plan_attempts (
       id, spec_id, pinned_revision_id, status, draft_revision, content_json,
       proposed_snapshot_id, approval_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ATTEMPT_ID,
    SPEC_ID,
    REVISION_ID,
    "approved",
    1,
    "{}",
    SNAPSHOT_ID,
    stableStringify({
      snapshotId: SNAPSHOT_ID,
      candidateId: CANDIDATE_ID,
      candidateHash: CANDIDATE_HASH,
      approvedAt: NOW,
      approvedBy: { kind: "human" },
    }),
    NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO spec_delivery_plan_snapshots (
       id, attempt_id, candidate_id, candidate_hash, draft_revision,
       content_json, pinned_revision_id, proposed_at, proposed_by_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SNAPSHOT_ID,
    ATTEMPT_ID,
    CANDIDATE_ID,
    CANDIDATE_HASH,
    1,
    "{}",
    REVISION_ID,
    NOW,
    stableStringify({ kind: "agent", conversationId: "conversation-plan" }),
  );
}

type AttachmentWriteBoundary =
  | "execution"
  | "disposition"
  | "binding"
  | "link"
  | "attempt-transition"
  | "execution-event";

function prepare(failAt?: AttachmentWriteBoundary, log?: CapturingLogger) {
  const eventRows = createSpecEventsRepo(db);
  const deliveryRepo = createSpecDeliveryRepo(db);
  const bindingRepo = createSpecExecutionBindingRepo(db);
  const linksRepo = createSpecLinksRepo(db);
  const deliveryPlans = createSpecDeliveryPlanRepo(db, {
    appendEvent: (event) => eventRows.appendInTransaction(event),
  });
  const fail = (boundary: AttachmentWriteBoundary) => {
    if (boundary === failAt) throw new Error(`fault: ${boundary}`);
  };
  return prepareSpecExecutionStartAttachment(
    {
      deliveryRepo: {
        insertExecution(row) {
          fail("execution");
          deliveryRepo.insertExecution(row);
        },
        saveCriterionDisposition(row) {
          fail("disposition");
          deliveryRepo.saveCriterionDisposition(row);
        },
      },
      bindingRepo: {
        insert(input) {
          fail("binding");
          return bindingRepo.insert(input);
        },
      },
      linksRepo: {
        insertLink(link) {
          fail("link");
          linksRepo.insertLink(link);
        },
      },
      plansRepo: {
        findAttemptById: (attemptId) =>
          deliveryPlans.findAttemptById(attemptId),
        recordTransition(input) {
          fail("attempt-transition");
          return deliveryPlans.recordTransition(input);
        },
      },
      events: {
        appendInTransaction(input) {
          fail("execution-event");
          return createSpecEventsPublisher({
            appendInTransaction: (event) =>
              eventRows.appendInTransaction(event),
          }).appendInTransaction(input);
        },
      },
      nextLinkId: () => "link-start-attachment",
      ...(log === undefined ? {} : { log }),
    },
    {
      spec,
      specExecutionId: SPEC_EXECUTION_ID,
      attemptId: ATTEMPT_ID,
      sessionName: "session-start-attachment",
      executionStartDial: "gate",
      scope: {
        selectedTaskIds: [],
        selectedCriterionIds: ["criterion-start-attachment"],
        exclusionDispositions: [],
      },
      origin: {
        kind: "spec_delivery",
        specSlug: spec.slug,
        candidateId: CANDIDATE_ID,
      },
      workflowDefinition: {
        id: CANDIDATE_ID,
        revision: 3,
      },
      binding: {
        schemaVersion: 2,
        candidateId: CANDIDATE_ID,
        candidateHash: CANDIDATE_HASH,
        pinnedRevisionId: REVISION_ID,
        dispositions: [
          {
            criterionElementId: "criterion-start-attachment",
            disposition: "in_scope",
            deliveredByExecutionId: null,
          },
        ],
        claims: [
          {
            contextId: "implement-start-attachment",
            criterionElementIds: ["criterion-start-attachment"],
          },
        ],
      },
      actor: {
        kind: "agent",
        conversationId: "conversation-start-attachment",
      },
      createdAt: NOW,
    },
  );
}

function plansRepo() {
  const eventRows = createSpecEventsRepo(db);
  return createSpecDeliveryPlanRepo(db, {
    appendEvent: (event) => eventRows.appendInTransaction(event),
  });
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedParents();
});

afterEach(() => {
  db.close();
});

describe("spec one-off execution transaction attachment", () => {
  // #80 design 3.10: this is the production launch path — a real `cctl spec
  // start` records its launch here — so the catalogued attempt-transition
  // event has to be emitted from it, not from a sibling with no caller.
  it("emits spec.plan.attempt.transition for the launch it records", () => {
    const log = createCapturingLogger();
    const prepared = prepare(undefined, log);
    db.transaction(() => {
      prepared.attach({ executionId: WORKFLOW_EXECUTION_ID });
    }).immediate();

    expect(
      log.entries.filter(
        (entry) => entry.message === "spec.plan.attempt.transition",
      ),
    ).toEqual([
      {
        level: "info",
        message: "spec.plan.attempt.transition",
        fields: {
          slug: spec.slug,
          from: "approved",
          to: "launched",
          actor: "agent",
        },
      },
    ]);
  });

  it("carries the actor kind only — never the conversation that launched", () => {
    const log = createCapturingLogger();
    const prepared = prepare(undefined, log);
    db.transaction(() => {
      prepared.attach({ executionId: WORKFLOW_EXECUTION_ID });
    }).immediate();

    expect(JSON.stringify(log.allFieldValues())).not.toContain(
      "conversation-start-attachment",
    );
  });

  it("emits no transition line when the launch write is rolled back", () => {
    const log = createCapturingLogger();
    const prepared = prepare("execution-event", log);
    expect(() =>
      db
        .transaction(() => {
          prepared.attach({ executionId: WORKFLOW_EXECUTION_ID });
        })
        .immediate(),
    ).toThrow("fault: execution-event");

    expect(
      log.entries.filter(
        (entry) => entry.message === "spec.plan.attempt.transition",
      ),
    ).toEqual([]);
  });

  it("commits the spec execution, frozen binding, typed link, dispositions, audit link, event, and attempt transition together", () => {
    const prepared = prepare();
    db.transaction(() => {
      prepared.attach({ executionId: WORKFLOW_EXECUTION_ID });
    }).immediate();

    expect(
      createSpecDeliveryRepo(db).findExecutionById(SPEC_EXECUTION_ID),
    ).toMatchObject({
      workflow_execution_id: WORKFLOW_EXECUTION_ID,
      workflow_execution_binding_json: null,
      state: "definition_review",
      workflow_definition_id: CANDIDATE_ID,
      workflow_definition_revision: 3,
    });
    expect(
      createSpecExecutionBindingRepo(db).requireByWorkflowExecutionId(
        WORKFLOW_EXECUTION_ID,
        {
          specExecutionId: SPEC_EXECUTION_ID,
          candidateId: CANDIDATE_ID,
          candidateHash: CANDIDATE_HASH,
          pinnedRevisionId: REVISION_ID,
        },
      ).binding,
    ).toEqual({
      schemaVersion: 2,
      candidateId: CANDIDATE_ID,
      candidateHash: CANDIDATE_HASH,
      pinnedRevisionId: REVISION_ID,
      dispositions: [
        {
          criterionElementId: "criterion-start-attachment",
          disposition: "in_scope",
          deliveredByExecutionId: null,
        },
      ],
      claims: [
        {
          contextId: "implement-start-attachment",
          criterionElementIds: ["criterion-start-attachment"],
        },
      ],
    });
    expect(plansRepo().findAttemptById(ATTEMPT_ID)).toMatchObject({
      status: "launched",
      launched_execution_id: SPEC_EXECUTION_ID,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS total FROM spec_links").get(),
    ).toEqual({ total: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS total FROM spec_events").get(),
    ).toEqual({ total: 2 });
  });

  it("rolls every attached row and the attempt transition back when the surrounding graph transaction fails", () => {
    const prepared = prepare();
    expect(() =>
      db
        .transaction(() => {
          prepared.attach({ executionId: WORKFLOW_EXECUTION_ID });
          throw new Error("fault: graph commit");
        })
        .immediate(),
    ).toThrow("fault: graph commit");

    expect(
      db.prepare("SELECT COUNT(*) AS total FROM spec_executions").get(),
    ).toEqual({ total: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS total FROM spec_execution_bindings").get(),
    ).toEqual({ total: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS total FROM spec_links").get(),
    ).toEqual({ total: 0 });
    expect(plansRepo().findAttemptById(ATTEMPT_ID)).toMatchObject({
      status: "approved",
      launched_execution_id: null,
    });
  });

  it.each<AttachmentWriteBoundary>([
    "execution",
    "disposition",
    "binding",
    "link",
    "attempt-transition",
    "execution-event",
  ])("rolls back when the %s write fails before commit", (boundary) => {
    const prepared = prepare(boundary);
    expect(() =>
      db
        .transaction(() => {
          prepared.attach({ executionId: WORKFLOW_EXECUTION_ID });
        })
        .immediate(),
    ).toThrow(`fault: ${boundary}`);

    expect(
      db.prepare("SELECT COUNT(*) AS total FROM spec_executions").get(),
    ).toEqual({ total: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS total FROM spec_execution_bindings").get(),
    ).toEqual({ total: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS total FROM spec_links").get(),
    ).toEqual({ total: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS total FROM spec_events").get(),
    ).toEqual({ total: 0 });
    expect(plansRepo().findAttemptById(ATTEMPT_ID)).toMatchObject({
      status: "approved",
      launched_execution_id: null,
    });
  });
});
