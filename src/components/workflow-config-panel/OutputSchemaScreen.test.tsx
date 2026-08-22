// @vitest-environment jsdom
/**
 * The Output schema screen: the text an author types, and what the engine makes
 * of it (Config Panel `schemaRows()`).
 *
 * The screen holds TEXT, never a parse. That is the point of the save-block
 * assertions below: a schema that parsed a keystroke ago must not be what a
 * save persists once the text has gone red.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GraphWorkflowExecutionContextDefinition } from "@/lib/workflow-graph/definition-schemas";
import { OutputSchemaScreen } from "./OutputSchemaScreen";
import type { ContextStructuralEditor } from "./structural-editor";
import type { ConfigAffordance } from "./types";

afterEach(cleanup);

const VALID = JSON.stringify(
  {
    type: "object",
    properties: { verdict: { type: "string" }, notes: { type: "string" } },
    required: ["verdict"],
  },
  null,
  2,
);

const UNSUPPORTED = JSON.stringify({
  type: "object",
  properties: { email: { type: "string", format: "email" } },
});

const CONTEXT: GraphWorkflowExecutionContextDefinition = {
  id: "ctx_checkout",
  title: "Implement checkout",
  acceptanceCriteria: [{ id: "ac-1", statement: "Audited." }],
  placement: { lane: "delivery", mode: "full" },
};

function editorFor(
  overrides: Partial<ContextStructuralEditor> = {},
): ContextStructuralEditor {
  return {
    host: "builder",
    affordance: "editable",
    context: CONTEXT,
    onContextChange: vi.fn(),
    outputSchemaText: VALID,
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
  render(<OutputSchemaScreen editor={editor} />);
  return editor;
}

describe("OutputSchemaScreen editing", () => {
  it("edits the raw text rather than a parsed schema", () => {
    const onOutputSchemaTextChange = vi.fn();
    renderScreen({ onOutputSchemaTextChange });

    fireEvent.change(screen.getByLabelText("Output schema JSON"), {
      target: { value: "{ half-typed" },
    });

    expect(onOutputSchemaTextChange).toHaveBeenCalledWith("{ half-typed");
  });

  it("shows the author their own text verbatim", () => {
    renderScreen();
    expect(screen.getByLabelText("Output schema JSON")).toHaveValue(VALID);
  });
});

describe("OutputSchemaScreen lint states", () => {
  it("reports an engine-acceptable schema with derived counts", () => {
    renderScreen();

    const card = screen.getByTestId("output-schema-lint");
    expect(card).toHaveAttribute("data-state", "valid");
    expect(card).toHaveTextContent("Accepted by the engine");
    expect(card).toHaveTextContent("2 fields");
    expect(card).toHaveTextContent("1 required");
  });

  it("recounts when the text changes", () => {
    const { rerender } = render(<OutputSchemaScreen editor={editorFor()} />);
    expect(screen.getByTestId("output-schema-lint")).toHaveTextContent(
      "2 fields",
    );

    rerender(
      <OutputSchemaScreen
        editor={editorFor({
          outputSchemaText: JSON.stringify({
            type: "object",
            properties: { verdict: { type: "string" } },
          }),
        })}
      />,
    );
    expect(screen.getByTestId("output-schema-lint")).toHaveTextContent(
      "1 field",
    );
  });

  it("reports invalid JSON with the parse position", () => {
    renderScreen({ outputSchemaText: '{\n "type": "object",\n oops\n}' });

    const card = screen.getByTestId("output-schema-lint");
    expect(card).toHaveAttribute("data-state", "invalid-json");
    expect(card).toHaveTextContent("Invalid JSON");
    expect(card).toHaveTextContent(/line \d+ · col \d+/);
    expect(card).toHaveTextContent(
      "Save is blocked while the text cannot be parsed.",
    );
  });

  it("names the unsupported keyword the engine refuses", () => {
    renderScreen({ outputSchemaText: UNSUPPORTED });

    const card = screen.getByTestId("output-schema-lint");
    expect(card).toHaveAttribute("data-state", "unsupported");
    expect(card).toHaveTextContent("Outside the supported subset");
    expect(card).toHaveTextContent("format");
    expect(card).toHaveTextContent("Save is blocked.");
  });

  it("states the empty contract's consequence without calling it an error", () => {
    renderScreen({ outputSchemaText: "" });

    const card = screen.getByTestId("output-schema-lint");
    expect(card).toHaveAttribute("data-state", "empty");
    expect(card).toHaveTextContent("No output contract");
    expect(card).toHaveTextContent("Read-only contexts require one.");
  });

  it("announces a refusal to assistive tech, and an acceptance quietly", () => {
    const { rerender } = render(
      <OutputSchemaScreen editor={editorFor({ outputSchemaText: "{ bad" })} />,
    );
    expect(screen.getByTestId("output-schema-lint")).toHaveAttribute(
      "role",
      "alert",
    );

    rerender(<OutputSchemaScreen editor={editorFor()} />);
    expect(screen.getByTestId("output-schema-lint")).not.toHaveAttribute(
      "role",
      "alert",
    );
  });
});

describe("OutputSchemaScreen when locked", () => {
  const HINTS: [Exclude<ConfigAffordance, "editable">, string][] = [
    [
      "frozen",
      "The output was already captured against this schema — editing it now would not re-validate anything.",
    ],
    [
      "pause-to-edit",
      "Pause the execution to change the contract before the next iteration runs.",
    ],
    [
      "read-only",
      "This execution is no longer running; its working definition is immutable.",
    ],
  ];

  it.each(HINTS)(
    "disables the editor and says why in %s",
    (affordance, hint) => {
      renderScreen({ host: "execution", affordance });

      expect(screen.getByLabelText("Output schema JSON")).toBeDisabled();
      expect(screen.getByText(hint)).toBeInTheDocument();
    },
  );

  it("shows no disabled hint while the editor is live", () => {
    renderScreen();
    expect(screen.queryByTestId("config-row-schema-locked")).toBeNull();
  });

  it("freezes the contract of an otherwise editable context once output was captured", () => {
    // AC schema-frozen: the capture, not the mode, is what settles the
    // contract — a paused execution is fully editable and its already-banked
    // context still must not have the declaration moved under it.
    renderScreen({
      host: "execution",
      affordance: "editable",
      schemaFrozen: true,
    });

    expect(screen.getByLabelText("Output schema JSON")).toBeDisabled();
    expect(
      screen.getByText(
        "The output was already captured against this schema — editing it now would not re-validate anything.",
      ),
    ).toBeInTheDocument();
  });

  it("leaves an editable context with nothing captured alone", () => {
    renderScreen({
      host: "execution",
      affordance: "editable",
      schemaFrozen: false,
    });

    expect(screen.getByLabelText("Output schema JSON")).toBeEnabled();
    expect(screen.queryByTestId("config-row-schema-locked")).toBeNull();
  });
});
