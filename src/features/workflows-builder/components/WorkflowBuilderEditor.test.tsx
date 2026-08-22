// @vitest-environment jsdom
import { useState } from "react";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ConfigScope } from "@/components/workflow-config-panel/types";
import { renderWithQuery } from "@/test/component-mocks";
import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
} from "@/lib/workflow-graph/test-fixtures";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";
import WorkflowBuilderEditor from "./WorkflowBuilderEditor";

const defaultHeaderProps = {
  workflowName: "Test Workflow",
  revision: 1 as number | null,
  onRename: vi.fn(),
  onDelete: vi.fn(),
};

/**
 * The scope is owned by the page, not by the editor, so a deep link that has to
 * switch tiers only works when something holds that state — the harness stands
 * in for `ConnectedWorkflowBuilderPage`, including its rule that selecting a
 * context switches the rail to Context scope.
 */
function ScopedEditor(
  props: Omit<
    React.ComponentProps<typeof WorkflowBuilderEditor>,
    "configScope" | "onConfigScopeChange"
  >,
): React.JSX.Element {
  const [scope, setScope] = useState<ConfigScope>("workflow");
  const selectedContextId = _useGraphWorkflowBuilderStore(
    (state) => state.selectedContextId,
  );
  const [previousContextId, setPreviousContextId] = useState(selectedContextId);
  if (selectedContextId !== previousContextId) {
    setPreviousContextId(selectedContextId);
    if (selectedContextId) setScope("context");
  }
  return (
    <WorkflowBuilderEditor
      {...props}
      configScope={scope}
      onConfigScopeChange={setScope}
    />
  );
}

function resetStore() {
  _useGraphWorkflowBuilderStore.setState({
    persistedDraft: null,
    draftDefinition: null,
    draftLayout: null,
    selectedContextId: null,
    selectedTaskId: null,
    dirty: false,
    refusedEdits: [],
    pendingOutputSchemaText: {},
    ephemeralLanes: [],
  });
}

