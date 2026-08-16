import type Database from "better-sqlite3";
import {
  deliveryPlanDocumentSchema,
  type DeliveryPlanDocument,
} from "@/lib/specs/delivery-plan";
import {
  createSpecEventsPublisher,
  type SpecEventsPublisher,
} from "@/lib/specs/events";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import { createSpecEventsRepo } from "./spec-events-repo";
import { createSpecReviewRepo, type SpecReviewRepo } from "./spec-review-repo";
import {
  createSpecDeliveryPlanRepo,
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
    schemaVersion: 2,
    launch: {
      name: "Fixture launch",
      description: "Fixture launch.",
      definition: {
        schemaVersion: 2,
        workflowConfig: {
          implementer: {
            id: "fixture-implementer",
            profile: { tier: "builtin", id: "general-implementer" },
            focus: "Persist fixture launch configuration",
            agent: {
              backend: "claude",
              model: "opus",
              reasoningEffort: "high",
            },
          },
          contextValidator: {
            enabled: false,
            assignments: [
              {
                id: "fixture-reviewer",
                profile: { tier: "builtin", id: "general-reviewer" },
                focus: "Review fixture launch configuration",
                strategy: "conversation",
                authority: "blocking",
                agent: {
                  backend: "claude",
                  model: "sonnet",
                  reasoningEffort: "medium",
                },
                continuity: { enabled: false, contextLimitTokens: 110_000 },
              },
            ],
          },
          scriptValidator: { commands: ["typecheck", "test"] },
          iterationPolicy: {
            maxIterations: 9,
            continuity: { enabled: false, contextLimitTokens: 80_000 },
          },
          circuitBreaker: { consecutiveFailureThreshold: 4 },
          mutability: {
            allowAgentTaskAdd: true,
            allowAgentContextAdd: true,
          },
          planRepair: {
            enabled: false,
            maxAttemptsPerContext: 3,
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
          },
          collaboration: {
            enabled: true,
            secondAgent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "low",
            },
            negotiationRounds: 3,
            autonomousResolutionThreshold: "major",
          },
          humanApprovalGate: { enabled: true },
          askUserQuestions: { enabled: true },
          agentValidation: {
            implementer: { mode: "all", except: ["format"] },
            contextValidator: { mode: "only", commands: ["test"] },
          },
          laneMergeValidation: {
            strategy: "every-merge",
            commands: { mode: "only", commands: ["typecheck"] },
          },
        },
        charter: makeTestCharter(),
        parameters: [
          {
            type: "string",
            name: "fixture-input",
            label: "Fixture input",
            required: true,
            default: "value",
            minLength: 1,
            maxLength: 32,
          },
          {
            type: "text",
            name: "fixture-notes",
            label: "Fixture notes",
            required: false,
            default: "Persist this complete authored launch.",
            minLength: 1,
            maxLength: 200,
          },
          {
            type: "enum",
            name: "fixture-mode",
            label: "Fixture mode",
            required: true,
            options: ["safe", "fast"],
            default: "safe",
          },
        ],
        prerequisites: [
          {
            kind: "path",
            path: "src",
            label: "Fixture source path",
          },
          {
            kind: "skill",
            skill: "fixture-skill",
            backend: "codex",
            label: "Fixture skill prerequisite",
          },
        ],
        executionContexts: [
          {
            id: "fixture-context",
            title: "Fixture context",
            description: "Persists every launch definition field.",
            acceptanceCriteria: "The fixture persists.",
            placement: {
              lane: "fixture",
              mode: "owned",
              ownedPaths: ["src/fixture"],
            },
            outputSchema: {
              type: "object",
              properties: { result: { type: "string" } },
              required: ["result"],
            },
            routing: { cardinality: "atLeastOne" },
            implementer: {
              id: "fixture-context-implementer",
              profile: { tier: "project", id: "fixture-profile" },
              focus: "Persist context configuration",
              agent: {
                backend: "claude",
                model: "opus",
                reasoningEffort: "high",
              },
            },
            contextValidator: {
              enabled: false,
              assignments: [
                {
                  id: "fixture-context-reviewer",
                  profile: { tier: "project", id: "fixture-reviewer" },
                  focus: "Review context configuration",
                  strategy: "task",
                  authority: "blocking",
                  agent: {
                    backend: "codex",
                    model: "gpt-5.4",
                    reasoningEffort: "high",
                  },
                  continuity: {
                    enabled: false,
                    contextLimitTokens: 60_000,
                  },
                },
              ],
            },
            scriptValidator: { commands: ["typecheck"] },
            mutability: {
              allowAgentTaskAdd: true,
              allowAgentContextAdd: true,
            },
            circuitBreaker: { consecutiveFailureThreshold: 5 },
            iterationPolicy: {
              maxIterations: 7,
              continuity: { enabled: false, contextLimitTokens: 90_000 },
            },
            planRepair: {
              enabled: false,
              maxAttemptsPerContext: 4,
              agent: {
                backend: "claude",
                model: "opus",
                reasoningEffort: "low",
              },
            },
            collaboration: {
              enabled: true,
              secondAgent: {
                backend: "claude",
                model: "opus",
                reasoningEffort: "high",
              },
              negotiationRounds: 2,
              autonomousResolutionThreshold: "minor",
            },
            humanApprovalGate: { enabled: true },
            askUserQuestions: { enabled: true },
            agentValidation: {
              implementer: { mode: "only", commands: ["typecheck", "test"] },
              contextValidator: { mode: "all", except: ["format"] },
            },
            origin: {
              sourceUri: "fixture://delivery-plan-launch/context",
              label: "Fixture context source",
            },
            metadata: { fixture: "context" },
          },
          {
            id: "fixture-followup",
            title: "Fixture follow-up",
            acceptanceCriteria: "The fixture follows up.",
            placement: { lane: "fixture-followup", mode: "readOnly" },
          },
          {
            id: "fixture-fallback",
            title: "Fixture fallback",
            acceptanceCriteria: "The fixture fallback remains available.",
            placement: { lane: "fixture-fallback", mode: "full" },
          },
        ],
        tasks: [
          {
            id: "fixture-task",
            contextId: "fixture-context",
            order: 1,
            title: "Persist the fixture",
            instructions: "Persist all fixture fields.",
            metadata: { fixture: "launch" },
            source: "agent",
          },
        ],
        edges: [
          {
            id: "fixture-edge",
            sourceContextId: "fixture-context",
            targetContextId: "fixture-followup",
            when: {
              schema: {
                type: "object",
                properties: { result: { const: "persisted" } },
                required: ["result"],
              },
            },
          },
          {
            id: "fixture-edge-fallback",
            sourceContextId: "fixture-context",
            targetContextId: "fixture-fallback",
            when: { else: true },
          },
        ],
        loopGroups: [
          {
            id: "fixture-loop",
            title: "Fixture loop",
            bodyContextIds: ["fixture-context", "fixture-followup"],
            entryContextId: "fixture-context",
            exitContextId: "fixture-followup",
            until: {
              schema: {
                type: "object",
                properties: { result: { const: "persisted" } },
                required: ["result"],
              },
            },
            maxPasses: 2,
          },
        ],
      },
      layout: {
        workflowId: "fixture-delivery-plan-launch",
        contextPositions: {
          "fixture-context": { x: 1, y: 2 },
          "fixture-followup": { x: 5, y: 6 },
          "fixture-fallback": { x: 9, y: 10 },
        },
        viewport: { x: 3, y: 4, zoom: 1.5 },
      },
    },
    binding: {
      dispositions: [
        {
          criterionElementId: "criterion-reaffirmed",
          disposition: "delivered_elsewhere",
          deliveredByExecutionId: EARLIER_EXECUTION_ID,
        },
        {
          criterionElementId: "criterion-selected",
          disposition: "in_scope",
          deliveredByExecutionId: null,
        },
      ],
      claims: [
        {
          contextId: "fixture-context",
          criterionElementIds: ["criterion-selected"],
        },
      ],
    },
  });
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
