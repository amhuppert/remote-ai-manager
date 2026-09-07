import { createNonParticipatingGraphExecutionContract } from "@/lib/workflow-graph/execution-contract-port";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createValidatorRunner } from "./validator-runner";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
  seedAssignment,
} from "./test-fixtures";
import type { ExecuteWorkflowTaskRunInput } from "@/lib/workflows/conversation/execute-workflow-task-run";
import type { TaskRunResult } from "@/lib/workflows/conversation/turn-result";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { ValidatorAssignment } from "@/lib/workflow-graph/config-schemas";
import type { GraphWorkflowResolvedContext } from "@/lib/workflow-graph/definition-schemas";
import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";
import { workflowCharterSchema } from "@/lib/workflows/charter-schemas";

/**
 * Behavioral fixture: the AeroTrainer "floor/round" reproduction — the primary
 * acceptance fixture for the workflow-charter feature's intent.
 *
 * History the feature exists to prevent: an implementer correctly followed a
 * higher-ranked CODE prototype for the floor/round rule; the per-context
 * acceptance criterion restated that rule INCORRECTLY; the validator enforced
 * the wrong acceptance criterion and reopened the work, and a later context
 * silently reverted the correct implementation.
 *
 * Under the plan-time-resolution model (simplification change 3) the runtime
 * no longer arbitrates that conflict: source conflicts are resolved during
 * planning, so the validator prompt carries the context's ranked references
 * WITHOUT the retired precedence/deferral rule. This fixture pins two REAL
 * production paths and simulates ONLY the LLM's judgment via the existing
 * `executeWorkflowTaskRun` dependency-injection seam on
 * `createValidatorRunner`:
 *
 *   1. The REAL validator prompt built by `runContextValidator` for this
 *      floor/round conflict carries the charter digest at the top and ranks
 *      the code prototype ABOVE the contradicting acceptance-criterion source
 *      — and carries none of the retired runtime-governance text (deferral
 *      rule, access policy, amendment log).
 *   2. With the injected fake standing in for a validator that records a
 *      conflict resolution in its verdict (empty `issues`, a `summary` naming
 *      the criterion, the prevailing rank-1 source, and the resolution), the
 *      runner's REAL outcome derivation (`issues.length === 0` ⇒ PASS, with
 *      `summary` passed through) yields a PASS whose summary records the
 *      conflict.
 *
 * The fake never decides anything: it returns a fixed result so the assertions
 * exercise the production prompt builder and the production pass/summary
 * derivation, not the fake itself.
 */

// Rank-1 authoritative prototype: rounding HALF-UP at the boundary.
const ROUNDING_PROTOTYPE_LOCATOR = "src/prototype/rounding.ts";

// The criterion the validator must NOT enforce: it restates the rule with
// `Math.floor`, contradicting the higher-ranked prototype's half-up rounding.
const WRONG_ACCEPTANCE_CRITERION =
  "Scores at a half-point boundary must be rounded down with Math.floor(score) so a 4.5 becomes 4.";

const floorRoundCharter: WorkflowCharter = workflowCharterSchema.parse({
  mission:
    "Compute AeroTrainer session scores exactly as the authoritative rounding prototype prescribes.",
  nonGoals: ["Do not change the scoring storage schema."],
  knownAmbiguities: [
    "The acceptance-criteria document restates the rounding rule and may drift from the prototype.",
  ],
  sourcesOfTruth: [
    {
      rank: 1,
      id: "rounding-prototype",
      label: "AeroTrainer rounding prototype",
      type: "code",
      locator: ROUNDING_PROTOTYPE_LOCATOR,
      description:
        "Authoritative implementation: scores at a half-point boundary round HALF-UP, so a 4.5 becomes 5. This prototype governs all score rounding.",
      appliesTo: "src/scoring/**",
      accessPolicy: "worktree-relative",
    },
    {
      rank: 2,
      id: "scoring-acceptance-doc",
      label: "Scoring acceptance-criteria document",
      type: "document",
      locator: "docs/scoring-acceptance.md",
      description:
        "Per-context acceptance criteria for scoring; defers to the rounding prototype where they disagree.",
      appliesTo: "src/scoring/**",
      accessPolicy: "worktree-relative",
    },
  ],
});

