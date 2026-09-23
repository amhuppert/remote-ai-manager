import { describe, expect, it } from "vitest";

import { DELIVERY_PLAN_BINDING_LINT_ISSUE_CODES } from "./delivery-plan-binding-lint";
import {
  ADVISORY_DELIVERY_PLAN_BINDING_LINT_ISSUE_CODES,
  type DeliveryPlanBindingLintIssueCode,
} from "./lint-rules";
import {
  DELIVERY_PLAN_GATE_RULE_IDS,
  LAUNCH_ADVISORY_RULE_ID,
  LAUNCH_CHARTER_UNAUTHORED_RULE_ID,
} from "./delivery-plan-health";
import {
  NATIVE_SDD_GUIDANCE,
  NATIVE_SDD_GUIDANCE_SECTIONS,
} from "./native-sdd-guidance";

/**
 * The catalogue is derived from the same code the gate emits from, so this
 * expectation is derived too: a hand-listed expectation would go stale in
 * exactly the case the taxonomy exists to prevent — a new code nobody
 * published.
 */
const EMITTABLE_CODES = [
  ...DELIVERY_PLAN_BINDING_LINT_ISSUE_CODES,
  ...DELIVERY_PLAN_GATE_RULE_IDS,
];

describe("NATIVE_SDD_GUIDANCE delivery-plan lint taxonomy", () => {
  it("publishes every code the propose gate can emit", () => {
    const published = NATIVE_SDD_GUIDANCE.lintTaxonomy.deliveryPlan.map(
      ({ ruleId }) => ruleId,
    );

    expect([...published].sort()).toEqual([...EMITTABLE_CODES].sort());
  });

  it("names the transition each code blocks", () => {
    const severityOf = new Map(
      NATIVE_SDD_GUIDANCE.lintTaxonomy.deliveryPlan.map(
        ({ ruleId, severity }) => [ruleId, severity],
      ),
    );

    expect(severityOf.get(LAUNCH_ADVISORY_RULE_ID)).toBe("advisory");
    for (const code of ADVISORY_DELIVERY_PLAN_BINDING_LINT_ISSUE_CODES) {
      expect(severityOf.get(code)).toBe("advisory");
    }
    for (const code of EMITTABLE_CODES) {
      if (code === LAUNCH_ADVISORY_RULE_ID) continue;
      if (
        ADVISORY_DELIVERY_PLAN_BINDING_LINT_ISSUE_CODES.has(
          code as DeliveryPlanBindingLintIssueCode,
        )
      )
        continue;
      expect(severityOf.get(code)).toBe("blocks_propose");
    }
  });

  it("marks the two codes only a human act can clear", () => {
    const noteOf = new Map(
      NATIVE_SDD_GUIDANCE.lintTaxonomy.deliveryPlan.map(({ ruleId, note }) => [
        ruleId,
        note,
      ]),
    );

    expect(noteOf.get("binding/pending-reaffirmation")).toBe("human act");
    expect(noteOf.get("binding/reaffirmed-without-delivery")).toBe("human act");
    expect(noteOf.get(LAUNCH_CHARTER_UNAUTHORED_RULE_ID)).toBeUndefined();
  });

  it("renders one reference line per published code", () => {
    expect(NATIVE_SDD_GUIDANCE_SECTIONS.deliveryPlanLint.lines).toHaveLength(
      EMITTABLE_CODES.length,
    );
    expect(NATIVE_SDD_GUIDANCE_SECTIONS.deliveryPlanLint.lines).toContain(
      `${LAUNCH_CHARTER_UNAUTHORED_RULE_ID} — blocks_propose`,
    );
    expect(NATIVE_SDD_GUIDANCE_SECTIONS.deliveryPlanLint.lines).toContain(
      "binding/pending-reaffirmation — blocks_propose (human act)",
    );
  });
});
