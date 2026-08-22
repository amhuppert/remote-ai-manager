// @vitest-environment jsdom
/**
 * The Brief screen: identity, ordered acceptance criteria, the read-only data
 * contract, and the builder-only danger zone (Config Panel `briefRows()`).
 *
 * The assertions that matter are the ones an author would notice going wrong:
 * an edit that drops a sibling field, a reorder that renames a criterion id a
 * validator cites, and a delete that fires without a confirmation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowTaskDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowUpstreamInput } from "@/lib/workflow-graph/context-outputs";
import { BriefScreen } from "./BriefScreen";
import type { ContextStructuralEditor } from "./structural-editor";

afterEach(cleanup);

const CONTEXT: GraphWorkflowExecutionContextDefinition = {
  id: "ctx_checkout",
  title: "Implement checkout",
  description: "Wire the new checkout path behind the rollout flag.",
  acceptanceCriteria: [
    { id: "ac-1", statement: "Every attempt writes exactly one audit row." },
    { id: "ac-2", statement: "A declined card never reserves inventory." },
  ],
  placement: {
    lane: "delivery",
    mode: "owned",
    ownedPaths: ["src/checkout", "src/risk"],
  },
  // Authored by no screen in this panel — the round-trip witness (README §6).
  mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: true },
};

const UPSTREAM: GraphWorkflowUpstreamInput[] = [
  {
    contextId: "ctx_plan",
    title: "Plan the migration",
    declared: true,
    schemaFields: [
      {
        name: "migrationPlan",
        type: "string",
        required: true,
        description: null,
      },
    ],
    output: null,
    skipped: false,
  },
];

function editorFor(
  overrides: Partial<ContextStructuralEditor> = {},
): ContextStructuralEditor {
  return {
    host: "builder",
    affordance: "editable",
    context: CONTEXT,
    onContextChange: vi.fn(),
    outputSchemaText: "",
    onOutputSchemaTextChange: vi.fn(),
    upstreamInputs: UPSTREAM,
    tasks: [] as GraphWorkflowTaskDefinition[],
    workflowTaskIds: [],
    onTasksChange: vi.fn(),
    ...overrides,
  };
}

function renderBrief(overrides: Partial<ContextStructuralEditor> = {}) {
  const editor = editorFor(overrides);
  render(<BriefScreen editor={editor} onOpenSchema={vi.fn()} />);
  return editor;
}

describe("BriefScreen identity", () => {
  it("edits the title without disturbing the fields it does not author", () => {
    const onContextChange = vi.fn();
    renderBrief({ onContextChange });

    fireEvent.change(screen.getByLabelText("Context title"), {
      target: { value: "Implement checkout v2" },
    });

    expect(onContextChange).toHaveBeenCalledWith({
      ...CONTEXT,
      title: "Implement checkout v2",
    });
  });

  it("edits the description", () => {
    const onContextChange = vi.fn();
    renderBrief({ onContextChange });

    fireEvent.change(screen.getByLabelText("Context description"), {
      target: { value: "Now with risk rules." },
    });

    expect(onContextChange).toHaveBeenCalledWith({
      ...CONTEXT,
      description: "Now with risk rules.",
    });
  });
});

describe("BriefScreen acceptance criteria", () => {
  it("renders every criterion in order with its own statement editor", () => {
    renderBrief();

    expect(screen.getByLabelText("Statement for ac-1")).toHaveValue(
      "Every attempt writes exactly one audit row.",
    );
    expect(screen.getByLabelText("Statement for ac-2")).toHaveValue(
      "A declined card never reserves inventory.",
    );
  });

  it("edits one criterion's statement and leaves its siblings alone", () => {
    const onContextChange = vi.fn();
    renderBrief({ onContextChange });

    fireEvent.change(screen.getByLabelText("Statement for ac-2"), {
      target: { value: "A declined card releases the hold." },
    });

    expect(onContextChange).toHaveBeenCalledWith({
      ...CONTEXT,
      acceptanceCriteria: [
        {
          id: "ac-1",
          statement: "Every attempt writes exactly one audit row.",
        },
        { id: "ac-2", statement: "A declined card releases the hold." },
      ],
    });
  });

  it("reorders criteria without renaming the ids validators cite", () => {
    const onContextChange = vi.fn();
    renderBrief({ onContextChange });

    fireEvent.click(screen.getByRole("button", { name: "Move ac-2 up" }));

    expect(onContextChange).toHaveBeenCalledWith({
      ...CONTEXT,
      acceptanceCriteria: [
        { id: "ac-2", statement: "A declined card never reserves inventory." },
        {
          id: "ac-1",
          statement: "Every attempt writes exactly one audit row.",
        },
      ],
    });
  });

  it("adds a criterion with a fresh id", () => {
    const onContextChange = vi.fn();
    renderBrief({ onContextChange });

    fireEvent.click(screen.getByRole("button", { name: /add criterion/i }));

    expect(onContextChange).toHaveBeenCalledWith({
      ...CONTEXT,
      acceptanceCriteria: [
        ...CONTEXT.acceptanceCriteria,
        { id: "ac-3", statement: "" },
      ],
    });
  });

  it("removes a criterion", () => {
    const onContextChange = vi.fn();
    renderBrief({ onContextChange });

    fireEvent.click(screen.getByRole("button", { name: "Remove ac-1" }));

    expect(onContextChange).toHaveBeenCalledWith({
      ...CONTEXT,
      acceptanceCriteria: [
        { id: "ac-2", statement: "A declined card never reserves inventory." },
      ],
    });
  });

  it("refuses to remove the only criterion — a context must keep one", () => {
    renderBrief({
      context: {
        ...CONTEXT,
        acceptanceCriteria: [{ id: "ac-1", statement: "Only one." }],
      },
    });

    expect(screen.getByRole("button", { name: "Remove ac-1" })).toBeDisabled();
  });

  it("carries the design's ordering hint", () => {
    renderBrief();
    expect(
      screen.getByText(/Ordered\. Passed to the implementer and to every/i),
    ).toBeInTheDocument();
  });
});

describe("BriefScreen data contract", () => {
  it("opens the output schema screen from the drill row", () => {
    const onOpenSchema = vi.fn();
    render(<BriefScreen editor={editorFor()} onOpenSchema={onOpenSchema} />);

    fireEvent.click(screen.getByRole("button", { name: /output schema/i }));

    expect(onOpenSchema).toHaveBeenCalled();
  });

  it("derives the schema row's field and required counts from the text", () => {
    render(
      <BriefScreen
        editor={editorFor({
          outputSchemaText: JSON.stringify({
            type: "object",
            properties: { a: { type: "string" }, b: { type: "number" } },
            required: ["a"],
          }),
        })}
        onOpenSchema={vi.fn()}
      />,
    );

    const row = screen.getByRole("button", { name: /output schema/i });
    expect(row).toHaveTextContent("2");
    expect(row).toHaveTextContent("fields");
    expect(row).toHaveTextContent("1");
    expect(row).toHaveTextContent("required");
  });

  it("chips the schema row red when the text is not acceptable", () => {
    render(
      <BriefScreen
        editor={editorFor({ outputSchemaText: "{ not json" })}
        onOpenSchema={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /output schema/i }),
    ).toHaveTextContent("invalid JSON");
  });

  it("lists upstream inputs read-only, naming the source context and field", () => {
    renderBrief();

    const row = screen.getByTestId("config-item-ctx_plan");
    expect(within(row).getByText("Plan the migration")).toBeInTheDocument();
    expect(within(row).getByText("migrationPlan")).toBeInTheDocument();
    expect(within(row).queryByRole("textbox")).toBeNull();
    expect(within(row).queryByRole("button")).toBeNull();
  });
});

describe("BriefScreen danger zone", () => {
  it("deletes the context only after the confirm dialog is accepted", () => {
    const onDeleteContext = vi.fn();
    renderBrief({ onDeleteContext });

    fireEvent.click(screen.getByRole("button", { name: /delete context/i }));
    expect(onDeleteContext).not.toHaveBeenCalled();

    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^delete/i }));

    expect(onDeleteContext).toHaveBeenCalledTimes(1);
  });

  it("is absent on the execution host, which has no draft to delete from", () => {
    renderBrief({ host: "execution", onDeleteContext: undefined });

    expect(
      screen.queryByRole("button", { name: /delete context/i }),
    ).toBeNull();
  });
});

describe("BriefScreen when locked", () => {
  it("disables every editor and every ordering control", () => {
    renderBrief({ affordance: "frozen" });

    expect(screen.getByLabelText("Context title")).toBeDisabled();
    expect(screen.getByLabelText("Statement for ac-1")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move ac-2 up" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /add criterion/i })).toBeNull();
  });
});
