import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createGraphPlanReviewsRepo } from "@/lib/state-store/graph-plan-reviews-repo";
import { createWorkflowDefinitionRecord } from "@/lib/workflow-graph/test-fixtures";

import {
  createPlanReviewRouteHandlers,
  type PlanReviewRouteDeps,
} from "./route-handlers";
import type { ReviewerConversationResolver } from "./reviewer-conversation";
import { createPlanReviewService } from "./service";
import { planReviewStatusResponseSchema } from "./status-schemas";

/**
 * The routes run over the REAL repository against a real SQLite file, and every
 * read goes through a repository instance that never saw the write. A JS fake
 * would let an in-memory value answer a question about durable state, which is
 * the only question a "record then reload" test is asking.
 */
let fixture: PersistenceFixture;

const REVIEWER_ID = "conv-reviewer-1";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    "http://localhost/api/projects/repo/workflows/reviews",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

function makeContext(name = "repo") {
  return { params: Promise.resolve({ name }) };
}

function makePlan(overrides: Record<string, unknown> = {}) {
  const record = createWorkflowDefinitionRecord();
  return {
    name: "Review Me",
    description: "a plan under review",
    definition: record.definition,
    layout: record.layout,
    ...overrides,
  };
}

const resolvedReviewer: ReviewerConversationResolver = {
  async resolve() {
    return { found: true, hasCompaction: false };
  },
};

function makeDeps(
  overrides: Partial<PlanReviewRouteDeps> = {},
): PlanReviewRouteDeps {
  let seq = 0;
  return {
    resolveProjectPath: async (name) => (name === "repo" ? "/repo" : null),
    // A fresh repository per call: the status handler reads through an instance
    // that never performed the write.
    reviews: () =>
      createPlanReviewService(createGraphPlanReviewsRepo(fixture.db)),
    reviewerConversation: resolvedReviewer,
    newReviewId: () => `review-${++seq}`,
    now: () => "2026-08-18T12:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  fixture = createPersistenceFixture();
});

afterEach(() => {
  fixture.close();
});

describe("plan review RECORD route", () => {
  it("persists a review the status route reloads from durable state", async () => {
    const handlers = createPlanReviewRouteHandlers(makeDeps());
    const plan = makePlan();

    const recorded = await handlers.RECORD(
      makeRequest({
        plan,
        verdict: "changes_requested",
        findings: "Context 2 carries two unrelated outcomes.",
        reviewerConversationId: REVIEWER_ID,
      }),
      makeContext(),
    );
    expect(recorded.status).toBe(201);
    const recordedBody: unknown = await recorded.json();
    expect(recordedBody).toMatchObject({
      verdict: "changes_requested",
      reviewerConversationId: REVIEWER_ID,
      reviewedAt: "2026-08-18T12:00:00.000Z",
    });

    const status = await handlers.STATUS(makeRequest({ plan }), makeContext());
    expect(status.status).toBe(200);
    const parsed = planReviewStatusResponseSchema.parse(await status.json());
    expect(parsed.status).toMatchObject({
      state: "changes_requested",
      reviewerConversationId: REVIEWER_ID,
      reviewedAt: "2026-08-18T12:00:00.000Z",
      findings: "Context 2 carries two unrelated outcomes.",
    });
  });

  it("refuses a changes_requested verdict with no findings artifact", async () => {
    const handlers = createPlanReviewRouteHandlers(makeDeps());

    const response = await handlers.RECORD(
      makeRequest({
        plan: makePlan(),
        verdict: "changes_requested",
        reviewerConversationId: REVIEWER_ID,
      }),
      makeContext(),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain("findings");
  });

  it("404s an unknown project rather than recording against it", async () => {
    const handlers = createPlanReviewRouteHandlers(makeDeps());
    const response = await handlers.RECORD(
      makeRequest({
        plan: makePlan(),
        verdict: "approved",
        reviewerConversationId: REVIEWER_ID,
      }),
      makeContext("missing"),
    );
    expect(response.status).toBe(404);
  });

  it("refuses a plan the shared validation rejects, with located issues", async () => {
    const handlers = createPlanReviewRouteHandlers(makeDeps());
    const response = await handlers.RECORD(
      makeRequest({
        plan: { name: "", definition: {}, layout: {} },
        verdict: "approved",
        reviewerConversationId: REVIEWER_ID,
      }),
      makeContext(),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues?: unknown[] };
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues?.length).toBeGreaterThan(0);
  });
});

