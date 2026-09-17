import { describe, expect, it } from "vitest";

import { POST as recordPOST } from "@/app/api/projects/[name]/workflows/reviews/route";
import { POST as statusPOST } from "@/app/api/projects/[name]/workflows/reviews/status/route";
import {
  getWorkflowPlanReviewStatus,
  recordWorkflowPlanReview,
} from "@/lib/workflows/route-handlers";

/**
 * A handler that is exported and tested is still dead in the running app until
 * a route file mounts it. These pin the mount itself: a missing file fails at
 * import, and a mount wired to the wrong handler fails on identity.
 */
describe("plan review API route mounting", () => {
  // `reviews` is a static sibling of `[workflowId]`, which Next.js resolves in
  // its favour — the same shape `generate` already has in this directory. It
  // can never shadow a real definition: workflow ids are minted by randomUUID.
  it("mounts the record route the `cctl workflow review record --verdict` path posts to", () => {
    expect(recordPOST).toBe(recordWorkflowPlanReview);
  });

  it("mounts the status route `cctl workflow review get` reads", () => {
    expect(statusPOST).toBe(getWorkflowPlanReviewStatus);
  });
});
