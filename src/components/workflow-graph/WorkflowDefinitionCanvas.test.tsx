// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createMaximalAuthoredWorkflowLaunchFixture } from "@/lib/workflow-graph/testing/maximal-authored-launch";

import { deriveEdges, deriveNodes } from "./derive-graph";
import WorkflowDefinitionCanvas from "./WorkflowDefinitionCanvas";
import WorkflowFinalizedLaunchMetadata from "./WorkflowFinalizedLaunchMetadata";

/**
 * The delivery-plan surface hands an authored candidate launch to the ordinary
 * graph renderer rather than projecting a spec-shaped view model, so the
 * renderer must carry every admitted graph surface a candidate may author.
 * This is the same maximal launch the admission boundary is pinned to, which
 * is what keeps a newly admitted graph field from rendering as nothing.
 */
describe("WorkflowDefinitionCanvas with a maximal authored launch", () => {
  it("renders the authored layout without rewriting its workflowId", () => {
    const launch = createMaximalAuthoredWorkflowLaunchFixture();

    render(<WorkflowDefinitionCanvas launch={launch} />);

    expect(screen.getByTestId("workflow-definition-canvas")).toHaveAttribute(
      "data-workflow-id",
      "maximal-authored-graph-launch",
    );
  });

  it("derives a node for every authored context at its authored position", () => {
    const launch = createMaximalAuthoredWorkflowLaunchFixture();

    const nodes = deriveNodes(launch.definition, launch.layout);

    expect(nodes.map((node) => node.id)).toEqual([
      "context-spawner",
      "context-loop-worker",
      "context-loop-judge",
      "context-alternate",
      "context-audit",
      "context-fallback",
      "context-integrate",
    ]);
    // Loop bodies and guard targets are ordinary authored contexts; the
    // renderer positions them from the authored layout, not a re-layout.
    expect(
      nodes.find((node) => node.id === "context-loop-worker")?.position,
    ).toEqual({ x: 320, y: -180 });
    expect(
      nodes.find((node) => node.id === "context-fallback")?.position,
    ).toEqual({ x: 640, y: 260 });
  });

  it("carries authored output schemas and per-context tasks onto nodes", () => {
    const launch = createMaximalAuthoredWorkflowLaunchFixture();

    const nodes = deriveNodes(launch.definition, launch.layout);
    const worker = nodes.find((node) => node.id === "context-loop-worker");

    // Nothing has run, so an authored schema reads as declared-but-uncaptured
    // rather than as absent.
    expect(worker?.data.outputSchema).toEqual({ captured: false });
    expect(worker?.data.tasks.map((task) => task.id)).toEqual([
      "task-loop-worker",
    ]);
    expect(worker?.data.mode).toBe("builder");
    expect(worker?.data.context.placement).toEqual({
      lane: "implementation",
      mode: "owned",
      ownedPaths: ["src/lib/workflow-graph"],
    });
  });

  it("carries per-context validation, breakers, and expansion permission", () => {
    const launch = createMaximalAuthoredWorkflowLaunchFixture();

    const nodes = deriveNodes(launch.definition, launch.layout);
    const spawner = nodes.find((node) => node.id === "context-spawner");

    expect(spawner?.data.context.circuitBreaker).toEqual({
      consecutiveFailureThreshold: 4,
    });
    expect(spawner?.data.context.scriptValidator).toEqual({
      commands: ["lint"],
    });
    expect(spawner?.data.context.agentValidation?.implementer).toEqual({
      mode: "only",
      commands: ["lint"],
    });
    // Dynamic expansion permission is authored per context; the renderer must
    // not flatten it into the workflow-level default.
    expect(spawner?.data.context.mutability).toEqual({
      allowAgentTaskAdd: true,
      allowAgentContextAdd: true,
    });
  });

  it("derives an edge for every authored route including guarded and else routes", () => {
    const launch = createMaximalAuthoredWorkflowLaunchFixture();

    const edges = deriveEdges(launch.definition);

    expect(edges.map((edge) => edge.id)).toEqual([
      "edge-spawner-loop",
      "edge-spawner-alternate",
      "edge-spawner-integrate",
      "edge-loop-worker-judge",
      "edge-loop-judge-integrate",
      "edge-alternate-audit",
      "edge-alternate-fallback",
      "edge-audit-integrate",
      "edge-fallback-integrate",
    ]);
    expect(
      edges.find((edge) => edge.id === "edge-alternate-fallback"),
    ).toMatchObject({
      source: "context-alternate",
      target: "context-fallback",
    });
  });

  it("renders loop-group bodies as ordinary nodes rather than collapsing them", () => {
    const launch = createMaximalAuthoredWorkflowLaunchFixture();
    const loopGroup = launch.definition.loopGroups?.[0];

    const nodes = deriveNodes(launch.definition, launch.layout);

    // A loop group names existing contexts; the renderer must still draw each
    // body context on its own rather than folding the group into one node.
    expect(loopGroup?.bodyContextIds).not.toHaveLength(0);
    for (const bodyContextId of loopGroup?.bodyContextIds ?? []) {
      expect(nodes.find((node) => node.id === bodyContextId)).toBeDefined();
    }
  });
});

describe("WorkflowFinalizedLaunchMetadata", () => {
  it("shows the server-injected origin, approval flag, sources, and locks", () => {
    const launch = createMaximalAuthoredWorkflowLaunchFixture();

    render(<WorkflowFinalizedLaunchMetadata launch={launch} />);

    expect(screen.getByText("workflow://maximal-canary")).toBeVisible();
    expect(screen.getByText("approvalRequired: false")).toBeVisible();
    expect(screen.getByText("design-doc")).toBeVisible();
    expect(screen.getByText("/charter")).toBeVisible();
  });
});
