// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { SpecDetailView } from "@/lib/specs/queries";

import {
  DraftBlocked,
  InReview,
  QuestionsAndAssumptions,
} from "./SpecDetailPage.stories";

function storyDetail(story: {
  args?: { detail?: SpecDetailView };
}): SpecDetailView {
  const detail = story.args?.detail;
  if (detail === undefined) throw new Error("Detail story fixture missing");
  return detail;
}

describe("Spec detail story fixtures", () => {
  it.each([
    ["in-review", InReview],
    ["questions", QuestionsAndAssumptions],
    ["draft", DraftBlocked],
  ])(
    "keeps the %s authoring lifecycle internally consistent",
    (_name, story) => {
      const detail = storyDetail(story);
      const current = detail.currentRevision?.revision;
      const approved = detail.currentApprovedRevision?.revision;

      expect(current?.authoringStage).toBe("plan");
      expect(["draft", "proposed"]).toContain(current?.state);
      expect(approved).toMatchObject({
        authoringStage: "design",
        state: "approved",
      });
      expect(detail.revisions).not.toContainEqual(
        expect.objectContaining({ authoringStage: "plan", state: "approved" }),
      );
      expect(current?.id).not.toBe(approved?.id);
      expect(
        detail.currentRevision?.elements.every(
          ({ version }) => version.revisionId === current?.id,
        ),
      ).toBe(true);
      expect(
        detail.currentApprovedRevision?.elements.every(
          ({ version }) => version.revisionId === approved?.id,
        ),
      ).toBe(true);
    },
  );
});
