/**
 * Tests for the implementer-side collaboration context builder (Task 4.3).
 *
 * The builder produces the `GraphWorkflowCollaborationContextBlock` that the
 * workflow MCP gateway attaches to the tool-server context for implementer
 * registrations. It must derive a non-empty `parentImplementerTurnId` on
 * every invocation, expose a callable `startWorkflowCollaboration`, and
 * resolve collaboration config with provenance.
 */

import { describe, expect, it, vi } from "vitest";
import { buildImplementerCollaborationContext } from "./implementer-collaboration-context";
import type { WorkflowDefaults } from "@/lib/config/schemas";
import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowHaltReason,
  ResolvedCollaborationConfig,
  WorkflowCollaborationResult,
  WorkflowConfigOverride,
} from "@/lib/workflows/schemas";

function globalDefaultsFixture(): WorkflowDefaults {
  return {
    implementer: {
      backend: "claude",
      model: "opus",
      reasoningEffort: "medium",
    },
    contextValidator: {
      type: "claude",
      enabled: true,
      continuity: { enabled: true },
      agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
    },
    scriptValidator: { enabled: false },
    iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
    circuitBreaker: { consecutiveFailureThreshold: 3 },
    mutability: { allowAgentTaskAdd: false },
    collaboration: {
      secondAgent: {
        backend: "codex",
        model: "gpt-5.4",
        reasoningEffort: "medium",
      },
      negotiationRounds: 4,
      autonomousResolutionThreshold: "minor",
    },
  };
}

function contextDefinitionFixture(
  overrides?: Partial<GraphWorkflowExecutionContextDefinition>,
): GraphWorkflowExecutionContextDefinition {
  return {
    id: "ctx-implement",
    title: "Implement",
    acceptanceCriteria: "all tasks complete",
    ...overrides,
  };
}

function baseInput() {
  return {
    projectPath: "/proj",
    sessionName: "sess",
    executionId: "exec-1",
    contextId: "ctx-implement",
    conversationId: "conv-1",
    iterationIndex: 0,
    globalDefaults: globalDefaultsFixture(),
    workflowConfig: {} as WorkflowConfigOverride,
    executionContextDefinition: contextDefinitionFixture(),
  };
}

function baseDeps() {
  return {
    setPendingHaltReason: vi.fn(async () => undefined),
    startWorkflowCollaboration: vi.fn(async () => ({
      result: {
        status: "converged",
        finalAnswer: "ok",
        openConflicts: [],
      } satisfies WorkflowCollaborationResult,
      roundsConsumed: 1,
    })),
  };
}

describe("buildImplementerCollaborationContext", () => {
  it("derives a non-empty parentImplementerTurnId on every invocation", () => {
    const a = buildImplementerCollaborationContext(baseInput(), baseDeps());
    const b = buildImplementerCollaborationContext(baseInput(), baseDeps());
    expect(a.parentImplementerTurnId).toBeTruthy();
    expect(a.parentImplementerTurnId.length).toBeGreaterThan(0);
    expect(b.parentImplementerTurnId).toBeTruthy();
    expect(a.parentImplementerTurnId).not.toEqual(b.parentImplementerTurnId);
  });

  it("uses the injected parentImplementerTurnIdFactory when provided", () => {
    const block = buildImplementerCollaborationContext(baseInput(), {
      ...baseDeps(),
      parentImplementerTurnIdFactory: () => "turn-deterministic",
    });
    expect(block.parentImplementerTurnId).toBe("turn-deterministic");
  });

  it("threads executionContextId, conversationId, and executionId from the input", () => {
    const input = {
      ...baseInput(),
      executionId: "exec-42",
      contextId: "ctx-impl-7",
      conversationId: "conv-99",
    };
    const block = buildImplementerCollaborationContext(input, baseDeps());
    expect(block.executionContextId).toBe("ctx-impl-7");
    expect(block.conversationId).toBe("conv-99");
    expect(block.executionId).toBe("exec-42");
  });

  it("provides a resolveCollaborationConfig that returns provenanced config from the cascade", () => {
    const input = {
      ...baseInput(),
      workflowConfig: {
        collaboration: { negotiationRounds: 2 },
      } as WorkflowConfigOverride,
      executionContextDefinition: contextDefinitionFixture({
        collaboration: { autonomousResolutionThreshold: "none" },
      }),
    };
    const block = buildImplementerCollaborationContext(input, baseDeps());

    const resolved = block.resolveCollaborationConfig();
    expect(resolved.secondAgent.source).toBe("global");
    expect(resolved.negotiationRounds).toEqual({
      value: 2,
      source: "workflow",
    });
    expect(resolved.autonomousResolutionThreshold).toEqual({
      value: "none",
      source: "per-node",
    });
  });

  it("provides a callable startWorkflowCollaboration that delegates to the injected dep", async () => {
    const deps = baseDeps();
    const block = buildImplementerCollaborationContext(baseInput(), deps);

    expect(typeof block.startWorkflowCollaboration).toBe("function");

    const resolvedConfig: ResolvedCollaborationConfig = {
      secondAgent: {
        value: {
          backend: "codex",
          model: "gpt-5.4",
          reasoningEffort: "medium",
        },
        source: "global",
      },
      negotiationRounds: { value: 4, source: "global" },
      autonomousResolutionThreshold: { value: "minor", source: "global" },
    };

    await block.startWorkflowCollaboration({
      brief: "test brief",
      resolvedConfig,
      parentImplementerTurnId: block.parentImplementerTurnId,
      executionContextId: "ctx-implement",
      conversationId: "conv-1",
      executionId: "exec-1",
      iterationIndex: 0,
    });

    expect(deps.startWorkflowCollaboration).toHaveBeenCalledTimes(1);
    expect(deps.startWorkflowCollaboration).toHaveBeenCalledWith(
      expect.objectContaining({
        brief: "test brief",
        executionContextId: "ctx-implement",
        conversationId: "conv-1",
        executionId: "exec-1",
        iterationIndex: 0,
      }),
    );
  });

  it("provides a callable setPendingHaltReason that delegates to the injected dep", async () => {
    const deps = baseDeps();
    const block = buildImplementerCollaborationContext(baseInput(), deps);

    const reason: GraphWorkflowHaltReason = {
      type: "collaboration_failure",
      status: "objective_disagreement",
      brief: "Should we use Postgres?",
      executionContextId: "ctx-implement",
      conversationId: "conv-1",
      summary: "collaboration ended with status=objective_disagreement",
    };

    await block.setPendingHaltReason(reason);

    expect(deps.setPendingHaltReason).toHaveBeenCalledTimes(1);
    expect(deps.setPendingHaltReason).toHaveBeenCalledWith(reason);
  });
});
