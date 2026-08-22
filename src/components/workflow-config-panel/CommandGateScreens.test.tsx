// @vitest-environment jsdom
/**
 * The three command gates (Config Panel `scriptRows()`, `agentvalRows()`,
 * `laneMergeRows()`).
 *
 * The load-bearing assertion is per-role independence: agent validation is the
 * one block stored at role granularity, so editing the implementer's selector
 * must leave the context validator's reading from whichever tier it came from.
 * The rest pins that the checklists come from the LIVE registry — and that an
 * unreadable registry says so instead of presenting itself as a project with no
 * commands.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import type { ValidationCommandSummary } from "@/lib/validation/schemas";
import type {
  GraphWorkflowExecutionContextDefinition,
  WorkflowConfigOverride,
} from "@/lib/workflow-graph/definition-schemas";
import { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";
import type { ConfigCascadeEditor } from "./cascade-editor";
import {
  AgentValidationScreen,
  LaneMergeValidationScreen,
  ScriptValidatorScreen,
} from "./CommandGateScreens";
import { createConfigCascade, type ConfigEditIntent } from "./config-cascade";
import type { ConfigScope } from "./types";

afterEach(cleanup);

const REGISTRY: readonly ValidationCommandSummary[] = [
  {
    name: "lint",
    cost: 2,
    description: "ESLint over the changed files",
    pathArgs: "paths",
    changedScope: "native",
  },
  {
    name: "typecheck",
    cost: 3,
    description: "tsc across the project",
    pathArgs: "forbid",
    changedScope: "full_fallback",
  },
  {
    name: "test",
    cost: 5,
    description: "Vitest",
    pathArgs: "paths",
    changedScope: "native",
  },
];

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
      validationCommands: REGISTRY,
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

function tierOf(rowId: string): string | null {
  const row = screen.getByTestId(`config-row-${rowId}`);
  const chip = within(row).queryByTestId("config-tier-chip");
  return chip === null ? null : (chip.textContent?.trim().charAt(0) ?? null);
}

describe("Script validator screen", () => {
  it("offers the project's registered commands with their cost and description", () => {
    const { editor, onEdit } = editorFor();
    renderScreen(<ScriptValidatorScreen editor={editor} />);

    const row = screen.getByTestId("config-row-script-commands");
    expect(row.textContent).toContain("cost 2 — ESLint over the changed files");
    expect(row.textContent).toContain(
      "Runs before agent validation. An empty selection disables the gate.",
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "typecheck" }));

    expect(setIntents(onEdit)).toEqual([
      {
        kind: "set-path",
        tier: "context",
        path: "scriptValidator",
        value: { commands: ["typecheck"] },
        granularity: "block",
      },
    ]);
  });

  it("drops a command from the selection without disturbing the rest", () => {
    const { editor, onEdit } = editorFor({
      contextOverrides: { scriptValidator: { commands: ["lint", "test"] } },
    });
    renderScreen(<ScriptValidatorScreen editor={editor} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "lint" }));

    expect(setIntents(onEdit)[0]?.value).toEqual({ commands: ["test"] });
  });

  it("says the registry is unreadable rather than showing an empty checklist", () => {
    const { editor } = editorFor({ validationCommands: undefined });
    renderScreen(<ScriptValidatorScreen editor={editor} />);

    expect(
      screen.getByTestId("config-row-script-commands").textContent,
    ).toMatch(/could not be read/);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("Agent validation screen", () => {
  it("renders both roles with their own mode and command list", () => {
    const { editor } = editorFor();
    renderScreen(<AgentValidationScreen editor={editor} />);

    expect(screen.getByText("Implementer")).toBeInTheDocument();
    expect(screen.getByText("Context validator")).toBeInTheDocument();
    expect(
      screen.getByTestId("config-row-agentval-note").textContent,
    ).toContain("The two roles resolve independently");
    // The seeded default: the implementer may run everything, the validator
    // nothing — so the two rows label their lists differently.
    expect(
      screen.getByTestId("config-row-agentval-implementer-commands")
        .textContent,
    ).toContain("Exceptions");
    expect(
      screen.getByTestId("config-row-agentval-contextValidator-commands")
        .textContent,
    ).toContain("Allowed commands");
  });

  it("leaves the other role's provenance alone when one role is edited", () => {
    const { editor, onEdit } = editorFor({
      workflowConfig: {
        agentValidation: { contextValidator: { mode: "only", commands: [] } },
      },
    });
    renderScreen(<AgentValidationScreen editor={editor} />);

    // Before: implementer from global, context validator from the workflow.
    expect(tierOf("agentval-implementer-mode")).toBe("G");
    expect(tierOf("agentval-contextValidator-mode")).toBe("W");

    fireEvent.click(
      within(
        screen.getByTestId("config-row-agentval-implementer-mode"),
      ).getByRole("radio", { name: "Only" }),
    );

    expect(setIntents(onEdit)).toEqual([
      {
        kind: "set-path",
        tier: "context",
        path: "agentValidation.implementer",
        value: { mode: "only", commands: [] },
        granularity: "role",
      },
    ]);
    // The untouched role still reads from the workflow: this screen wrote one
    // role, and the sibling's chip is unmoved.
    expect(tierOf("agentval-contextValidator-mode")).toBe("W");
  });

  it("resets exactly one role, naming the granularity it clears", () => {
    const { editor, onEdit } = editorFor({
      contextOverrides: {
        agentValidation: { implementer: { mode: "only", commands: ["test"] } },
      },
    });
    renderScreen(<AgentValidationScreen editor={editor} />);

    expect(tierOf("agentval-implementer-mode")).toBeNull();
    fireEvent.click(
      within(
        screen.getByTestId("config-row-agentval-implementer-mode"),
      ).getByRole("button", { name: /Reset this role to inherit/ }),
    );

    expect(onEdit).toHaveBeenCalledWith({
      kind: "reset-path",
      tier: "context",
      path: "agentValidation.implementer",
      granularity: "role",
    });
  });

  it("states what the mode plus the current list actually allows", () => {
    const { editor } = editorFor({
      contextOverrides: {
        agentValidation: { implementer: { mode: "all", except: ["test"] } },
      },
    });
    renderScreen(<AgentValidationScreen editor={editor} />);

    expect(
      screen.getByTestId("config-row-agentval-implementer-mode").textContent,
    ).toContain("Every registered command is allowed except the listed names.");
    expect(
      screen.getByTestId("config-row-agentval-contextValidator-mode")
        .textContent,
    ).toContain("No validation commands are allowed.");
  });

  it("toggles a command into the role it belongs to", () => {
    const { editor, onEdit } = editorFor();
    renderScreen(<AgentValidationScreen editor={editor} />);

    fireEvent.click(
      within(
        screen.getByTestId("config-row-agentval-contextValidator-commands"),
      ).getByRole("checkbox", { name: /lint/ }),
    );

    expect(setIntents(onEdit)[0]).toMatchObject({
      path: "agentValidation.contextValidator",
      value: { mode: "only", commands: ["lint"] },
    });
  });
});

describe("Lane-merge validation screen", () => {
  it("says it is workflow scope only and edits strategy as its own field", () => {
    const { editor, onEdit } = editorFor({ scope: "workflow" });
    renderScreen(<LaneMergeValidationScreen editor={editor} />);

    expect(
      screen.getByTestId("config-row-lanemerge-note").textContent,
    ).toContain("Contexts cannot override it");
    expect(
      screen.getByTestId("config-row-lanemerge-strategy").textContent,
    ).toContain("Validates only the last merge of a join series.");

    fireEvent.click(
      within(screen.getByTestId("config-row-lanemerge-strategy")).getByRole(
        "radio",
        { name: "every-merge" },
      ),
    );

    expect(setIntents(onEdit)).toEqual([
      {
        kind: "set-path",
        tier: "workflow",
        path: "laneMergeValidation.strategy",
        value: "every-merge",
        granularity: "field",
      },
    ]);
  });

  it("hides the command list until a custom source is chosen", () => {
    const { editor, onEdit } = editorFor({ scope: "workflow" });
    renderScreen(<LaneMergeValidationScreen editor={editor} />);

    expect(
      screen.getByTestId("config-row-lanemerge-source").textContent,
    ).toContain("resolved at merge submission");
    expect(screen.queryByTestId("config-row-lanemerge-commands")).toBeNull();

    fireEvent.click(
      within(screen.getByTestId("config-row-lanemerge-source")).getByRole(
        "radio",
        { name: "Custom list" },
      ),
    );

    expect(setIntents(onEdit)[0]).toMatchObject({
      path: "laneMergeValidation.commands",
      value: { mode: "only", commands: [] },
      granularity: "field",
    });
  });

  it("reads an empty custom list as the gate being disabled", () => {
    const { editor } = editorFor({
      scope: "workflow",
      workflowConfig: {
        laneMergeValidation: { commands: { mode: "only", commands: [] } },
      },
    });
    renderScreen(<LaneMergeValidationScreen editor={editor} />);

    expect(
      screen.getByTestId("config-row-lanemerge-source").textContent,
    ).toContain("Empty list — lane-merge validation is disabled.");
    expect(
      screen.getByTestId("config-row-lanemerge-commands"),
    ).toBeInTheDocument();
    // Strategy came from global and must not have moved with the commands edit.
    expect(tierOf("lanemerge-strategy")).toBe("G");
    expect(tierOf("lanemerge-source")).toBeNull();
  });
});
