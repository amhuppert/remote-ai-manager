import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";

import { buildMaximalGraphPlanReview } from "@/lib/shared/testing/graph-plan-review-fixture";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { graphPlanReviewSchema } from "@/lib/workflows/plan-review/schemas";

import {
  createGraphPlanReviewsRepo,
  type GraphPlanReviewsRepo,
} from "./graph-plan-reviews-repo";
import { _createTestDb } from "./state-db";

type Db = InstanceType<typeof Database>;

const HASH = `sha256:${"3f".repeat(32)}`;
const OTHER_HASH = `sha256:${"b1".repeat(32)}`;

let db: Db;
let repo: GraphPlanReviewsRepo;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  repo = createGraphPlanReviewsRepo(db);
});

afterEach(() => {
  db.close();
});

describe("graph-plan-reviews-repo durability contract", () => {
  it("round-trips every persisted key path through record -> listByDefinitionHash", async () => {
    await assertRoundTripDurability({
      label: "graph-plan-review",
      schema: graphPlanReviewSchema,
      buildMaximalFixture: () => buildMaximalGraphPlanReview(),
      persist: (review) => {
        repo.record(review);
        return review;
      },
      // A repo instance that never saw the write — the post-restart read a
      // later create/replace actually performs.
      reload: (expected) =>
        createGraphPlanReviewsRepo(db)
          .listByDefinitionHash(expected.definitionHash)
          .at(-1) ?? null,
    });
  });

  it("returns an empty list for a hash no one has reviewed", () => {
    expect(repo.listByDefinitionHash(OTHER_HASH)).toEqual([]);
  });

  it("preserves a null findings artifact on an approved verdict", () => {
    repo.record(
      buildMaximalGraphPlanReview({ verdict: "approved", findings: null }),
    );

    const [reloaded] =
      createGraphPlanReviewsRepo(db).listByDefinitionHash(HASH);
    expect(reloaded?.verdict).toBe("approved");
    expect(reloaded?.findings).toBeNull();
  });
});

describe("graph-plan-reviews-repo hash keying", () => {
  it("keeps every review of one revision, oldest first", () => {
    repo.record(
      buildMaximalGraphPlanReview({
        id: "review-1",
        reviewedAt: "2026-08-18T09:00:00.000Z",
      }),
    );
    repo.record(
      buildMaximalGraphPlanReview({
        id: "review-2",
        verdict: "approved",
        findings: null,
        reviewedAt: "2026-08-18T11:00:00.000Z",
      }),
    );

    expect(
      createGraphPlanReviewsRepo(db)
        .listByDefinitionHash(HASH)
        .map((review) => review.id),
    ).toEqual(["review-1", "review-2"]);
  });

  it("orders by reviewedAt rather than by insertion order", () => {
    repo.record(
      buildMaximalGraphPlanReview({
        id: "review-late",
        reviewedAt: "2026-08-18T18:00:00.000Z",
      }),
    );
    repo.record(
      buildMaximalGraphPlanReview({
        id: "review-early",
        reviewedAt: "2026-08-18T06:00:00.000Z",
      }),
    );

    expect(
      createGraphPlanReviewsRepo(db)
        .listByDefinitionHash(HASH)
        .map((review) => review.id),
    ).toEqual(["review-early", "review-late"]);
  });

  it("never leaks a review of another revision into a scoped read", () => {
    repo.record(buildMaximalGraphPlanReview());
    repo.record(
      buildMaximalGraphPlanReview({
        id: "review-other",
        definitionHash: OTHER_HASH,
      }),
    );

    expect(
      createGraphPlanReviewsRepo(db)
        .listByDefinitionHash(OTHER_HASH)
        .map((review) => review.id),
    ).toEqual(["review-other"]);
  });

  it("quarantines an undecodable row without hiding its valid neighbours", () => {
    // A changes-requested verdict whose findings artifact is gone is a row the
    // schema refuses. Failing the whole read over it would make a revision that
    // carries a durable approved verdict read back as unreviewed.
    db.prepare(
      `INSERT INTO graph_plan_reviews (
         id, definition_hash, reviewer_conversation_id, verdict, findings,
         reviewed_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "review-corrupt",
      HASH,
      "conv-1",
      "changes_requested",
      null,
      "2026-08-18T08:00:00.000Z",
    );
    repo.record(
      buildMaximalGraphPlanReview({
        id: "review-valid",
        verdict: "approved",
        findings: null,
        reviewedAt: "2026-08-18T16:00:00.000Z",
      }),
    );

    expect(
      createGraphPlanReviewsRepo(db)
        .listByDefinitionHash(HASH)
        .map((review) => review.id),
    ).toEqual(["review-valid"]);
  });

  it("converges on a replayed record of the same review", () => {
    repo.record(buildMaximalGraphPlanReview());
    repo.record(buildMaximalGraphPlanReview());

    expect(
      createGraphPlanReviewsRepo(db).listByDefinitionHash(HASH),
    ).toHaveLength(1);
  });

  it("keeps the stored verdict when an id is reused with different content", () => {
    // Overwriting here would erase the earlier verdict — the audit gap this
    // table exists to close — so the first write stands and the second is
    // logged rather than applied.
    repo.record(
      buildMaximalGraphPlanReview({ findings: "Original findings." }),
    );
    repo.record(
      buildMaximalGraphPlanReview({
        verdict: "approved",
        findings: null,
        reviewedAt: "2026-08-19T09:00:00.000Z",
      }),
    );

    const reloaded = createGraphPlanReviewsRepo(db).listByDefinitionHash(HASH);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]?.verdict).toBe("changes_requested");
    expect(reloaded[0]?.findings).toBe("Original findings.");
    expect(reloaded[0]?.reviewedAt).toBe("2026-08-18T14:23:07.512Z");
  });

  it("keeps both verdicts when a second review is minted with a fresh id", () => {
    repo.record(
      buildMaximalGraphPlanReview({ findings: "Original findings." }),
    );
    repo.record(
      buildMaximalGraphPlanReview({
        id: "review-second-pass",
        verdict: "approved",
        findings: null,
        reviewedAt: "2026-08-19T09:00:00.000Z",
      }),
    );

    expect(
      createGraphPlanReviewsRepo(db)
        .listByDefinitionHash(HASH)
        .map((review) => review.verdict),
    ).toEqual(["changes_requested", "approved"]);
  });
});
