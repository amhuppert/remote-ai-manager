import { describe, expect, it } from "vitest";
import { applyConfigEditToContext } from "@/components/workflow-config-panel/config-cascade";
import { inheritedTierChip } from "@/components/workflow-config-panel/row-provenance";
import type { GraphWorkflowExecutionContextDefinition } from "@/lib/workflow-graph/definition-schemas";
import { createLiveConfigCascade } from "./live-config-cascade";
import type { LiveConfigProvenance } from "./live-context-draft";

/**
 * A live execution has no cascade to reset into: every block was resolved at
 * seed time and the live-edit vocabulary has no clear-to-inherit spelling. The
 * adapter therefore has to state where a value came from WITHOUT ever offering
 * to take it back, and without inventing provenance the seed did not record.
 */

function liveContext(): GraphWorkflowExecutionContextDefinition {
  return {
    id: "context-impl",
    title: "Implement",
    acceptanceCriteria: [{ id: "ac-1", statement: "It works" }],
    placement: { lane: "delivery", mode: "full" },
    scriptValidator: { commands: ["typecheck"] },
    circuitBreaker: { consecutiveFailureThreshold: 7 },
    collaboration: {
      enabled: true,
      secondAgent: {
        backend: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
      },
      negotiationRounds: 5,
      autonomousResolutionThreshold: "major",
    },
    agentValidation: {
      implementer: { mode: "all", except: [] },
      contextValidator: { mode: "only", commands: ["test"] },
    },
  };
}

const PROVENANCE: LiveConfigProvenance = {
  scriptValidator: "workflow",
  "collaboration.enabled": "workflow",
  "collaboration.negotiationRounds": "context",
  "agentValidation.implementer": "global",
};

describe("createLiveConfigCascade", () => {
  it("resolves the snapshotted value the run actually holds", () => {
    const cascade = createLiveConfigCascade({
      context: liveContext(),
      provenance: PROVENANCE,
    });

    expect(cascade.resolve("circuitBreaker").value).toEqual({
      consecutiveFailureThreshold: 7,
    });
    expect(cascade.resolve("collaboration.negotiationRounds").value).toBe(5);
    expect(cascade.resolve("agentValidation.contextValidator").value).toEqual({
      mode: "only",
      commands: ["test"],
    });
  });

  it("names the tier the seed recorded, and only where it recorded one", () => {
    const cascade = createLiveConfigCascade({
      context: liveContext(),
      provenance: PROVENANCE,
    });

    expect(cascade.resolve("scriptValidator").sourceTier).toBe("workflow");
    expect(cascade.resolve("agentValidation.implementer").sourceTier).toBe(
      "global",
    );
    // Nothing recorded for the block, so it is the context's own value rather
    // than a tier guessed by comparing against today's global defaults.
    expect(cascade.resolve("circuitBreaker").sourceTier).toBe("context");
  });

  it("shows an inherited tier chip but never a set-here row", () => {
    const cascade = createLiveConfigCascade({
      context: liveContext(),
      provenance: PROVENANCE,
    });

    expect(inheritedTierChip(cascade.provenance("scriptValidator"))).toBe("W");
    expect(
      inheritedTierChip(cascade.provenance("agentValidation.implementer")),
    ).toBe("G");
    expect(inheritedTierChip(cascade.provenance("circuitBreaker"))).toBeNull();
  });

  it("never offers a reset, because a live block has no tier to fall back to", () => {
    const cascade = createLiveConfigCascade({
      context: liveContext(),
      provenance: PROVENANCE,
    });

    for (const path of cascade.paths) {
      expect(cascade.own(path)).toBe(false);
      expect(cascade.provenance(path).setHere).toBe(false);
    }
    expect(cascade.counts()).toEqual({ block: 0, role: 0, field: 0 });
    expect(
      cascade.groupProvenance(["circuitBreaker", "planRepair"]).setHere,
    ).toBe(false);
  });

  it("omits the workflow-only lane-merge paths", () => {
    const cascade = createLiveConfigCascade({
      context: liveContext(),
      provenance: {},
    });

    expect(cascade.scope).toBe("context");
    expect(
      cascade.paths.filter((path) => path.startsWith("laneMergeValidation.")),
    ).toEqual([]);
  });

  it("emits an edit intent the shared applier writes onto the draft", () => {
    const context = liveContext();
    const cascade = createLiveConfigCascade({
      context,
      provenance: PROVENANCE,
    });

    const next = applyConfigEditToContext(
      cascade.set("collaboration.negotiationRounds", 9),
      context,
    );

    expect(next.collaboration?.negotiationRounds).toBe(9);
    // The siblings are untouched, which is what the field granularity means.
    expect(next.collaboration?.enabled).toBe(true);
    expect(next.circuitBreaker).toEqual({ consecutiveFailureThreshold: 7 });
  });
});
