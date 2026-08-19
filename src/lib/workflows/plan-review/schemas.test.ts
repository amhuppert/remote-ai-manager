import { describe, expect, it } from "vitest";

import {
  createWorkflowDefinition,
  createWorkflowLayout,
} from "@/lib/workflow-graph/test-fixtures";
import { workingDefinitionHash } from "@/lib/workflow-graph/working-definition-hash";

import { graphPlanReviewSchema, planDefinitionHash } from "./schemas";

/** A well-formed create/replace body: `{ name, description?, definition, layout }`. */
function makePlan(definition = createWorkflowDefinition()) {
  return {
    name: "Reviewed Workflow",
    description: "A workflow under review",
    definition,
    layout: createWorkflowLayout(),
  };
}

/**
 * A wire body whose object keys arrive in a different order — what a second
 * client serializing the same plan actually sends. `stableStringify` sorts
 * keys, so the hash must be blind to it.
 */
function reorderKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderKeysDeep);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, child]) => [key, reorderKeysDeep(child)]),
    );
  }
  return value;
}

function hashOrThrow(rawBody: unknown): string {
  const result = planDefinitionHash(rawBody);
  if (!result.ok) {
    throw new Error(
      `expected a hashable plan, got issues: ${JSON.stringify(result.issues)}`,
    );
  }
  return result.hash;
}

function review(overrides: Record<string, unknown> = {}) {
  return {
    id: "review-1",
    definitionHash: `sha256:${"a".repeat(64)}`,
    reviewerConversationId: "conv-reviewer-1",
    verdict: "approved",
    findings: null,
    reviewedAt: "2026-08-18T10:00:00.000Z",
    ...overrides,
  };
}

describe("planDefinitionHash", () => {
  it("yields the identical hash for the same plan content with reordered keys", () => {
    const plan = makePlan();
    const reordered = JSON.parse(
      JSON.stringify(reorderKeysDeep(plan)),
    ) as unknown;

    expect(hashOrThrow(reordered)).toBe(hashOrThrow(plan));
  });

  it("yields a different hash for a materially different definition", () => {
    const base = createWorkflowDefinition();
    const changed = {
      ...base,
      executionContexts: base.executionContexts.map((context, index) =>
        index === 0
          ? {
              ...context,
              acceptanceCriteria: "Plan is documented and reviewed",
            }
          : context,
      ),
    };

    expect(hashOrThrow(makePlan(changed))).not.toBe(
      hashOrThrow(makePlan(base)),
    );
  });

  it("hashes the canonical definition, not the submitted bytes", () => {
    // Prose acceptance criteria canonicalize to exactly one `ac-1` record, so
    // the two spellings of the same plan are one reviewable revision.
    const prose = createWorkflowDefinition();
    const records = {
      ...prose,
      executionContexts: prose.executionContexts.map((context) => ({
        ...context,
        acceptanceCriteria: [
          { id: "ac-1", statement: String(context.acceptanceCriteria) },
        ],
      })),
    };

    expect(hashOrThrow(makePlan(records))).toBe(hashOrThrow(makePlan(prose)));
  });

  it("matches workingDefinitionHash over the validated draft definition", () => {
    const hash = hashOrThrow(makePlan());

    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(hash).toBe(
      workingDefinitionHash({
        ...createWorkflowDefinition(),
        executionContexts: createWorkflowDefinition().executionContexts.map(
          (context) => ({
            ...context,
            acceptanceCriteria: [
              { id: "ac-1", statement: String(context.acceptanceCriteria) },
            ],
          }),
        ),
      }),
    );
  });

  it("reports validation issues instead of throwing on an unhashable plan", () => {
    const result = planDefinitionHash({ name: "", definition: {} });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe("graphPlanReviewSchema", () => {
  it("accepts an approved terminal review with no findings artifact", () => {
    const parsed = graphPlanReviewSchema.safeParse(review());

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.verdict).toBe("approved");
    expect(parsed.data.findings).toBeNull();
    expect(parsed.data.reviewerConversationId).toBe("conv-reviewer-1");
  });

  it("accepts a changes-requested review carrying its findings artifact", () => {
    const parsed = graphPlanReviewSchema.safeParse(
      review({
        verdict: "changes_requested",
        findings: "Context 2 is overloaded.",
      }),
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.findings).toBe("Context 2 is overloaded.");
  });

  it("refuses a changes-requested review with no findings artifact", () => {
    // The incident change 5 exists for: a verdict presented without the
    // artifact that justifies it.
    expect(
      graphPlanReviewSchema.safeParse(
        review({ verdict: "changes_requested", findings: null }),
      ).success,
    ).toBe(false);
    expect(
      graphPlanReviewSchema.safeParse(
        review({ verdict: "changes_requested", findings: "   " }),
      ).success,
    ).toBe(false);
  });

  it("refuses a non-terminal verdict", () => {
    for (const verdict of ["draft", "canceled", "pending"]) {
      expect(graphPlanReviewSchema.safeParse(review({ verdict })).success).toBe(
        false,
      );
    }
  });

  it("refuses a definitionHash that is not a canonical sha256 digest", () => {
    for (const definitionHash of [
      "a".repeat(64),
      `sha256:${"A".repeat(64)}`,
      `sha256:${"a".repeat(63)}`,
      "sha256:",
    ]) {
      expect(
        graphPlanReviewSchema.safeParse(review({ definitionHash })).success,
      ).toBe(false);
    }
  });

  it("shape-validates the reviewer conversation reference without resolving it", () => {
    expect(
      graphPlanReviewSchema.safeParse(review({ reviewerConversationId: "" }))
        .success,
    ).toBe(false);
    // An id that no conversation carries still records: an existence check here
    // would be a new fail-closed path on an advisory record.
    expect(
      graphPlanReviewSchema.safeParse(
        review({ reviewerConversationId: "conv-does-not-exist" }),
      ).success,
    ).toBe(true);
  });

  it("refuses a reviewedAt that is not an ISO timestamp", () => {
    expect(
      graphPlanReviewSchema.safeParse(review({ reviewedAt: "2026-08-18" }))
        .success,
    ).toBe(false);
  });
});
