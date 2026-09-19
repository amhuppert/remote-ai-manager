/**
 * The cascade and provenance adapter the panel reads. It composes the existing
 * resolution modules rather than restating them; what it adds is the panel's
 * three granularities — block, role, field — and the reset that clears exactly
 * one of them (design README §7).
 */
import { describe, expect, it } from "vitest";
import { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";
import type { WorkflowConfigOverride } from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowExecutionContextDefinition } from "@/lib/workflow-graph/definition-schemas";
import {
  applyConfigEditToContext,
  applyConfigEditToWorkflowConfig,
  createConfigCascade,
  overrideCountLabel,
  CONTEXT_CONFIG_PATHS,
  WORKFLOW_CONFIG_PATHS,
} from "./config-cascade";

function context(
  overrides: Partial<GraphWorkflowExecutionContextDefinition> = {},
): GraphWorkflowExecutionContextDefinition {
  return {
    id: "ctx_checkout",
    title: "Implement checkout",
    acceptanceCriteria: [
      { id: "ac-1", statement: "Every attempt writes exactly one audit row." },
    ],
    placement: { lane: "delivery", mode: "full" },
    ...overrides,
  };
}

function contextCascade(
  contextOverrides: Partial<GraphWorkflowExecutionContextDefinition> = {},
  workflowConfig: WorkflowConfigOverride = {},
) {
  return createConfigCascade({
    scope: "context",
    globalDefaults: SEEDED_WORKFLOW_DEFAULTS,
    workflowConfig,
    context: context(contextOverrides),
  });
}

describe("resolve", () => {
  it("reports the nearest tier that declares a block and the value it resolved", () => {
    const cascade = contextCascade(
      { circuitBreaker: { consecutiveFailureThreshold: 5 } },
      { humanApprovalGate: { enabled: true } },
    );

    expect(cascade.resolve("circuitBreaker")).toEqual({
      value: { consecutiveFailureThreshold: 5 },
      sourceTier: "context",
    });
    expect(cascade.resolve("humanApprovalGate")).toEqual({
      value: { enabled: true },
      sourceTier: "workflow",
    });
    expect(cascade.resolve("askUserQuestions").sourceTier).toBe("global");
    expect(cascade.resolve("askUserQuestions").value).toEqual(
      SEEDED_WORKFLOW_DEFAULTS.askUserQuestions,
    );
  });

  it("hands back the whole block, including the fields the panel does not author", () => {
    const cascade = contextCascade({
      mutability: { allowAgentTaskAdd: true, allowAgentContextAdd: true },
    });

    expect(cascade.resolve("mutability").value).toEqual({
      allowAgentTaskAdd: true,
      allowAgentContextAdd: true,
    });
  });

  it("resolves the workflow tier without ever attributing a value to a context", () => {
    const cascade = createConfigCascade({
      scope: "workflow",
      globalDefaults: SEEDED_WORKFLOW_DEFAULTS,
      workflowConfig: {
        iterationPolicy: { maxIterations: 8 },
      },
    });

    expect(cascade.resolve("iterationPolicy").sourceTier).toBe("workflow");
    expect(cascade.resolve("circuitBreaker").sourceTier).toBe("global");
    for (const path of WORKFLOW_CONFIG_PATHS) {
      expect(cascade.resolve(path).sourceTier).not.toBe("context");
    }
  });

  it("resolves lane-merge validation per field at the workflow tier only", () => {
    const cascade = createConfigCascade({
      scope: "workflow",
      globalDefaults: SEEDED_WORKFLOW_DEFAULTS,
      workflowConfig: { laneMergeValidation: { strategy: "every-merge" } },
    });

    expect(cascade.resolve("laneMergeValidation.strategy")).toEqual({
      value: "every-merge",
      sourceTier: "workflow",
    });
    expect(cascade.resolve("laneMergeValidation.commands").sourceTier).toBe(
      "global",
    );
    expect(cascade.own("laneMergeValidation.commands")).toBe(false);
  });

  it("keeps lane-merge validation off the context tier entirely", () => {
    expect(CONTEXT_CONFIG_PATHS).not.toContain("laneMergeValidation.strategy");
    expect(CONTEXT_CONFIG_PATHS).not.toContain("laneMergeValidation.commands");
    expect(contextCascade().own("laneMergeValidation.strategy")).toBe(false);
  });
});

