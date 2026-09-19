import { describe, expect, it } from "vitest";

import type { GraphExecutionContract } from "./execution-contract-port";
import { composeGraphRolePrompt } from "./prompt-composer";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";
import { buildContextValidationPrompt } from "./validator-runner";
import type { ValidationPromptSelections } from "./validation-prompt-section";

const EMPTY_VALIDATION_SELECTIONS = {
  registry: "none",
  enabled: { kind: "commands", commands: [] },
  disabled: [],
  scriptGate: { kind: "off" },
} satisfies ValidationPromptSelections;

const ownershipProjection = {
  heading: "Spec ownership",
  body: [
    "This immutable binding is the authority for criterion ownership.",
    "",
    "| Criterion id | Claimant context ids |",
    "| --- | --- |",
    "| `criterion-sibling` | `context-verify` |",
    "| `criterion-dynamic` | `context-plan` |",
    "| `criterion-unrelated` | `context-unrelated` |",
  ].join("\n"),
};

function contract(): GraphExecutionContract {
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
    loadPromptProjection: async () => ownershipProjection,
  };
}

function executionFor(input: {
  currentAcceptanceCriteria: string;
  siblingAcceptanceCriteria: string;
  upstreamAcceptanceCriteria?: string;
  unrelatedAcceptanceCriteria?: string;
}) {
  const base = createResolvedWorkflowDefinition();
  const unrelatedTemplate = base.executionContexts.find(
    (context) => context.id === "context-verify",
  );
  if (unrelatedTemplate === undefined)
    throw new Error("missing context-verify");
  const workingDefinition = createResolvedWorkflowDefinition({
    executionContexts: [
      ...base.executionContexts.map((context) => {
        if (context.id === "context-implement") {
          return {
            ...context,
            acceptanceCriteria: input.currentAcceptanceCriteria,
          };
        }
        if (context.id === "context-verify") {
          return {
            ...context,
            acceptanceCriteria: input.siblingAcceptanceCriteria,
          };
        }
        if (context.id === "context-plan") {
          return {
            ...context,
            title: "Dynamic work orchestrator",
            acceptanceCriteria:
              input.upstreamAcceptanceCriteria ??
              "Own the generated expansion and loop work through its integrated authored outcome.",
          };
        }
        return context;
      }),
      {
        ...unrelatedTemplate,
        id: "context-unrelated",
        title: "Unrelated claimant",
        acceptanceCriteria:
          input.unrelatedAcceptanceCriteria ??
          "Run regression tests for the unrelated status endpoint.",
        placement: { lane: "unrelated", mode: "full" },
      },
    ],
  });
  return createWorkflowExecution({
    id: "execution-deferral-integrity",
    workingDefinition,
  });
}

function deferralCohort(prompt: string): string {
  const start = prompt.indexOf(
    "## Acceptance-criteria cohort for deferral checks",
  );
  const end = prompt.indexOf("# Context Validation", start);
  if (start < 0 || end < 0) {
    throw new Error("missing validator deferral cohort");
  }
  return prompt.slice(start, end);
}

async function validatorPrompt(input: {
  currentAcceptanceCriteria: string;
  siblingAcceptanceCriteria: string;
  upstreamAcceptanceCriteria?: string;
  unrelatedAcceptanceCriteria?: string;
}): Promise<string> {
  const execution = executionFor(input);
  const context = execution.workingDefinition.executionContexts.find(
    (candidate) => candidate.id === "context-implement",
  );
  if (context === undefined) throw new Error("missing context-implement");
  const tasks = execution.workingDefinition.tasks.filter(
    (task) => task.contextId === context.id,
  );
  const validator = context.implementer.profileSnapshot
    ? {
        ...context.implementer,
        authority: "blocking" as const,
      }
    : neverContext();
  const basePrompt = buildContextValidationPrompt({
    context,
    tasks,
    taskStates: execution.taskStates,
    validator,
    validationSelections: EMPTY_VALIDATION_SELECTIONS,
  });

  return composeGraphRolePrompt({
    execution,
    executionContract: contract(),
    prompt: basePrompt,
    role: "context-validator",
    contextId: context.id,
  });
}

