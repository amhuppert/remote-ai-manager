// @vitest-environment jsdom
/**
 * Execution policy and plan repair (Config Panel `policyRows()`,
 * `planRepairRows()`).
 *
 * The assertion this screen exists to carry is the round-trip one:
 * `mutability.allowAgentContextAdd` has no editor here, and an edit to the
 * sibling this surface DOES author must carry it through verbatim. Everything
 * else on the screen is block-granular, so each write replaces its whole policy.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { PLAN_REPAIR_DEFAULT_AGENT } from "@/lib/workflow-graph/config-schemas";
import type {
  GraphWorkflowExecutionContextDefinition,
  WorkflowConfigOverride,
} from "@/lib/workflow-graph/definition-schemas";
import { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";
import type { ConfigCascadeEditor } from "./cascade-editor";
import { createConfigCascade, type ConfigEditIntent } from "./config-cascade";
import { ExecutionPolicyScreen, PlanRepairScreen } from "./PolicyScreens";
import type { ConfigScope } from "./types";

afterEach(cleanup);

function context(
  overrides: Partial<GraphWorkflowExecutionContextDefinition> = {},
): GraphWorkflowExecutionContextDefinition {
  return {
    id: "ctx_checkout",
    title: "Implement checkout",
    acceptanceCriteria: [
      { id: "ac-1", statement: "Every attempt writes exactly one audit row." },
    ],
    placement: { lane: "delivery", mode: "full" },
    ...overrides,
  };
}

function editorFor({
  scope = "context",
  contextOverrides = {},
  workflowConfig = {},
  ...rest
}: {
  scope?: ConfigScope;
  contextOverrides?: Partial<GraphWorkflowExecutionContextDefinition>;
  workflowConfig?: WorkflowConfigOverride;
} & Partial<ConfigCascadeEditor> = {}): {
  editor: ConfigCascadeEditor;
  onEdit: ReturnType<typeof vi.fn<(intent: ConfigEditIntent) => void>>;
} {
  const onEdit = vi.fn<(intent: ConfigEditIntent) => void>();
  return {
    onEdit,
    editor: {
      host: "builder",
      affordance: "editable",
      cascade: createConfigCascade({
        scope,
        globalDefaults: SEEDED_WORKFLOW_DEFAULTS,
        workflowConfig,
        context: context(contextOverrides),
      }),
      onEdit,
      validationCommands: [],
      libraryProjectName: "checkout",
      ...rest,
    },
  };
}

function renderScreen(ui: React.ReactElement) {
  return renderWithQuery(ui, createTestQueryClient());
}

function setIntents(
  onEdit: ReturnType<typeof vi.fn<(intent: ConfigEditIntent) => void>>,
) {
  return onEdit.mock.calls
    .map(([intent]) => intent)
    .filter((intent) => intent.kind === "set-path");
}

describe("Execution policy screen", () => {
  it("renders iteration, failure handling and mutability", () => {
    const { editor } = editorFor();
    renderScreen(<ExecutionPolicyScreen editor={editor} onOpen={vi.fn()} />);

    for (const rowId of [
      "policy-max-iterations",
      "policy-continuity",
      "policy-context-limit",
      "policy-failure-threshold",
      "planrepair",
      "mutability-task-add",
    ]) {
      expect(screen.getByTestId(`config-row-${rowId}`)).toBeInTheDocument();
    }
    expect(
      screen.getByTestId("config-row-policy-context-limit").textContent,
    ).toContain("Leave empty for auto.");
    expect(
      screen.getByTestId("config-row-policy-failure-threshold").textContent,
    ).toContain("Consecutive failures before the context is halted.");
  });

  it("promotes the whole iteration policy when one of its fields moves", () => {
    const { editor, onEdit } = editorFor();
    renderScreen(<ExecutionPolicyScreen editor={editor} onOpen={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Max iterations"), {
      target: { value: "8" },
    });

    expect(setIntents(onEdit)[0]).toEqual({
      kind: "set-path",
      tier: "context",
      path: "iterationPolicy",
      value: {
        maxIterations: 8,
        continuity: SEEDED_WORKFLOW_DEFAULTS.iterationPolicy.continuity,
      },
      granularity: "block",
    });
  });

  it("opens the plan repair screen from its drill row", () => {
    const onOpen = vi.fn();
    const { editor } = editorFor();
    renderScreen(<ExecutionPolicyScreen editor={editor} onOpen={onOpen} />);

    fireEvent.click(
      within(screen.getByTestId("config-row-planrepair")).getByRole("button"),
    );

    expect(onOpen).toHaveBeenCalledWith("planrepair");
  });
});

describe("Preserved mutability field", () => {
  it("shows allowAgentContextAdd as a value with no editor", () => {
    const { editor } = editorFor({
      contextOverrides: {
        mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: true },
      },
    });
    renderScreen(<ExecutionPolicyScreen editor={editor} onOpen={vi.fn()} />);

    const row = screen.getByTestId("config-row-mutability-context-add");
    expect(row.textContent).toContain("allowAgentContextAdd");
    expect(row.textContent).toContain("true");
    expect(row.textContent).toContain("preserved");
    expect(row.textContent).toContain("round-tripped unchanged");
    expect(within(row).queryByRole("switch")).toBeNull();
    expect(within(row).queryByRole("checkbox")).toBeNull();
    expect(within(row).queryByRole("textbox")).toBeNull();
  });

  it("carries allowAgentContextAdd through an edit to its sibling", () => {
    const { editor, onEdit } = editorFor({
      contextOverrides: {
        mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: true },
      },
    });
    renderScreen(<ExecutionPolicyScreen editor={editor} onOpen={vi.fn()} />);

    fireEvent.click(
      within(screen.getByTestId("config-row-mutability-task-add")).getByRole(
        "switch",
      ),
    );

    expect(setIntents(onEdit)[0]?.value).toEqual({
      allowAgentTaskAdd: true,
      allowAgentContextAdd: true,
    });
  });
});

describe("Plan repair screen", () => {
  it("names the default repair agent from the shipped policy while custom is off", () => {
    const { editor } = editorFor();
    renderScreen(<PlanRepairScreen editor={editor} />);

    const row = screen.getByTestId("config-row-planrepair-custom-agent");
    expect(row.textContent).toContain("Off — uses the default repair agent");
    // The default is the canonical PLAN_REPAIR_DEFAULT_AGENT, named by the
    // catalog's long label rather than its short selector id.
    expect(row.textContent).toContain("Opus 5");
    expect(row.textContent).toContain(
      `effort=${PLAN_REPAIR_DEFAULT_AGENT.modelSelection.parameters.effort}`,
    );
    expect(
      screen.queryByTestId("config-row-planrepair-agent-model-selection"),
    ).toBeNull();
  });

  it("seeds a custom agent from that same default and shows its runtime", () => {
    const { editor, onEdit } = editorFor();
    renderScreen(<PlanRepairScreen editor={editor} />);

    fireEvent.click(
      within(
        screen.getByTestId("config-row-planrepair-custom-agent"),
      ).getByRole("switch"),
    );

    expect(setIntents(onEdit)[0]).toMatchObject({
      path: "planRepair",
      granularity: "block",
      value: {
        enabled: SEEDED_WORKFLOW_DEFAULTS.planRepair.enabled,
        maxAttemptsPerContext:
          SEEDED_WORKFLOW_DEFAULTS.planRepair.maxAttemptsPerContext,
        agent: PLAN_REPAIR_DEFAULT_AGENT,
      },
    });
  });

  it("drops the agent key rather than storing an empty runtime", () => {
    const { editor, onEdit } = editorFor({
      contextOverrides: {
        planRepair: {
          enabled: true,
          maxAttemptsPerContext: 2,
          agent: PLAN_REPAIR_DEFAULT_AGENT,
        },
      },
    });
    renderScreen(<PlanRepairScreen editor={editor} />);

    expect(
      screen.getByTestId("config-row-planrepair-agent-model-selection"),
    ).toBeInTheDocument();

    fireEvent.click(
      within(
        screen.getByTestId("config-row-planrepair-custom-agent"),
      ).getByRole("switch"),
    );

    expect(setIntents(onEdit)[0]?.value).not.toHaveProperty("agent");
  });

  it("edits max attempts without disturbing the rest of the policy", () => {
    const { editor, onEdit } = editorFor();
    renderScreen(<PlanRepairScreen editor={editor} />);

    fireEvent.change(screen.getByLabelText("Max attempts"), {
      target: { value: "5" },
    });

    expect(setIntents(onEdit)[0]?.value).toEqual({
      ...SEEDED_WORKFLOW_DEFAULTS.planRepair,
      maxAttemptsPerContext: 5,
    });
  });
});
