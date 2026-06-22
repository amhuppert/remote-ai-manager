import { describe, expect, it } from "vitest";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";

describe("mcp-gateway/planner-draft-registry", () => {
  it("stores and consumes submitted drafts", async () => {
    const {
      createPlannerDraftSubmission,
      submitPlannerDraft,
      consumePlannerDraft,
      deletePlannerDraft,
    } = await import("./planner-draft-registry");

    const { draftId } = createPlannerDraftSubmission();
    const definition = {
      schemaVersion: 1,
      workflowConfig: {},
      charter: makeTestCharter(),
      parameters: [],
      prerequisites: [],
      executionContexts: [],
      tasks: [],
      edges: [],
    };

    submitPlannerDraft(draftId, definition);

    expect(consumePlannerDraft(draftId)).toEqual(definition);
    deletePlannerDraft(draftId);
  });

  it("returns null for unknown drafts", async () => {
    const { consumePlannerDraft } = await import("./planner-draft-registry");

    expect(consumePlannerDraft("missing")).toBeNull();
  });

  it("removes expired drafts during cleanup", async () => {
    const {
      createPlannerDraftSubmission,
      consumePlannerDraft,
      cleanupExpiredPlannerDrafts,
    } = await import("./planner-draft-registry");

    const { draftId } = createPlannerDraftSubmission();
    cleanupExpiredPlannerDrafts(Date.now() + 16 * 60 * 1000);

    expect(consumePlannerDraft(draftId)).toBeNull();
  });
});