describe("plan review STATUS route", () => {
  it("answers unreviewed for a revision nobody reviewed, echoing the hash", async () => {
    const handlers = createPlanReviewRouteHandlers(makeDeps());
    const response = await handlers.STATUS(
      makeRequest({ plan: makePlan() }),
      makeContext(),
    );

    expect(response.status).toBe(200);
    const parsed = planReviewStatusResponseSchema.parse(await response.json());
    expect(parsed.status.state).toBe("unreviewed");
    expect(parsed.status.definitionHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("binds the review to canonical CONTENT, not to submitted key order", async () => {
    const handlers = createPlanReviewRouteHandlers(makeDeps());
    const plan = makePlan();
    await handlers.RECORD(
      makeRequest({
        plan,
        verdict: "approved",
        reviewerConversationId: REVIEWER_ID,
      }),
      makeContext(),
    );

    // The same document, re-keyed: a review bound to one encoding of a revision
    // must be found by the other.
    const reordered = {
      layout: plan.layout,
      definition: plan.definition,
      description: plan.description,
      name: plan.name,
    };
    const response = await handlers.STATUS(
      makeRequest({ plan: reordered }),
      makeContext(),
    );
    const parsed = planReviewStatusResponseSchema.parse(await response.json());
    expect(parsed.status.state).toBe("approved");
  });

  it("carries the compaction command only when a completed compaction exists", async () => {
    const compacted = createPlanReviewRouteHandlers(
      makeDeps({
        reviewerConversation: {
          async resolve() {
            return { found: true, hasCompaction: true };
          },
        },
      }),
    );
    const plan = makePlan();
    await compacted.RECORD(
      makeRequest({
        plan,
        verdict: "approved",
        reviewerConversationId: REVIEWER_ID,
      }),
      makeContext(),
    );

    const withCompaction = planReviewStatusResponseSchema.parse(
      await (
        await compacted.STATUS(makeRequest({ plan }), makeContext())
      ).json(),
    );
    if (withCompaction.status.state === "unreviewed") {
      throw new Error("expected a reviewed status");
    }
    expect(
      withCompaction.status.reviewer.commands.map((c) => c.command),
    ).toEqual([
      `cctl conversation compaction get ${REVIEWER_ID} --json`,
      `cctl conversation read ${REVIEWER_ID} --outline`,
    ]);

    const plain = createPlanReviewRouteHandlers(makeDeps());
    const withoutCompaction = planReviewStatusResponseSchema.parse(
      await (await plain.STATUS(makeRequest({ plan }), makeContext())).json(),
    );
    if (withoutCompaction.status.state === "unreviewed") {
      throw new Error("expected a reviewed status");
    }
    expect(
      withoutCompaction.status.reviewer.commands.map((c) => c.command),
    ).toEqual([`cctl conversation read ${REVIEWER_ID} --outline`]);
  });

  it("degrades to the bare id with a note when the reviewer cannot be resolved", async () => {
    const handlers = createPlanReviewRouteHandlers(
      makeDeps({
        reviewerConversation: {
          async resolve() {
            throw new Error("conversation store unavailable");
          },
        },
      }),
    );
    const plan = makePlan();
    await handlers.RECORD(
      makeRequest({
        plan,
        verdict: "approved",
        reviewerConversationId: REVIEWER_ID,
      }),
      makeContext(),
    );

    const response = await handlers.STATUS(
      makeRequest({ plan }),
      makeContext(),
    );

    expect(response.status).toBe(200);
    const parsed = planReviewStatusResponseSchema.parse(await response.json());
    if (parsed.status.state === "unreviewed") {
      throw new Error("expected a reviewed status");
    }
    expect(parsed.status.reviewer.resolved).toBe(false);
    expect(parsed.status.reviewer.note).not.toBeNull();
    expect(parsed.status.reviewer.commands).toHaveLength(1);
  });
});
