import { describe, expect, it, vi } from "vitest";
import type { WorkflowDefaults } from "@/lib/config/schemas";
import type { ResolvedCollaborationConfig } from "@/lib/workflow-graph/collaboration-schemas";
import type { GraphWorkflowResolvedContext } from "@/lib/workflow-graph/definition-schemas";
import {
  resolveLaneToolCollaborationConfig,
  type LaneCollaborationFallbackInputs,
} from "./lane-collaboration-resolver";
import { makeProfileSnapshot } from "./test-fixtures";

const GLOBAL_DEFAULTS: WorkflowDefaults = {
  implementer: {
    id: "implementer",
    profile: { tier: "builtin", id: "general-implementer" },
    agent: { backend: "claude", model: "opus", reasoningEffort: "medium" },
  },
  contextValidator: {
    enabled: true,
    assignments: [
      {
        id: "general",
        profile: { tier: "builtin", id: "general-reviewer" },
        strategy: "conversation",
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
        continuity: { enabled: true },
      },
    ],
  },
  scriptValidator: { enabled: false },
  humanApprovalGate: { enabled: false },
  askUserQuestions: { enabled: false },
  iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
  circuitBreaker: { consecutiveFailureThreshold: 3 },
  mutability: { allowAgentTaskAdd: false },
  planRepair: { enabled: true, maxAttemptsPerContext: 2 },
  collaboration: {
    enabled: false,
    secondAgent: {
      backend: "claude",
      model: "sonnet",
      reasoningEffort: "medium",
    },
    negotiationRounds: 3,
    autonomousResolutionThreshold: "minor",
  },
};

function resolvedContext(
  overrides: Partial<GraphWorkflowResolvedContext> = {},
): GraphWorkflowResolvedContext {
  return {
    id: "ctx-1",
    title: "Implement",
    acceptanceCriteria: "all tasks complete",
    implementer: {
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      profileSnapshot: makeProfileSnapshot(),
      agent: {
        backend: "claude",
        model: "opus",
        reasoningEffort: "medium",
      },
    },
    contextValidator: { enabled: false, assignments: [] },
    scriptValidator: { enabled: false },
    humanApprovalGate: { enabled: false },
    askUserQuestions: { enabled: false },
    mutability: { allowAgentTaskAdd: false },
    circuitBreaker: { consecutiveFailureThreshold: 3 },
    iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
    planRepair: { enabled: true, maxAttemptsPerContext: 2 },
    ...overrides,
  };
}

const WORKING_COPY_COLLABORATION: ResolvedCollaborationConfig = {
  enabled: { value: true, source: "per-node" },
  secondAgent: {
    value: { backend: "codex", model: "gpt-5.4", reasoningEffort: "high" },
    source: "per-node",
  },
  negotiationRounds: { value: 5, source: "workflow" },
  autonomousResolutionThreshold: { value: "major", source: "global" },
};

describe("resolveLaneToolCollaborationConfig", () => {
  it("prefers the working copy and never reloads the saved definition when present", async () => {
    const loadFallbackInputs = vi.fn(async () => {
      throw new Error("must not reload the saved definition");
    });

    const resolved = await resolveLaneToolCollaborationConfig(
      resolvedContext({ collaboration: WORKING_COPY_COLLABORATION }),
      { loadFallbackInputs },
    );

    expect(resolved).toEqual(WORKING_COPY_COLLABORATION);
    expect(loadFallbackInputs).not.toHaveBeenCalled();
  });

  it("falls back to the saved-definition reload cascade only when the working copy lacks it", async () => {
    const fallbackInputs: LaneCollaborationFallbackInputs = {
      globalDefaults: GLOBAL_DEFAULTS,
      workflowConfig: { collaboration: { negotiationRounds: 7 } },
      contextDefinition: {
        id: "ctx-1",
        title: "Implement",
        acceptanceCriteria: "all tasks complete",
        collaboration: {
          secondAgent: {
            backend: "claude",
            model: "haiku",
            reasoningEffort: "low",
          },
        },
      },
    };
    const loadFallbackInputs = vi.fn(async () => fallbackInputs);

    const resolved = await resolveLaneToolCollaborationConfig(
      resolvedContext(),
      { loadFallbackInputs },
    );

    expect(loadFallbackInputs).toHaveBeenCalledTimes(1);
    // Cascade provenance: per-node second agent, workflow rounds, global threshold.
    expect(resolved.secondAgent).toEqual({
      value: { backend: "claude", model: "haiku", reasoningEffort: "low" },
      source: "per-node",
    });
    expect(resolved.negotiationRounds).toEqual({
      value: 7,
      source: "workflow",
    });
    expect(resolved.autonomousResolutionThreshold).toEqual({
      value: "minor",
      source: "global",
    });
  });
});
