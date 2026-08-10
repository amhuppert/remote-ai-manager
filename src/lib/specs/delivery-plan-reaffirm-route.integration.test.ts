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

import type Database from "better-sqlite3";

import type { AgentAuth } from "@/lib/agent-gateway/token";
import { createSpecDeliveryPlanRepo } from "@/lib/state-store/spec-delivery-plan-repo";
import {
  createDeliveryPlanTestRepos,
  EARLIER_EXECUTION_ID,
  PINNED_REVISION_ID,
  PRIOR_REVISION_ID,
  PROJECT_PATH,
  seedDeliveryPlanParents,
  SPEC_ID,
} from "@/lib/state-store/spec-delivery-plan-test-fixture";
import { _createTestDb } from "@/lib/state-store/state-db";
import { deliveryDeltaProjectionSchema } from "./delivery-delta";
import {
  createDeliveryPlanService,
  type DeliveryPlanCompilationContext,
  type DeliveryPlanService,
} from "./delivery-plan-service";
import {
  createSpecWriteRouteHandlers,
  SPEC_CALLER_BACKEND_HEADER,
  SPEC_CALLER_CONVERSATION_HEADER,
  type SpecMutationServices,
} from "./route-handlers";
import type {
  ActorProvenance,
  Spec,
  SpecRevisionElement,
  SpecRevisionSnapshot,
} from "./schemas";

type Db = InstanceType<typeof Database>;
type Plans = ReturnType<typeof createSpecDeliveryPlanRepo>;
type WriteHandlers = ReturnType<typeof createSpecWriteRouteHandlers>;

const SPEC: Spec = {
  id: SPEC_ID,
  projectPath: PROJECT_PATH,
  slug: "delivery-plan",
  name: "Delivery plan",
  gatePolicy: { preset: "contract-bearing" },
  abandonedAt: null,
  abandonedReason: null,
  createdAt: "2026-08-07T08:00:00.000Z",
  updatedAt: "2026-08-07T08:00:00.000Z",
};

const AGENT = {
  kind: "agent",
  conversationId: "conversation-reaffirm-route",
  backend: "codex",
} as const satisfies ActorProvenance;

const CRITERION_ID = "criterion-soft-stale";
const REQUIREMENT_ID = "requirement-parent";
const REAFFIRM_EVENT = "spec-delivery-plan-reaffirmed";

function pinnedElement(
  id: string,
  kind: SpecRevisionElement["element"]["kind"],
  number: number,
  parentElementId: string | null,
  position: number,
  payload: SpecRevisionElement["version"]["payload"],
): SpecRevisionElement {
  return {
    element: {
      id,
      specId: SPEC_ID,
      kind,
      number,
      parentElementId,
      createdAt: "2026-08-07T08:02:00.000Z",
    },
    version: {
      revisionId: PINNED_REVISION_ID,
      elementId: id,
      position,
      payload,
      payloadHash: `hash-${id}`,
      elementVersion: 1,
      createdAt: "2026-08-07T08:02:00.000Z",
      updatedAt: "2026-08-07T08:02:00.000Z",
    },
  };
}

function pinnedSnapshot(): SpecRevisionSnapshot {
  return {
    revision: {
      id: PINNED_REVISION_ID,
      specId: SPEC_ID,
      number: 2,
      state: "approved",
      authoringStage: "design",
      basedOnRevisionId: PRIOR_REVISION_ID,
      contentHash: "sha256:pinned",
      proposedAt: "2026-08-07T08:01:30.000Z",
      approvedAt: "2026-08-07T08:02:00.000Z",
      createdAt: "2026-08-07T08:01:00.000Z",
    },
    elements: [
      pinnedElement(REQUIREMENT_ID, "requirement", 1, null, 0, {
        kind: "requirement",
        statement: "The reviewed delivery remains valid after rewording.",
        priority: "must",
        risk: "medium",
      }),
      pinnedElement(CRITERION_ID, "criterion", 1, REQUIREMENT_ID, 1, {
        kind: "criterion",
        text: "The delivered behavior remains observable.",
        validationStrategy: { kinds: ["validator_verdict"] },
      }),
    ],
  };
}

