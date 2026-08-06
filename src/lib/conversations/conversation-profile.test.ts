import { describe, expect, it } from "vitest";
import {
  ConversationProfileLockedError,
  assertConversationProfileChangeAllowed,
  conversationProfileInstructionBlock,
  describeConversationProfile,
} from "./conversation-profile";
import {
  PROFILE_SECRET_SENTINEL,
  REDACTED_SNAPSHOT_FIXTURE,
  SNAPSHOT_FIXTURE,
  buildStoredConversation,
} from "./testing/profile-snapshot-fixtures";

describe("conversationProfileInstructionBlock — replay, never recompose", () => {
  it("returns the stored rendered block verbatim", () => {
    const conversation = buildStoredConversation({
      profileSnapshot: SNAPSHOT_FIXTURE,
    });
    expect(conversationProfileInstructionBlock(conversation)).toBe(
      SNAPSHOT_FIXTURE.renderedInstructionBlock,
    );
  });

  it("returns null for a legacy conversation, so its next turn gets no injection", () => {
    expect(conversationProfileInstructionBlock(buildStoredConversation())).toBe(
      null,
    );
  });
});

describe("describeConversationProfile — what a read surface may render", () => {
  it("describes a legacy conversation as no-profile", () => {
    expect(describeConversationProfile(buildStoredConversation())).toEqual({
      kind: "legacy",
    });
  });

  it("describes a profiled conversation with the redacted snapshot only", () => {
    const description = describeConversationProfile(
      buildStoredConversation({
        profileSnapshot: SNAPSHOT_FIXTURE,
        profileLockedAt: "2026-01-01T00:05:00.000Z",
      }),
    );

    expect(description).toEqual({
      kind: "profile",
      ref: "project:security-reviewer",
      snapshot: REDACTED_SNAPSHOT_FIXTURE,
      lockedAt: "2026-01-01T00:05:00.000Z",
    });
    expect(JSON.stringify(description)).not.toContain(PROFILE_SECRET_SENTINEL);
  });
});

describe("assertConversationProfileChangeAllowed", () => {
  it("allows a change before the conversation's first turn locks it", () => {
    expect(() =>
      assertConversationProfileChangeAllowed(
        buildStoredConversation({ profileSnapshot: SNAPSHOT_FIXTURE }),
      ),
    ).not.toThrow();
  });

  it("refuses once the profile is locked", () => {
    const locked = buildStoredConversation({
      profileSnapshot: SNAPSHOT_FIXTURE,
      profileLockedAt: "2026-01-01T00:05:00.000Z",
    });
    expect(() => assertConversationProfileChangeAllowed(locked)).toThrow(
      ConversationProfileLockedError,
    );
    try {
      assertConversationProfileChangeAllowed(locked);
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ConversationProfileLockedError);
      expect((err as ConversationProfileLockedError).reason).toBe("locked");
    }
  });

  it("refuses a legacy conversation with the same standard post-lock error", () => {
    const legacy = buildStoredConversation();
    try {
      assertConversationProfileChangeAllowed(legacy);
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ConversationProfileLockedError);
      expect((err as ConversationProfileLockedError).reason).toBe("legacy");
      // The refusal must never quote instruction text back at a caller.
      expect((err as Error).message).not.toContain(PROFILE_SECRET_SENTINEL);
    }
  });
});
