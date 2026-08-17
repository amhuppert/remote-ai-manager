import { describe, expect, it } from "vitest";

import type { GraphExecutionContract } from "./execution-contract-port";
import {
  composeGraphRolePrompt,
  type GraphRolePromptProjection,
} from "./prompt-composer";
import { createWorkflowExecution } from "./test-fixtures";

const BASE_PROMPT = "# Context Validation\n\nJudge the context.";

const PROJECTION: GraphRolePromptProjection = {
  heading: "Spec ownership",
  body: "This immutable binding is the authority for criterion ownership.",
};

/**
 * The cohort's paragraphs are restated here verbatim rather than imported: this
 * file is the byte-level pin for what a validator actually reads, so it must
 * fail when the composer's wording drifts, not track it.
 */
const OWNERSHIP_PARAGRAPH =
  "The authoritative Spec ownership section above decides criterion assignment. Do not fail this context for criterion work assigned only to another claimant. A stable authored claimant may be a dynamic orchestrator accountable for generated or loop work; honor that ownership without tracing generated children or loop instances.";
const DEFERRAL_PARAGRAPH =
  "Ownership alone never authorizes a production-capability deferral. Missing production wiring may be deferred only to a graph-downstream owner, and only when either the current context's acceptance criteria explicitly name that downstream owner for the obligation, or the downstream owner's acceptance criteria below contain the matching obligation. A claim, context title, graph edge, or vague downstream reference is not enough. If neither route is present, raise an issue for the missing production call path.";
const COHORT_INTRO_PARAGRAPH =
  "This is the current and graph-downstream authored acceptance-criteria cohort, not a wiring table. Upstream or unrelated claimants remain ownership-visible but cannot authorize a future production handoff:";

/** The current context (`context-plan`) plus both graph-downstream contexts. */
const PLAN_COHORT_LISTING = [
  "### `context-plan` — Plan (current context)",
  "Plan is documented",
  "",
  "### `context-implement` — Implement",
  "Feature implemented",
  "",
  "### `context-verify` — Verify",
  "Verification passes",
];

function contract(
  projection: GraphRolePromptProjection | null,
): GraphExecutionContract {
  return {
    validateDefinition: () => ({ ok: true }),
    loadLiveEdit: () => ({
      validateOperation: () => ({ ok: true }),
      accountabilityCoverageGroups: [],
    }),
    validateTaskCompletion: () => ({ ok: true }),
    deriveContextAcceptanceCriteria: () => ({
      ok: true,
      acceptanceCriteriaByContextId: {},
    }),
    loadPromptProjection: async () => projection,
  };
}

function validatorPrompt(input: {
  projection: GraphRolePromptProjection | null;
  contextId?: string;
}): Promise<string> {
  return composeGraphRolePrompt({
    execution: createWorkflowExecution({ id: "execution-prompt-composer" }),
    executionContract: contract(input.projection),
    prompt: BASE_PROMPT,
    role: "context-validator",
    ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
  });
}

describe("composeGraphRolePrompt", () => {
  describe("context-validator without a prompt projection", () => {
    it("renders the deferral cohort with no dangling Spec ownership reference", async () => {
      const prompt = await validatorPrompt({
        projection: null,
        contextId: "context-plan",
      });

      expect(prompt).toBe(
        [
          "## Acceptance-criteria cohort for deferral checks",
          DEFERRAL_PARAGRAPH,
          "",
          COHORT_INTRO_PARAGRAPH,
          "",
          ...PLAN_COHORT_LISTING,
          "",
          BASE_PROMPT,
        ].join("\n"),
      );
      expect(prompt).not.toContain("Spec ownership");
      expect(prompt).not.toContain(OWNERSHIP_PARAGRAPH);
    });

    it("limits the cohort to the current context when nothing is downstream", async () => {
      const prompt = await validatorPrompt({
        projection: null,
        contextId: "context-verify",
      });

      expect(prompt).toBe(
        [
          "## Acceptance-criteria cohort for deferral checks",
          DEFERRAL_PARAGRAPH,
          "",
          COHORT_INTRO_PARAGRAPH,
          "",
          "### `context-verify` — Verify (current context)",
          "Verification passes",
          "",
          BASE_PROMPT,
        ].join("\n"),
      );
    });

    it("refuses a validator prompt that names no current context", async () => {
      await expect(validatorPrompt({ projection: null })).rejects.toThrow(
        "A context-validator prompt requires its current context id",
      );
    });

    it("refuses a validator prompt for a context outside the working definition", async () => {
      await expect(
        validatorPrompt({ projection: null, contextId: "context-missing" }),
      ).rejects.toThrow(
        "Cannot compose validator deferral cohort for missing context context-missing",
      );
    });
  });

  describe("context-validator with a prompt projection", () => {
    it("keeps the spec-bound rendering byte-identical", async () => {
      const prompt = await validatorPrompt({
        projection: PROJECTION,
        contextId: "context-plan",
      });

      expect(prompt).toBe(
        [
          "# Spec ownership (authoritative)",
          "",
          "This immutable binding is the authority for criterion ownership.",
          "",
          "## Acceptance-criteria cohort for deferral checks",
          OWNERSHIP_PARAGRAPH,
          "",
          DEFERRAL_PARAGRAPH,
          "",
          COHORT_INTRO_PARAGRAPH,
          "",
          ...PLAN_COHORT_LISTING,
          "",
          BASE_PROMPT,
        ].join("\n"),
      );
    });
  });

  describe("implementer role", () => {
    it("returns the bare prompt when no projection exists", async () => {
      const prompt = await composeGraphRolePrompt({
        execution: createWorkflowExecution({ id: "execution-prompt-composer" }),
        executionContract: contract(null),
        prompt: BASE_PROMPT,
      });

      expect(prompt).toBe(BASE_PROMPT);
    });

    it("prefixes the projection without the validator-only cohort", async () => {
      const prompt = await composeGraphRolePrompt({
        execution: createWorkflowExecution({ id: "execution-prompt-composer" }),
        executionContract: contract(PROJECTION),
        prompt: BASE_PROMPT,
        role: "implementer",
      });

      expect(prompt).toBe(
        [
          "# Spec ownership (authoritative)",
          "",
          "This immutable binding is the authority for criterion ownership.",
          "",
          BASE_PROMPT,
        ].join("\n"),
      );
      expect(prompt).not.toContain(
        "## Acceptance-criteria cohort for deferral checks",
      );
    });
  });
});