const validatorConfig: ValidatorAssignment = {
  id: "general",
  profile: { tier: "builtin" as const, id: "general-reviewer" },
  strategy: "conversation" as const,
  authority: "blocking",
  agent: {
    backend: "claude",
    modelSelection: { modelId: "sonnet", parameters: { effort: "medium" } },
  },
  continuity: { enabled: true },
};

// A real directory: composing the lane write envelope canonicalizes the
// candidate worktree and fails closed when it cannot resolve.
const stubWorktreeDir = mkdtempSync(path.join(tmpdir(), "cc-validator-wt-"));
const stubWorktreePath = async () => stubWorktreeDir;
const stubTimeoutMs = async () => 300_000;
const stubProjectDisplayName = () => "test-project";

/**
 * Build a running execution whose `context-plan` carries the wrong acceptance
 * criterion, has its two tasks completed, and where the completed-task summary
 * records that the implementer followed the rank-1 prototype and cited it.
 */
function buildFloorRoundExecution(): GraphWorkflowExecution {
  const baseDefinition = createResolvedWorkflowDefinition();
  const definition = createResolvedWorkflowDefinition({
    executionContexts: baseDefinition.executionContexts.map((ctx) =>
      ctx.id === "context-plan"
        ? {
            ...ctx,
            title: "Implement scoring",
            acceptanceCriteria: WRONG_ACCEPTANCE_CRITERION,
            contextValidator: {
              enabled: true,
              assignments: [seedAssignment(validatorConfig)],
            },
          }
        : ctx,
    ),
    tasks: [
      {
        id: "task-plan-1",
        contextId: "context-plan",
        order: 1,
        title: "Implement score rounding",
        instructions: "Round AeroTrainer session scores per the charter.",
        source: "user",
      },
      ...baseDefinition.tasks.filter(
        (task) => task.contextId !== "context-plan",
      ),
    ],
  });

  const base = createWorkflowExecution({
    status: "running",
    activeContextIds: ["context-plan"],
    workingDefinition: definition,
    charter: floorRoundCharter,
  });

  return {
    ...base,
    contextStates: {
      ...base.contextStates,
      "context-plan": {
        ...base.contextStates["context-plan"]!,
        status: "running",
        totalTaskCount: 1,
        completedTaskCount: 1,
      },
    },
    taskStates: {
      ...base.taskStates,
      "task-plan-1": {
        ...base.taskStates["task-plan-1"]!,
        status: "completed",
        summary:
          "Implemented half-up rounding so a 4.5 becomes 5, following the rank-1 rounding-prototype " +
          `source (\`${ROUNDING_PROTOTYPE_LOCATOR}\`). This conflicts with the acceptance criterion's ` +
          "Math.floor rule; per the charter the higher-ranked prototype prevails.",
        completedAt: "2026-03-27T16:10:00.000Z",
      },
    },
  };
}

/**
 * A conflict-recording verdict as a validator LLM would emit it after judging
 * that the implementation follows the plan's rank-1 authority: empty `issues`
 * (so the runner derives PASS) and a `summary` that records the affected
 * criterion, the prevailing rank-1 source, and the resolution.
 */
const DEFERRAL_SUMMARY =
  "Conflict resolved by the charter precedence. Affected acceptance criterion: the Math.floor " +
  "round-down rule. Prevailing source: rank-1 'AeroTrainer rounding prototype' (src/prototype/rounding.ts), " +
  "which rounds half-up. Resolution: the implementation correctly follows the higher-ranked prototype " +
  "(4.5 -> 5); the lower-ranked acceptance criterion is flagged as wrong and not enforced. Context passes.";

function deferralTaskRun(): TaskRunResult {
  return {
    kind: "text",
    text: [
      "```json",
      JSON.stringify({
        summary: DEFERRAL_SUMMARY,
        issues: [],
        advisories: [],
      }),
      "```",
    ].join("\n"),
    usage: {
      costUsd: null,
      durationMs: null,
      contextTokens: null,
      contextWindowMax: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    },
    backendRef: null,
    continuationDisposition: "retain",
  };
}