describe("role and field independence", () => {
  it("keeps each agent-validation role on its own tier", () => {
    const cascade = contextCascade(
      {
        agentValidation: { implementer: { mode: "only", commands: ["lint"] } },
      },
      {
        agentValidation: {
          contextValidator: { mode: "all", except: ["build"] },
        },
      },
    );

    expect(cascade.resolve("agentValidation.implementer")).toEqual({
      value: { mode: "only", commands: ["lint"] },
      sourceTier: "context",
    });
    expect(cascade.resolve("agentValidation.contextValidator")).toEqual({
      value: { mode: "all", except: ["build"] },
      sourceTier: "workflow",
    });
    expect(cascade.own("agentValidation.implementer")).toBe(true);
    expect(cascade.own("agentValidation.contextValidator")).toBe(false);
  });

  it("keeps each collaboration field on its own tier", () => {
    const cascade = contextCascade(
      { collaboration: { enabled: true } },
      { collaboration: { negotiationRounds: 5 } },
    );

    expect(cascade.resolve("collaboration.enabled")).toEqual({
      value: true,
      sourceTier: "context",
    });
    expect(cascade.resolve("collaboration.negotiationRounds")).toEqual({
      value: 5,
      sourceTier: "workflow",
    });
    expect(
      cascade.resolve("collaboration.autonomousResolutionThreshold"),
    ).toEqual({
      value:
        SEEDED_WORKFLOW_DEFAULTS.collaboration.autonomousResolutionThreshold,
      sourceTier: "global",
    });
  });
});

describe("override counts", () => {
  it("counts overrides by granularity across the tier", () => {
    const cascade = contextCascade({
      circuitBreaker: { consecutiveFailureThreshold: 5 },
      humanApprovalGate: { enabled: true },
      agentValidation: { implementer: { mode: "all", except: [] } },
      collaboration: { enabled: true },
    });

    expect(cascade.counts()).toEqual({ block: 2, role: 1, field: 1 });
    expect(overrideCountLabel(cascade.counts())).toBe(
      "2 blocks · 1 role · 1 field set here",
    );
  });

  it("counts only the paths a card asks about", () => {
    const cascade = contextCascade({
      circuitBreaker: { consecutiveFailureThreshold: 5 },
      humanApprovalGate: { enabled: true },
    });

    expect(cascade.counts(["humanApprovalGate"])).toEqual({
      block: 1,
      role: 0,
      field: 0,
    });
  });

  it("says all inherited when the tier overrides nothing", () => {
    expect(overrideCountLabel(contextCascade().counts())).toBe("all inherited");
  });

  it("singularises each kind", () => {
    expect(overrideCountLabel({ block: 1, role: 1, field: 1 })).toBe(
      "1 block · 1 role · 1 field set here",
    );
  });
});

describe("provenance", () => {
  it("hands the row primitives a provenance the current scope understands", () => {
    const cascade = contextCascade(
      {},
      { humanApprovalGate: { enabled: true } },
    );

    expect(cascade.provenance("humanApprovalGate")).toEqual({
      sourceTier: "workflow",
      scopeTier: "context",
      granularity: "block",
    });
    expect(cascade.provenance("agentValidation.implementer").granularity).toBe(
      "role",
    );
    expect(cascade.provenance("collaboration.enabled").granularity).toBe(
      "field",
    );
  });

  it("marks a drill row set-here when any path behind it is overridden", () => {
    const cascade = contextCascade({ collaboration: { enabled: true } });

    const group = cascade.groupProvenance([
      "implementer",
      "collaboration.enabled",
    ]);
    expect(group.setHere).toBe(true);

    const inherited = cascade.groupProvenance(["iterationPolicy"]);
    expect(inherited.setHere).toBe(false);
    expect(inherited.sourceTier).toBe("global");
  });
});

