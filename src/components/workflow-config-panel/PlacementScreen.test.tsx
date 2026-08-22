// @vitest-environment jsdom
/**
 * The Placement screen: where a context runs and what it may write (Config
 * Panel `placementRows()`).
 *
 * Lane and grade are the two fields a lane drag and this screen both write, so
 * the assertions pin that they mean the same thing here as on the canvas — a
 * grade change never rewrites paths, and a lane change never re-grades.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { placementAuthoringIssue } from "@/components/workflow-config/PlacementEditor";
import type { GraphWorkflowExecutionContextDefinition } from "@/lib/workflow-graph/definition-schemas";
import { PlacementScreen } from "./PlacementScreen";
import type {
  ContextRuntimeFacts,
  ContextStructuralEditor,
} from "./structural-editor";

afterEach(cleanup);

const OWNING: GraphWorkflowExecutionContextDefinition = {
  id: "ctx_checkout",
  title: "Implement checkout",
  acceptanceCriteria: [{ id: "ac-1", statement: "Audited." }],
  placement: {
    lane: "delivery",
    mode: "owned",
    ownedPaths: ["src/checkout", "src/risk"],
  },
  // Authored by no screen here — the round-trip witness.
  mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: true },
};

const RUNTIME: ContextRuntimeFacts = {
  lane: "delivery",
  branch: "cc/lane-delivery",
  worktree: ".worktrees/lane-delivery",
  isolation: "worktree",
  activity: "implementing",
  merge: "merged-success",
  cleanup: "removed",
  join: "pending — 2 members",
  batch: "batch 1 of 2",
  mergeError: "",
};

function editorFor(
  overrides: Partial<ContextStructuralEditor> = {},
): ContextStructuralEditor {
  return {
    host: "builder",
    affordance: "editable",
    context: OWNING,
    onContextChange: vi.fn(),
    outputSchemaText: "",
    onOutputSchemaTextChange: vi.fn(),
    upstreamInputs: [],
    tasks: [],
    workflowTaskIds: [],
    onTasksChange: vi.fn(),
    ...overrides,
  };
}

function renderScreen(overrides: Partial<ContextStructuralEditor> = {}) {
  const editor = editorFor(overrides);
  render(<PlacementScreen editor={editor} />);
  return editor;
}

describe("PlacementScreen lane", () => {
  it("edits the lane and nothing else", () => {
    const onContextChange = vi.fn();
    renderScreen({ onContextChange });

    fireEvent.change(screen.getByLabelText("Lane name"), {
      target: { value: "candidate-rules" },
    });

    expect(onContextChange).toHaveBeenCalledWith({
      ...OWNING,
      placement: { ...OWNING.placement, lane: "candidate-rules" },
    });
  });

  it("carries the design's lane hint, which names the drag equivalence", () => {
    renderScreen();
    expect(
      screen.getByText(
        /Contexts sharing a lane share one worktree and land through one join\. Dragging this context to another lane on the canvas edits this field and nothing else\./,
      ),
    ).toBeInTheDocument();
  });

  it("reports the existing lane-identity refusal while the author types", () => {
    renderScreen({
      context: {
        ...OWNING,
        placement: { ...OWNING.placement, lane: "bad lane name" },
      },
    });

    const issue = placementAuthoringIssue({
      ...OWNING.placement,
      lane: "bad lane name",
    });
    expect(issue).not.toBeNull();
    expect(screen.getByTestId("placement-issue")).toHaveTextContent(
      issue ?? "",
    );
  });

  it("shows no issue for a legal placement", () => {
    renderScreen();
    expect(screen.queryByTestId("placement-issue")).toBeNull();
  });
});

describe("PlacementScreen write grade", () => {
  it("offers the three grades with the design's labels", () => {
    renderScreen();

    const group = screen.getByRole("radiogroup", { name: "Write grade" });
    for (const label of ["Full", "Owning", "Read-only"]) {
      expect(within(group).getByRole("radio", { name: label })).toBeTruthy();
    }
  });

  it.each([
    [
      "owned",
      "Writes only inside the listed paths. Runs beside other owning members whose canonical paths are disjoint.",
    ],
    [
      "full",
      "Writes anywhere in the lane worktree — requires exclusive occupancy of the lane while it runs.",
    ],
    [
      "readOnly",
      "Writes nothing; delivers through its output schema alone. Required on the reserved session lane, allowed on any lane.",
    ],
  ] as const)("explains the %s grade with the design's copy", (mode, hint) => {
    const placement =
      mode === "owned"
        ? OWNING.placement
        : ({ lane: "delivery", mode } as const);
    renderScreen({ context: { ...OWNING, placement } });

    expect(screen.getByText(hint)).toBeInTheDocument();
  });

  it("moving off owning drops the paths the grade cannot carry", () => {
    const onContextChange = vi.fn();
    renderScreen({ onContextChange });

    fireEvent.click(screen.getByRole("radio", { name: "Full" }));

    expect(onContextChange).toHaveBeenCalledWith({
      ...OWNING,
      placement: { lane: "delivery", mode: "full" },
    });
  });

  it("moving to owning starts an empty write surface rather than inventing one", () => {
    const onContextChange = vi.fn();
    renderScreen({
      onContextChange,
      context: { ...OWNING, placement: { lane: "delivery", mode: "full" } },
    });

    fireEvent.click(screen.getByRole("radio", { name: "Owning" }));

    expect(onContextChange).toHaveBeenCalledWith({
      ...OWNING,
      placement: { lane: "delivery", mode: "owned", ownedPaths: [] },
    });
  });
});

describe("PlacementScreen write surface", () => {
  it("chips each owned path with its own remove", () => {
    const onContextChange = vi.fn();
    renderScreen({ onContextChange });

    expect(screen.getByText("src/checkout")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove src/risk" }));

    expect(onContextChange).toHaveBeenCalledWith({
      ...OWNING,
      placement: {
        lane: "delivery",
        mode: "owned",
        ownedPaths: ["src/checkout"],
      },
    });
  });

  it("adds a typed path and refuses a duplicate", () => {
    const onContextChange = vi.fn();
    renderScreen({ onContextChange });

    const field = screen.getByLabelText("Add owned path");
    const add = screen.getByRole("button", { name: /^add path$/i });

    fireEvent.change(field, { target: { value: "src/checkout" } });
    expect(add).toBeDisabled();

    fireEvent.change(field, { target: { value: "src/settings" } });
    fireEvent.click(add);

    expect(onContextChange).toHaveBeenCalledWith({
      ...OWNING,
      placement: {
        lane: "delivery",
        mode: "owned",
        ownedPaths: ["src/checkout", "src/risk", "src/settings"],
      },
    });
  });

  it("carries the literal-paths hint", () => {
    renderScreen();
    expect(
      screen.getByText(/Literal repo-relative paths, never globs\./),
    ).toBeInTheDocument();
  });

  it("is absent unless the grade is owning", () => {
    renderScreen({
      context: { ...OWNING, placement: { lane: "delivery", mode: "full" } },
    });
    expect(screen.queryByLabelText("Add owned path")).toBeNull();
  });
});

describe("PlacementScreen runtime section", () => {
  it("appends read-only runtime rows on the execution host", () => {
    renderScreen({
      host: "execution",
      affordance: "editable",
      runtime: RUNTIME,
    });

    for (const [label, value] of [
      ["Lane", RUNTIME.lane],
      ["Branch", RUNTIME.branch],
      ["Worktree", RUNTIME.worktree],
      ["Isolation", RUNTIME.isolation],
      ["Activity", RUNTIME.activity],
      ["Merge", RUNTIME.merge],
      ["Cleanup", RUNTIME.cleanup],
      ["Join", RUNTIME.join],
      ["Batch", RUNTIME.batch],
    ] as const) {
      const row = screen.getByTestId(
        `config-row-runtime-${label.toLowerCase()}`,
      );
      expect(row).toHaveTextContent(label);
      expect(row).toHaveTextContent(value);
      // Runtime is what the engine did, not something to author.
      expect(within(row).queryByRole("textbox")).toBeNull();
      expect(within(row).queryByRole("button")).toBeNull();
    }
  });

  it("is absent on the builder, where nothing is running", () => {
    renderScreen();
    expect(screen.queryByTestId("config-row-runtime-branch")).toBeNull();
  });

  it("keeps the merge-error row away until there is an error to report", () => {
    renderScreen({
      host: "execution",
      affordance: "editable",
      runtime: RUNTIME,
    });
    expect(screen.queryByTestId("config-row-runtime-mergeError")).toBeNull();
    cleanup();

    renderScreen({
      host: "execution",
      affordance: "editable",
      runtime: { ...RUNTIME, mergeError: "conflict in file.ts" },
    });
    expect(
      screen.getByTestId("config-row-runtime-mergeError"),
    ).toHaveTextContent("conflict in file.ts");
  });
});

describe("PlacementScreen when locked", () => {
  it("disables every authoring control", () => {
    renderScreen({ host: "execution", affordance: "frozen", runtime: RUNTIME });

    expect(screen.getByLabelText("Lane name")).toBeDisabled();
    expect(screen.getByLabelText("Add owned path")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Remove src/risk" }),
    ).toBeDisabled();
  });
});
