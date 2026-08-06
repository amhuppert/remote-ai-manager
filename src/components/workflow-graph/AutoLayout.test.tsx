// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AutoLayout from "./AutoLayout";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
type MeasuredNode = {
  id: string;
  measured?: { width: number; height: number };
};

let mockedNodes: MeasuredNode[] = [];
let mockedInitialized = false;

vi.mock("@xyflow/react", () => ({
  useReactFlow: () => ({ getNodes: () => mockedNodes }),
  useNodesInitialized: () => mockedInitialized,
  useNodes: () => mockedNodes,
}));

function makeContext(id: string) {
  return {
    id,
    title: id,
    acceptanceCriteria: "TBD",
    implementer: {
      id: "implementer",
      profile: { tier: "builtin" as const, id: "general-implementer" },
      agent: {
        backend: "claude" as const,
        model: "sonnet" as const,
        reasoningEffort: "medium" as const,
      },
    },
    mutability: { allowAgentTaskAdd: false },
    circuitBreaker: {},
    iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
  };
}

function makeDefinition(contextIds: string[]): WorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    charter: makeTestCharter(),
    parameters: [],
    prerequisites: [],
    executionContexts: contextIds.map(makeContext),
    tasks: [],
    edges: [],
  };
}

describe("AutoLayout", () => {
  it("regenerates layout when measured node dimensions change", () => {
    const onLayout = vi.fn();
    const definition = makeDefinition(["a", "b"]);

    mockedNodes = [
      { id: "a", measured: { width: 248, height: 200 } },
      { id: "b", measured: { width: 248, height: 200 } },
    ];
    mockedInitialized = true;

    const { rerender } = render(
      <AutoLayout definition={definition} onLayout={onLayout} />,
    );

    expect(onLayout).toHaveBeenCalledTimes(1);
    const firstLayout = onLayout.mock.calls[0]![0];
    expect(firstLayout.contextPositions["b"]?.y).toBe(200 + 40);

    mockedNodes = [
      { id: "a", measured: { width: 248, height: 350 } },
      { id: "b", measured: { width: 248, height: 200 } },
    ];

    rerender(<AutoLayout definition={definition} onLayout={onLayout} />);

    expect(onLayout).toHaveBeenCalledTimes(2);
    const secondLayout = onLayout.mock.calls[1]![0];
    expect(secondLayout.contextPositions["b"]?.y).toBe(350 + 40);
  });

  it("does not regenerate when nodes render but dimensions are unchanged", () => {
    const onLayout = vi.fn();
    const definition = makeDefinition(["a", "b"]);

    mockedNodes = [
      { id: "a", measured: { width: 248, height: 200 } },
      { id: "b", measured: { width: 248, height: 200 } },
    ];
    mockedInitialized = true;

    const { rerender } = render(
      <AutoLayout definition={definition} onLayout={onLayout} />,
    );

    expect(onLayout).toHaveBeenCalledTimes(1);

    mockedNodes = [
      { id: "a", measured: { width: 248, height: 200 } },
      { id: "b", measured: { width: 248, height: 200 } },
    ];

    rerender(<AutoLayout definition={definition} onLayout={onLayout} />);

    expect(onLayout).toHaveBeenCalledTimes(1);
  });
});
