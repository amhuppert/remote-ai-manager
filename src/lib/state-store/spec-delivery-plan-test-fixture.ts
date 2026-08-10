import type Database from "better-sqlite3";
import {
  deliveryPlanDocumentSchema,
  deliveryPlanHash,
  type DeliveryPlanDocument,
} from "@/lib/specs/delivery-plan";
import {
  createSpecEventsPublisher,
  type SpecEventsPublisher,
} from "@/lib/specs/events";
import { stableStringify } from "./serialization";
import { createSpecEventsRepo } from "./spec-events-repo";
import { createSpecReviewRepo, type SpecReviewRepo } from "./spec-review-repo";
import {
  createSpecDeliveryPlanRepo,
  type ProposeDeliveryPlanCandidate,
  type SpecDeliveryPlanRepo,
} from "./spec-delivery-plan-repo";

type Db = InstanceType<typeof Database>;

/**
 * Shared seeding for the delivery-plan repo's tests: the spec, revision, and
 * execution rows its foreign keys point at, plus a representative plan
 * document. Kept out of the test files so the contract test and the behaviour
 * test agree on what "the same attempt" means.
 */

export const PROJECT_PATH = "/repos/delivery-plan";
export const SPEC_ID = "spec-delivery-plan";
export const PINNED_REVISION_ID = "revision-delivery-plan-pinned";
export const PRIOR_REVISION_ID = "revision-delivery-plan-prior";
export const EARLIER_EXECUTION_ID = "execution-delivery-plan-earlier";
export const LAUNCHED_EXECUTION_ID = "execution-delivery-plan-launched";

export function seedDeliveryPlanParents(db: Db): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SPEC_ID,
    PROJECT_PATH,
    "delivery-plan",
    "Delivery plan",
    '{"preset":"contract-bearing"}',
    "2026-08-07T08:00:00.000Z",
    "2026-08-07T08:00:00.000Z",
  );
  const insertRevision = db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, content_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertRevision.run(
    PRIOR_REVISION_ID,
    SPEC_ID,
    1,
    "approved",
    "sha256:prior",
    "2026-08-07T08:01:00.000Z",
  );
  insertRevision.run(
    PINNED_REVISION_ID,
    SPEC_ID,
    2,
    "approved",
    "sha256:pinned",
    "2026-08-07T08:02:00.000Z",
  );
  const insertExecution = db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, workflow_definition_id,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertExecution.run(
    EARLIER_EXECUTION_ID,
    SPEC_ID,
    PRIOR_REVISION_ID,
    "{}",
    "delivered",
    "workflow-definition-earlier",
    "2026-08-07T08:03:00.000Z",
    "2026-08-07T08:03:00.000Z",
  );
  insertExecution.run(
    LAUNCHED_EXECUTION_ID,
    SPEC_ID,
    PINNED_REVISION_ID,
    "{}",
    "running",
    "workflow-definition-launched",
    "2026-08-07T08:04:00.000Z",
    "2026-08-07T08:04:00.000Z",
  );
}

/**
 * A plan document with every field populated and no null leaf, so the
 * round-trip harness can descend into each collection.
 */
