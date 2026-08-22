// @vitest-environment jsdom
/**
 * The Launch parameters screen (workflow scope): the typed inputs a definition
 * collects at launch (Config Panel `paramsRows()`).
 *
 * The types offered are the ones `parameterDeclarationSchema` actually
 * declares — string, text, enum. The prototype's `number`/`boolean` are design
 * mock values the engine has no variant for, and offering them would be new
 * authoring for a field that is not authorable today (README §14).
 */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  parameterDeclarationSchema,
  type ParameterDeclaration,
} from "@/lib/workflow-graph/definition-schemas";
import { ParametersScreen } from "./ParametersScreen";
import type { WorkflowStructuralEditor } from "./structural-editor";

afterEach(cleanup);

const PARAMETERS: ParameterDeclaration[] = [
  {
    type: "string",
    name: "target_branch",
    label: "Target branch",
    required: true,
    default: "main",
  },
  {
    type: "enum",
    name: "rollout",
    label: "Rollout mode",
    required: false,
    options: ["canary", "full"],
    default: "canary",
  },
];

function editorFor(
  overrides: Partial<WorkflowStructuralEditor> = {},
): WorkflowStructuralEditor {
  return {
    affordance: "editable",
    charter: {
      mission: "Ship it.",
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
    parameters: PARAMETERS,
    onParametersChange: vi.fn(),
    contexts: [{ id: "ctx_checkout", title: "Implement checkout" }],
    ...overrides,
  };
}

function renderScreen(overrides: Partial<WorkflowStructuralEditor> = {}) {
  const editor = editorFor(overrides);
  render(<ParametersScreen editor={editor} />);
  return editor;
}

function firstCall(mock: ReturnType<typeof vi.fn>): ParameterDeclaration[] {
  return mock.mock.calls[0]?.[0];
}

/**
 * The screen wired to a host that actually holds the draft, so an edit comes
 * back as props the way it will in the builder. Character-by-character typing
 * is only meaningful against this: with a bare spy the props never change and
 * a controlled field's value can never be wrong.
 */
function StatefulScreen({
  onChange,
  initial = PARAMETERS,
}: {
  onChange: (next: ParameterDeclaration[]) => void;
  initial?: ParameterDeclaration[];
}): React.JSX.Element {
  const [parameters, setParameters] = useState<ParameterDeclaration[]>(
    () => initial,
  );
  return (
    <ParametersScreen
      editor={editorFor({
        parameters,
        onParametersChange: (next) => {
          setParameters(next);
          onChange(next);
        },
      })}
    />
  );
}

describe("ParametersScreen listing", () => {
  it("cards each declared parameter by name with its type and required chips", () => {
    renderScreen();

    // Scoped to the card's HEADER row: the same words appear again below it as
    // `<option>` text and as the inline field labels. Cards are identified by
    // POSITION, not by name — the name is an editable field.
    const header = (position: number): HTMLElement => {
      const card = screen.getByTestId(`config-item-parameter-${position}`);
      const row = card.firstElementChild;
      if (!(row instanceof HTMLElement)) throw new Error("no header row");
      return row;
    };

    const branch = header(0);
    expect(within(branch).getByText("target_branch")).toBeInTheDocument();
    expect(within(branch).getByText("string")).toBeInTheDocument();
    expect(within(branch).getByText("required")).toBeInTheDocument();

    const rollout = header(1);
    expect(within(rollout).getByText("enum")).toBeInTheDocument();
    expect(within(rollout).queryByText("required")).toBeNull();
  });

  it("says so when a workflow declares none", () => {
    renderScreen({ parameters: [] });
    expect(
      screen.getByText(/no launch parameters declared/i),
    ).toBeInTheDocument();
  });
});

describe("ParametersScreen card identity", () => {
  it("lets a name be typed one character at a time without losing focus", async () => {
    // A card keyed by its own editable name changes key on the first keystroke,
    // which remounts the card and drops focus — so every following character
    // lands nowhere and the name cannot be typed at all.
    const user = userEvent.setup();
    render(<StatefulScreen onChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Name of target_branch"), "_v2");

    const renamed = screen.getByLabelText("Name of target_branch_v2");
    expect(renamed).toHaveValue("target_branch_v2");
    expect(renamed).toHaveFocus();
  });

  it("does not strand a half-typed options draft on the card a removal shifts up", async () => {
    // Cards are keyed by position, so removing one hands its mounted state to
    // the declaration that shifts into that slot. A draft left over from the
    // removed parameter must not be shown as the survivor's options.
    const enums: ParameterDeclaration[] = [
      { type: "enum", name: "first", label: "", required: false, options: [] },
      {
        type: "enum",
        name: "second",
        label: "",
        required: false,
        options: ["kept"],
      },
    ];
    const user = userEvent.setup();
    render(<StatefulScreen initial={enums} onChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Enum options of first"), "draft");
    await user.click(screen.getByRole("button", { name: "Remove first" }));

    // `second` now occupies slot 0, where `first` was being edited.
    expect(screen.getByLabelText("Enum options of second")).toHaveValue("kept");
  });

  it("gives two unnamed parameters distinct cards", () => {
    // Freshly added declarations are both nameless, so a name-keyed list would
    // hand them the same React key.
    renderScreen({
      parameters: [
        { type: "string", name: "", label: "", required: false },
        { type: "string", name: "", label: "", required: false },
      ],
    });

    expect(screen.getByTestId("config-item-parameter-0")).toBeInTheDocument();
    expect(screen.getByTestId("config-item-parameter-1")).toBeInTheDocument();
  });
});

describe("ParametersScreen inline fields", () => {
  it("edits the name", () => {
    const onParametersChange = vi.fn();
    renderScreen({ onParametersChange });

    fireEvent.change(screen.getByLabelText("Name of target_branch"), {
      target: { value: "release_branch" },
    });

    expect(firstCall(onParametersChange)[0]).toEqual({
      ...PARAMETERS[0],
      name: "release_branch",
    });
  });

  it("edits the label", () => {
    const onParametersChange = vi.fn();
    renderScreen({ onParametersChange });

    fireEvent.change(screen.getByLabelText("Label of target_branch"), {
      target: { value: "Release branch" },
    });

    expect(firstCall(onParametersChange)[0]).toMatchObject({
      label: "Release branch",
    });
  });

  it("edits the default", () => {
    const onParametersChange = vi.fn();
    renderScreen({ onParametersChange });

    fireEvent.change(screen.getByLabelText("Default of target_branch"), {
      target: { value: "trunk" },
    });

    expect(firstCall(onParametersChange)[0]).toMatchObject({
      default: "trunk",
    });
  });

  it("toggles required", () => {
    const onParametersChange = vi.fn();
    renderScreen({ onParametersChange });

    fireEvent.click(screen.getByRole("switch", { name: "rollout required" }));

    expect(firstCall(onParametersChange)[1]).toMatchObject({ required: true });
  });

  it("offers only the types the engine declares", () => {
    renderScreen();

    const select = screen.getByLabelText("Type of target_branch");
    expect(
      [...within(select).getAllByRole("option")].map(
        (option) => (option as HTMLOptionElement).value,
      ),
    ).toEqual(["string", "text", "enum"]);
  });

  it("changing the type keeps the common fields and settles the variant", () => {
    const onParametersChange = vi.fn();
    renderScreen({ onParametersChange });

    fireEvent.change(screen.getByLabelText("Type of target_branch"), {
      target: { value: "enum" },
    });

    const next = firstCall(onParametersChange)[0];
    expect(next).toMatchObject({
      type: "enum",
      name: "target_branch",
      label: "Target branch",
      required: true,
      options: [],
    });
    expect(parameterDeclarationSchema.safeParse(next).success).toBe(true);
  });
});

describe("ParametersScreen enum options", () => {
  it("edits enum options as a comma-separated list", () => {
    const onParametersChange = vi.fn();
    renderScreen({ onParametersChange });

    fireEvent.change(screen.getByLabelText("Enum options of rollout"), {
      target: { value: "canary, full, halted" },
    });

    expect(firstCall(onParametersChange)[1]).toMatchObject({
      options: ["canary", "full", "halted"],
    });
  });

  it("shows the current options joined", () => {
    renderScreen();
    expect(screen.getByLabelText("Enum options of rollout")).toHaveValue(
      "canary, full",
    );
  });

  it("lets an option be typed in one character at a time", async () => {
    // The host owns the draft, so the screen only ever sees the array it just
    // emitted come back as props. Deriving the input's value from that array
    // strips the separator the moment it is typed, which makes every keystroke
    // after the comma land in the previous option instead of a new one.
    const user = userEvent.setup();
    const seen: ParameterDeclaration[][] = [];
    render(<StatefulScreen onChange={(next) => seen.push(next)} />);

    const input = screen.getByLabelText("Enum options of rollout");
    await user.type(input, ", halted");

    expect(input).toHaveValue("canary, full, halted");
    // Whole-object equality, not a subset: the declaration's `default` is a
    // field this control does not author and has to survive the edit verbatim.
    expect(seen.at(-1)?.[1]).toEqual({
      ...PARAMETERS[1],
      options: ["canary", "full", "halted"],
    });
  });

  it("keeps the separator visible while the next option is still empty", async () => {
    const user = userEvent.setup();
    render(<StatefulScreen onChange={vi.fn()} />);

    const input = screen.getByLabelText("Enum options of rollout");
    await user.type(input, ",");

    expect(input).toHaveValue("canary, full,");
  });

  it("settles back to the canonical joined list once editing ends", async () => {
    const user = userEvent.setup();
    render(<StatefulScreen onChange={vi.fn()} />);

    const input = screen.getByLabelText("Enum options of rollout");
    await user.type(input, ",  ");
    await user.tab();

    expect(input).toHaveValue("canary, full");
  });

  it("placeholders the options field enum-only on a non-enum parameter", () => {
    renderScreen();
    expect(
      screen.getByLabelText("Enum options of target_branch"),
    ).toHaveAttribute("placeholder", "enum only");
  });
});

describe("ParametersScreen add and remove", () => {
  it("adds a declaration the schema accepts once named", () => {
    const onParametersChange = vi.fn();
    renderScreen({ onParametersChange });

    fireEvent.click(screen.getByRole("button", { name: /add parameter/i }));

    const next = firstCall(onParametersChange);
    expect(next).toHaveLength(3);
    expect(next[2]).toMatchObject({ type: "string", required: false });
  });

  it("removes a declaration", () => {
    const onParametersChange = vi.fn();
    renderScreen({ onParametersChange });

    fireEvent.click(
      screen.getByRole("button", { name: "Remove target_branch" }),
    );

    expect(firstCall(onParametersChange)).toEqual([PARAMETERS[1]]);
  });
});

describe("ParametersScreen when locked", () => {
  it("disables every field and offers no Add", () => {
    renderScreen({ affordance: "frozen" });

    expect(screen.getByLabelText("Name of target_branch")).toBeDisabled();
    expect(screen.getByLabelText("Type of target_branch")).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: "rollout required" }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: /add parameter/i })).toBeNull();
  });
});
