import { describe, expect, it } from "vitest";

import {
  DRAFT_HEALTH_TOP_FINDINGS,
  LINT_SEVERITY_LABEL,
  LINT_SEVERITY_ORDER,
  draftHealth,
} from "./draft-health";
import type { LintFinding } from "./lint";

function finding(
  severity: LintFinding["severity"],
  elementHandle: string,
  ruleId = "9.3.uncovered-criterion",
): LintFinding {
  return {
    ruleId,
    severity,
    elementHandle,
    message: `${elementHandle} ${ruleId}`,
  };
}

describe("draftHealth", () => {
  it("reads an empty finding list as a clean draft", () => {
    const health = draftHealth([]);

    expect(health.total).toBe(0);
    expect(health.blocking).toBe(0);
    expect(health.counts).toEqual([]);
    expect(health.groups).toEqual([]);
    expect(health.blockingFindings).toEqual([]);
    expect(health.ordered).toEqual([]);
  });

  it("groups by severity in refusal order and omits severities with no findings", () => {
    const health = draftHealth([
      finding("advisory", "R1.1", "9.12.serialized-plan"),
      finding("blocks_signoff", "R2.1", "9.9.open-question"),
      finding("blocks_propose", "T1", "9.3.task-without-criterion"),
    ]);

    expect(health.groups.map((group) => group.severity)).toEqual([
      "blocks_propose",
      "blocks_signoff",
      "advisory",
    ]);
    expect(health.groups.map((group) => group.findings.length)).toEqual([
      1, 1, 1,
    ]);
    // blocks_claim produced nothing, so it is not named at all — a zero beside
    // a severity reads as a checked-and-clean claim this projection cannot make.
    expect(health.counts).toEqual([
      { severity: "blocks_propose", count: 1 },
      { severity: "blocks_signoff", count: 1 },
      { severity: "advisory", count: 1 },
    ]);
  });

  it("preserves the lint order within a severity so the same findings show every run", () => {
    const findings = [
      finding("blocks_propose", "R1.1"),
      finding("blocks_propose", "R1.2"),
      finding("blocks_propose", "R2.1"),
    ];

    expect(
      draftHealth(findings).ordered.map((entry) => entry.elementHandle),
    ).toEqual(["R1.1", "R1.2", "R2.1"]);
  });

  it("counts and collects exactly the blocks_propose findings", () => {
    const health = draftHealth([
      finding("blocks_propose", "T1", "9.3.task-without-criterion"),
      finding("advisory", "T2", "9.12.overloaded-task"),
      finding("blocks_propose", "R1.1"),
      finding("blocks_claim", "T3", "9.7.claim-without-evidence"),
    ]);

    expect(health.total).toBe(4);
    expect(health.blocking).toBe(2);
    expect(health.blockingFindings.map((entry) => entry.elementHandle)).toEqual(
      ["T1", "R1.1"],
    );
  });

  it("orders every severity ahead of the advisory tail", () => {
    const health = draftHealth([
      finding("advisory", "A1", "9.12.serialized-plan"),
      finding("blocks_claim", "C1", "9.7.claim-without-evidence"),
      finding("blocks_signoff", "S1", "9.9.open-question"),
      finding("blocks_propose", "P1"),
    ]);

    expect(health.ordered.map((entry) => entry.elementHandle)).toEqual([
      "P1",
      "C1",
      "S1",
      "A1",
    ]);
    expect(LINT_SEVERITY_ORDER).toEqual([
      "blocks_propose",
      "blocks_claim",
      "blocks_signoff",
      "advisory",
    ]);
  });

  it("labels every severity it can classify", () => {
    for (const severity of LINT_SEVERITY_ORDER) {
      expect(LINT_SEVERITY_LABEL[severity].length).toBeGreaterThan(0);
    }
    expect(DRAFT_HEALTH_TOP_FINDINGS).toBe(5);
  });
});
