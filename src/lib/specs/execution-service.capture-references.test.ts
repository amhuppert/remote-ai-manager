import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

import { createSpecEventsPublisher } from "./events";
import {
  createExecutionService,
  type ExecutionService,
  type ExecutionWorkflowDefinitions,
} from "./execution-service";
import type { TaskElementPayload } from "./schemas";

const PROJECT_PATH = "/repos/native-sdd-capture";
const SPEC_ID = "spec-capture";
const REVISION_ID = "revision-approved";
const EXECUTION_ID = "execution-running";
const NOW = "2026-07-30T10:00:00.000Z";

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
let idSequence: Map<string, number>;

function discoveredTask(
  scope: Partial<
    Pick<
      TaskElementPayload,
      | "tracedRequirementElementIds"
      | "tracedDecisionElementIds"
      | "coveredCriterionElementIds"
      | "dependsOnTaskElementIds"
    >
  > = {},
): Omit<TaskElementPayload, "kind"> {
  return {
    title: "Implement the discovered prerequisite",
    instructions: "Add the prerequisite in a future execution.",
    tracedRequirementElementIds: scope.tracedRequirementElementIds ?? [],
    tracedDecisionElementIds: scope.tracedDecisionElementIds ?? [],
    coveredCriterionElementIds: scope.coveredCriterionElementIds ?? [],
    dependsOnTaskElementIds: scope.dependsOnTaskElementIds ?? [],
  };
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
    "native-sdd-capture",
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
        text: "Capture writes a task or nothing at all.",
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
       workflow_execution_id, session_name, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    "workflow-execution-1",
    "session-capture",
    NOW,
    NOW,
  );
}

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  seedSpec();
  idSequence = new Map();

  const eventsRepo = createSpecEventsRepo(fixture.db);
  service = createExecutionService({
    specsRepo: fixture.specs,
    deliveryRepo: createSpecDeliveryRepo(fixture.db),
    linksRepo: createSpecLinksRepo(fixture.db),
    eventsRepo,
    reviewRepo: createSpecReviewRepo(fixture.db),
    events: createSpecEventsPublisher({
      appendInTransaction: eventsRepo.appendInTransaction,
      publish: () => ({ delivered: true }),
    }),
    workflowDefinitions: unusedWorkflowDefinitions,
    writeQueue: createWriteQueue(),
    ingestExecutionEvidence: async () => undefined,
    sessionExists: async () => true,
    getWorkflowExecutionStatus: async () => null,
    getPublishedMerge: async () => null,
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

function reloadedDraftElementIds(): string[] {
  return fixture.db
    .prepare(
      `SELECT element_id FROM spec_element_versions
       WHERE revision_id != ? ORDER BY element_id`,
    )
    .all(REVISION_ID)
    .map((row) => elementIdOf(row));
}

function elementIdOf(row: unknown): string {
  if (
    typeof row === "object" &&
    row !== null &&
    "element_id" in row &&
    typeof row.element_id === "string"
  ) {
    return row.element_id;
  }
  throw new Error("unexpected spec_element_versions row shape");
}

function capturedEventCount(): number {
  const row: unknown = fixture.db
    .prepare(
      `SELECT COUNT(*) AS count FROM spec_events
       WHERE payload_json LIKE '%scope_amendment_captured%'`,
    )
    .get();
  if (
    typeof row === "object" &&
    row !== null &&
    "count" in row &&
    typeof row.count === "number"
  ) {
    return row.count;
  }
  throw new Error("unexpected count row shape");
}

describe("captureScopeAmendment reference guard", () => {
  it("leaves no draft, no task and no event behind when the discovered task covers a criterion the revision does not carry", async () => {
    const captured = await service.captureScopeAmendment({
      executionId: EXECUTION_ID,
      actor: { kind: "agent", conversationId: "conversation-discovery" },
      discoveredTask: discoveredTask({
        coveredCriterionElementIds: ["criterion-vanished"],
      }),
    });

    expect(captured).toMatchObject({
      ok: false,
      refusal: { code: "dangling_reference" },
    });
    if (captured.ok) throw new Error("expected the capture to be refused");
    expect(captured.refusal.details?.references).toEqual([
      {
        code: "missing_target",
        sourceElementId: "element-1",
        field: "coveredCriterionElementIds",
        index: 0,
        targetId: "criterion-vanished",
        expectedKind: "criterion",
        actualKind: null,
        relation: "covers",
      },
    ]);

    await expect(
      fixture.specs.findDraftRevisionBySpecId(SPEC_ID),
    ).resolves.toBeNull();
    expect(reloadedDraftElementIds()).toEqual([]);
    await expect(fixture.specs.findElement("element-1")).resolves.toBeNull();
    expect(capturedEventCount()).toBe(0);
  });

  it("captures a discovered task whose references the pinned revision carries", async () => {
    const captured = await service.captureScopeAmendment({
      executionId: EXECUTION_ID,
      actor: { kind: "agent", conversationId: "conversation-discovery" },
      discoveredTask: discoveredTask({
        tracedRequirementElementIds: ["requirement-1"],
        coveredCriterionElementIds: ["criterion-1"],
      }),
    });

    if (!captured.ok) throw new Error("expected the capture to succeed");
    const draft = await fixture.specs.findDraftRevisionBySpecId(SPEC_ID);
    expect(draft?.id).toBe(captured.value.revision.id);
    expect(reloadedDraftElementIds()).toEqual([
      "criterion-1",
      "element-1",
      "requirement-1",
    ]);
    expect(capturedEventCount()).toBe(1);
  });

  it("keeps empty id arrays legal at capture time", async () => {
    const captured = await service.captureScopeAmendment({
      executionId: EXECUTION_ID,
      actor: { kind: "agent", conversationId: "conversation-discovery" },
      discoveredTask: discoveredTask(),
    });

    expect(captured.ok).toBe(true);
    expect(reloadedDraftElementIds()).toContain("element-1");
  });
});
