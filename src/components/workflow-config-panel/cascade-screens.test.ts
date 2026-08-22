/**
 * What the cascade family registers, and what each of its screen headers
 * badges. The rows inside the screens are covered by their own files; this one
 * pins the seam the hosts mount — which ids exist in which scope, and whether a
 * header's override count is its own.
 */
import { describe, expect, it, vi } from "vitest";
import type { ValidationCommandSummary } from "@/lib/validation/schemas";
import type {
  GraphWorkflowExecutionContextDefinition,
  WorkflowConfigOverride,
} from "@/lib/workflow-graph/definition-schemas";
import { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";
import type { ConfigCascadeEditor } from "./cascade-editor";
import { cascadeScreens } from "./cascade-screens";
import { createConfigCascade } from "./config-cascade";
import {
  AGENT_VALIDATION_SCREEN_ID,
  LANE_MERGE_SCREEN_ID,
  SCRIPT_SCREEN_ID,
  VALIDATOR_SCREEN_ID,
} from "./GatesScreens";
import { seatScreenId } from "./navigation-ids";
import { PLAN_REPAIR_SCREEN_ID } from "./PolicyScreens";
import { buildContextRootCards, buildWorkflowRootCards } from "./root-cards";
import { createConfigScreenRegistry } from "./screen-registry";

const COMMANDS: readonly ValidationCommandSummary[] = [
  {
    name: "test",
    cost: 5,
    description: "Vitest",
    pathArgs: "paths",
    changedScope: "native",
  },
];

function contextDefinition(
  overrides: Partial<GraphWorkflowExecutionContextDefinition> = {},
): GraphWorkflowExecutionContextDefinition {
  return {
    id: "ctx_checkout",
    title: "Implement checkout",
    acceptanceCriteria: [
      { id: "ac-1", statement: "Every attempt writes one audit row." },
    ],
    placement: {
      lane: "delivery",
      mode: "owned",
      ownedPaths: ["src/checkout"],
    },
    ...overrides,
  };
}

function contextEditor(
  overrides: Partial<GraphWorkflowExecutionContextDefinition> = {},
): ConfigCascadeEditor {
  return {
    host: "builder",
    affordance: "editable",
    cascade: createConfigCascade({
      scope: "context",
      globalDefaults: SEEDED_WORKFLOW_DEFAULTS,
      workflowConfig: {},
      context: contextDefinition(overrides),
    }),
    onEdit: vi.fn(),
    validationCommands: COMMANDS,
    libraryProjectName: "checkout",
  };
}

function workflowEditor(
  workflowConfig: WorkflowConfigOverride = {},
): ConfigCascadeEditor {
  return {
    host: "builder",
    affordance: "editable",
    cascade: createConfigCascade({
      scope: "workflow",
      globalDefaults: SEEDED_WORKFLOW_DEFAULTS,
      workflowConfig,
    }),
    onEdit: vi.fn(),
    validationCommands: COMMANDS,
    libraryProjectName: "checkout",
  };
}

function registryFor(editor: ConfigCascadeEditor) {
  return createConfigScreenRegistry(cascadeScreens(editor));
}

function labelOf(editor: ConfigCascadeEditor, screenId: string): string | null {
  const resolved = registryFor(editor).resolve(screenId);
  expect(resolved).toBeDefined();
  return resolved?.overrideLabel ?? null;
}

describe("cascade screen registration", () => {
  it.each([
    ["agents", "Agents"],
    ["implementer", "Implementer"],
    ["collab", "Collaboration"],
    ["gates", "Quality gates"],
    [VALIDATOR_SCREEN_ID, "Validator cohort"],
    [SCRIPT_SCREEN_ID, "Script validator"],
    [AGENT_VALIDATION_SCREEN_ID, "Agent validation"],
    ["policy", "Execution policy"],
    [PLAN_REPAIR_SCREEN_ID, "Plan repair"],
  ])("resolves %s to its titled screen at the context scope", (id, title) => {
    expect(registryFor(contextEditor()).resolve(id)?.title).toBe(title);
  });

  it("titles a seat screen from the assignment id it names", () => {
    expect(
      registryFor(contextEditor()).resolve(seatScreenId("security"))?.title,
    ).toBe("security");
  });

  it("registers the lane-merge screen at the workflow scope only", () => {
    // Unreachable rather than merely unlisted: a context has no lane-merge
    // tier, so its panel must not be able to navigate to the screen at all.
    expect(
      registryFor(contextEditor()).resolve(LANE_MERGE_SCREEN_ID),
    ).toBeUndefined();
    expect(
      registryFor(workflowEditor()).resolve(LANE_MERGE_SCREEN_ID)?.title,
    ).toBe("Lane-merge validation");
  });

  it("gives every cascade root card a destination in its scope's registry", () => {
    const contextRegistry = registryFor(contextEditor());
    const contextCards = buildContextRootCards({
      cascade: contextEditor().cascade,
      context: contextDefinition(),
      outputSchemaText: "",
      upstreamInputCount: 0,
      taskCount: 0,
      nextTaskTitle: null,
    }).filter((card) => ["agents", "gates", "policy"].includes(card.screenId));
    expect(contextCards).toHaveLength(3);
    for (const card of contextCards) {
      expect(contextRegistry.resolve(card.screenId)?.title).toBe(card.title);
    }

    const workflowRegistry = registryFor(workflowEditor());
    const workflowCards = buildWorkflowRootCards({
      cascade: workflowEditor().cascade,
      invariantCount: 0,
      sourceCount: 0,
      parameters: [],
    }).filter((card) => ["agents", "gates", "policy"].includes(card.screenId));
    expect(workflowCards).toHaveLength(3);
    for (const card of workflowCards) {
      expect(workflowRegistry.resolve(card.screenId)?.title).toBe(card.title);
    }
  });
});

describe("cascade screen override badges", () => {
  it("badges nothing when the whole tier is inherited", () => {
    const editor = contextEditor();
    expect(labelOf(editor, "agents")).toBeNull();
    expect(labelOf(editor, "gates")).toBeNull();
    expect(labelOf(editor, "policy")).toBeNull();
  });

  it("counts a block override on the group and the screen that owns it", () => {
    const editor = contextEditor({
      circuitBreaker: { consecutiveFailureThreshold: 5 },
    });

    expect(labelOf(editor, "policy")).toBe("1 block set here");
    // The sibling drill under the same group opens a different block, so it
    // carries none of that count.
    expect(labelOf(editor, PLAN_REPAIR_SCREEN_ID)).toBeNull();
    expect(labelOf(editor, "agents")).toBeNull();
    expect(labelOf(editor, "gates")).toBeNull();
  });

  it("counts an agent-validation override as a role, on that screen alone", () => {
    const editor = contextEditor({
      agentValidation: { implementer: { mode: "only", commands: ["test"] } },
    });

    expect(labelOf(editor, "gates")).toBe("1 role set here");
    expect(labelOf(editor, AGENT_VALIDATION_SCREEN_ID)).toBe("1 role set here");
    expect(labelOf(editor, VALIDATOR_SCREEN_ID)).toBeNull();
    expect(labelOf(editor, SCRIPT_SCREEN_ID)).toBeNull();
  });

  it("counts a collaboration override as a field, and leaves the implementer alone", () => {
    const editor = contextEditor({ collaboration: { negotiationRounds: 4 } });

    expect(labelOf(editor, "agents")).toBe("1 field set here");
    expect(labelOf(editor, "collab")).toBe("1 field set here");
    expect(labelOf(editor, "implementer")).toBeNull();
  });

  it("names each kind separately when one group carries several granularities", () => {
    const editor = contextEditor({
      contextValidator: {
        enabled: false,
        assignments: SEEDED_WORKFLOW_DEFAULTS.contextValidator.assignments,
      },
      agentValidation: { implementer: { mode: "all", except: ["build"] } },
    });

    expect(labelOf(editor, "gates")).toBe("1 block · 1 role set here");
  });

  it("counts the lane-merge fields on the workflow scope's quality gates", () => {
    const editor = workflowEditor({
      laneMergeValidation: { strategy: "every-merge" },
    });

    expect(labelOf(editor, "gates")).toBe("1 field set here");
    expect(labelOf(editor, LANE_MERGE_SCREEN_ID)).toBe("1 field set here");
  });
});