function neverContext(): never {
  throw new Error("fixture implementer must be seeded");
}

describe("validator deferral integrity", () => {
  it("keeps all claimant ownership visible while limiting the acceptance-criteria cohort to the current and downstream contexts", async () => {
    const prompt = await validatorPrompt({
      currentAcceptanceCriteria:
        "Implement the adapter. context-verify owns wiring the publisher into production startup.",
      siblingAcceptanceCriteria:
        "Wire the publisher into the production startup call path and verify event publication.",
    });
    const cohort = deferralCohort(prompt);

    expect(prompt).toContain("criterion-sibling");
    expect(prompt).toContain("`context-verify`");
    expect(prompt).toContain("criterion-dynamic");
    expect(prompt).toContain("`context-plan`");
    expect(prompt).toContain("criterion-unrelated");
    expect(prompt).toContain("`context-unrelated`");
    expect(cohort).toContain("### `context-implement`");
    expect(cohort).toContain("### `context-verify`");
    expect(cohort).not.toContain("### `context-plan`");
    expect(cohort).not.toContain("### `context-unrelated`");
    expect(prompt).toContain(
      "Do not fail this context for criterion work assigned only to another claimant",
    );
    expect(prompt).toContain("dynamic orchestrator");
    expect(prompt).toContain(
      "without tracing generated children or loop instances",
    );
  });

  it("renders both accepted downstream deferral evidence routes", async () => {
    const prompt = await validatorPrompt({
      currentAcceptanceCriteria:
        "Implement the adapter. context-verify owns wiring the publisher into production startup.",
      siblingAcceptanceCriteria:
        "Wire the publisher into the production startup call path and verify event publication.",
    });

    expect(prompt).toContain(
      "## Acceptance-criteria cohort for deferral checks",
    );
    expect(prompt).toContain(
      "context-verify owns wiring the publisher into production startup",
    );
    expect(prompt).toContain(
      "Wire the publisher into the production startup call path",
    );
    expect(prompt).toContain(
      "Ownership alone never authorizes a production-capability deferral",
    );
    expect(prompt).toContain(
      "current context's acceptance criteria explicitly name that downstream owner",
    );
    expect(prompt).toContain(
      "downstream owner's acceptance criteria below contain the matching obligation",
    );
  });

  it("excludes upstream and unrelated claimant obligations from production deferral evidence", async () => {
    const prompt = await validatorPrompt({
      currentAcceptanceCriteria:
        "Implement and unit-test the publisher adapter with no production integration claim.",
      siblingAcceptanceCriteria:
        "Run regression tests for the downstream status endpoint.",
      upstreamAcceptanceCriteria:
        "Wire the publisher into the production startup call path from the dynamic orchestrator.",
      unrelatedAcceptanceCriteria:
        "Wire the publisher into the production startup call path from the unrelated claimant.",
    });
    const cohort = deferralCohort(prompt);

    expect(prompt).toContain("criterion-dynamic");
    expect(prompt).toContain("criterion-unrelated");
    expect(cohort).not.toContain("from the dynamic orchestrator");
    expect(cohort).not.toContain("from the unrelated claimant");
    expect(cohort).toContain(
      "Run regression tests for the downstream status endpoint.",
    );
    expect(cohort).toContain(
      "Upstream or unrelated claimants remain ownership-visible but cannot authorize a future production handoff",
    );
  });

  it("refuses an invented wiring handoff when neither acceptance-criteria route names the obligation", async () => {
    const prompt = await validatorPrompt({
      currentAcceptanceCriteria:
        "Implement and unit-test the publisher adapter with no production integration claim.",
      siblingAcceptanceCriteria:
        "Run regression tests for the unrelated status endpoint.",
    });

    expect(prompt).toContain(
      "Implement and unit-test the publisher adapter with no production integration claim.",
    );
    expect(prompt).toContain(
      "Run regression tests for the unrelated status endpoint.",
    );
    expect(prompt).toContain(
      "A claim, context title, graph edge, or vague downstream reference is not enough",
    );
    expect(prompt).toContain(
      "If neither route is present, raise an issue for the missing production call path",
    );
    expect(prompt).not.toContain("context-verify => publisher wiring");
  });
});
