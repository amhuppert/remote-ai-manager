// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { modelDisplayLabel } from "@/lib/agent-backends/catalog";
import type { WorkflowDefinitionMutation } from "@/lib/workflow-graph/definition-schemas";
import { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";
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

    render(
      <WorkflowDefinitionCanvas
        launch={launch}
        globalDefaults={SEEDED_WORKFLOW_DEFAULTS}
      />,
    );

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

/**
 * The preview renders the AUTHORED document, so a workflow that configures its
 * agents once at the workflow tier leaves every context's crew blocks absent.
 * The canvas is the production path that must still show the crew that would
 * run, and the marker that says what the context sets on itself.
 */
describe("WorkflowDefinitionCanvas — effective crew and overrides", () => {
  function inheritedCrewLaunch(): WorkflowDefinitionMutation {
    const launch = createMaximalAuthoredWorkflowLaunchFixture();
    launch.definition.workflowConfig = {
      ...launch.definition.workflowConfig,
      implementer: {
        id: "implementer",
        profile: { tier: "builtin", id: "general-implementer" },
        agent: {
          backend: "claude",
          modelSelection: {
            modelId: "opus",
            parameters: { effort: "high" },
          },
        },
      },
      contextValidator: {
        enabled: true,
        assignments: [
          {
            id: "security",
            profile: { tier: "builtin", id: "general-reviewer" },
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
        ],
      },
    };
    launch.definition.executionContexts =
      launch.definition.executionContexts.map(
        ({
          implementer: _implementer,
          contextValidator: _cohort,
          ...context
        }) => context,
      );
    return launch;
  }

  it("shows the workflow-tier implementer and cohort a context inherits", () => {
    render(
      <WorkflowDefinitionCanvas
        launch={inheritedCrewLaunch()}
        globalDefaults={SEEDED_WORKFLOW_DEFAULTS}
      />,
    );

    const crew = screen.getAllByTestId("node-crew")[0];
    expect(crew).toHaveTextContent(modelDisplayLabel("claude", "opus"));
    expect(within(crew!).getAllByTestId("node-crew-seat")[0]).toHaveTextContent(
      "security",
    );
  });

  it("marks a context that sets its own implementer, naming the reason", () => {
    const launch = inheritedCrewLaunch();
    const [first, ...rest] = launch.definition.executionContexts;
    launch.definition.executionContexts = [
      {
        ...first!,
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          agent: {
            backend: "codex",
            modelSelection: {
              modelId: "gpt-5.5",
              parameters: { effort: "medium" },
            },
          },
        },
      },
      ...rest,
    ];

    render(
      <WorkflowDefinitionCanvas
        launch={launch}
        globalDefaults={SEEDED_WORKFLOW_DEFAULTS}
      />,
    );

    const card = screen
      .getAllByTestId("context-node")
      .find((node) => node.textContent?.includes(first!.title));
    // The dot itself is decorative — it repeats what the name below states.
    expect(within(card!).getByTestId("node-set-here-marker")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    // Hover is not a reading channel: the reason belongs to the node's name.
    // Asserted on the attribute rather than the computed name because React
    // Flow keeps a node hidden until the pane measures it, and jsdom never
    // does — a computed name would be empty for reasons unrelated to this.
    expect(card).toHaveAttribute(
      "aria-label",
      expect.stringContaining("set on this context: implementer"),
    );
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

  // #69 change 4 stage 1: the launch preview lists each context's acceptance
  // criteria — numbered `[id]` lines for records, prose verbatim for legacy.
  it("lists each context's acceptance criteria as numbered records", () => {
    const launch = createMaximalAuthoredWorkflowLaunchFixture();
    launch.definition.executionContexts =
      launch.definition.executionContexts.map((context, index) =>
        index === 0
          ? {
              ...context,
              acceptanceCriteria: [
                { id: "ac-1", statement: "The spawner selects a route" },
                { id: "audit-log", statement: "The choice is audited" },
              ],
            }
          : context,
      );

    render(<WorkflowFinalizedLaunchMetadata launch={launch} />);

    const block = screen.getByTestId("launch-context-criteria");
    expect(block).toHaveTextContent("1. [ac-1] The spawner selects a route");
    expect(block).toHaveTextContent("2. [audit-log] The choice is audited");
    expect(block).toHaveTextContent("The pass emits progress.");
  });
});