describe("WorkflowBuilderEditor", () => {
  it("does not accept unused backend-default pass-through props", () => {
    expectTypeOf<
      React.ComponentProps<typeof WorkflowBuilderEditor>
    >().not.toHaveProperty("defaultImplementerConfig");
    expectTypeOf<
      React.ComponentProps<typeof WorkflowBuilderEditor>
    >().not.toHaveProperty("codexConfig");
  });

  it("adds an inherited context, marks the draft dirty, and resets it", () => {
    resetStore();
    renderWithQuery(
      <WorkflowBuilderEditor
        record={createWorkflowDefinitionRecord()}
        {...defaultHeaderProps}
      />,
    );

    expect(screen.getByText("All changes saved")).toBeInTheDocument();
    const initialContextCount =
      _useGraphWorkflowBuilderStore.getState().draftDefinition
        ?.executionContexts.length ?? 0;

    fireEvent.click(screen.getByRole("button", { name: /Add Context/i }));

    const state = _useGraphWorkflowBuilderStore.getState();
    const added = state.draftDefinition?.executionContexts.at(-1);
    expect(state.draftDefinition?.executionContexts).toHaveLength(
      initialContextCount + 1,
    );
    expect(state.selectedContextId).toBeTruthy();
    expect(added).toBeDefined();
    expect(added?.implementer).toBeUndefined();
    expect(added?.contextValidator).toBeUndefined();
    expect(added?.iterationPolicy).toBeUndefined();
    expect(added?.circuitBreaker).toBeUndefined();
    expect(added?.mutability).toBeUndefined();
    expect(added?.acceptanceCriteria).toBe("");
    expect(_useGraphWorkflowBuilderStore.getState().dirty).toBe(true);
    // A fresh context owes acceptance criteria before anything can accept it,
    // and the status reports that immediately rather than after a rejected
    // save attempt.
    expect(screen.getByText("Validation errors")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    expect(
      _useGraphWorkflowBuilderStore.getState().draftDefinition
        ?.executionContexts.length ?? 0,
    ).toBe(initialContextCount);
    expect(_useGraphWorkflowBuilderStore.getState().dirty).toBe(false);
  });

  // README §2.2: creating an empty lane is not an edit to the definition, so
  // the toolbar must keep saying so — this is the whole point of holding the
  // band outside the draft.
  it("draws an empty lane without leaving the draft dirty", () => {
    resetStore();
    renderWithQuery(
      <WorkflowBuilderEditor
        record={createWorkflowDefinitionRecord()}
        {...defaultHeaderProps}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /New Lane/i }));

    expect(
      _useGraphWorkflowBuilderStore.getState().ephemeralLanes,
    ).toHaveLength(1);
    expect(_useGraphWorkflowBuilderStore.getState().dirty).toBe(false);
    expect(screen.getByText("All changes saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
  });

  it("displays save error when provided", () => {
    resetStore();
    renderWithQuery(
      <WorkflowBuilderEditor
        record={createWorkflowDefinitionRecord()}
        {...defaultHeaderProps}
        saveError="Network error"
      />,
    );

    expect(screen.getByText("Network error")).toBeInTheDocument();
  });

  it("blocks save and lists every error when the definition has empty required fields", async () => {
    resetStore();
    const onSave = vi.fn();

    const invalidDefinition = createWorkflowDefinition({
      executionContexts: [
        {
          id: "ctx-1",
          title: "",
          acceptanceCriteria: "Some criteria",
          placement: { lane: "ctx-1", mode: "full" },
          implementer: {
            id: "implementer",
            profile: { tier: "builtin", id: "general-implementer" },
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
          },
          mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
          circuitBreaker: {},
          iterationPolicy: {
            maxIterations: 4,
            continuity: { enabled: true },
          },
        },
      ],
      tasks: [
        {
          id: "task-1",
          contextId: "ctx-1",
          order: 1,
          title: "A task",
          instructions: "",
          source: "user",
        },
      ],
      edges: [],
    });

    const record = createWorkflowDefinitionRecord({
      definition: invalidDefinition,
    });

    renderWithQuery(
      <WorkflowBuilderEditor
        record={record}
        {...defaultHeaderProps}
        onSave={onSave}
      />,
    );

    act(() => {
      _useGraphWorkflowBuilderStore.setState({ dirty: true });
    });

    const strip = await screen.findByRole(
      "list",
      { name: "Validation errors" },
      { timeout: 15000 },
    );
    // Each raised code names its own row; the message the validator wrote is
    // what the author reads.
    expect(strip).toHaveTextContent("empty-context-title");
    expect(strip).toHaveTextContent("empty-task-instructions");

    fireEvent.click(screen.getByRole("button", { name: /Save Draft/i }));
    expect(screen.getByRole("button", { name: /Save Draft/i })).toBeDisabled();
    await waitFor(() => expect(onSave).not.toHaveBeenCalled());
  }, 30000);

  it("blocks save and surfaces the accept-time parameter lint error when content references an undeclared parameter", async () => {
    resetStore();
    const onSave = vi.fn();

    // Structurally valid definition whose task instruction references an
    // undeclared parameter — only the accept-time lint (not the structural
    // validator) rejects it. This pins R8.3: the builder runs the FULL
    // accept-time validation, so the undeclared-reference error reaches the
    // author with its offending field rather than as a server refusal.
    const definitionWithUndeclaredRef = createWorkflowDefinition({
      parameters: [],
      tasks: [
        {
          id: "task-plan-1",
          contextId: "context-plan",
          order: 1,
          title: "Inspect code",
          instructions: "Implement {{inputs.feature}} carefully.",
          source: "user",
        },
        {
          id: "task-implement-1",
          contextId: "context-implement",
          order: 1,
          title: "Write code",
          instructions: "Implement the feature.",
          source: "user",
        },
        {
          id: "task-verify-1",
          contextId: "context-verify",
          order: 1,
          title: "Run checks",
          instructions: "Verify behavior.",
          source: "user",
        },
      ],
    });

    const record = createWorkflowDefinitionRecord({
      definition: definitionWithUndeclaredRef,
    });

    renderWithQuery(
      <WorkflowBuilderEditor
        record={record}
        {...defaultHeaderProps}
        onSave={onSave}
      />,
    );

    act(() => {
      _useGraphWorkflowBuilderStore.setState({ dirty: true });
    });

    // The strip is the builder's only validation surface, so the accept-time
    // lint has to reach it — a structural-only check never raises this.
    const strip = await screen.findByRole("list", {
      name: "Validation errors",
    });
    expect(
      within(strip).getByRole("button", {
        name: /workflow · instructions — .*feature/,
      }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Save Draft/i }));
    await waitFor(() => expect(onSave).not.toHaveBeenCalled());
  });

  it("saves the draft while preserving seeded context continuity", async () => {
    resetStore();
    const onSave = vi.fn();

    renderWithQuery(
      <WorkflowBuilderEditor
        record={createWorkflowDefinitionRecord()}
        {...defaultHeaderProps}
        onSave={onSave}
      />,
    );

    act(() => {
      _useGraphWorkflowBuilderStore.setState({ dirty: true });
    });

    fireEvent.click(screen.getByRole("button", { name: /Save Draft/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: expect.any(Object),
        layout: expect.any(Object),
      }),
    );

    const [payload] = onSave.mock.calls[0] as [
      {
        definition: {
          executionContexts: Array<{
            iterationPolicy?: { continuity?: Record<string, unknown> };
          }>;
        };
      },
    ];

    for (const ctx of payload.definition.executionContexts) {
      if (!ctx.iterationPolicy) continue;
      expect(ctx.iterationPolicy.continuity).toHaveProperty("enabled");
      expect(ctx.iterationPolicy.continuity).not.toHaveProperty(
        "contextSoftLimitTokens",
      );
      expect(ctx.iterationPolicy.continuity).not.toHaveProperty(
        "contextHardLimitTokens",
      );
    }
  });
});

