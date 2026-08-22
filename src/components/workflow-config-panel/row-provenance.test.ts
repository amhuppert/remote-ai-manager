/**
 * The provenance chrome a row shows: which tier a value came from, the tooltip
 * naming it, and the granularity-specific reset title (design README §7).
 */
import { describe, expect, it } from "vitest";
import {
  inheritedTierChip,
  inheritedTierTitle,
  isSetHere,
  resetToInheritTitle,
  type ConfigRowProvenance,
} from "./row-provenance";

function provenance(
  overrides: Partial<ConfigRowProvenance> = {},
): ConfigRowProvenance {
  return {
    sourceTier: "global",
    scopeTier: "context",
    granularity: "block",
    ...overrides,
  };
}

describe("isSetHere", () => {
  it("is true only when the value resolves from the tier being edited", () => {
    expect(isSetHere(provenance({ sourceTier: "context" }))).toBe(true);
    expect(isSetHere(provenance({ sourceTier: "workflow" }))).toBe(false);
    expect(isSetHere(provenance({ sourceTier: "global" }))).toBe(false);
    expect(
      isSetHere(provenance({ sourceTier: "workflow", scopeTier: "workflow" })),
    ).toBe(true);
  });

  it("honours the explicit flag a drill row uses to summarise several paths", () => {
    expect(isSetHere(provenance({ sourceTier: "global", setHere: true }))).toBe(
      true,
    );
    expect(
      isSetHere(provenance({ sourceTier: "context", setHere: false })),
    ).toBe(false);
  });
});

describe("inheritedTierChip", () => {
  it("labels the inherited tier G or W", () => {
    expect(inheritedTierChip(provenance({ sourceTier: "global" }))).toBe("G");
    expect(inheritedTierChip(provenance({ sourceTier: "workflow" }))).toBe("W");
  });

  it("has no chip for a value set at the tier being edited", () => {
    expect(inheritedTierChip(provenance({ sourceTier: "context" }))).toBeNull();
    expect(
      inheritedTierChip(provenance({ sourceTier: "global", setHere: true })),
    ).toBeNull();
  });
});

describe("inheritedTierTitle", () => {
  it("names the source tier and the granularity that is unset", () => {
    expect(
      inheritedTierTitle(
        provenance({ sourceTier: "global", granularity: "block" }),
      ),
    ).toBe(
      "Inherited from global defaults — this block is not set on the context",
    );
    expect(
      inheritedTierTitle(
        provenance({ sourceTier: "workflow", granularity: "field" }),
      ),
    ).toBe(
      "Inherited from this workflow — this field is not set on the context",
    );
    expect(
      inheritedTierTitle(
        provenance({ sourceTier: "workflow", granularity: "role" }),
      ),
    ).toBe(
      "Inherited from this workflow — this role is not set on the context",
    );
  });

  it("names the workflow tier when the builder edits workflow defaults", () => {
    expect(
      inheritedTierTitle(
        provenance({ sourceTier: "global", scopeTier: "workflow" }),
      ),
    ).toBe(
      "Inherited from global defaults — this block is not set on the workflow",
    );
  });

  it("has no tooltip for a value set at the tier being edited", () => {
    expect(
      inheritedTierTitle(provenance({ sourceTier: "context" })),
    ).toBeNull();
  });
});

describe("resetToInheritTitle", () => {
  it("names exactly the granularity it clears", () => {
    expect(resetToInheritTitle("block")).toBe("Reset this block to inherit");
    expect(resetToInheritTitle("role")).toBe("Reset this role to inherit");
    expect(resetToInheritTitle("field")).toBe("Reset this field to inherit");
  });
});
