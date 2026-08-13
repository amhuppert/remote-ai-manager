import { describe, expect, it } from "vitest";

import { GET as projectSearchGET } from "@/app/api/specs/[name]/-/search/route";
import { GET as inventoryGET } from "@/app/api/specs/[name]/route";
import { GET as commentsGET } from "@/app/api/specs/[name]/[slug]/comments/route";
import { GET as deltaGET } from "@/app/api/specs/[name]/[slug]/delta/route";
import { GET as diffGET } from "@/app/api/specs/[name]/[slug]/diff/route";
import { GET as editContextGET } from "@/app/api/specs/[name]/[slug]/edit-context/route";
import { GET as planGET } from "@/app/api/specs/[name]/[slug]/plan/route";
import { GET as planDiffGET } from "@/app/api/specs/[name]/[slug]/plan/diff/route";
import { GET as planReviewGET } from "@/app/api/specs/[name]/[slug]/plan/review/route";
import {
  GET as planAttemptPreviewGET,
  POST as planPreviewPOST,
} from "@/app/api/specs/[name]/[slug]/plan-preview/route";
import {
  specCommentsGET,
  specDeltaGET,
  specDiffGET,
  specEditContextGET,
  specPlanAttemptPreviewGET,
  specPlanDiffGET,
  specPlanGET,
  specPlanPreviewPOST,
  specPlanReviewGET,
  specProjectSearchGET,
  specsInventoryGET,
} from "@/lib/specs/route-handlers";

/**
 * A handler that is exported, tested and reachable through a hand-built router
 * is still dead in the running app until a route file mounts it. These pin the
 * mount itself: a missing file fails at import, and a mount wired to the wrong
 * handler fails on identity.
 */
describe("spec API route mounting", () => {
  // Project-scoped reads live under the `-` segment because a bare static
  // sibling of [slug] would shadow a spec whose slug is that same word, and
  // `-` cannot be a slug (CANONICAL_SLUG requires alphanumeric edges).
  it("mounts project-wide search, which the CLI reaches at /api/specs/<project>/-/search", () => {
    expect(projectSearchGET).toBe(specProjectSearchGET);
  });

  it("mounts the project inventory", () => {
    expect(inventoryGET).toBe(specsInventoryGET);
  });

  it("mounts the edit-context read the CLI write path uses instead of a full detail fetch", () => {
    expect(editContextGET).toBe(specEditContextGET);
  });

  it("mounts the review-comment read behind `cctl spec comments`", () => {
    expect(commentsGET).toBe(specCommentsGET);
  });

  it("mounts the semantic diff the reviewer changelog reads", () => {
    expect(diffGET).toBe(specDiffGET);
  });

  it("mounts the delivery-delta projection the CLI and Studio panel both read", () => {
    expect(deltaGET).toBe(specDeltaGET);
  });

  it("mounts the delivery-plan attempt read behind `cctl spec plan get/status`", () => {
    expect(planGET).toBe(specPlanGET);
  });

  it("mounts the delivery-plan review projection the Studio attempt surface reads", () => {
    expect(planReviewGET).toBe(specPlanReviewGET);
  });

  it("mounts the snapshot-to-snapshot plan diff the Studio review surface reads", () => {
    expect(planDiffGET).toBe(specPlanDiffGET);
  });

  // POST because the preview's request carries an execution scope document;
  // it reads only, so it sits on the read handlers rather than the actions route.
  it("mounts the compiled-plan preview the CLI reaches at .../plan-preview", () => {
    expect(planPreviewPOST).toBe(specPlanPreviewPOST);
  });

  // Same resource, different question: GET reads the delivery-plan ATTEMPT's
  // compiled shape (query-string stage), POST compiles a scope document.
  it("mounts the delivery-plan attempt preview behind `cctl spec plan preview --stage`", () => {
    expect(planAttemptPreviewGET).toBe(specPlanAttemptPreviewGET);
  });
});
