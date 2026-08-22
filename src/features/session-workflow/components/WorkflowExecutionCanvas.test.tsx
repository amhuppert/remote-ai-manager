// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  createWorkflowDefinition,
  createWorkflowExecution,
  createWorkflowLayout,
} from "@/lib/workflow-graph/test-fixtures";

import type {
  GraphWorkflowResolvedContext,
  ResolvedWorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";

import WorkflowExecutionCanvas from "./WorkflowExecutionCanvas";

function planCard(): HTMLElement {
  const card = screen
    .getAllByTestId("context-node")
    .find((node) => node.textContent?.includes("Plan"));
  expect(card).toBeDefined();
  return card!;
}

/**
 * The cascade flattens away WHICH tier set each block, so a running execution's
 * working definition alone cannot light the set-on-this-context marker. Its
 * launch document is the pre-cascade source that still says so.
 */
describe("WorkflowExecutionCanvas — set-on-this-context marker", () => {
  it("reads the launch document for the blocks a context sets on itself", () => {
    const authored = createWorkflowDefinition();
    const execution = createWorkflowExecution({
      launchDocument: {
        name: "Workflow Graph Builder",
        description: null,
        definition: authored,
        layout: createWorkflowLayout(),
      },
    });

    render(
      <WorkflowExecutionCanvas
        execution={execution}
        layout={createWorkflowLayout()}
        onSelectContext={() => {}}
        preserveLayout
      />,
    );

    const card = planCard();
    expect(within(card).getByTestId("node-set-here-marker")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    // Asserted on the attribute rather than the computed name: React Flow keeps
    // a node hidden until the pane measures it, which jsdom never does.
    expect(card).toHaveAttribute(
      "aria-label",
      expect.stringContaining("set on this context: implementer"),
    );
  });

  /**
   * The launch document is immutable, so it can never record a live edit. A
   * context that inherited a block at launch and had it changed mid-run through
   * update-context must still light the marker — otherwise the node reports the
   * run's configuration as it was launched rather than as it is.
   */
  it("marks a block a live edit changed after launch", () => {
    const authored = createWorkflowDefinition();
    const planIndex = authored.executionContexts.findIndex(
      (context) => context.id === "context-plan",
    );
    const inheritedImplementer =
      authored.executionContexts[planIndex]!.implementer!;

    // Launched inheriting the implementer from the workflow tier.
    const launchDefinition = {
      ...authored,
      workflowConfig: {
        ...authored.workflowConfig,
        implementer: inheritedImplementer,
      },
      executionContexts: authored.executionContexts.map((context) =>
        context.id === "context-plan"
          ? { ...context, implementer: undefined }
          : context,
      ),
    };

    // The working definition as a live edit left it: a different effort.
    const seeded = createWorkflowExecution();
    const working: ResolvedWorkflowSemanticDefinition = {
      ...seeded.workingDefinition,
      executionContexts: seeded.workingDefinition.executionContexts.map(
        (context): GraphWorkflowResolvedContext =>
          context.id === "context-plan"
            ? {
                ...context,
                implementer: {
                  ...context.implementer,
                  agent: {
                    ...context.implementer.agent,
                    reasoningEffort: "low" as const,
                  },
                },
              }
            : context,
      ),
    };

    const execution = createWorkflowExecution({
      workingDefinition: working,
      launchDocument: {
        name: "Workflow Graph Builder",
        description: null,
        definition: launchDefinition,
        layout: createWorkflowLayout(),
      },
    });

    render(
      <WorkflowExecutionCanvas
        execution={execution}
        layout={createWorkflowLayout()}
        onSelectContext={() => {}}
        preserveLayout
      />,
    );

    expect(planCard()).toHaveAttribute(
      "aria-label",
      expect.stringContaining("set on this context: implementer"),
    );
  });

  it("reports the crew as inherited for a run that snapshotted no launch document", () => {
    const execution = createWorkflowExecution({ launchDocument: null });

    render(
      <WorkflowExecutionCanvas
        execution={execution}
        layout={createWorkflowLayout()}
        onSelectContext={() => {}}
        preserveLayout
      />,
    );

    const card = planCard();
    expect(within(card).queryByTestId("node-set-here-marker")).toBeNull();
    expect(card).toHaveAttribute(
      "aria-label",
      expect.stringContaining("inherited"),
    );
  });
});

function planNodeTransform(): string {
  const wrapper = planCard().closest(".react-flow__node");
  expect(wrapper).not.toBeNull();
  return (wrapper as HTMLElement).style.transform;
}

/**
 * Selecting a different execution can reuse this mounted canvas rather than
 * remounting it, so the layout the canvas holds has to follow the execution it
 * is drawing. With `preserveLayout` there is no AutoLayout to re-place anything
 * either, so a layout that stayed behind is the only thing positioning nodes.
 */
describe("WorkflowExecutionCanvas — layout follows the selected execution", () => {
  it("adopts the newly selected execution's explicit positions", () => {
    const first = createWorkflowExecution({ id: "execution-1" });
    const second = createWorkflowExecution({ id: "execution-2" });

    const { rerender } = render(
      <WorkflowExecutionCanvas
        execution={first}
        layout={createWorkflowLayout({
          contextPositions: { "context-plan": { x: 10, y: 20 } },
        })}
        onSelectContext={() => {}}
        preserveLayout
      />,
    );

    expect(planNodeTransform()).toContain("translate(10px,20px)");

    rerender(
      <WorkflowExecutionCanvas
        execution={second}
        layout={createWorkflowLayout({
          contextPositions: { "context-plan": { x: 999, y: 555 } },
        })}
        onSelectContext={() => {}}
        preserveLayout
      />,
    );

    expect(planNodeTransform()).toContain("translate(999px,555px)");
  });

  /**
   * A runtime expansion adds a context to the SAME execution mid-run, and the
   * panel re-merges the layout to place it. Keying the drawn layout to the
   * execution id alone would hold the pre-expansion layout, leaving the new
   * context stranded at the origin: AutoLayout cannot repair that either,
   * because it is handed the new layout as `existingLayout`, regenerates
   * identical positions and correctly stays silent.
   */
  it("adopts positions that arrive for the same execution", () => {
    const execution = createWorkflowExecution({ id: "execution-1" });

    const { rerender } = render(
      <WorkflowExecutionCanvas
        execution={execution}
        layout={createWorkflowLayout({
          contextPositions: { "context-plan": { x: 10, y: 20 } },
        })}
        onSelectContext={() => {}}
        preserveLayout
      />,
    );

    rerender(
      <WorkflowExecutionCanvas
        execution={execution}
        layout={createWorkflowLayout({
          contextPositions: { "context-plan": { x: 640, y: 320 } },
        })}
        onSelectContext={() => {}}
        preserveLayout
      />,
    );

    expect(planNodeTransform()).toContain("translate(640px,320px)");
  });

  /**
   * The other half: within ONE execution the canvas keeps the layout it holds.
   * AutoLayout refines positions into that state as React Flow measures cards,
   * and re-adopting the prop on every render would throw each refinement away.
   */
  it("keeps its layout across a re-render of the same execution", () => {
    const execution = createWorkflowExecution({ id: "execution-1" });
    const layout = createWorkflowLayout({
      contextPositions: { "context-plan": { x: 10, y: 20 } },
    });

    const { rerender } = render(
      <WorkflowExecutionCanvas
        execution={execution}
        layout={layout}
        onSelectContext={() => {}}
        preserveLayout
      />,
    );

    rerender(
      <WorkflowExecutionCanvas
        execution={execution}
        layout={layout}
        onSelectContext={() => {}}
        preserveLayout
      />,
    );

    expect(planNodeTransform()).toContain("translate(10px,20px)");
  });
});

const JOIN_ID = "join_delivery_1";

/** A run stopped by a conflicted join, as the engine persists one. */
function haltedOnJoin() {
  const base = createWorkflowExecution({ status: "halted" });
  const lane = (laneId: string, contextId: string) => ({
    laneId,
    kind: "worktree" as const,
    status: "active" as const,
    worktreePath: `/tmp/${laneId}`,
    branchName: `wf/${laneId}`,
    includedContextIds: [contextId],
    lastCommittingContextId: contextId,
    commitSnapshots: [],
    createdAt: "2026-08-21T09:00:00.000Z",
    updatedAt: "2026-08-21T10:00:00.000Z",
  });
  return {
    ...base,
    haltReason: {
      type: "join_failure" as const,
      joinId: JOIN_ID,
      joinKind: "context_merge" as const,
      contextId: "context-implement",
      sourceLaneIds: ["lane-plan", "lane-implement"],
      targetLaneId: "delivery",
      message: "merge conflict",
      conflictFiles: ["src/checkout/audit.ts"],
    },
    joins: {
      [JOIN_ID]: {
        joinId: JOIN_ID,
        kind: "context_merge" as const,
        contextId: "context-implement",
        targetLaneId: "delivery",
        sourceLaneIds: ["lane-plan", "lane-implement"],
        mergedSourceLaneIds: ["lane-plan"],
        validationDebtSourceLaneIds: [],
        sourceLaneContextIds: {
          "lane-plan": ["context-plan"],
          "lane-implement": ["context-implement"],
        },
        status: "conflicts" as const,
        errorMessage: "both wrote the timeout branch",
        conflicts: {
          files: ["src/checkout/audit.ts"],
          message: "merge conflict",
          analysis: null,
        },
        conflictGuidance: null,
        createdAt: "2026-08-21T10:00:00.000Z",
        updatedAt: "2026-08-21T10:05:00.000Z",
        completedAt: null,
      },
    },
    executionLanes: {
      "lane-plan": lane("lane-plan", "context-plan"),
      "lane-implement": lane("lane-implement", "context-implement"),
    },
  };
}

// M2: below 768px the Graph panel is the stacked lane list, not a pannable
// viewport — the same substitution the builder makes.
describe("WorkflowExecutionCanvas — mobile graph panel", () => {
  it("stacks the execution's lanes instead of mounting the canvas", () => {
    const execution = createWorkflowExecution();
    render(
      <WorkflowExecutionCanvas
        execution={execution}
        layout={createWorkflowLayout()}
        onSelectContext={() => {}}
        isMobile
      />,
    );

    expect(screen.getByTestId("workflow-mobile-graph")).toBeInTheDocument();
    expect(screen.getAllByTestId("mobile-lane-band").length).toBeGreaterThan(0);
    // Runtime state is what the execution list adds over the builder's.
    expect(screen.getAllByTestId("mobile-lane-band")[0]).toHaveAttribute(
      "data-lane-state",
    );
  });

  it("marks the selected context as current in the stacked list", () => {
    render(
      <WorkflowExecutionCanvas
        execution={createWorkflowExecution()}
        layout={createWorkflowLayout()}
        onSelectContext={() => {}}
        isMobile
        selectedContextId="context-plan"
      />,
    );

    const selected = screen
      .getAllByTestId("mobile-lane-member")
      .filter((card) => card.getAttribute("aria-current") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveAttribute("data-context-id", "context-plan");
  });

  // README §11 puts join conflicts on the lane rail at every breakpoint. The
  // stacked list has no band geometry, but it is still the Graph panel, so the
  // conflict is stated there rather than only on the canvas.
  it("states a conflicted join and its recovery actions on the stacked list", () => {
    const onEditOwnership = vi.fn();
    render(
      <WorkflowExecutionCanvas
        execution={haltedOnJoin()}
        layout={createWorkflowLayout()}
        onSelectContext={() => {}}
        onEditOwnership={onEditOwnership}
        isMobile
      />,
    );

    const card = screen.getByTestId("lane-join-conflict-card");
    expect(card).toHaveTextContent("Join conflict — delivery");
    expect(card).toHaveTextContent("both wrote the timeout branch");

    fireEvent.click(
      within(card).getByRole("button", { name: "Edit ownership" }),
    );
    expect(onEditOwnership).toHaveBeenCalledWith("context-implement");
  });
});
