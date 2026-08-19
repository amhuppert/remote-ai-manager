import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildMaximalGraphPlanReview } from "@/lib/shared/testing/graph-plan-review-fixture";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createGraphPlanReviewsRepo } from "@/lib/state-store/graph-plan-reviews-repo";

import { createPlanReviewService, type PlanReviewService } from "./service";

const HASH = `sha256:${"3f".repeat(32)}`;
const OTHER_HASH = `sha256:${"b1".repeat(32)}`;

let fixture: PersistenceFixture;

/**
 * The service over a repository instance that never saw the writes — the
 * post-restart reader. Reading back through the writing repo would let an
 * in-memory value answer a question about durable state.
 */
function reloadedService(): PlanReviewService {
  return createPlanReviewService(createGraphPlanReviewsRepo(fixture.db));
}

function writingService(): PlanReviewService {
  return createPlanReviewService(createGraphPlanReviewsRepo(fixture.db));
}

beforeEach(() => {
  fixture = createPersistenceFixture();
});

afterEach(() => {
  fixture.close();
});

describe("findLatestTerminalReview", () => {
  it("returns null for a revision nobody has reviewed", () => {
    expect(reloadedService().findLatestTerminalReview(HASH)).toBeNull();
  });

  it("returns the most recent review of that exact revision after a reload", () => {
    const service = writingService();
    service.recordPlanReview(
      buildMaximalGraphPlanReview({
        id: "review-early",
        verdict: "approved",
        findings: null,
        reviewedAt: "2026-08-18T09:00:00.000Z",
      }),
    );
    service.recordPlanReview(
      buildMaximalGraphPlanReview({
        id: "review-late",
        findings: "Context 2 carries two unrelated outcomes.",
        reviewedAt: "2026-08-18T15:30:00.000Z",
      }),
    );

    const latest = reloadedService().findLatestTerminalReview(HASH);
    expect(latest?.id).toBe("review-late");
    expect(latest?.verdict).toBe("changes_requested");
    expect(latest?.findings).toBe("Context 2 carries two unrelated outcomes.");
  });

  it("never answers with a review of a different revision", () => {
    writingService().recordPlanReview(
      buildMaximalGraphPlanReview({ definitionHash: OTHER_HASH }),
    );

    expect(reloadedService().findLatestTerminalReview(HASH)).toBeNull();
  });

  it("resolves recency by instant, not by timestamp string order", () => {
    // `2026-08-18T12:00:00Z` sorts AFTER `2026-08-18T12:00:00.500Z` as text
    // ('Z' > '.'), so a lexicographic "last row wins" would name the earlier
    // review the latest one.
    const service = writingService();
    service.recordPlanReview(
      buildMaximalGraphPlanReview({
        id: "review-later-instant",
        reviewedAt: "2026-08-18T12:00:00.500Z",
      }),
    );
    service.recordPlanReview(
      buildMaximalGraphPlanReview({
        id: "review-earlier-instant",
        reviewedAt: "2026-08-18T12:00:00Z",
      }),
    );

    expect(reloadedService().findLatestTerminalReview(HASH)?.id).toBe(
      "review-later-instant",
    );
  });
});

/** A row the record schema refuses: a changes-requested verdict with no artifact. */
function seedUndecodableRow(reviewedAt: string): void {
  fixture.db
    .prepare(
      `INSERT INTO graph_plan_reviews (
         id, definition_hash, reviewer_conversation_id, verdict, findings,
         reviewed_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "review-corrupt",
      HASH,
      "conv-1",
      "changes_requested",
      null,
      reviewedAt,
    );
}

describe("findLatestTerminalReview fail-open", () => {
  it("answers unreviewed when the only stored row cannot be decoded", () => {
    seedUndecodableRow("2026-08-18T15:00:00.000Z");

    expect(reloadedService().findLatestTerminalReview(HASH)).toBeNull();
  });

  it("still finds a durable verdict stored beside an undecodable row", () => {
    // The revision HAS been reviewed. Letting one bad neighbour erase that
    // answer would report "unreviewed" for a plan carrying a real verdict.
    seedUndecodableRow("2026-08-18T08:00:00.000Z");
    writingService().recordPlanReview(
      buildMaximalGraphPlanReview({
        id: "review-valid",
        verdict: "approved",
        findings: null,
        reviewedAt: "2026-08-18T16:00:00.000Z",
      }),
    );

    expect(reloadedService().findLatestTerminalReview(HASH)?.id).toBe(
      "review-valid",
    );
  });

  it("answers unreviewed when the store cannot answer at all", () => {
    // A missing table is the store failing outright, not a bad row. The lookup
    // must still answer "unreviewed": an advisory record that can refuse a
    // create would be a new way for an execution to fail.
    const service = reloadedService();
    fixture.db.exec("DROP TABLE graph_plan_reviews");

    expect(service.findLatestTerminalReview(HASH)).toBeNull();
  });
});

describe("recordPlanReview", () => {
  it("persists a review a restarted reader can find", () => {
    writingService().recordPlanReview(buildMaximalGraphPlanReview());

    expect(reloadedService().findLatestTerminalReview(HASH)?.id).toBe(
      "review-7c1f0b3e-2a44-4e0d-9d51-8b6c2f0a1e73",
    );
  });

  it("refuses a changes-requested verdict with no findings artifact", () => {
    // The record schema makes it unrepresentable; the service must not smuggle
    // one past it into durable state.
    expect(() =>
      writingService().recordPlanReview({
        id: "review-artifactless",
        definitionHash: HASH,
        reviewerConversationId: "conv-1",
        verdict: "changes_requested",
        findings: null,
      } as never),
    ).toThrow();

    expect(reloadedService().findLatestTerminalReview(HASH)).toBeNull();
  });

  it("converges on an identical replay of the same review", () => {
    const service = writingService();
    service.recordPlanReview(buildMaximalGraphPlanReview());
    service.recordPlanReview(buildMaximalGraphPlanReview());

    expect(reloadedService().findLatestTerminalReview(HASH)?.id).toBe(
      "review-7c1f0b3e-2a44-4e0d-9d51-8b6c2f0a1e73",
    );
  });

  it("does not let a reused id rewrite the recorded verdict", () => {
    const service = writingService();
    service.recordPlanReview(
      buildMaximalGraphPlanReview({ findings: "Original findings." }),
    );
    service.recordPlanReview(
      buildMaximalGraphPlanReview({ verdict: "approved", findings: null }),
    );

    const latest = reloadedService().findLatestTerminalReview(HASH);
    expect(latest?.verdict).toBe("changes_requested");
    expect(latest?.findings).toBe("Original findings.");
  });
});
