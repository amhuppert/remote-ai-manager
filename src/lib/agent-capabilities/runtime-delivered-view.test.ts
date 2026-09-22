import { describe, expect, it } from "vitest";
import type { ResolvedCapabilityCascade } from "@/lib/agent-backends/runtime-config";
import { defaultAgentCapabilityMetadataRegistry } from "./metadata";
import { resolveCascadeView } from "./resolver";
import { applyDeliveredCapabilityView } from "./runtime-seed";

function requestedView() {
  return resolveCascadeView({
    cascadeKind: "cursor-skills",
    scope: { level: "conversation" },
    metadata: defaultAgentCapabilityMetadataRegistry.get("cursor-skills"),
    overrideChain: [],
    discoveredItems: ["delivered", "missing"].map((itemId) => ({
      itemId,
      displayName: itemId,
      capabilityKind: "skill" as const,
      nativeDefault: { enabled: true },
      source: { kind: "user-file" as const, path: `/skills/${itemId}` },
      runtimeVisibility: "source-only" as const,
    })),
  });
}

describe("delivered capability availability", () => {
  it("leaves an absent delivered kind unknown", () => {
    const result = applyDeliveredCapabilityView(requestedView(), {
      backend: "cursor",
      kinds: [],
    });
    expect(result.items.map((item) => item.appliedEnabled)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("reports only explicitly delivered item states from an incomplete inventory", () => {
    const delivered: ResolvedCapabilityCascade = {
      backend: "cursor",
      kinds: [
        {
          kind: "skills",
          items: [
            {
              itemId: "delivered",
              enabled: false,
              originLayer: "conversation",
            },
          ],
        },
      ],
    };
    const result = applyDeliveredCapabilityView(requestedView(), delivered);
    expect(
      result.items.find((item) => item.itemId === "delivered")?.appliedEnabled,
    ).toBe(false);
    expect(
      result.items.find((item) => item.itemId === "missing")?.appliedEnabled,
    ).toBeUndefined();
  });
});
