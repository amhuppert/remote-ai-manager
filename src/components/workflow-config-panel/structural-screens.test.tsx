// @vitest-environment jsdom
/**
 * The structural screens as the panel actually mounts them: registered ids,
 * push navigation between them, and the back row that names the parent.
 *
 * The component suites cover what each screen edits; this one covers that a
 * card can reach it — the registry wiring no single-screen test can see.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowTaskDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { ConfigPanel } from "./ConfigPanel";
import { createConfigScreenRegistry } from "./screen-registry";
import type {
  ContextStructuralEditor,
  WorkflowStructuralEditor,
} from "./structural-editor";
import {
  contextStructuralScreens,
  workflowStructuralScreens,
} from "./structural-screens";

afterEach(cleanup);

const CONTEXT: GraphWorkflowExecutionContextDefinition = {
  id: "ctx_checkout",
  title: "Implement checkout",
  acceptanceCriteria: [{ id: "ac-1", statement: "Audited." }],
  placement: { lane: "delivery", mode: "owned", ownedPaths: ["src/checkout"] },
};

const TASKS: GraphWorkflowTaskDefinition[] = [
  {
    id: "task-1",
    contextId: "ctx_checkout",
    order: 1,
    title: "Reserve inventory",
    instructions: "Hold the stock.",
    source: "user",
  },
];

function editorFor(): ContextStructuralEditor {
  return {
    host: "builder",
    affordance: "editable",
    context: CONTEXT,
    onContextChange: vi.fn(),
    outputSchemaText: "",
    onOutputSchemaTextChange: vi.fn(),
    upstreamInputs: [],
    tasks: TASKS,
    workflowTaskIds: TASKS.map((each) => each.id),
    onTasksChange: vi.fn(),
    onDeleteContext: vi.fn(),
  };
}

function renderPanel(initialScreenPath: string[]) {
  const screens = createConfigScreenRegistry(
    contextStructuralScreens(editorFor()),
  );
  render(
    <ConfigPanel
      host="builder"
      scope="context"
      entityTitle={CONTEXT.title}
      entityMeta="delivery · owning"
      rootCards={[]}
      screens={screens}
      initialScreenPath={initialScreenPath}
    />,
  );
}

describe("contextStructuralScreens registration", () => {
  it.each([
    ["brief", "Brief"],
    ["schema", "Output schema"],
    ["placement", "Placement"],
    ["tasks", "Tasks"],
  ])("resolves %s to its titled screen", (screenId, title) => {
    renderPanel([screenId]);
    expect(screen.getByTestId("config-screen-title")).toHaveTextContent(title);
  });

  it("titles a task screen from the task's own position and title", () => {
    renderPanel(["tasks", "task:task-1"]);
    expect(screen.getByTestId("config-screen-title")).toHaveTextContent(
      "1 · Reserve inventory",
    );
  });
});

describe("workflowStructuralScreens registration", () => {
  function workflowEditor(): WorkflowStructuralEditor {
    return {
      affordance: "editable",
      charter: {
        mission: "Ship checkout v2.",
        invariants: [{ id: "inv-1", statement: "Audit everything." }],
        sourcesOfTruth: [
          {
            rank: 1,
            id: "src-spec",
            label: "Spec",
            type: "spec",
            locator: "docs/spec.md",
            description: "The spec.",
          },
        ],
      },
      onCharterChange: vi.fn(),
      parameters: [
        {
          type: "string",
          name: "target_branch",
          label: "Target branch",
          required: true,
        },
      ],
      onParametersChange: vi.fn(),
      contexts: [{ id: "ctx_checkout", title: "Implement checkout" }],
    };
  }

  function renderWorkflowPanel(screenId: string) {
    render(
      <ConfigPanel
        host="builder"
        scope="workflow"
        entityTitle="checkout-v2 release train"
        entityMeta="r5 · unsaved"
        rootCards={[]}
        screens={createConfigScreenRegistry(
          workflowStructuralScreens(workflowEditor()),
        )}
        initialScreenPath={[screenId]}
      />,
    );
  }

  it.each([
    ["charter", "Charter", "Statement for inv-1"],
    ["params", "Launch parameters", "Name of target_branch"],
  ])("resolves %s to its titled screen", (screenId, title, control) => {
    renderWorkflowPanel(screenId);
    expect(screen.getByTestId("config-screen-title")).toHaveTextContent(title);
    expect(screen.getByLabelText(control)).toBeInTheDocument();
  });

  it("names the workflow tier in the back row", () => {
    renderWorkflowPanel("charter");
    expect(
      screen.getByRole("button", { name: "Back to Workflow" }),
    ).toBeInTheDocument();
  });
});

describe("structural screen navigation", () => {
  it("drills Brief → Output schema and back", () => {
    renderPanel(["brief"]);

    fireEvent.click(screen.getByRole("button", { name: /output schema/i }));
    expect(screen.getByTestId("config-screen-title")).toHaveTextContent(
      "Output schema",
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to Brief" }));
    expect(screen.getByTestId("config-screen-title")).toHaveTextContent(
      "Brief",
    );
  });

  it("drills Tasks → a task and back, the back row naming Tasks", () => {
    renderPanel(["tasks"]);

    fireEvent.click(
      screen.getByRole("button", { name: "1 · Reserve inventory" }),
    );
    expect(screen.getByLabelText("Task instructions")).toHaveValue(
      "Hold the stock.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to Tasks" }));
    expect(screen.getByTestId("config-screen-title")).toHaveTextContent(
      "Tasks",
    );
  });
});
