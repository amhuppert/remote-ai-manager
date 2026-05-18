import { describe, expect, it } from "vitest";

import type { AgentCapabilityOverrides } from "@/lib/schemas";

import { mutationAffectsConversationRuntime } from "./default-deps";

function overrides(items: Record<string, boolean>): AgentCapabilityOverrides {
  return {
    cascades: {
      "claude-skills": {
        items: Object.fromEntries(
          Object.entries(items).map(([itemId, enabled]) => [
            itemId,
            { enabled },
          ]),
        ),
      },
    },
  };
}

describe("agent-capabilities/default-deps fanout filtering", () => {
  it("excludes a conversation when narrower overrides mask every changed item", () => {
    expect(
      mutationAffectsConversationRuntime({
        scope: { level: "global" },
        cascadeKind: "claude-skills",
        changedItemIds: ["alpha"],
        overrideChain: {
          global: overrides({ alpha: false }),
          project: overrides({ alpha: true }),
        },
      }),
    ).toBe(false);
  });

  it("includes a conversation when any changed item can flow through the edited scope", () => {
    expect(
      mutationAffectsConversationRuntime({
        scope: { level: "global" },
        cascadeKind: "claude-skills",
        changedItemIds: ["alpha", "beta"],
        overrideChain: {
          global: overrides({ alpha: false, beta: false }),
          project: overrides({ alpha: true }),
        },
      }),
    ).toBe(true);
  });
});
