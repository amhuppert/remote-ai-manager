/**
 * Tests for `parseAndInjectArtifact`: the orchestrator parses a phase turn's
 * model-authored content, then injects the bookkeeping it owns (envelope
 * kind/agent/target_agent/round and each generated artifact's round/agent/phase)
 * to reconstruct the full persisted artifact.
 *
 * Pure function, no mocks: the real content + full Zod schemas validate a hand
 * built structured output. The confidence test holds — replacing the helper with
 * a pass-through would fail the injection and round-trip assertions.
 */
import { describe, expect, it } from "vitest";

import { parseAndInjectArtifact } from "./helpers";
import {
  collaborationArtifactSchema,
  collaborationProposedChangesContentSchema,
  collaborationProposedChangesOutputSchema,
} from "./types";
import type { AgentCallResult } from "@/lib/workflows/primitives/agent-call-vocabulary";

function completed(structuredOutput: unknown): AgentCallResult {
  return {
    backend: "claude",
    backendRef: { backend: "claude", sessionId: "sess" },
    capabilities: {
      backend: "claude",
      continuationStrength: "precise_session",
      structuredOutputEnforcement: "post_validation",
      mcpApplicationBoundary: "between_turns",
      contextMetricsAvailable: true,
      nativeMidTurnAskUser: true,
    },
    usage: { durationMs: 1 },
    artifacts: [],
    outcome: { kind: "completed", text: "synthetic", structuredOutput },
  };
}

const proposedChangesContent = {
  summary: "Primary proposed changes after reading Agent Two's draft.",
  artifacts: [
    {
      id: "main",
      artifact_type: "main_response",
      path: "memory-bank/collaboration/wf/round-2/agent_one/proposed_changes/main.md",
      summary: "Full proposed_changes response.",
    },
  ],
  accepted_from_other_agent_draft: [],
  proposed_changes: [],
  remaining_disagreements: [],
};

const injection = {
  kind: "proposed_changes" as const,
  agent: "agent_one" as const,
  target_agent: "agent_two" as const,
  round: 2,
};

describe("parseAndInjectArtifact", () => {
  it("injects orchestrator-owned envelope and per-artifact bookkeeping", () => {
    const outcome = parseAndInjectArtifact(
      "agent_one",
      completed(proposedChangesContent),
      {
        contentSchema: collaborationProposedChangesContentSchema,
        fullSchema: collaborationProposedChangesOutputSchema,
        injection,
      },
    );

    expect(outcome.success).toBe(true);
    if (!outcome.success) return;
    expect(outcome.value.kind).toBe("proposed_changes");
    expect(outcome.value.agent).toBe("agent_one");
    expect(outcome.value.target_agent).toBe("agent_two");
    expect(outcome.value.round).toBe(2);
    expect(outcome.value.artifacts[0]).toMatchObject({
      id: "main",
      round: 2,
      agent: "agent_one",
      phase: "proposed_changes",
    });
  });

  it("produces an artifact that round-trips through the persisted discriminated union", () => {
    const outcome = parseAndInjectArtifact(
      "agent_one",
      completed(proposedChangesContent),
      {
        contentSchema: collaborationProposedChangesContentSchema,
        fullSchema: collaborationProposedChangesOutputSchema,
        injection,
      },
    );
    expect(outcome.success).toBe(true);
    if (!outcome.success) return;
    expect(collaborationArtifactSchema.safeParse(outcome.value).success).toBe(
      true,
    );
  });

  it("surfaces a legible schema_validation error when required content is missing", () => {
    const outcome = parseAndInjectArtifact(
      "agent_one",
      completed({ ...proposedChangesContent, artifacts: [] }),
      {
        contentSchema: collaborationProposedChangesContentSchema,
        fullSchema: collaborationProposedChangesOutputSchema,
        injection,
      },
    );

    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.error).toContain(
      "proposed_changes (agent_one) schema_validation",
    );
    expect(outcome.error).toContain("artifacts:");
    expect(outcome.error).toContain('id "main"');
  });

  it("fails when the lane call did not complete", () => {
    const failed: AgentCallResult = {
      ...completed(proposedChangesContent),
      outcome: {
        kind: "failed",
        error: {
          failureKind: "backend_error",
          backend: "claude",
          message: "boom",
        },
      },
    };
    const outcome = parseAndInjectArtifact("agent_one", failed, {
      contentSchema: collaborationProposedChangesContentSchema,
      fullSchema: collaborationProposedChangesOutputSchema,
      injection,
    });

    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.error).toContain("did not complete");
  });
});
