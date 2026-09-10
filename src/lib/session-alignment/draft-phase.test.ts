import { describe, expect, it } from "vitest";
import { alignmentDraftPhase } from "@/lib/session-alignment/draft-phase";
import type { AlignmentVersion } from "@/lib/session-alignment/schemas";

function makeDraft(
  overrides: Partial<AlignmentVersion> = {},
): AlignmentVersion {
  return {
    id: "draft-1",
    version: null,
    content: "Mission: stay aligned.",
    contentHash: "hash-1",
    status: "draft",
    source: "align_rerun",
    authorConversationId: "conv-1",
    autoActivate: false,
    linkedDecisionIds: [],
    createdAt: "2026-06-26T00:00:00.000Z",
    activatedAt: null,
    approver: null,
    ...overrides,
  };
}

describe("alignmentDraftPhase", () => {
  it("has no phase when no draft is open", () => {
    expect(alignmentDraftPhase(null)).toBeNull();
    expect(alignmentDraftPhase(undefined)).toBeNull();
  });

  it("treats an unfilled /align row as authoring, not the user's to resolve", () => {
    expect(
      alignmentDraftPhase(makeDraft({ content: "", contentHash: "" })),
    ).toBe("authoring");
    expect(alignmentDraftPhase(makeDraft({ content: "   \n\t " }))).toBe(
      "authoring",
    );
  });

  it("treats a filled manual draft as awaiting the user's approval", () => {
    expect(alignmentDraftPhase(makeDraft())).toBe("awaiting_approval");
  });

  it("treats an auto-activating decision draft as incorporating, filled or not", () => {
    const decision = { source: "decision" as const, autoActivate: true };
    expect(alignmentDraftPhase(makeDraft(decision))).toBe("incorporating");
    expect(
      alignmentDraftPhase(
        makeDraft({ ...decision, content: "", contentHash: "" }),
      ),
    ).toBe("incorporating");
  });
});