describe("reset intents", () => {
  it("names the granularity it clears", () => {
    const cascade = contextCascade();

    expect(cascade.reset("circuitBreaker")).toEqual({
      kind: "reset-path",
      tier: "context",
      path: "circuitBreaker",
      granularity: "block",
    });
    expect(cascade.reset("agentValidation.implementer").granularity).toBe(
      "role",
    );
    expect(cascade.reset("collaboration.enabled").granularity).toBe("field");
    expect(cascade.resetAll()).toEqual({ kind: "reset-all", tier: "context" });
  });

  it("clears one role without disturbing its sibling", () => {
    const authored = context({
      agentValidation: {
        implementer: { mode: "only", commands: ["lint"] },
        contextValidator: { mode: "only", commands: ["test"] },
      },
    });
    const cascade = contextCascade({
      agentValidation: authored.agentValidation,
    });

    const next = applyConfigEditToContext(
      cascade.reset("agentValidation.implementer"),
      authored,
    );

    expect(next.agentValidation).toEqual({
      contextValidator: { mode: "only", commands: ["test"] },
    });
    const after = createConfigCascade({
      scope: "context",
      globalDefaults: SEEDED_WORKFLOW_DEFAULTS,
      workflowConfig: {},
      context: next,
    });
    expect(after.resolve("agentValidation.implementer").sourceTier).toBe(
      "global",
    );
    expect(after.resolve("agentValidation.contextValidator").sourceTier).toBe(
      "context",
    );
  });

  it("clears one field without disturbing its sibling", () => {
    const authored = context({
      collaboration: { enabled: true, negotiationRounds: 5 },
    });
    const cascade = contextCascade({ collaboration: authored.collaboration });

    const next = applyConfigEditToContext(
      cascade.reset("collaboration.enabled"),
      authored,
    );

    expect(next.collaboration).toEqual({ negotiationRounds: 5 });
  });

  it("drops the container when its last field is cleared, so the block stops reading as set here", () => {
    const authored = context({ collaboration: { enabled: true } });
    const cascade = contextCascade({ collaboration: authored.collaboration });

    const next = applyConfigEditToContext(
      cascade.reset("collaboration.enabled"),
      authored,
    );

    expect(next.collaboration).toBeUndefined();
    expect("collaboration" in next).toBe(false);
  });

  it("clears a whole block and leaves the other blocks alone", () => {
    const authored = context({
      circuitBreaker: { consecutiveFailureThreshold: 5 },
      humanApprovalGate: { enabled: true },
    });
    const cascade = contextCascade({
      circuitBreaker: authored.circuitBreaker,
      humanApprovalGate: authored.humanApprovalGate,
    });

    const next = applyConfigEditToContext(
      cascade.reset("circuitBreaker"),
      authored,
    );

    expect(next.circuitBreaker).toBeUndefined();
    expect(next.humanApprovalGate).toEqual({ enabled: true });
  });
});

describe("reset all", () => {
  it("returns the tier to inheritance and never seeds a value in its place", () => {
    const authored = context({
      circuitBreaker: { consecutiveFailureThreshold: 5 },
      collaboration: { enabled: true },
      agentValidation: { implementer: { mode: "all", except: [] } },
    });
    const cascade = contextCascade({
      circuitBreaker: authored.circuitBreaker,
      collaboration: authored.collaboration,
      agentValidation: authored.agentValidation,
    });

    const next = applyConfigEditToContext(cascade.resetAll(), authored);

    for (const path of CONTEXT_CONFIG_PATHS) {
      expect(
        createConfigCascade({
          scope: "context",
          globalDefaults: SEEDED_WORKFLOW_DEFAULTS,
          workflowConfig: {},
          context: next,
        }).own(path),
      ).toBe(false);
    }
    expect(next.circuitBreaker).toBeUndefined();
    expect(next.collaboration).toBeUndefined();
    expect(next.agentValidation).toBeUndefined();
  });

  it("preserves everything the panel does not author", () => {
    const authored = context({
      circuitBreaker: { consecutiveFailureThreshold: 5 },
      description: "Wire the risk rules into the checkout path.",
      outputSchema: { fields: { verdict: { type: "string" } } },
      metadata: { compiledBy: "spec-delivery" },
    });
    const cascade = contextCascade({ circuitBreaker: authored.circuitBreaker });

    const next = applyConfigEditToContext(cascade.resetAll(), authored);

    expect(next.id).toBe("ctx_checkout");
    expect(next.title).toBe("Implement checkout");
    expect(next.placement).toEqual({ lane: "delivery", mode: "full" });
    expect(next.description).toBe(
      "Wire the risk rules into the checkout path.",
    );
    expect(next.outputSchema).toEqual({
      fields: { verdict: { type: "string" } },
    });
    expect(next.metadata).toEqual({ compiledBy: "spec-delivery" });
    expect(next.acceptanceCriteria).toEqual(authored.acceptanceCriteria);
  });

  it("clears the workflow tier's own overrides, lane-merge validation included", () => {
    const workflowConfig: WorkflowConfigOverride = {
      iterationPolicy: { maxIterations: 8 },
      laneMergeValidation: { strategy: "every-merge" },
    };
    const cascade = createConfigCascade({
      scope: "workflow",
      globalDefaults: SEEDED_WORKFLOW_DEFAULTS,
      workflowConfig,
    });

    const next = applyConfigEditToWorkflowConfig(
      cascade.resetAll(),
      workflowConfig,
    );

    expect(next).toEqual({});
    const after = createConfigCascade({
      scope: "workflow",
      globalDefaults: SEEDED_WORKFLOW_DEFAULTS,
      workflowConfig: next,
    });
    expect(after.resolve("laneMergeValidation.strategy")).toEqual({
      value: SEEDED_WORKFLOW_DEFAULTS.laneMergeValidation.strategy,
      sourceTier: "global",
    });
  });
});

