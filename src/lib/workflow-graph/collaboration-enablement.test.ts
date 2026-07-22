import { describe, expect, it } from "vitest";
import {
  resolvedCollaborationConfigSchema,
  workflowCollaborationConfigOverrideSchema,
  workflowCollaborationConfigSchema,
} from "./collaboration-schemas";

const agent = {
  backend: "claude" as const,
  model: "sonnet" as const,
  reasoningEffort: "medium" as const,
};

describe("graph workflow collaboration enablement schemas", () => {
  it("defaults concrete collaboration config to disabled when enabled is omitted", () => {
    const parsed = workflowCollaborationConfigSchema.parse({
      secondAgent: agent,
      negotiationRounds: 3,
      autonomousResolutionThreshold: "minor",
    });

    expect(parsed).toHaveProperty("enabled", false);
  });

  it("preserves an authored enabled override", () => {
    const parsed = workflowCollaborationConfigOverrideSchema.parse({
      enabled: true,
    });

    expect(parsed).toEqual({ enabled: true });
  });

  it("requires resolved enablement to carry cascade provenance", () => {
    const parsed = resolvedCollaborationConfigSchema.safeParse({
      enabled: { value: false, source: "global" },
      secondAgent: { value: agent, source: "global" },
      negotiationRounds: { value: 3, source: "global" },
      autonomousResolutionThreshold: { value: "minor", source: "global" },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toHaveProperty("enabled", {
        value: false,
        source: "global",
      });
    }
  });
});
