import { describe, expect, it } from "vitest";
import { locateAuthoredAccountabilityCoverage } from "./authored-accountability-coverage";
import { workerJudgeDefinition } from "./loop-test-fixtures";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";
import type {
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "./definition-schemas";

const SHIP_GUARD = {
  schema: {
    type: "object",
    properties: { verdict: { const: "ship" } },
    required: ["verdict"],
  },
};

function definition(
  contextIds: readonly string[],
  edges: WorkflowSemanticDefinition["edges"],
  loopGroups?: ReadonlyArray<{
    id: string;
    bodyContextIds: string[];
    entryContextId: string;
    exitContextId: string;
  }>,
): WorkflowSemanticDefinition {
  const base = createWorkflowDefinition();
  const context = base.executionContexts[0]!;
  return {
    ...base,
    executionContexts: contextIds.map((id) =>
      id === "route"
        ? {
            ...context,
            id,
            outputSchema: {
              type: "object",
              properties: { verdict: { type: "string" } },
            },
          }
        : { ...context, id },
    ),
    tasks: [],
    edges,
    ...(loopGroups === undefined
      ? { loopGroups: undefined }
      : {
          loopGroups: loopGroups.map((group) => ({
            ...group,
            title: group.id,
            until: { schema: { type: "object" } },
            maxPasses: 2,
          })),
        }),
  };
}

function edge(
  sourceContextId: string,
  targetContextId: string,
  when?: WorkflowSemanticDefinition["edges"][number]["when"],
): WorkflowSemanticDefinition["edges"][number] {
  return {
    id: `${sourceContextId}__${targetContextId}`,
    sourceContextId,
    targetContextId,
    ...(when === undefined ? {} : { when }),
  };
}

function workingDefinition(
  contextIds: readonly string[],
  edges: ResolvedWorkflowSemanticDefinition["edges"],
): ResolvedWorkflowSemanticDefinition {
  const base = createWorkflowExecution().workingDefinition;
  const context = base.executionContexts[0]!;
  return {
    ...base,
    executionContexts: contextIds.map((id) => ({ ...context, id })),
    tasks: [],
    edges: [...edges],
    loopGroups: undefined,
  };
}

describe("locateAuthoredAccountabilityCoverage", () => {
  it("locates overlapping and redundant claimants independently", () => {
    const result = locateAuthoredAccountabilityCoverage({
      source: {
        kind: "authored",
        definition: definition(
          ["route", "implement", "integrate", "conditional"],
          [
            edge("route", "implement"),
            edge("implement", "integrate"),
            edge("route", "conditional", SHIP_GUARD),
          ],
        ),
      },
      groups: [
        {
          bindingKey: "requirement-a",
          claimantContextIds: ["conditional", "integrate"],
        },
        {
          bindingKey: "requirement-b",
          claimantContextIds: ["implement", "integrate"],
        },
        {
          bindingKey: "requirement-c",
          claimantContextIds: ["conditional"],
        },
      ],
    });

    expect(result).toEqual([
      {
        bindingKey: "requirement-a",
        claimantContextIds: ["conditional", "integrate"],
        stableExistingClaimantContextIds: ["conditional", "integrate"],
        mustRunClaimantContextIds: ["integrate"],
        covered: true,
      },
      {
        bindingKey: "requirement-b",
        claimantContextIds: ["implement", "integrate"],
        stableExistingClaimantContextIds: ["implement", "integrate"],
        mustRunClaimantContextIds: ["implement", "integrate"],
        covered: true,
      },
      {
        bindingKey: "requirement-c",
        claimantContextIds: ["conditional"],
        stableExistingClaimantContextIds: ["conditional"],
        mustRunClaimantContextIds: [],
        covered: false,
      },
    ]);
  });

  it("accepts removing one alternative while locating only the orphaned group", () => {
    const result = locateAuthoredAccountabilityCoverage({
      source: {
        kind: "working",
        admittedStableSourceIds: ["root", "left", "right", "integrate"],
        definition: workingDefinition(
          ["root", "right", "integrate"],
          [edge("root", "right"), edge("right", "integrate")],
        ),
      },
      groups: [
        {
          bindingKey: "redundant",
          claimantContextIds: ["left", "right"],
        },
        { bindingKey: "orphaned", claimantContextIds: ["left"] },
        { bindingKey: "retained", claimantContextIds: ["right"] },
      ],
    });

    expect(
      result.map(({ bindingKey, covered }) => ({ bindingKey, covered })),
    ).toEqual([
      { bindingKey: "redundant", covered: true },
      { bindingKey: "orphaned", covered: false },
      { bindingKey: "retained", covered: true },
    ]);
    expect(result[0]?.stableExistingClaimantContextIds).toEqual(["right"]);
  });

  it("excludes loop templates while retaining a post-loop integration source", () => {
    const graph = definition(
      ["prepare", "loop-entry", "loop-worker", "integrate"],
      [
        edge("prepare", "loop-entry"),
        edge("loop-entry", "loop-worker"),
        edge("loop-worker", "integrate"),
      ],
      [
        {
          id: "refine",
          bodyContextIds: ["loop-entry", "loop-worker"],
          entryContextId: "loop-entry",
          exitContextId: "loop-worker",
        },
      ],
    );

    expect(
      locateAuthoredAccountabilityCoverage({
        source: { kind: "authored", definition: graph },
        groups: [
          { bindingKey: "loop-body", claimantContextIds: ["loop-worker"] },
          { bindingKey: "integration", claimantContextIds: ["integrate"] },
        ],
      }).map(({ bindingKey, stableExistingClaimantContextIds, covered }) => ({
        bindingKey,
        stableExistingClaimantContextIds,
        covered,
      })),
    ).toEqual([
      {
        bindingKey: "loop-body",
        stableExistingClaimantContextIds: [],
        covered: false,
      },
      {
        bindingKey: "integration",
        stableExistingClaimantContextIds: ["integrate"],
        covered: true,
      },
    ]);
  });

  it("keeps an unconditional post-loop claimant covered in a resolved working definition", () => {
    const result = locateAuthoredAccountabilityCoverage({
      source: {
        kind: "working",
        admittedStableSourceIds: ["seed", "publish"],
        definition: workerJudgeDefinition(),
      },
      groups: [
        {
          bindingKey: "post-loop-integration",
          claimantContextIds: ["publish"],
        },
      ],
    });

    expect(result).toEqual([
      {
        bindingKey: "post-loop-integration",
        claimantContextIds: ["publish"],
        stableExistingClaimantContextIds: ["publish"],
        mustRunClaimantContextIds: ["publish"],
        covered: true,
      },
    ]);
  });

  it("keeps a stable expansion spawner covered but refuses generated and loop-instance replacements", () => {
    const result = locateAuthoredAccountabilityCoverage({
      source: {
        kind: "working",
        admittedStableSourceIds: ["spawner", "integrate"],
        definition: workingDefinition(
          ["spawner", "spawned-child", "loop-worker__p1", "integrate"],
          [
            edge("spawner", "spawned-child"),
            edge("spawned-child", "loop-worker__p1"),
            edge("loop-worker__p1", "integrate"),
          ],
        ),
      },
      groups: [
        { bindingKey: "spawner", claimantContextIds: ["spawner"] },
        {
          bindingKey: "generated-replacement",
          claimantContextIds: ["spawned-child"],
        },
        {
          bindingKey: "loop-replacement",
          claimantContextIds: ["loop-worker__p1"],
        },
      ],
    });

    expect(
      result.map(({ bindingKey, covered }) => ({ bindingKey, covered })),
    ).toEqual([
      { bindingKey: "spawner", covered: true },
      { bindingKey: "generated-replacement", covered: false },
      { bindingKey: "loop-replacement", covered: false },
    ]);
  });
});