// README §5: there is no separate Validate action — the toolbar's status IS the
// definition validation, and every row it lists has to reach the editor that
// can clear it.
describe("WorkflowBuilderEditor — validation strip", () => {
  /** A leaf context turned read-only without the output contract that demands. */
  function readOnlyLeafRecord() {
    const definition = createWorkflowDefinition();
    const contexts = definition.executionContexts;
    const leaf = contexts.at(-1);
    if (!leaf) throw new Error("fixture has no execution context");
    return {
      record: createWorkflowDefinitionRecord({
        definition: {
          ...definition,
          executionContexts: [
            ...contexts.slice(0, -1),
            {
              ...leaf,
              placement: {
                lane: leaf.placement.lane,
                mode: "readOnly" as const,
              },
            },
          ],
        },
      }),
      contextId: leaf.id,
    };
  }

  function saveDraft() {
    fireEvent.click(screen.getByRole("button", { name: /Save Draft/i }));
  }

  it("lists the raised errors and deep-links a context error to its screen", async () => {
    resetStore();
    const { record, contextId } = readOnlyLeafRecord();
    renderWithQuery(
      <ScopedEditor record={record} {...defaultHeaderProps} onSave={vi.fn()} />,
    );

    act(() => {
      _useGraphWorkflowBuilderStore.setState({ dirty: true });
    });
    saveDraft();

    const strip = await screen.findByRole("list", {
      name: "Validation errors",
    });
    const row = within(strip).getByRole("button", {
      name: new RegExp(`^${contextId} · outputSchema — `),
    });

    fireEvent.click(row);

    expect(_useGraphWorkflowBuilderStore.getState().selectedContextId).toBe(
      contextId,
    );
    expect(screen.getByRole("radio", { name: "Context" })).toBeChecked();
    expect(screen.getByTestId("config-screen-title")).toHaveTextContent(
      "Output schema",
    );
  });

  it("keeps Save refused while the errors stand", async () => {
    resetStore();
    const onSave = vi.fn();
    const { record } = readOnlyLeafRecord();
    renderWithQuery(
      <ScopedEditor record={record} {...defaultHeaderProps} onSave={onSave} />,
    );

    act(() => {
      _useGraphWorkflowBuilderStore.setState({ dirty: true });
    });
    saveDraft();

    await screen.findByRole("list", { name: "Validation errors" });
    expect(onSave).not.toHaveBeenCalled();
    const save = screen.getByRole("button", { name: /Save Draft/i });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute(
      "title",
      "Fix the validation errors before saving",
    );
  });

  // A refused canvas edit — a self-edge, a duplicate dependency, a cycle — was
  // never applied, so it is not a defect of the draft. It is reported apart
  // from the validator's own verdict, and a row that can be reached still is.
  it("lists an edit the canvas refused apart from the draft's own errors", async () => {
    resetStore();
    renderWithQuery(
      <ScopedEditor
        record={createWorkflowDefinitionRecord()}
        {...defaultHeaderProps}
        onSave={vi.fn()}
      />,
    );

    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        refusedEdits: [
          {
            code: "self-edge",
            message: "Execution contexts cannot depend on themselves",
            contextId: "context-plan",
          },
        ],
      });
    });

    const notice = await screen.findByRole("list", { name: "Refused edits" });
    expect(
      screen.queryByRole("list", { name: "Validation errors" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(notice).getByRole("button", {
        name: /^context-plan · self-edge — /,
      }),
    );
    expect(_useGraphWorkflowBuilderStore.getState().selectedContextId).toBe(
      "context-plan",
    );
  });

  // The draft the author has is valid and dirty; a gesture the canvas turned
  // away changed nothing about that, so refusing the save would strand them.
  it("keeps a valid draft savable after a refused edit", async () => {
    resetStore();
    const onSave = vi.fn();
    renderWithQuery(
      <ScopedEditor
        record={createWorkflowDefinitionRecord()}
        {...defaultHeaderProps}
        onSave={onSave}
      />,
    );

    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        dirty: true,
        refusedEdits: [
          {
            code: "duplicate-edge",
            message: "Dependency already exists",
            edgeId: "context-plan->context-implement",
          },
        ],
      });
    });

    await screen.findByRole("list", { name: "Refused edits" });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: /Save Draft/i });
    expect(save).not.toBeDisabled();

    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  // Nothing in the panel can fix a duplicate dependency, so the row states it
  // rather than offering a control that would open the panel at nothing.
  it("states a row with no destination instead of offering a dead control", async () => {
    resetStore();
    renderWithQuery(
      <ScopedEditor
        record={createWorkflowDefinitionRecord()}
        {...defaultHeaderProps}
        onSave={vi.fn()}
      />,
    );

    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        refusedEdits: [
          {
            code: "duplicate-edge",
            message: "Dependency already exists",
            edgeId: "context-plan->context-implement",
          },
        ],
      });
    });

    const notice = await screen.findByRole("list", { name: "Refused edits" });
    expect(notice).toHaveTextContent(
      "workflow · duplicate-edge — Dependency already exists",
    );
    expect(within(notice).queryByRole("button")).not.toBeInTheDocument();
  });

  // The refusal describes an attempt against the draft as it stood. Once the
  // draft moves, keeping it would report a rejection nobody just made.
  it("retires a refused edit once the draft changes", async () => {
    resetStore();
    renderWithQuery(
      <ScopedEditor
        record={createWorkflowDefinitionRecord()}
        {...defaultHeaderProps}
        onSave={vi.fn()}
      />,
    );

    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        refusedEdits: [
          {
            code: "duplicate-edge",
            message: "Dependency already exists",
            edgeId: "context-plan->context-implement",
          },
        ],
      });
    });
    await screen.findByRole("list", { name: "Refused edits" });

    fireEvent.click(screen.getByRole("button", { name: /Add Context/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("list", { name: "Refused edits" }),
      ).not.toBeInTheDocument(),
    );
  });

  // The schema text never reaches the store, so the structural validator can
  // never raise it — but it refuses the same save, so it belongs in the same
  // list rather than being visible only as a disabled button.
  it("lists unacceptable output-schema text as its own row", async () => {
    resetStore();
    const definition = createWorkflowDefinition();
    const first = definition.executionContexts[0];
    if (!first) throw new Error("fixture has no execution context");
    renderWithQuery(
      <ScopedEditor
        record={createWorkflowDefinitionRecord({ definition })}
        {...defaultHeaderProps}
        onSave={vi.fn()}
      />,
    );

    act(() => {
      _useGraphWorkflowBuilderStore.setState({ selectedContextId: first.id });
    });
    fireEvent.click(screen.getByRole("button", { name: "Brief" }));
    fireEvent.click(screen.getByRole("button", { name: /Output schema/ }));
    fireEvent.change(screen.getByLabelText("Output schema JSON"), {
      target: { value: '{ "type": ' },
    });

    const strip = await screen.findByRole("list", {
      name: "Validation errors",
    });
    const row = within(strip).getByRole("button", {
      name: new RegExp(`^${first.id} · outputSchema — `),
    });

    fireEvent.click(row);
    expect(screen.getByTestId("config-screen-title")).toHaveTextContent(
      "Output schema",
    );
    // Following the row has to land on the value that RAISED it. Reseeding the
    // editor from the last valid stored schema would hand the author a fixed
    // field and re-enable a save that persists the wrong document.
    expect(screen.getByLabelText("Output schema JSON")).toHaveValue(
      '{ "type": ',
    );
  });

  // B3: the toolbar status IS the validation surface, so text that puts a row
  // in the red strip cannot be reported as ordinary unsaved work.
  it("reports unacceptable schema text as a validation error, not as amber", async () => {
    resetStore();
    const definition = createWorkflowDefinition();
    const first = definition.executionContexts[0];
    if (!first) throw new Error("fixture has no execution context");
    renderWithQuery(
      <ScopedEditor
        record={createWorkflowDefinitionRecord({ definition })}
        {...defaultHeaderProps}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByText("All changes saved")).toBeInTheDocument();

    act(() => {
      _useGraphWorkflowBuilderStore.setState({ selectedContextId: first.id });
    });
    fireEvent.click(screen.getByRole("button", { name: "Brief" }));
    fireEvent.click(screen.getByRole("button", { name: /Output schema/ }));
    fireEvent.change(screen.getByLabelText("Output schema JSON"), {
      target: { value: '{ "type": ' },
    });

    await screen.findByRole("list", { name: "Validation errors" });
    expect(screen.getByText("Validation errors")).toBeInTheDocument();
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });

  // The whole point of the deep link: land on the field, fix it, save. A
  // verdict frozen at the last save attempt would leave Save refused forever.
  it("clears the row and re-enables Save once the deep-linked field is fixed", async () => {
    resetStore();
    const onSave = vi.fn();
    const { record, contextId } = readOnlyLeafRecord();
    renderWithQuery(
      <ScopedEditor record={record} {...defaultHeaderProps} onSave={onSave} />,
    );

    act(() => {
      _useGraphWorkflowBuilderStore.setState({ dirty: true });
    });
    const strip = await screen.findByRole("list", {
      name: "Validation errors",
    });
    fireEvent.click(
      within(strip).getByRole("button", {
        name: new RegExp(`^${contextId} · outputSchema — `),
      }),
    );

    fireEvent.change(screen.getByLabelText("Output schema JSON"), {
      target: {
        value: JSON.stringify(
          { type: "object", properties: { ok: { type: "boolean" } } },
          null,
          2,
        ),
      },
    });

    await waitFor(() =>
      expect(
        screen.queryByRole("list", { name: "Validation errors" }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Save Draft/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  it("shows no strip while the draft validates", () => {
    resetStore();
    renderWithQuery(
      <ScopedEditor
        record={createWorkflowDefinitionRecord()}
        {...defaultHeaderProps}
        onSave={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("list", { name: "Validation errors" }),
    ).not.toBeInTheDocument();
  });
});

describe("WorkflowBuilderEditor — right rail", () => {
  it("mounts the config panel on Workflow scope while nothing is selected", () => {
    resetStore();
    renderWithQuery(
      <WorkflowBuilderEditor
        record={createWorkflowDefinitionRecord()}
        {...defaultHeaderProps}
      />,
    );

    const rail = screen.getByRole("complementary", { name: "Configuration" });
    expect(rail).toHaveClass("w-[420px]");
    expect(screen.getByRole("radio", { name: "Workflow" })).toBeInTheDocument();
    // Workflow scope's own cards, not a context's.
    expect(screen.getByRole("button", { name: "Charter" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Placement" }),
    ).not.toBeInTheDocument();
  });

  it("shows the selected context's cards on Context scope and returns to Workflow when deselected", () => {
    resetStore();
    const record = createWorkflowDefinitionRecord();
    const contextId = record.definition.executionContexts[0]?.id ?? "";
    renderWithQuery(
      <WorkflowBuilderEditor
        record={record}
        {...defaultHeaderProps}
        configScope="context"
      />,
    );

    act(() => {
      _useGraphWorkflowBuilderStore.setState({ selectedContextId: contextId });
    });
    expect(
      screen.getByRole("button", { name: "Placement" }),
    ).toBeInTheDocument();

    // Both scope tabs stay navigable while a context is selected (README §5).
    expect(screen.getByRole("radio", { name: "Workflow" })).toBeEnabled();

    act(() => {
      _useGraphWorkflowBuilderStore.setState({ selectedContextId: null });
    });
    expect(screen.getByRole("button", { name: "Charter" })).toBeInTheDocument();
  });

  it("collapses and restores the rail", () => {
    resetStore();
    renderWithQuery(
      <WorkflowBuilderEditor
        record={createWorkflowDefinitionRecord()}
        {...defaultHeaderProps}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse configuration panel" }),
    );
    const rail = screen.getByRole("complementary", { name: "Configuration" });
    expect(rail).toHaveClass("w-[48px]");
    expect(
      screen.queryByRole("button", { name: "Charter" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand configuration panel" }),
    );
    expect(screen.getByRole("button", { name: "Charter" })).toBeInTheDocument();
  });

  // README §5: launching a template belongs to the session/template flow.
  // `Launch parameters` is the workflow's parameter card, not an action.
  it("exposes no Launch action", () => {
    resetStore();
    renderWithQuery(
      <WorkflowBuilderEditor
        record={createWorkflowDefinitionRecord()}
        {...defaultHeaderProps}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /^launch( workflow)?$/i }),
    ).not.toBeInTheDocument();
  });
});

// R7.4's save gate belongs to the SAVE OWNER, not to the screen holding the
// text: invalid schema text never reaches the store, so a gate that lived only
// in the config panel would leave the toolbar free to persist the LAST VALID
// schema while the author is still looking at red text, and report the draft as
// saved.
describe("WorkflowBuilderEditor — output schema save gate", () => {
  const VALID_SCHEMA = { type: "object", properties: {} };

  function recordWithSchema() {
    const definition = createWorkflowDefinition();
    const [first, ...rest] = definition.executionContexts;
    if (!first) throw new Error("fixture has no execution context");
    return {
      record: createWorkflowDefinitionRecord({
        definition: {
          ...definition,
          executionContexts: [
            { ...first, outputSchema: VALID_SCHEMA },
            ...rest,
          ],
        },
      }),
      contextId: first.id,
    };
  }

  function schemaTextarea(): HTMLTextAreaElement {
    const element = screen.getByLabelText("Output schema JSON");
    if (!(element instanceof HTMLTextAreaElement)) {
      throw new Error("The output schema editor is not a textarea");
    }
    return element;
  }

  /**
   * The schema editor is a screen the reader drills to: Context scope → Brief →
   * Output schema. Walking that path is the point — it proves the rail switches
   * scope on selection and that the panel's push navigation reaches the editor.
   */
  function renderWithSelectedContext(onSave: ReturnType<typeof vi.fn>) {
    resetStore();
    const { record, contextId } = recordWithSchema();
    const view = renderWithQuery(
      <WorkflowBuilderEditor
        record={record}
        {...defaultHeaderProps}
        onSave={onSave}
        configScope="context"
      />,
    );
    act(() => {
      _useGraphWorkflowBuilderStore.setState({ selectedContextId: contextId });
    });
    fireEvent.click(screen.getByRole("button", { name: "Brief" }));
    fireEvent.click(screen.getByRole("button", { name: /Output schema/ }));
    return { ...view, contextId };
  }

  it("blocks the save while the schema text is invalid", async () => {
    const onSave = vi.fn();
    renderWithSelectedContext(onSave);

    fireEvent.change(schemaTextarea(), { target: { value: '{ "type": ' } });

    const toolbarSave = screen.getByRole("button", { name: /Save Draft/i });
    expect(toolbarSave).toBeDisabled();
    fireEvent.click(toolbarSave);

    await waitFor(() => expect(onSave).not.toHaveBeenCalled());
  });

  it("reports uncommittable schema text as work the draft cannot absorb", () => {
    renderWithSelectedContext(vi.fn());

    expect(screen.getByText("All changes saved")).toBeInTheDocument();

    // An invalid-only edit leaves the STORE clean — the status must not claim
    // the draft is saved while the editor holds text nothing has persisted.
    fireEvent.change(schemaTextarea(), { target: { value: "{{{" } });

    expect(screen.getByText("Validation errors")).toBeInTheDocument();
    expect(screen.queryByText("All changes saved")).not.toBeInTheDocument();
  });

  it("re-enables the save once the text is valid again and persists it", async () => {
    const onSave = vi.fn();
    renderWithSelectedContext(onSave);

    fireEvent.change(schemaTextarea(), { target: { value: "{{{" } });
    expect(screen.getByRole("button", { name: /Save Draft/i })).toBeDisabled();

    const repaired = {
      type: "object",
      properties: { ok: { type: "boolean" } },
    };
    fireEvent.change(schemaTextarea(), {
      target: { value: JSON.stringify(repaired, null, 2) },
    });

    const toolbarSave = screen.getByRole("button", { name: /Save Draft/i });
    expect(toolbarSave).not.toBeDisabled();
    fireEvent.click(toolbarSave);

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    // The persisted schema is the repaired one — never the stale last-valid.
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: expect.objectContaining({
          executionContexts: expect.arrayContaining([
            expect.objectContaining({ outputSchema: repaired }),
          ]),
        }),
      }),
    );
  });

  // Navigating away is not a fix. If deselecting released the gate, the very
  // next Save would persist the last valid schema while the author's own text
  // is still owed — a silent discard of the edit they were making.
  it("keeps the save refused when the selection leaves the context holding invalid text", async () => {
    const onSave = vi.fn();
    const { contextId } = renderWithSelectedContext(onSave);

    fireEvent.change(schemaTextarea(), { target: { value: "{{{" } });
    expect(screen.getByRole("button", { name: /Save Draft/i })).toBeDisabled();

    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        selectedContextId: null,
        dirty: true,
      });
    });

    const save = screen.getByRole("button", { name: /Save Draft/i });
    expect(save).toBeDisabled();
    // And the row keeps naming the context that owes the fix.
    const strip = await screen.findByRole("list", {
      name: "Validation errors",
    });
    expect(strip).toHaveTextContent(`${contextId} · outputSchema`);
  });

  // Following the row is the remedy the strip promises: it selects the context
  // again and re-opens the editor still holding the text that raised it.
  it("returns to the pending text through its validation row", async () => {
    renderWithSelectedContext(vi.fn());

    fireEvent.change(schemaTextarea(), { target: { value: "{{{" } });
    act(() => {
      _useGraphWorkflowBuilderStore.setState({ selectedContextId: null });
    });

    const strip = await screen.findByRole("list", {
      name: "Validation errors",
    });
    fireEvent.click(within(strip).getByRole("button"));

    expect(screen.getByTestId("config-screen-title")).toHaveTextContent(
      "Output schema",
    );
    expect(schemaTextarea()).toHaveValue("{{{");
  });

  // Two refusals are two debts. A strip that named only the first would leave
  // the author repairing it, finding the save still refused, and no row saying
  // which other context is owed.
  it("lists a row for every context holding invalid text", async () => {
    resetStore();
    const { record, contextId } = recordWithSchema();
    const second = record.definition.executionContexts[1];
    if (!second) throw new Error("fixture needs a second execution context");
    renderWithQuery(
      <WorkflowBuilderEditor
        record={record}
        {...defaultHeaderProps}
        onSave={vi.fn()}
        configScope="context"
      />,
    );

    for (const id of [contextId, second.id]) {
      act(() => {
        _useGraphWorkflowBuilderStore.setState({ selectedContextId: id });
      });
      // Switching context may leave the rail on the screen it was already
      // showing, so only walk the path when the editor is not on screen.
      if (screen.queryByLabelText("Output schema JSON") === null) {
        fireEvent.click(screen.getByRole("button", { name: "Brief" }));
        fireEvent.click(screen.getByRole("button", { name: /Output schema/ }));
      }
      fireEvent.change(schemaTextarea(), { target: { value: "{{{" } });
    }

    const strip = await screen.findByRole("list", {
      name: "Validation errors",
    });
    const rows = within(strip).getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining(`${contextId} · outputSchema`),
      expect.stringContaining(`${second.id} · outputSchema`),
    ]);
  });

  // Collapsing the rail hides the editor; it does not abandon the edit.
  it("keeps pending text across a rail collapse", () => {
    renderWithSelectedContext(vi.fn());

    fireEvent.change(schemaTextarea(), { target: { value: "{{{" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse configuration panel" }),
    );
    expect(screen.getByRole("button", { name: /Save Draft/i })).toBeDisabled();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand configuration panel" }),
    );
    expect(screen.getByRole("button", { name: /Save Draft/i })).toBeDisabled();
  });
});
