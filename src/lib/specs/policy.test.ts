import { describe, expect, it } from "vitest";

import type { SpecGate, SpecGatePolicy, SpecGatePreset } from "./schemas";
import {
  COMBINED_APPROVAL_DIAL,
  dialRequiresHumanApproval,
  isExploratoryShippingRefused,
  policyChangeRequiresHardConfirmation,
  resolveDial,
  type ResolvedGateDial,
} from "./policy";
import { resolvedGateDialSchema } from "./schemas";

const gates: SpecGate[] = [
  "requirements",
  "design",
  "plan",
  "execution_start",
  "delivery",
];

const presetMatrix: Record<
  SpecGatePreset,
  Record<SpecGate, ResolvedGateDial>
> = {
  "contract-bearing": {
    requirements: "gate",
    design: "gate",
    plan: "gate",
    execution_start: "gate",
    delivery: "gate",
  },
  exploratory: {
    requirements: "notify",
    design: "notify",
    plan: "notify",
    execution_start: "notify",
    delivery: "gate",
  },
  "fast-path": {
    requirements: COMBINED_APPROVAL_DIAL,
    design: COMBINED_APPROVAL_DIAL,
    plan: COMBINED_APPROVAL_DIAL,
    execution_start: "notify",
    delivery: "gate",
  },
};

const presetCases: Array<{
  preset: SpecGatePreset;
  expected: Record<SpecGate, ResolvedGateDial>;
}> = [
  {
    preset: "contract-bearing",
    expected: presetMatrix["contract-bearing"],
  },
  { preset: "exploratory", expected: presetMatrix.exploratory },
  { preset: "fast-path", expected: presetMatrix["fast-path"] },
];

describe("spec gate policy", () => {
  it.each(presetCases)(
    "resolves every $preset preset gate",
    ({ preset, expected }) => {
      const policy: SpecGatePolicy = { preset };

      for (const gate of gates) {
        expect(resolveDial(policy, gate)).toBe(expected[gate]);
      }
    },
  );

  it("changes only the overridden dial without leaving the preset", () => {
    const policy: SpecGatePolicy = {
      preset: "fast-path",
      overrides: { plan: "notify" },
    };

    expect(resolveDial(policy, "requirements")).toBe(COMBINED_APPROVAL_DIAL);
    expect(resolveDial(policy, "design")).toBe(COMBINED_APPROVAL_DIAL);
    expect(resolveDial(policy, "plan")).toBe("notify");
    expect(resolveDial(policy, "execution_start")).toBe("notify");
    expect(resolveDial(policy, "delivery")).toBe("gate");
    expect(policy.preset).toBe("fast-path");
  });

  it.each<SpecGatePreset>(["contract-bearing", "exploratory", "fast-path"])(
    "floors a delivery off override at notify for %s",
    (preset) => {
      expect(
        resolveDial({ preset, overrides: { delivery: "off" } }, "delivery"),
      ).toBe("notify");
    },
  );

  it("allows the delivery gate to be lowered to notify", () => {
    expect(
      resolveDial(
        {
          preset: "contract-bearing",
          overrides: { delivery: "notify" },
        },
        "delivery",
      ),
    ).toBe("notify");
  });

  it("allows off on a gate outside the delivery floor", () => {
    expect(
      resolveDial(
        {
          preset: "contract-bearing",
          overrides: { requirements: "off" },
        },
        "requirements",
      ),
    ).toBe("off");
  });

  it("requires hard confirmation for preset switches and gate loosening", () => {
    expect(
      policyChangeRequiresHardConfirmation(
        { preset: "contract-bearing" },
        { preset: "exploratory" },
      ),
    ).toBe(true);
    expect(
      policyChangeRequiresHardConfirmation(
        { preset: "contract-bearing" },
        {
          preset: "contract-bearing",
          overrides: { requirements: "notify" },
        },
      ),
    ).toBe(true);
  });

  it("does not require hard confirmation for a same-preset tightening", () => {
    expect(
      policyChangeRequiresHardConfirmation(
        {
          preset: "exploratory",
          overrides: { requirements: "notify" },
        },
        {
          preset: "exploratory",
          overrides: { requirements: "gate" },
        },
      ),
    ).toBe(false);
  });

  it.each<[SpecGatePreset, boolean]>([
    ["contract-bearing", false],
    ["exploratory", true],
    ["fast-path", false],
  ])(
    "exposes the exploratory shipping-refusal marker for %s",
    (preset, expected) => {
      expect(isExploratoryShippingRefused({ preset })).toBe(expected);
    },
  );
});

describe("the canonical human-approval predicate", () => {
  it.each<[ResolvedGateDial, boolean]>([
    ["gate", true],
    [COMBINED_APPROVAL_DIAL, true],
    ["notify", false],
    ["off", false],
  ])("reports %s as requiring a human approval: %s", (dial, expected) => {
    expect(dialRequiresHumanApproval(dial)).toBe(expected);
  });

  it("answers for every dial the schema admits, so a new dial cannot be silently unhandled", () => {
    const dials: ResolvedGateDial[] = [
      "gate",
      "notify",
      "off",
      COMBINED_APPROVAL_DIAL,
    ];
    for (const dial of dials) {
      expect(resolvedGateDialSchema.safeParse(dial).success).toBe(true);
      expect(typeof dialRequiresHumanApproval(dial)).toBe("boolean");
    }
  });

  it("agrees with the preset matrix that every contract-bearing gate is a human act", () => {
    for (const gate of gates) {
      expect(
        dialRequiresHumanApproval(
          resolveDial({ preset: "contract-bearing" }, gate),
        ),
      ).toBe(true);
    }
  });
});
