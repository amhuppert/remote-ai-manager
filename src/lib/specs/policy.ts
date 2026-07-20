import type {
  SpecGate,
  SpecGateDial,
  SpecGatePolicy,
  SpecGatePreset,
} from "./schemas";

export const COMBINED_APPROVAL_DIAL = "combined-approval";
export type ResolvedGateDial = SpecGateDial | typeof COMBINED_APPROVAL_DIAL;

const PRESET_DIALS: Record<
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

export function resolveDial(
  policy: SpecGatePolicy,
  gate: SpecGate,
): ResolvedGateDial {
  const resolved =
    policy.overrides?.[gate] ?? PRESET_DIALS[policy.preset][gate];
  if (gate === "delivery" && resolved === "off") {
    return "notify";
  }

  return resolved;
}

export function isExploratoryShippingRefused(policy: SpecGatePolicy): boolean {
  return policy.preset === "exploratory";
}

const POLICY_GATES: SpecGate[] = [
  "requirements",
  "design",
  "plan",
  "execution_start",
  "delivery",
];

function dialStrength(dial: ResolvedGateDial): number {
  switch (dial) {
    case "off":
      return 0;
    case "notify":
      return 1;
    case "gate":
    case COMBINED_APPROVAL_DIAL:
      return 2;
  }
}

export function policyChangeRequiresHardConfirmation(
  currentPolicy: SpecGatePolicy,
  proposedPolicy: SpecGatePolicy,
): boolean {
  if (currentPolicy.preset !== proposedPolicy.preset) return true;
  return POLICY_GATES.some(
    (gate) =>
      dialStrength(resolveDial(proposedPolicy, gate)) <
      dialStrength(resolveDial(currentPolicy, gate)),
  );
}