function deliveryDelta() {
  return deliveryDeltaProjectionSchema.parse({
    specSlug: SPEC.slug,
    current: { revisionId: PINNED_REVISION_ID, revisionNumber: 2 },
    base: { revisionId: PRIOR_REVISION_ID, revisionNumber: 1 },
    comparedExecution: {
      executionId: EARLIER_EXECUTION_ID,
      revisionId: PRIOR_REVISION_ID,
      state: "delivered",
      deliveredAt: "2026-08-07T08:03:30.000Z",
    },
    elements: [],
    criteria: [
      {
        criterionElementId: CRITERION_ID,
        handle: "R1.1",
        class: "soft_stale",
        priorDisposition: "in_scope",
        freshness: {
          grade: "soft_stale",
          basis: [
            {
              elementId: REQUIREMENT_ID,
              kind: "requirement",
              handle: "R1",
              reason: "parent_requirement",
              baseHash: "requirement-before",
              currentHash: "requirement-after",
            },
          ],
        },
      },
    ],
    advisories: [],
    counts: {
      elements: { added: 0, amended: 0, unchanged: 0, removed: 0 },
      criteria: {
        delivered_and_fresh: 0,
        soft_stale: 1,
        hard_stale: 0,
        never_delivered: 0,
        deferred: 0,
        waived: 0,
      },
    },
  });
}

function compilationContext(): DeliveryPlanCompilationContext {
  return {
    criteria: [
      {
        criterionElementId: CRITERION_ID,
        handle: "R1.1",
        text: "The delivered behavior remains observable.",
        validationStrategy: { kinds: ["validator_verdict"] },
      },
    ],
    registeredValidationCommandNames: ["test"],
    defaults: {
      approvalRequired: true,
      workflowConfig: {
        mutability: {
          allowAgentTaskAdd: false,
          allowAgentContextAdd: false,
        },
      },
    },
  };
}

const auth: AgentAuth = {
  async requireToken(request) {
    const resolution = await this.validateOptionalToken(request);
    return resolution.kind === "valid"
      ? null
      : Response.json({ error: "Invalid token" }, { status: 401 });
  },
  async validateOptionalToken(request) {
    const authorization = request.headers.get("authorization");
    if (authorization === null) return { kind: "absent" };
    return authorization === "Bearer valid"
      ? { kind: "valid" }
      : { kind: "invalid" };
  },
};

interface World {
  db: Db;
  events: ReturnType<typeof createDeliveryPlanTestRepos>;
  createService(plans?: Plans): DeliveryPlanService;
  createHandlers(service: DeliveryPlanService): WriteHandlers;
}

function createWorld(): World {
  const db = _createTestDb();
  seedDeliveryPlanParents(db);
  const events = createDeliveryPlanTestRepos(db);
  let idSequence = 0;
  let clockSequence = 0;

  function createService(plans: Plans = events.plans): DeliveryPlanService {
    return createDeliveryPlanService({
      plans,
      reviewRepo: events.review,
      events: events.events,
      runInTransaction: <T>(operation: () => T): T =>
        db.transaction(operation).immediate(),
      currentApprovedRevision: async () => pinnedSnapshot(),
      revisionSnapshot: async (revisionId) =>
        revisionId === PINNED_REVISION_ID ? pinnedSnapshot() : null,
      deliveryDelta: async () => ({
        ok: true,
        projection: deliveryDelta(),
      }),
      latestLegacyDeliverySource: async () => null,
      capturedDiscoveries: async () => [],
      classifyDeliveredElsewhere: () => ({
        code: "accepted",
        baseExecutionId: EARLIER_EXECUTION_ID,
      }),
      compilationContext: async () => compilationContext(),
      nextId: () => `reaffirm-route-${++idSequence}`,
      now: () =>
        `2026-08-08T10:${String(++clockSequence).padStart(2, "0")}:00.000Z`,
    });
  }

  function createHandlers(service: DeliveryPlanService): WriteHandlers {
    return createSpecWriteRouteHandlers({
      auth,
      resolveProjectPath: async (name) =>
        name === "command-center" ? PROJECT_PATH : null,
      resolveSpec: async (projectPath, slug) =>
        projectPath === PROJECT_PATH && slug === SPEC.slug ? SPEC : null,
      getServices: async () =>
        ({ deliveryPlan: service }) as unknown as SpecMutationServices,
    });
  }

  return { db, events, createService, createHandlers };
}

async function openReaffirmableAttempt(service: DeliveryPlanService) {
  const opened = await service.open({
    spec: SPEC,
    seedFromLast: true,
    actor: AGENT,
  });
  if (!opened.ok) throw new Error(`plan open refused: ${opened.refusal.code}`);
  expect(opened.value.document.dispositions).toEqual([
    expect.objectContaining({
      criterionElementId: CRITERION_ID,
      disposition: "pending_reaffirmation",
    }),
  ]);
  return opened.value.attempt;
}