describe("charter floor/round conflict behavioral fixture", () => {
  it("builds a validator prompt that opens with the charter and ranks the prototype above the contradicting AC, without the retired deferral rule", async () => {
    let capturedPrompt: string | undefined;
    const executeWorkflowTaskRun = vi.fn(
      async (input: ExecuteWorkflowTaskRunInput) => {
        capturedPrompt = input.prompt;
        return deferralTaskRun();
      },
    );

    const runner = createValidatorRunner({
      executionContract: createNonParticipatingGraphExecutionContract(),
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const execution = buildFloorRoundExecution();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const contextWithCharter: GraphWorkflowResolvedContext = {
      ...contextDef,
      charter: floorRoundCharter,
    };

    await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextWithCharter,
      validator: seedAssignment(validatorConfig),
    });

    expect(executeWorkflowTaskRun).toHaveBeenCalledTimes(1);
    const prompt = capturedPrompt!;

    // The charter digest opens the builder's section, ahead of the validation
    // header. The composer's acceptance-criteria deferral cohort precedes it on
    // every dispatched validator prompt.
    expect(prompt.indexOf("# Workflow Charter")).toBeGreaterThan(-1);
    expect(prompt.indexOf("# Workflow Charter")).toBeLessThan(
      prompt.indexOf("# Context Validation"),
    );

    // The higher-ranked code prototype is presented ABOVE the contradicting
    // acceptance-criteria document in the ranked hierarchy.
    const prototypeIndex = prompt.indexOf("AeroTrainer rounding prototype");
    const acDocIndex = prompt.indexOf("Scoring acceptance-criteria document");
    expect(prototypeIndex).toBeGreaterThan(-1);
    expect(acDocIndex).toBeGreaterThan(-1);
    expect(prototypeIndex).toBeLessThan(acDocIndex);
    expect(prompt).toContain(`\`${ROUNDING_PROTOTYPE_LOCATOR}\``);

    // Change 3: the runtime deferral/precedence rule, access-policy
    // instructions, and amendment history retired from every agent prompt —
    // conflicts among sources are resolved at plan time, and the validator
    // judges the contract with the ranked references as context.
    const lowered = prompt.toLowerCase();
    expect(lowered).not.toContain("higher-ranked source");
    expect(lowered).not.toContain("prevailing source");
    expect(prompt).not.toContain("Applying the source-of-truth hierarchy");
    expect(lowered).not.toContain("permission-gated");
    expect(prompt).not.toContain("Amendment log");
  });

  it("passes the context and carries the validator's conflict-recording summary through the outcome derivation", async () => {
    const executeWorkflowTaskRun = vi.fn(
      async (_input: ExecuteWorkflowTaskRunInput) => deferralTaskRun(),
    );

    const runner = createValidatorRunner({
      executionContract: createNonParticipatingGraphExecutionContract(),
      resolveWorktreePath: stubWorktreePath,
      resolveTimeoutMs: stubTimeoutMs,
      executeWorkflowTaskRun,
      getProjectDisplayName: stubProjectDisplayName,
    });

    const execution = buildFloorRoundExecution();
    const contextDef = execution.workingDefinition.executionContexts.find(
      (c) => c.id === "context-plan",
    )!;
    const contextWithCharter: GraphWorkflowResolvedContext = {
      ...contextDef,
      charter: floorRoundCharter,
    };

    const result = await runner.runContextValidator({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      context: contextWithCharter,
      validator: seedAssignment(validatorConfig),
    });

    // The real outcome derivation (issues.length === 0 ⇒ PASS) produces a pass
    // with no reopened tasks — the floor/round work is NOT reverted.
    expect(result.result.kind).toBe("pass");
    if (result.result.kind === "pass") {
      expect(result.result.reopenTaskIds).toEqual([]);
      expect(result.result.issues).toEqual([]);

      // The conflict is recorded in the existing `summary` (no schema change):
      // affected criterion, prevailing rank-1 source, and resolution.
      const summary = result.result.summary;
      expect(summary).toContain("acceptance criterion");
      expect(summary).toContain("AeroTrainer rounding prototype");
      expect(summary).toContain(ROUNDING_PROTOTYPE_LOCATOR);
      expect(summary).toMatch(/half-up|4\.5 -> 5|prevail/i);
    }
  });
});
