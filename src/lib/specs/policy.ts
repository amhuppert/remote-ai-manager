import { COMBINED_APPROVAL_DIAL } from "./schemas";
import type {
  ResolvedGateDial,
  SpecGate,
  SpecGatePolicy,
  SpecGatePreset,
} from "./schemas";

export { COMBINED_APPROVAL_DIAL };
export type { ResolvedGateDial };

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

/**
 * The one answer to "does this dial make the transition a human act?". Gate
 * asks for the approval per subject and the combined dial collapses them into
 * one sign-off, but both still require a human; Notify and Off do not. Every
 * surface that decides whether approvals are involved — the transition
 * preconditions, the remaining-sequence projection, and the confirmation
 * preview — reads it here, because a second copy would let the modal promise
 * an operator something the server refuses.
 */
export function dialRequiresHumanApproval(dial: ResolvedGateDial): boolean {
  return dial === "gate" || dial === COMBINED_APPROVAL_DIAL;
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
