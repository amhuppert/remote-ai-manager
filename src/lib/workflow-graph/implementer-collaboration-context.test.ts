/**
 * Tests for the implementer-side collaboration context builder (Task 4.3).
 *
 * The builder produces the `GraphWorkflowCollaborationContextBlock` that the
 * workflow MCP gateway attaches to the tool-server context for implementer
 * registrations. It must derive a non-empty `parentImplementerTurnId` on
 * every invocation, expose a callable `triggerWorkflowCollaboration`, and
 * resolve collaboration config with provenance.
 */

import { describe, expect, it, vi } from "vitest";
import { buildImplementerCollaborationContext } from "./implementer-collaboration-context";
import type { GraphWorkflowHaltReason } from "@/lib/workflow-graph/schemas";
import type { ResolvedCollaborationConfig } from "@/lib/workflow-graph/collaboration-schemas";

function resolvedCollaborationFixture(
  overrides?: Partial<ResolvedCollaborationConfig>,
): ResolvedCollaborationConfig {
  return {
    secondAgent: {
      value: { backend: "codex", model: "gpt-5.4", reasoningEffort: "medium" },
      source: "global",
    },
    negotiationRounds: { value: 4, source: "global" },
    autonomousResolutionThreshold: { value: "minor", source: "global" },
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
    resolvedCollaboration: resolvedCollaborationFixture(),
  };
}

function baseDeps() {
  return {
    setPendingHaltReason: vi.fn(async () => undefined),
    triggerWorkflowCollaboration: vi.fn(async () => ({
      workflowId: "collab-1",
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

  it("returns the pre-resolved collaboration config verbatim from resolveCollaborationConfig", () => {
    const resolvedCollaboration = resolvedCollaborationFixture({
      negotiationRounds: { value: 2, source: "workflow" },
      autonomousResolutionThreshold: { value: "none", source: "per-node" },
    });
    const block = buildImplementerCollaborationContext(
      { ...baseInput(), resolvedCollaboration },
      baseDeps(),
    );

    expect(block.resolveCollaborationConfig()).toEqual(resolvedCollaboration);
  });

  it("provides a callable triggerWorkflowCollaboration that delegates to the injected dep", async () => {
    const deps = baseDeps();
    const block = buildImplementerCollaborationContext(baseInput(), deps);

    expect(typeof block.triggerWorkflowCollaboration).toBe("function");

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

    await block.triggerWorkflowCollaboration({
      brief: "test brief",
      resolvedConfig,
      parentImplementerTurnId: block.parentImplementerTurnId,
      executionContextId: "ctx-implement",
      conversationId: "conv-1",
      executionId: "exec-1",
      iterationIndex: 0,
    });

    expect(deps.triggerWorkflowCollaboration).toHaveBeenCalledTimes(1);
    expect(deps.triggerWorkflowCollaboration).toHaveBeenCalledWith(
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
