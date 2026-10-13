import { describe, expect, it } from "vitest";
import {
  isEligibleOwner,
  type OwnerEligibilityFacts,
} from "./owner-eligibility";
import { isEligibleSubscriptionRecipient } from "./provenance";
import { conversationStateSchema } from "./schemas";

const ordinary: OwnerEligibilityFacts = {
  role: null,
  owner: null,
  archived: false,
};

describe("isEligibleOwner", () => {
  it("accepts an ordinary, unowned, unarchived conversation in an unarchived session", () => {
    expect(isEligibleOwner(ordinary, false)).toBe(true);
  });

  it("refuses a seat or another managed role, an owned conversation, and archived ones", () => {
    expect(isEligibleOwner({ ...ordinary, role: "iteration" }, false)).toBe(
      false,
    );
    expect(isEligibleOwner({ ...ordinary, role: "validator" }, false)).toBe(
      false,
    );
    expect(
      isEligibleOwner(
        {
          ...ordinary,
          owner: { kind: "collaboration", workflowId: "w", attemptEpoch: 0 },
        },
        false,
      ),
    ).toBe(false);
    expect(isEligibleOwner({ ...ordinary, archived: true }, false)).toBe(false);
    expect(isEligibleOwner(ordinary, true)).toBe(false);
  });
});

describe("isEligibleSubscriptionRecipient", () => {
  const conversation = conversationStateSchema.parse({
    id: "conv-1",
    scope: "session",
    transcriptPath: null,
    status: "awaiting",
    promptCount: 1,
    createdAt: "2026-10-12T10:00:00.000Z",
    lastActivityAt: "2026-10-12T10:00:00.000Z",
    agentBackend: "claude",
  });

  it("adds the project to the owner rule", () => {
    const identity = {
      projectPath: "/repo",
      sessionName: "session",
      sessionArchived: false,
      conversation,
    };
    expect(isEligibleSubscriptionRecipient(identity, "/repo")).toBe(true);
    expect(isEligibleSubscriptionRecipient(identity, "/other")).toBe(false);
    expect(
      isEligibleSubscriptionRecipient(
        { ...identity, sessionArchived: true },
        "/repo",
      ),
    ).toBe(false);
    expect(
      isEligibleSubscriptionRecipient(
        { ...identity, conversation: { ...conversation, role: "iteration" } },
        "/repo",
      ),
    ).toBe(false);
    expect(isEligibleSubscriptionRecipient(null, "/repo")).toBe(false);
  });
});