export function maximalPlanDocument(): DeliveryPlanDocument {
  return deliveryPlanDocumentSchema.parse({
    dispositions: [
      {
        criterionElementId: "criterion-reaffirmed",
        disposition: "reaffirmed",
        deliveredByExecutionId: EARLIER_EXECUTION_ID,
        reaffirmation: {
          actor: { kind: "human" },
          at: "2026-08-07T09:30:00.000Z",
          basisRevisionId: PRIOR_REVISION_ID,
          basis: [
            {
              elementId: "req-1",
              reason: "parent_requirement",
              baseHash: "req-1-a",
              currentHash: "req-1-b",
            },
          ],
        },
        note: "The parent requirement was reworded; the proof still holds.",
      },
      {
        criterionElementId: "criterion-selected",
        disposition: "selected",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
      },
    ],
    contexts: [
      {
        contextId: "ctx-store",
        title: "Repository and round trip",
        contextType: "delivery",
        criterionElementIds: ["criterion-selected"],
        acceptanceContract: [
          "An attempt round-trips through SQLite via its repository.",
        ],
        proofPlan: [
          {
            criterionElementId: "criterion-selected",
            evidenceKinds: ["validator_verdict"],
            note: "The maximal round-trip contract test is the proof.",
          },
        ],
      },
    ],
    tasks: [
      {
        taskId: "task-store",
        contextId: "ctx-store",
        title: "Write the repository",
        instructions: "Implement open, saveDraft, propose, and reopen.",
        order: 0,
        contributesToCriterionElementIds: ["criterion-selected"],
      },
    ],
    edges: [
      {
        edgeId: "edge-store-to-lint",
        fromContextId: "ctx-store",
        toContextId: "ctx-store",
      },
    ],
    wiring: [
      {
        capabilityId: "delivery-plan-repo",
        criterionElementIds: ["criterion-selected"],
        owner: {
          kind: "call_site",
          contextId: "ctx-store",
          locator: "src/lib/specs/service-factory.ts",
        },
      },
    ],
    policyOverrides: [
      {
        key: "validation.preMerge",
        value: "typecheck,lint",
        rationale: "The full suite runs once at closeout.",
      },
    ],
    touchedSurfaces: ["src/lib/state-store/"],
    governance: {
      mission: "Persist the delivery plan attempt and prove it round-trips.",
      charterInvariants: [
        {
          id: "durability-contracts",
          statement:
            "Every persisted field lands with repository mapping and round-trip coverage.",
        },
      ],
      sourcesOfTruth: [
        {
          rank: 1,
          id: "final-design",
          label: "Final agreed design",
          type: "document",
          locator: "command-center#47 attachment f7b542c4",
          description: "Section 4 owns the document shape.",
          appliesTo: "every context",
          accessPolicy: "external-readonly",
        },
      ],
      validationCommandNames: ["typecheck"],
    },
  });
}

/**
 * The compiled candidate a propose carries. The repository stores the compiled
 * bytes opaquely, so the fixture states a representative definition rather than
 * running the materializer: what these tests prove is that the candidate lands
 * atomically with its snapshot and survives a reload, not how it was compiled.
 * The plan hash is real, because the repository checks it.
 */
export function candidateFor(
  document: DeliveryPlanDocument,
  input: {
    readonly draftRevision: number;
    readonly id?: string;
    readonly pinnedRevisionId?: string;
    readonly compiledDefinitionHash?: string;
  },
): ProposeDeliveryPlanCandidate {
  const definition = {
    schemaVersion: 1,
    charter: { mission: "Fixture", sourcesOfTruth: [] },
    executionContexts: [],
    tasks: [],
    edges: [],
  };
  return {
    id: input.id ?? "candidate-delivery-plan",
    compiledDefinitionHash:
      input.compiledDefinitionHash ?? `sha256:${"c".repeat(64)}`,
    definitionJson: stableStringify(definition),
    planHash: deliveryPlanHash({
      pinnedRevisionId: input.pinnedRevisionId ?? PINNED_REVISION_ID,
      draftRevision: input.draftRevision,
      document,
    }),
  };
}

export interface DeliveryPlanTestRepos {
  readonly plans: SpecDeliveryPlanRepo;
  /** The approval + gate-admission writer a plan sign-off goes through. */
  readonly review: SpecReviewRepo;
  readonly events: SpecEventsPublisher;
  countEvents(eventType: string): number;
  readEventPayload(eventType: string): unknown;
}

export function createDeliveryPlanTestRepos(db: Db): DeliveryPlanTestRepos {
  const eventsRepo = createSpecEventsRepo(db);
  const plans = createSpecDeliveryPlanRepo(db, {
    appendEvent: (event) => eventsRepo.appendInTransaction(event),
  });
  const events = createSpecEventsPublisher({
    appendInTransaction: (event) => eventsRepo.appendInTransaction(event),
    // The publication seam is out of scope here: these fixtures prove what
    // lands in SQLite, and a real publish would reach the process-wide bus.
    publish: () => ({ delivered: true }),
  });
  return {
    plans,
    review: createSpecReviewRepo(db),
    events,
    countEvents(eventType) {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS total FROM spec_events WHERE event_type = ?",
        )
        .get(eventType) as { total: number };
      return row.total;
    },
    readEventPayload(eventType) {
      const row = db
        .prepare(
          "SELECT payload_json FROM spec_events WHERE event_type = ? ORDER BY id DESC LIMIT 1",
        )
        .get(eventType) as { payload_json: string } | undefined;
      return row === undefined ? null : JSON.parse(row.payload_json);
    },
  };
}