function postReaffirm(
  handlers: WriteHandlers,
  transport: "agent" | "human",
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (transport === "agent") {
    headers.authorization = "Bearer valid";
    headers[SPEC_CALLER_CONVERSATION_HEADER] = AGENT.conversationId;
    headers[SPEC_CALLER_BACKEND_HEADER] = "codex";
  }
  const request = new Request(
    `http://cc.test/api/specs/command-center/${SPEC.slug}/actions/plan-reaffirm`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ criterionElementId: CRITERION_ID }),
    },
  );
  return handlers.specActionPOST(request, {
    params: Promise.resolve({
      name: "command-center",
      slug: SPEC.slug,
      action: "plan-reaffirm",
    }),
  });
}

function readAttempt(db: Db, attemptId: string) {
  return db
    .prepare(
      `SELECT draft_revision, content_json
         FROM spec_delivery_plan_attempts
        WHERE id = ?`,
    )
    .get(attemptId) as { draft_revision: number; content_json: string };
}

let world: World;

beforeEach(() => {
  world = createWorld();
});

afterEach(() => {
  world.db.close();
});

describe("delivery-plan reaffirmation through the production spec action route", () => {
  it("refuses agent transport, then records the human act and its audit event together", async () => {
    const service = world.createService();
    const attempt = await openReaffirmableAttempt(service);
    const handlers = world.createHandlers(service);
    const before = readAttempt(world.db, attempt.id);

    const agentResponse = await postReaffirm(handlers, "agent");
    const agentBody = (await agentResponse.json()) as {
      code?: string;
      instruction?: string;
    };

    expect(agentResponse.status).toBe(403);
    expect(agentBody.code).toBe("human_act_required");
    expect(agentBody.instruction).toContain("Spec Studio");
    expect(readAttempt(world.db, attempt.id)).toEqual(before);
    expect(world.events.countEvents(REAFFIRM_EVENT)).toBe(0);

    const humanResponse = await postReaffirm(handlers, "human");
    const humanBody = (await humanResponse.json()) as {
      document?: { dispositions?: unknown[] };
    };

    expect(humanResponse.status).toBe(200);
    expect(humanBody.document?.dispositions).toEqual([
      expect.objectContaining({
        criterionElementId: CRITERION_ID,
        disposition: "reaffirmed",
        reaffirmation: expect.objectContaining({
          actor: { kind: "human" },
          basisRevisionId: PINNED_REVISION_ID,
          basis: [
            expect.objectContaining({
              elementId: REQUIREMENT_ID,
              baseHash: "requirement-before",
              currentHash: "requirement-after",
            }),
          ],
        }),
      }),
    ]);
    const persisted = readAttempt(world.db, attempt.id);
    expect(persisted.draft_revision).toBe(before.draft_revision + 1);
    expect(JSON.parse(persisted.content_json)).toMatchObject({
      dispositions: [
        {
          criterionElementId: CRITERION_ID,
          disposition: "reaffirmed",
          reaffirmation: { actor: { kind: "human" } },
        },
      ],
    });
    const event = world.db
      .prepare(
        `SELECT actor_json, payload_json
           FROM spec_events
          WHERE event_type = ?`,
      )
      .get(REAFFIRM_EVENT) as {
      actor_json: string;
      payload_json: string;
    };
    expect(JSON.parse(event.actor_json)).toEqual({ kind: "human" });
    expect(JSON.parse(event.payload_json)).toMatchObject({
      attemptId: attempt.id,
      criterionElementId: CRITERION_ID,
      pinnedRevisionId: PINNED_REVISION_ID,
      basisRevisionId: PINNED_REVISION_ID,
      draftRevision: before.draft_revision + 1,
    });
  });

  it("rolls the attempt edit back when the audit append fails", async () => {
    const service = world.createService();
    const attempt = await openReaffirmableAttempt(service);
    const before = readAttempt(world.db, attempt.id);
    const failingPlans = createSpecDeliveryPlanRepo(world.db, {
      appendEvent: () => {
        throw new Error("reaffirm audit unavailable");
      },
    });
    const failingHandlers = world.createHandlers(
      world.createService(failingPlans),
    );

    const response = await postReaffirm(failingHandlers, "human");

    expect(response.status).toBe(500);
    expect(readAttempt(world.db, attempt.id)).toEqual(before);
    expect(world.events.countEvents(REAFFIRM_EVENT)).toBe(0);
  });
});
