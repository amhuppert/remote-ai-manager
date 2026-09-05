import { describe, expect, it } from "vitest";

import {
  graphWorkflowExecutionContextDefinitionSchema,
  graphWorkflowResolvedContextSchema,
  workflowSemanticDefinitionSchema,
} from "./definition-schemas";
import type { CriterionRecord } from "./criteria/criterion-records";
import {
  createResolvedWorkflowDefinition,
  createWorkflowDefinition,
} from "./test-fixtures";

const SEEDED_DOCUMENT = {
  relativePath: ".cc/graph-workflow-docs/input.md",
  contents: "Conversation-provided source material.",
  description: "Authored input",
  readWhen: "Read before implementation.",
};

describe("definition seeded documents", () => {
  it("preserves seeded source material in an ordinary definition", () => {
    const definition = {
      ...createWorkflowDefinition(),
      seededDocuments: [SEEDED_DOCUMENT],
    };
    expect(workflowSemanticDefinitionSchema.parse(definition)).toMatchObject({
      seededDocuments: [SEEDED_DOCUMENT],
    });
  });

  it.each([
    "/tmp/input.md",
    "docs/input.md",
    ".cc/graph-workflow-docs/../input.md",
    ".cc/graph-workflow-docs/",
    ".cc/graph-workflow-docs/sub/../../input.md",
    ".cc/graph-workflow-docs/sub\\input.md",
  ])(
    "refuses a destination outside the document namespace: %s",
    (relativePath) => {
      expect(
        workflowSemanticDefinitionSchema.safeParse({
          ...createWorkflowDefinition(),
          seededDocuments: [{ ...SEEDED_DOCUMENT, relativePath }],
        }).success,
      ).toBe(false);
    },
  );

  it("measures the per-document cap in UTF-8 bytes", () => {
    const document = { ...SEEDED_DOCUMENT, contents: "é".repeat(131072) };
    const definition = {
      ...createWorkflowDefinition(),
      seededDocuments: [document],
    };
    expect(workflowSemanticDefinitionSchema.safeParse(definition).success).toBe(
      true,
    );
    document.contents += "x";
    expect(workflowSemanticDefinitionSchema.safeParse(definition).success).toBe(
      false,
    );
  });

  it("caps the combined document contents at one MiB and refuses duplicate destinations", () => {
    const seededDocuments = Array.from({ length: 4 }, (_, index) => ({
      ...SEEDED_DOCUMENT,
      relativePath: `.cc/graph-workflow-docs/${index}.md`,
      contents: "x".repeat(262144),
    }));
    expect(
      workflowSemanticDefinitionSchema.safeParse({
        ...createWorkflowDefinition(),
        seededDocuments,
      }).success,
    ).toBe(true);
    expect(
      workflowSemanticDefinitionSchema.safeParse({
        ...createWorkflowDefinition(),
        seededDocuments: [...seededDocuments, SEEDED_DOCUMENT],
      }).success,
    ).toBe(false);
    expect(
      workflowSemanticDefinitionSchema.safeParse({
        ...createWorkflowDefinition(),
        seededDocuments: [SEEDED_DOCUMENT, SEEDED_DOCUMENT],
      }).success,
    ).toBe(false);
  });
});

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
