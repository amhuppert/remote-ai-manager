// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { dialRequiresHumanApproval, resolveDial } from "@/lib/specs/policy";
import {
  specGateDialSchema,
  specGatePresetSchema,
  specGateSchema,
  type ResolvedGateDial,
  type SpecGate,
  type SpecGatePolicy,
} from "@/lib/specs/schemas";

import {
  PolicyImpactPreview,
  type PolicyImpactApprovalEffect,
} from "./SpecPolicyImpact";

const POLICY_IMPACT_NAME = "Impact of this change";

const approvalListLabels: Record<PolicyImpactApprovalEffect, string> = {
  added: "Approvals added",
  removed: "Approvals removed",
  unaffected: "Approvals unaffected",
};

const effects: PolicyImpactApprovalEffect[] = [
  "added",
  "removed",
  "unaffected",
];

const SUBJECT_GATE: SpecGate = "requirements";
const SUBJECT_CHIP_PREFIX = "Requirements · ";

/**
 * Every dial an authorable policy can actually resolve to, derived from the
 * presets and overrides rather than listed, so a new preset dial or a new
 * override value enters this matrix without anyone remembering to add it.
 */
function reachableDials(): ResolvedGateDial[] {
  const dials = new Set<ResolvedGateDial>();
  for (const preset of specGatePresetSchema.options) {
    for (const gate of specGateSchema.options) {
      dials.add(resolveDial({ preset }, gate));
      for (const override of specGateDialSchema.options) {
        dials.add(
          resolveDial({ preset, overrides: { [gate]: override } }, gate),
        );
      }
    }
  }
  return [...dials];
}

function policyResolvingTo(dial: ResolvedGateDial): SpecGatePolicy {
  for (const preset of specGatePresetSchema.options) {
    if (resolveDial({ preset }, SUBJECT_GATE) === dial) return { preset };
    for (const override of specGateDialSchema.options) {
      const policy: SpecGatePolicy = {
        preset,
        overrides: { [SUBJECT_GATE]: override },
      };
      if (resolveDial(policy, SUBJECT_GATE) === dial) return policy;
    }
  }
  throw new Error(`no authorable policy resolves ${SUBJECT_GATE} to ${dial}`);
}

function expectedEffect(
  currentDial: ResolvedGateDial,
  proposedDial: ResolvedGateDial,
): PolicyImpactApprovalEffect {
  const before = dialRequiresHumanApproval(currentDial);
  const after = dialRequiresHumanApproval(proposedDial);
  if (before === after) return "unaffected";
  return after ? "added" : "removed";
}

function groupHoldingSubjectGate(
  impact: HTMLElement,
): PolicyImpactApprovalEffect | null {
  const holding = effects.filter((effect) => {
    const list = within(impact).queryByRole("list", {
      name: approvalListLabels[effect],
    });
    if (list === null) return false;
    return within(list)
      .getAllByRole("listitem")
      .some((item) => (item.textContent ?? "").startsWith(SUBJECT_CHIP_PREFIX));
  });
  if (holding.length > 1) {
    throw new Error(
      `${SUBJECT_GATE} was classified into more than one approval group: ${holding.join(", ")}`,
    );
  }
  return holding[0] ?? null;
}

const dialPairs = reachableDials().flatMap((from) =>
  reachableDials().map((to) => ({ from, to })),
);

describe("PolicyImpactPreview approval chips", () => {
  it.each(dialPairs)(
    "classifies a $from → $to requirements dial by the canonical approval predicate",
    ({ from, to }) => {
      render(
        <PolicyImpactPreview
          currentPolicy={policyResolvingTo(from)}
          proposedPolicy={policyResolvingTo(to)}
          draft={null}
        />,
      );

      const impact = screen.getByRole("region", { name: POLICY_IMPACT_NAME });
      expect(groupHoldingSubjectGate(impact)).toBe(expectedEffect(from, to));
    },
  );

  // The matrix above reads its expectation from the same predicate the
  // component should be reading, so this case states the substantive rule
  // outright: the fast path collapses the per-subject approvals into one
  // sign-off but still requires a human, so the preview must not tell the
  // operator that switching to it drops the requirements approval.
  it("reports a switch to combined approval as an approval the operator keeps", () => {
    render(
      <PolicyImpactPreview
        currentPolicy={{ preset: "contract-bearing" }}
        proposedPolicy={{ preset: "fast-path" }}
        draft={null}
      />,
    );

    const impact = screen.getByRole("region", { name: POLICY_IMPACT_NAME });
    expect(groupHoldingSubjectGate(impact)).toBe("unaffected");
    expect(
      within(impact).getByText("Requirements · Gate → Combined approval"),
    ).toBeVisible();
  });
});
