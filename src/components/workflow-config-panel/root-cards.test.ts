/**
 * The root screen's cards for both scopes, and the summary vocabulary they and
 * the drill rows share (Config Panel prototype `cards()` / `parts()`).
 */
import { describe, expect, it } from "vitest";
import { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";
import { getModelsForBackend } from "@/lib/agent-backends/catalog";
import type { GraphWorkflowExecutionContextDefinition } from "@/lib/workflow-graph/definition-schemas";
import { createConfigCascade } from "./config-cascade";
import {
  blockSummaryParts,
  modelDisplayName,
  outputSchemaCounts,
  setHereMarkers,
} from "./config-summaries";
import { createPlaceholderScreenRegistry } from "./placeholder-screens";
import { buildContextRootCards, buildWorkflowRootCards } from "./root-cards";
import type { ConfigValuePart } from "./value-parts";

function textOf(parts: readonly ConfigValuePart[]): string[] {
  return parts.flatMap((part) => (part.kind === "dot" ? [] : [part.text]));
}

function contextDefinition(
  overrides: Partial<GraphWorkflowExecutionContextDefinition> = {},
): GraphWorkflowExecutionContextDefinition {
  return {
    id: "ctx_checkout",
    title: "Implement checkout",
    acceptanceCriteria: [
      { id: "ac-1", statement: "Every attempt writes one audit row." },
      { id: "ac-2", statement: "The timeout path writes the same record." },
    ],
    placement: {
      lane: "delivery",
      mode: "owned",
      ownedPaths: ["src/checkout"],
    },
    ...overrides,
  };
}

function cascadeFor(
  overrides: Partial<GraphWorkflowExecutionContextDefinition> = {},
) {
  return createConfigCascade({
    scope: "context",
    globalDefaults: SEEDED_WORKFLOW_DEFAULTS,
    workflowConfig: {},
    context: contextDefinition(overrides),
  });
}

const CONTEXT_FACTS = {
  outputSchemaText: "",
  upstreamInputCount: 2,
  taskCount: 3,
  nextTaskTitle: "Wire the risk rules in",
};

describe("modelDisplayName", () => {
  it("shows the catalog's canonical long name for a short model id", () => {
    const model = getModelsForBackend("claude")[0];
    expect(model).toBeDefined();
    if (!model) return;

    expect(modelDisplayName("claude", model.id)).toBe(model.label);
  });

  it("falls back to the raw id for a model the catalog does not list", () => {
    expect(modelDisplayName("claude", "some-unlisted-model")).toBe(
      "some-unlisted-model",
    );
  });
});

describe("outputSchemaCounts", () => {
  it("derives field and required counts from the parsed schema text", () => {
    expect(
      outputSchemaCounts(
        JSON.stringify({
          type: "object",
          properties: {
            verdict: { type: "string" },
            notes: { type: "string" },
          },
          required: ["verdict"],
        }),
      ),
    ).toEqual({ fields: 2, required: 1 });
  });

  it("reports the lint stage instead of a count when the text is not accepted", () => {
    expect(outputSchemaCounts("{not json")).toBeNull();
    expect(outputSchemaCounts("")).toBeNull();
  });
});

describe("blockSummaryParts", () => {
  it("names the implementer's model with its canonical long name", () => {
    const cascade = cascadeFor();
    const implementer = cascade.resolve("implementer").value;
    const expected = modelDisplayName(
      implementer.agent.backend,
      implementer.agent.modelSelection.modelId,
    );

    expect(textOf(blockSummaryParts(cascade, "implementer"))).toContain(
      expected,
    );
  });

  it("chips every seat in an enabled validator cohort", () => {
    const cascade = cascadeFor({
      contextValidator: {
        enabled: true,
        assignments: [
          {
            id: "security",
            profile: { tier: "builtin", id: "general-implementer" },
            strategy: "conversation",
            authority: "blocking",
            agent: {
              backend: "claude",
              modelSelection: {
                modelId: "sonnet",
                parameters: { effort: "medium" },
              },
            },
            continuity: { enabled: true },
          },
          {
            id: "style",
            profile: { tier: "builtin", id: "general-implementer" },
            strategy: "conversation",
            authority: "advisory",
            agent: {
              backend: "claude",
              modelSelection: {
                modelId: "sonnet",
                parameters: { effort: "medium" },
              },
            },
            continuity: { enabled: true },
          },
        ],
      },
    });

    expect(textOf(blockSummaryParts(cascade, "contextValidator"))).toEqual([
      "security",
      "style",
    ]);
  });

  it("keeps a disabled cohort's dormant seats visible in the count", () => {
    const cascade = cascadeFor({
      contextValidator: {
        enabled: false,
        assignments: SEEDED_WORKFLOW_DEFAULTS.contextValidator.assignments,
      },
    });

    const parts = textOf(blockSummaryParts(cascade, "contextValidator"));
    expect(parts).toContain("disabled");
    expect(parts).toContain("1 seat kept");
  });

  it("says off for an empty script-validator selection", () => {
    expect(textOf(blockSummaryParts(cascadeFor(), "scriptValidator"))).toEqual([
      "off — empty selection",
    ]);
  });

  it("summarises each agent-validation role's selector", () => {
    const cascade = cascadeFor({
      agentValidation: {
        implementer: { mode: "all", except: ["build", "lint"] },
        contextValidator: { mode: "only", commands: ["test"] },
      },
    });

    expect(textOf(blockSummaryParts(cascade, "agentValidation"))).toEqual([
      "impl",
      "all except 2",
      "val",
      "only 1",
    ]);
  });

  it("reads collaboration off as one part and on as its four fields", () => {
    expect(textOf(blockSummaryParts(cascadeFor(), "collaboration"))).toEqual([
      "off",
    ]);

    const on = cascadeFor({
      collaboration: {
        enabled: true,
        negotiationRounds: 5,
        autonomousResolutionThreshold: "major",
      },
    });
    const secondAgent = on.resolve("collaboration.secondAgent").value;
    expect(textOf(blockSummaryParts(on, "collaboration"))).toEqual([
      "on",
      modelDisplayName(secondAgent.backend, secondAgent.modelSelection.modelId),
      "5 rounds",
      "major",
    ]);
  });

  it("chips the human gates by whether they are on", () => {
    const inherited = cascadeFor();
    expect(textOf(blockSummaryParts(inherited, "humanApprovalGate"))).toEqual([
      "off",
    ]);
    expect(textOf(blockSummaryParts(inherited, "askUserQuestions"))).toEqual([
      "off",
    ]);

    const on = cascadeFor({
      humanApprovalGate: { enabled: true },
      askUserQuestions: { enabled: true },
    });
    expect(textOf(blockSummaryParts(on, "humanApprovalGate"))).toEqual([
      "parks before merge",
    ]);
    expect(textOf(blockSummaryParts(on, "askUserQuestions"))).toEqual(["on"]);
  });

  it("reads the whole lane-merge block at the workflow scope", () => {
    const cascade = createConfigCascade({
      scope: "workflow",
      globalDefaults: SEEDED_WORKFLOW_DEFAULTS,
      workflowConfig: {
        laneMergeValidation: {
          strategy: "every-merge",
          commands: { mode: "only", commands: ["test", "lint"] },
        },
      },
    });

    expect(textOf(blockSummaryParts(cascade, "laneMergeValidation"))).toEqual([
      "every-merge",
      "2 commands",
    ]);
  });
});

describe("setHereMarkers", () => {
  it("marks a block that is set at the current tier and counts its granularity", () => {
    const cascade = cascadeFor({
      circuitBreaker: { consecutiveFailureThreshold: 5 },
    });

    const [marker] = setHereMarkers(cascade, "circuitBreaker");
    expect(marker).toEqual({
      kind: "dot",
      title: "1 block set on this context",
    });
  });

  it("counts each overridden field of a partly-overridden block", () => {
    const cascade = cascadeFor({
      collaboration: { enabled: true, negotiationRounds: 5 },
    });

    expect(setHereMarkers(cascade, "collaboration")).toEqual([
      { kind: "dot", title: "2 fields set on this context" },
    ]);
  });

  it("marks nothing when the block is fully inherited", () => {
    expect(setHereMarkers(cascadeFor(), "iterationPolicy")).toEqual([]);
  });
});

describe("buildContextRootCards", () => {
  it("lays out the context scope's six cards in order", () => {
    const cards = buildContextRootCards({
      cascade: cascadeFor(),
      context: contextDefinition(),
      ...CONTEXT_FACTS,
    });

    expect(cards.map((card) => card.screenId)).toEqual([
      "brief",
      "placement",
      "agents",
      "gates",
      "policy",
      "tasks",
    ]);
    expect(cards.map((card) => card.title)).toEqual([
      "Brief",
      "Placement",
      "Agents",
      "Quality gates",
      "Execution policy",
      "Tasks",
    ]);
  });

  it("summarises the brief from the context's own content", () => {
    const cards = buildContextRootCards({
      cascade: cascadeFor(),
      context: contextDefinition(),
      ...CONTEXT_FACTS,
      outputSchemaText: JSON.stringify({
        type: "object",
        properties: { verdict: { type: "string" } },
        required: ["verdict"],
      }),
    });

    const brief = cards.find((card) => card.screenId === "brief");
    expect(brief).toBeDefined();
    const lines = Object.fromEntries(
      (brief?.lines ?? []).map((line) => [line.key, textOf(line.parts)]),
    );
    expect(lines.title).toEqual(["Implement checkout"]);
    expect(lines.criteria).toEqual(["2", "ordered"]);
    expect(lines.schema).toEqual(["1", "fields", "1", "required"]);
    expect(lines.upstream).toEqual(["2", "inputs"]);
  });

  it("chips the lane, the grade and the owned paths", () => {
    const cards = buildContextRootCards({
      cascade: cascadeFor(),
      context: contextDefinition(),
      ...CONTEXT_FACTS,
    });

    const placement = cards.find((card) => card.screenId === "placement");
    const lines = Object.fromEntries(
      (placement?.lines ?? []).map((line) => [line.key, textOf(line.parts)]),
    );
    expect(lines.lane).toEqual(["delivery"]);
    expect(lines.grade).toEqual(["owning"]);
    expect(lines["owned paths"]).toEqual(["src/checkout"]);
  });

  it("gives the policy card one line per block it opens", () => {
    const cards = buildContextRootCards({
      cascade: cascadeFor(),
      context: contextDefinition(),
      ...CONTEXT_FACTS,
    });

    const policy = cards.find((card) => card.screenId === "policy");
    // Read against the seeded defaults rather than restated literals: max
    // iterations, the breaker threshold and the repair budget are the resolver's
    // numbers, and the summary must not carry a second copy of them.
    const seededPolicy = SEEDED_WORKFLOW_DEFAULTS.iterationPolicy;
    const seededRepair = SEEDED_WORKFLOW_DEFAULTS.planRepair;
    expect(
      (policy?.lines ?? []).map((line) => [line.key, textOf(line.parts)]),
    ).toEqual([
      [
        "iterations",
        ["max", String(seededPolicy.maxIterations), "continuity auto"],
      ],
      [
        "breaker",
        [
          "halt after",
          String(
            SEEDED_WORKFLOW_DEFAULTS.circuitBreaker.consecutiveFailureThreshold,
          ),
          "fails",
        ],
      ],
      ["plan repair", ["on", `${seededRepair.maxAttemptsPerContext}/ctx`]],
      ["mutability", ["task add", "blocked"]],
    ]);
  });

  it("reads a token-limited continuity and a switched-off plan repair", () => {
    const cards = buildContextRootCards({
      cascade: cascadeFor({
        iterationPolicy: {
          maxIterations: 8,
          continuity: { enabled: true, contextLimitTokens: 150_000 },
        },
        planRepair: { enabled: false, maxAttemptsPerContext: 2 },
        mutability: { allowAgentTaskAdd: true, allowAgentContextAdd: false },
      }),
      context: contextDefinition(),
      ...CONTEXT_FACTS,
    });

    const policy = cards.find((card) => card.screenId === "policy");
    const lines = Object.fromEntries(
      (policy?.lines ?? []).map((line) => [line.key, textOf(line.parts)]),
    );
    expect(lines.iterations).toEqual(["max", "8", "continuity 150k"]);
    expect(lines["plan repair"]).toEqual(["off"]);
    expect(lines.mutability).toEqual(["task add", "allowed"]);
  });

  it("badges a card with the override count of exactly its own paths", () => {
    const cards = buildContextRootCards({
      cascade: cascadeFor({
        circuitBreaker: { consecutiveFailureThreshold: 5 },
        humanApprovalGate: { enabled: true },
      }),
      context: contextDefinition(),
      ...CONTEXT_FACTS,
    });

    expect(
      cards.find((card) => card.screenId === "policy")?.overrideLabel,
    ).toBe("1 block set here");
    expect(cards.find((card) => card.screenId === "gates")?.overrideLabel).toBe(
      "1 block set here",
    );
    expect(
      cards.find((card) => card.screenId === "agents")?.overrideLabel,
    ).toBe(null);
  });

  it("keeps the lane-merge line off the context scope", () => {
    const cards = buildContextRootCards({
      cascade: cascadeFor(),
      context: contextDefinition(),
      ...CONTEXT_FACTS,
    });

    const gates = cards.find((card) => card.screenId === "gates");
    expect(gates?.lines.map((line) => line.key)).not.toContain("lane merge");
  });
});

describe("buildWorkflowRootCards", () => {
  const workflowCascade = createConfigCascade({
    scope: "workflow",
    globalDefaults: SEEDED_WORKFLOW_DEFAULTS,
    workflowConfig: {},
  });

  it("lays out the workflow scope's five cards in order", () => {
    const cards = buildWorkflowRootCards({
      cascade: workflowCascade,
      invariantCount: 4,
      sourceCount: 8,
      parameters: [],
    });

    expect(cards.map((card) => card.screenId)).toEqual([
      "charter",
      "params",
      "agents",
      "gates",
      "policy",
    ]);
  });

  it("gives each declared parameter its own summary line", () => {
    const cards = buildWorkflowRootCards({
      cascade: workflowCascade,
      invariantCount: 4,
      sourceCount: 8,
      parameters: [
        {
          id: "target_branch",
          type: "string",
          required: true,
          defaultValue: "main",
        },
        { id: "rollout", type: "enum", required: false, defaultValue: null },
      ],
    });

    const params = cards.find((card) => card.screenId === "params");
    expect(
      (params?.lines ?? []).map((line) => [line.key, textOf(line.parts)]),
    ).toEqual([
      ["target_branch", ["string", "required", "main"]],
      ["rollout", ["enum", "—"]],
    ]);
  });

  it("adds the lane-merge line to the workflow scope's quality gates", () => {
    const cards = buildWorkflowRootCards({
      cascade: workflowCascade,
      invariantCount: 0,
      sourceCount: 0,
      parameters: [],
    });

    const gates = cards.find((card) => card.screenId === "gates");
    expect(gates?.lines.map((line) => line.key)).toEqual([
      "validator",
      "script",
      "agent val",
      "lane merge",
      "approval",
      "questions",
    ]);
  });

  it("summarises the charter from its declared counts", () => {
    const cards = buildWorkflowRootCards({
      cascade: workflowCascade,
      invariantCount: 4,
      sourceCount: 8,
      parameters: [],
    });

    const charter = cards.find((card) => card.screenId === "charter");
    expect(
      (charter?.lines ?? []).map((line) => [line.key, textOf(line.parts)]),
    ).toEqual([
      ["invariants", ["4", "declared"]],
      ["sources", ["8", "ranked"]],
    ]);
  });
});

describe("card destinations", () => {
  it("resolves every card's screen in its scope's registry", () => {
    const contextCards = buildContextRootCards({
      cascade: cascadeFor(),
      context: contextDefinition(),
      ...CONTEXT_FACTS,
    });
    const contextScreens = createPlaceholderScreenRegistry("context");
    for (const card of contextCards) {
      expect(contextScreens.resolve(card.screenId)).toBeDefined();
    }

    const workflowScreens = createPlaceholderScreenRegistry("workflow");
    const workflowCards = buildWorkflowRootCards({
      cascade: createConfigCascade({
        scope: "workflow",
        globalDefaults: SEEDED_WORKFLOW_DEFAULTS,
        workflowConfig: {},
      }),
      invariantCount: 0,
      sourceCount: 0,
      parameters: [],
    });
    for (const card of workflowCards) {
      expect(workflowScreens.resolve(card.screenId)).toBeDefined();
    }
  });
});
