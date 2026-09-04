import { describe, expect, it } from "vitest";

import {
  SPEC_PLAN_ATTEMPT_TRANSITION_EVENT,
  SPEC_PLAN_PREFLIGHT_EVENT,
  SPEC_PLAN_PROPOSE_ACCEPTED_EVENT,
  specPlanAttemptTransitionEvent,
  specPlanPreflightEvent,
  specPlanProposeAcceptedEvent,
} from "./planning-telemetry";

describe("specPlanPreflightEvent", () => {
  it("reports the surface, the blocking count and the codes it found", () => {
    expect(
      specPlanPreflightEvent({
        slug: "memory",
        surface: "validate",
        findings: [
          {
            ruleId: "binding/selected-criterion-unclaimed",
            severity: "blocks_propose",
          },
          {
            ruleId: "binding/selected-criterion-not-must-run",
            severity: "blocks_propose",
          },
          { ruleId: "launch/charter-unauthored", severity: "advisory" },
        ],
      }),
    ).toEqual({
      event: SPEC_PLAN_PREFLIGHT_EVENT,
      fields: {
        slug: "memory",
        surface: "validate",
        blocking: 2,
        codes: [
          "binding/selected-criterion-unclaimed",
          "binding/selected-criterion-not-must-run",
          "launch/charter-unauthored",
        ],
      },
    });
  });

  it("counts a repeated rule once in codes but keeps every blocking finding", () => {
    expect(
      specPlanPreflightEvent({
        slug: "memory",
        surface: "propose",
        findings: [
          {
            ruleId: "binding/selected-criterion-unclaimed",
            severity: "blocks_propose",
          },
          {
            ruleId: "binding/selected-criterion-unclaimed",
            severity: "blocks_propose",
          },
        ],
      }).fields,
    ).toEqual({
      slug: "memory",
      surface: "propose",
      blocking: 2,
      codes: ["binding/selected-criterion-unclaimed"],
    });
  });

  it("reports a clean draft as blocking zero with no codes", () => {
    expect(
      specPlanPreflightEvent({
        slug: "memory",
        surface: "status",
        findings: [],
      }).fields,
    ).toEqual({ slug: "memory", surface: "status", blocking: 0, codes: [] });
  });

  it("carries no finding message — a rule id is an id, a message is prose", () => {
    const fields = specPlanPreflightEvent({
      slug: "memory",
      surface: "status",
      findings: [
        {
          ruleId: "binding/selected-criterion-unclaimed",
          severity: "blocks_propose",
        },
      ],
    }).fields;

    expect(Object.keys(fields).sort()).toEqual([
      "blocking",
      "codes",
      "slug",
      "surface",
    ]);
  });
});

describe("specPlanProposeAcceptedEvent", () => {
  it("reports coverage at freeze", () => {
    expect(
      specPlanProposeAcceptedEvent({
        slug: "memory",
        covered: 29,
        selected: 31,
        contexts: 12,
      }),
    ).toEqual({
      event: SPEC_PLAN_PROPOSE_ACCEPTED_EVENT,
      fields: { slug: "memory", covered: 29, selected: 31, contexts: 12 },
    });
  });
});

describe("specPlanAttemptTransitionEvent", () => {
  it("names the states either side of the transition and the actor's kind", () => {
    expect(
      specPlanAttemptTransitionEvent({
        slug: "memory",
        from: "launched",
        to: "abandoned",
        actor: "agent",
      }),
    ).toEqual({
      event: SPEC_PLAN_ATTEMPT_TRANSITION_EVENT,
      fields: {
        slug: "memory",
        from: "launched",
        to: "abandoned",
        actor: "agent",
      },
    });
  });

  it("reports a freshly opened attempt as coming from no prior state", () => {
    expect(
      specPlanAttemptTransitionEvent({
        slug: "memory",
        from: "none",
        to: "draft",
        actor: "human",
      }).fields,
    ).toEqual({ slug: "memory", from: "none", to: "draft", actor: "human" });
  });
});