describe("set", () => {
  it("names the granularity the write lands at", () => {
    const cascade = contextCascade();

    expect(
      cascade.set("circuitBreaker", { consecutiveFailureThreshold: 4 }),
    ).toEqual({
      kind: "set-path",
      tier: "context",
      path: "circuitBreaker",
      value: { consecutiveFailureThreshold: 4 },
      granularity: "block",
    });
    expect(cascade.set("collaboration.negotiationRounds", 3).granularity).toBe(
      "field",
    );
    expect(
      cascade.set("agentValidation.implementer", { mode: "all", except: [] })
        .granularity,
    ).toBe("role");
  });

  it("writes a whole block at the tier, carrying the fields no screen authors", () => {
    const authored = context();
    const cascade = contextCascade();

    const next = applyConfigEditToContext(
      cascade.set("mutability", {
        allowAgentTaskAdd: true,
        allowAgentContextAdd: true,
      }),
      authored,
    );

    expect(next.mutability).toEqual({
      allowAgentTaskAdd: true,
      allowAgentContextAdd: true,
    });
    expect(
      contextCascade({ mutability: next.mutability }).own("mutability"),
    ).toBe(true);
  });

  it("promotes one collaboration field and leaves its siblings inheriting", () => {
    const authored = context();
    const cascade = contextCascade({}, { collaboration: { enabled: true } });

    const next = applyConfigEditToContext(
      cascade.set("collaboration.negotiationRounds", 3),
      authored,
    );

    expect(next.collaboration).toEqual({ negotiationRounds: 3 });
    const after = createConfigCascade({
      scope: "context",
      globalDefaults: SEEDED_WORKFLOW_DEFAULTS,
      workflowConfig: { collaboration: { enabled: true } },
      context: next,
    });
    expect(after.resolve("collaboration.negotiationRounds").sourceTier).toBe(
      "context",
    );
    expect(after.resolve("collaboration.enabled").sourceTier).toBe("workflow");
    expect(
      after.resolve("collaboration.autonomousResolutionThreshold").sourceTier,
    ).toBe("global");
  });

  it("promotes one agent-validation role and leaves the other on its own tier", () => {
    const authored = context();
    const cascade = contextCascade();

    const next = applyConfigEditToContext(
      cascade.set("agentValidation.contextValidator", {
        mode: "only",
        commands: ["test", "typecheck"],
      }),
      authored,
    );

    expect(next.agentValidation).toEqual({
      contextValidator: { mode: "only", commands: ["test", "typecheck"] },
    });
    const after = createConfigCascade({
      scope: "context",
      globalDefaults: SEEDED_WORKFLOW_DEFAULTS,
      workflowConfig: {},
      context: next,
    });
    expect(after.own("agentValidation.contextValidator")).toBe(true);
    expect(after.own("agentValidation.implementer")).toBe(false);
  });

  it("writes lane-merge fields on the workflow tier and never on a context", () => {
    const cascade = createConfigCascade({
      scope: "workflow",
      globalDefaults: SEEDED_WORKFLOW_DEFAULTS,
      workflowConfig: {},
    });

    const next = applyConfigEditToWorkflowConfig(
      cascade.set("laneMergeValidation.commands", {
        mode: "only",
        commands: ["test"],
      }),
      {},
    );

    expect(next.laneMergeValidation).toEqual({
      commands: { mode: "only", commands: ["test"] },
    });
    // A lane-merge intent reaching the context applier is a no-op: there is no
    // context tier for it to land on.
    expect(
      applyConfigEditToContext(
        cascade.set("laneMergeValidation.strategy", "every-merge"),
        context(),
      ),
    ).toEqual(context());
  });

  it("leaves every unauthored field of the entity verbatim", () => {
    const authored = context({
      description: "Wire the risk rules into the checkout path.",
      metadata: { compiledBy: "spec-delivery" },
      mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: true },
    });
    const cascade = contextCascade({ mutability: authored.mutability });

    const next = applyConfigEditToContext(
      cascade.set("mutability", {
        allowAgentTaskAdd: true,
        allowAgentContextAdd: true,
      }),
      authored,
    );

    expect(next.mutability?.allowAgentContextAdd).toBe(true);
    expect(next.description).toBe(
      "Wire the risk rules into the checkout path.",
    );
    expect(next.metadata).toEqual({ compiledBy: "spec-delivery" });
    expect(next.placement).toEqual(authored.placement);
  });
});
