import { describe, expect, it } from "vitest";

import {
  resolvedCapabilityCascadeSchema,
  validateResolvedCascade,
  type ResolvedCapabilityCascade,
} from "./runtime-config";
import { claudeConversationCapabilities } from "./claude/descriptor";
import { codexConversationCapabilities } from "./codex/descriptor";

function cascade(input: {
  backend: "claude" | "codex";
  kinds: ResolvedCapabilityCascade["kinds"];
}): ResolvedCapabilityCascade {
  return { backend: input.backend, kinds: input.kinds };
}

describe("resolvedCapabilityCascadeSchema", () => {
  it("parses a well-formed neutral cascade", () => {
    const result = resolvedCapabilityCascadeSchema.safeParse({
      backend: "claude",
      kinds: [
        {
          kind: "skills",
          items: [
            { itemId: "commit-helper", enabled: true, originLayer: "global" },
            { itemId: "native-skill", enabled: true, originLayer: "native" },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown capability kind", () => {
    const result = resolvedCapabilityCascadeSchema.safeParse({
      backend: "claude",
      kinds: [{ kind: "widgets", items: [] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown origin layer", () => {
    const result = resolvedCapabilityCascadeSchema.safeParse({
      backend: "codex",
      kinds: [
        {
          kind: "skills",
          items: [{ itemId: "x", enabled: false, originLayer: "workspace" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("validateResolvedCascade", () => {
  it("accepts a cascade whose kinds are all declared by the backend", () => {
    const result = validateResolvedCascade({
      resolved: cascade({
        backend: "claude",
        kinds: [
          { kind: "skills", items: [] },
          { kind: "plugins", items: [] },
          { kind: "agents", items: [] },
        ],
      }),
      backend: "claude",
      capabilityKinds: claudeConversationCapabilities.capabilityKinds,
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects codex+agents — an undeclared (backend, kind) pair", () => {
    const result = validateResolvedCascade({
      resolved: cascade({
        backend: "codex",
        kinds: [{ kind: "agents", items: [] }],
      }),
      backend: "codex",
      capabilityKinds: codexConversationCapabilities.capabilityKinds,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("agents");
    }
  });

  it("rejects a cascade addressed to a different backend", () => {
    const result = validateResolvedCascade({
      resolved: cascade({ backend: "claude", kinds: [] }),
      backend: "codex",
      capabilityKinds: codexConversationCapabilities.capabilityKinds,
    });
    expect(result.ok).toBe(false);
  });
});
