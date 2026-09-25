// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { SpecDetailView } from "@/lib/specs/queries";

import {
  DraftBlocked,
  DraftUnderReview,
  OverviewGroupedThreads,
  OverviewReviewThreads,
  OverviewReviewThreadsMobile,
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
    ["draft-under-review", DraftUnderReview],
    ["questions", QuestionsAndAssumptions],
    ["draft", DraftBlocked],
  ])(
    "keeps the %s authoring lifecycle internally consistent",
    (_name, story) => {
      const detail = storyDetail(story);
      const current = detail.currentRevision?.revision;
      const approved = detail.currentApprovedRevision?.revision;

      expect(current?.authoringStage).toBe("design");
      expect(current?.state).toBe("draft");
      expect(detail.draftReview?.snapshot.revision.id).toBe(current?.id);
      expect(approved).toMatchObject({
        authoringStage: "requirements",
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

  it.each([
    ["desktop", OverviewReviewThreads],
    ["mobile", OverviewReviewThreadsMobile],
  ])(
    "keeps the %s Overview conversation on one current prose root",
    (_name, story) => {
      const detail = storyDetail(story);
      const current = detail.currentRevision?.revision;
      const roots = detail.comments.filter(
        ({ parentCommentId }) => parentCommentId === null,
      );

      expect(current?.state).toBe("draft");
      expect(roots).toHaveLength(1);
      expect(detail.comments).toHaveLength(2);
      expect(new Set(detail.comments.map(({ threadId }) => threadId))).toEqual(
        new Set(["overview-thread-1"]),
      );
      expect(roots[0]).toMatchObject({
        elementId: "section-intent",
        revisionId: current?.id,
      });
    },
  );

  it("keeps grouped Overview pins backed by two roots on the same current passage", () => {
    const detail = storyDetail(OverviewGroupedThreads);
    const roots = detail.comments.filter(
      ({ parentCommentId }) => parentCommentId === null,
    );

    expect(roots).toHaveLength(2);
    expect(new Set(roots.map(({ threadId }) => threadId))).toEqual(
      new Set(["overview-thread-1", "overview-thread-2"]),
    );
    expect(new Set(roots.map(({ elementId }) => elementId))).toEqual(
      new Set(["section-intent"]),
    );
    expect(new Set(roots.map(({ quote }) => quote))).toEqual(
      new Set(["Native spec-driven development"]),
    );
  });
});
