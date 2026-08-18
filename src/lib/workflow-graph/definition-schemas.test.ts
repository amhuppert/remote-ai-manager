import { describe, expect, it } from "vitest";

import {
  graphWorkflowExecutionContextDefinitionSchema,
  graphWorkflowResolvedContextSchema,
} from "./definition-schemas";
import type { CriterionRecord } from "./criteria/criterion-records";
import { createResolvedWorkflowDefinition } from "./test-fixtures";

const RECORDS: CriterionRecord[] = [
  { id: "schema-accepts-records", statement: "Records parse on the context." },
  { id: "prose-still-parses", statement: "Legacy prose parses unchanged." },
];

function makeAuthoredContext(
  acceptanceCriteria: string | CriterionRecord[],
): Record<string, unknown> {
  return {
    id: "context-implement",
    title: "Implement",
    acceptanceCriteria,
    placement: { lane: "implement", mode: "full" },
  };
}

describe("authored context acceptanceCriteria", () => {
  it("accepts ordered criterion records", () => {
    const parsed = graphWorkflowExecutionContextDefinitionSchema.safeParse(
      makeAuthoredContext(RECORDS),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.data?.acceptanceCriteria).toEqual(RECORDS);
  });

  it("still accepts legacy prose", () => {
    const parsed = graphWorkflowExecutionContextDefinitionSchema.safeParse(
      makeAuthoredContext("The feature works end to end."),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.data?.acceptanceCriteria).toBe(
      "The feature works end to end.",
    );
  });

  it("refuses duplicate record ids with the offending element located", () => {
    const parsed = graphWorkflowExecutionContextDefinitionSchema.safeParse(
      makeAuthoredContext([
        { id: "same-id", statement: "First." },
        { id: "same-id", statement: "Second." },
      ]),
    );
    expect(parsed.success).toBe(false);
    expect(
      parsed.error?.issues.some(
        (issue) =>
          issue.message.includes("duplicate criterion id 'same-id'") &&
          issue.path.join(".") === "acceptanceCriteria.1.id",
      ),
    ).toBe(true);
  });
});

describe("resolved context acceptanceCriteria", () => {
  it("accepts both shapes and preserves them verbatim (no read-time transformation)", () => {
    const base = createResolvedWorkflowDefinition().executionContexts[0];
    if (base === undefined) throw new Error("fixture has no contexts");

    const prose = graphWorkflowResolvedContextSchema.safeParse(base);
    expect(prose.success).toBe(true);
    expect(prose.data?.acceptanceCriteria).toBe(base.acceptanceCriteria);

    const records = graphWorkflowResolvedContextSchema.safeParse({
      ...base,
      acceptanceCriteria: RECORDS,
    });
    expect(records.success).toBe(true);
    expect(records.data?.acceptanceCriteria).toEqual(RECORDS);
  });
});
