import { describe, expect, it, expectTypeOf } from "vitest";
import {
  conversationStateSchema,
  publicConversationStateSchema,
  storedConversationStateSchema,
  toPublicConversationState,
  toPublicConversationStates,
  type PublicConversationState,
  type StoredConversationState,
} from "./schemas";
import {
  conversationProfileInstructionBlock,
  describeConversationProfile,
} from "./conversation-profile";
import {
  BASE_CONVERSATION_FIELDS,
  PROFILE_SECRET_SENTINEL,
  REDACTED_SNAPSHOT_FIXTURE,
  SNAPSHOT_FIXTURE,
  buildStoredConversation,
} from "./testing/profile-snapshot-fixtures";

describe("stored conversation schema — the private snapshot", () => {
  it("is the schema the long-standing name resolves to, so repositories keep the private shape", () => {
    expect(storedConversationStateSchema).toBe(conversationStateSchema);
  });

  it("carries the full snapshot including instructions and the rendered block", () => {
    const stored = buildStoredConversation({
      profileSnapshot: SNAPSHOT_FIXTURE,
      profileLockedAt: "2026-01-01T00:05:00.000Z",
    });
    expect(stored.profileSnapshot).toEqual(SNAPSHOT_FIXTURE);
    expect(stored.profileLockedAt).toBe("2026-01-01T00:05:00.000Z");
  });

  it("preserves the explicit null every persisted row decodes to", () => {
    const stored = buildStoredConversation({ profileSnapshot: null });
    expect(stored.profileSnapshot).toBeNull();
    expect(stored.profileLockedAt).toBeNull();
  });

  it("reads as no-profile when the snapshot is absent as well as null", () => {
    for (const stored of [
      buildStoredConversation(),
      buildStoredConversation({ profileSnapshot: null }),
    ]) {
      expect(describeConversationProfile(stored)).toEqual({ kind: "legacy" });
      expect(conversationProfileInstructionBlock(stored)).toBeNull();
    }
  });
});

describe("public conversation schema — redacted by construction", () => {
  it("rejects the private snapshot field outright", () => {
    const result = publicConversationStateSchema.safeParse({
      ...BASE_CONVERSATION_FIELDS,
      profileSnapshot: SNAPSHOT_FIXTURE,
      profileLockedAt: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects instructions smuggled into the redacted snapshot", () => {
    for (const leaked of [
      "instructions",
      "renderedInstructionBlock",
    ] as const) {
      const result = publicConversationStateSchema.safeParse({
        ...BASE_CONVERSATION_FIELDS,
        redactedProfileSnapshot: {
          ...REDACTED_SNAPSHOT_FIXTURE,
          [leaked]: PROFILE_SECRET_SENTINEL,
        },
        profileLockedAt: null,
      });
      expect(result.success, `${leaked} must be rejected`).toBe(false);
    }
    // The refusal is instruction-specific, not a vacuous reject of the shape.
    expect(
      publicConversationStateSchema.safeParse({
        ...BASE_CONVERSATION_FIELDS,
        redactedProfileSnapshot: REDACTED_SNAPSHOT_FIXTURE,
        profileLockedAt: null,
      }).success,
    ).toBe(true);
  });

  it("rejects a top-level instruction field", () => {
    const result = publicConversationStateSchema.safeParse({
      ...BASE_CONVERSATION_FIELDS,
      renderedInstructionBlock: PROFILE_SECRET_SENTINEL,
    });
    expect(result.success).toBe(false);
  });

  it("proves at the type level that no instruction field exists on the public type", () => {
    expectTypeOf<PublicConversationState>().not.toHaveProperty(
      "profileSnapshot",
    );
    expectTypeOf<PublicConversationState>().not.toHaveProperty("instructions");
    expectTypeOf<PublicConversationState>().not.toHaveProperty(
      "renderedInstructionBlock",
    );
    type Redacted = NonNullable<
      PublicConversationState["redactedProfileSnapshot"]
    >;
    expectTypeOf<Redacted>().not.toHaveProperty("instructions");
    expectTypeOf<Redacted>().not.toHaveProperty("renderedInstructionBlock");
    // A stored conversation is not structurally a public one — it has no
    // `redactedProfileSnapshot` — so an egress typed public cannot be handed a
    // repository row and the projector is the only way across.
    expectTypeOf<StoredConversationState>().not.toHaveProperty(
      "redactedProfileSnapshot",
    );
  });
});

describe("toPublicConversationState — the one mandatory projector", () => {
  it("replaces the private snapshot with its redacted form", () => {
    const projected = toPublicConversationState(
      buildStoredConversation({
        profileSnapshot: SNAPSHOT_FIXTURE,
        profileLockedAt: "2026-01-01T00:05:00.000Z",
      }),
    );

    expect(projected.redactedProfileSnapshot).toEqual(
      REDACTED_SNAPSHOT_FIXTURE,
    );
    expect(projected.profileLockedAt).toBe("2026-01-01T00:05:00.000Z");
    expect(JSON.stringify(projected)).not.toContain(PROFILE_SECRET_SENTINEL);
  });

  it("keeps the legacy null snapshot null rather than inventing a profile", () => {
    const projected = toPublicConversationState(buildStoredConversation());
    expect(projected.redactedProfileSnapshot).toBeNull();
    expect(projected.profileLockedAt).toBeNull();
  });

  it("projects every conversation of a list", () => {
    const projected = toPublicConversationStates([
      buildStoredConversation({ id: "a", profileSnapshot: SNAPSHOT_FIXTURE }),
      buildStoredConversation({ id: "b" }),
    ]);
    expect(projected.map((c) => c.id)).toEqual(["a", "b"]);
    expect(JSON.stringify(projected)).not.toContain(PROFILE_SECRET_SENTINEL);
  });
});
