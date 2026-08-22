// @vitest-environment jsdom
/**
 * The Agents group and its two drill screens (Config Panel `agentsRows()`,
 * `implementerRows()`, `collabRows()`).
 *
 * The assertions that matter are the cascade ones: the implementer is one
 * block, so an edit to any of its fields promotes all of it, while every
 * collaboration field stands alone — editing negotiation rounds must leave its
 * three siblings reading from whichever tier they came from.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { agentProfileKeys } from "@/lib/agent-profiles/query-keys";
import type { AgentProfileLibraryListing } from "@/lib/agent-profiles/schemas";
import type { GraphWorkflowExecutionContextDefinition } from "@/lib/workflow-graph/definition-schemas";
import type { WorkflowConfigOverride } from "@/lib/workflow-graph/definition-schemas";
import { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";
import {
  AgentsGroupScreen,
  CollaborationScreen,
  ImplementerScreen,
} from "./AgentsScreens";
import type { ConfigCascadeEditor } from "./cascade-editor";
import { createConfigCascade, type ConfigEditIntent } from "./config-cascade";
import type { ConfigScope } from "./types";

afterEach(cleanup);

const PROJECT = "checkout";

const LISTING: AgentProfileLibraryListing = {
  profiles: [
    {
      ref: { tier: "builtin", id: "general-implementer" },
      name: "General Implementer",
      description: "Implements a context's tasks.",
      revision: 1,
      recommendedFor: ["workflow_implementer"],
      tags: [],
      readOnly: true,
    },
    {
      ref: { tier: "project", id: "checkout-impl" },
      name: "Checkout Implementer",
      description: "Knows the payments path.",
      revision: 2,
      recommendedFor: ["workflow_implementer"],
      tags: [],
      readOnly: false,
    },
  ],
  diagnostics: [],
};

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
      libraryProjectName: PROJECT,
      ...rest,
    },
  };
}

function renderScreen(ui: React.ReactElement) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(agentProfileKeys.projectList(PROJECT), LISTING);
  return renderWithQuery(ui, queryClient);
}

function tierOf(rowId: string): string | null {
  const row = screen.getByTestId(`config-row-${rowId}`);
  const chip = within(row).queryByTestId("config-tier-chip");
  return chip === null ? null : (chip.textContent?.trim().charAt(0) ?? null);
}

function setIntents(
  onEdit: ReturnType<typeof vi.fn<(intent: ConfigEditIntent) => void>>,
) {
  return onEdit.mock.calls
    .map(([intent]) => intent)
    .filter((intent) => intent.kind === "set-path");
}

describe("Agents group screen", () => {
  it("summarises the implementer on a drill row, naming the model by its catalog label", () => {
    const { editor } = editorFor();
    renderScreen(<AgentsGroupScreen editor={editor} onOpen={vi.fn()} />);

    const row = screen.getByTestId("config-row-implementer");
    // The short id `opus` is what the selector holds; the reader sees the
    // canonical long name (README §3.3).
    expect(row.textContent).toContain("Opus 5");
    expect(row.textContent).not.toMatch(/\bopus\b/);
    expect(row.textContent).toContain("medium");
    expect(row.textContent).toContain("general-implementer");
  });

  it("opens the implementer and the collaboration setup screens", () => {
    const onOpen = vi.fn();
    const { editor } = editorFor();
    renderScreen(<AgentsGroupScreen editor={editor} onOpen={onOpen} />);

    fireEvent.click(
      within(screen.getByTestId("config-row-implementer")).getByRole("button"),
    );
    fireEvent.click(
      within(screen.getByTestId("config-row-collab")).getByRole("button"),
    );

    expect(onOpen.mock.calls.map(([id]) => id)).toEqual([
      "implementer",
      "collab",
    ]);
  });

  it("cascades the collaboration switch as its own field and says so", () => {
    const { editor, onEdit } = editorFor();
    renderScreen(<AgentsGroupScreen editor={editor} onOpen={vi.fn()} />);

    const row = screen.getByTestId("config-row-collaboration-enabled");
    expect(row.textContent).toContain("the rest of the block is unaffected");

    fireEvent.click(within(row).getByRole("switch"));

    expect(setIntents(onEdit)).toEqual([
      {
        kind: "set-path",
        tier: "context",
        path: "collaboration.enabled",
        value: true,
        granularity: "field",
      },
    ]);
  });
});

describe("Implementer screen", () => {
  it("promotes the whole block when the profile changes, keeping its other fields", () => {
    const { editor, onEdit } = editorFor({
      contextOverrides: {
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          focus: "Prefer additive migrations.",
          agent: { backend: "claude", model: "opus", reasoningEffort: "high" },
        },
      },
    });
    renderScreen(<ImplementerScreen editor={editor} open />);

    fireEvent.click(
      screen.getByRole("option", { name: /Checkout Implementer/ }),
    );

    const intent = setIntents(onEdit)[0];
    expect(intent).toMatchObject({
      path: "implementer",
      granularity: "block",
      value: {
        id: "implementer",
        profile: { tier: "project", id: "checkout-impl" },
        focus: "Prefer additive migrations.",
        agent: { backend: "claude", model: "opus", reasoningEffort: "high" },
      },
    });
  });

  it("removes the instructions key rather than storing an empty steer", () => {
    const { editor, onEdit } = editorFor({
      contextOverrides: {
        implementer: {
          ...SEEDED_WORKFLOW_DEFAULTS.implementer,
          focus: "Prefer additive migrations.",
        },
      },
    });
    renderScreen(<ImplementerScreen editor={editor} />);

    const instructions = screen.getByLabelText("Implementer instructions");
    expect(
      screen.getByTestId("config-row-implementer-instructions").textContent,
    ).toContain("clearing it removes the key");

    fireEvent.change(instructions, { target: { value: "   " } });

    const intent = setIntents(onEdit)[0];
    expect(intent?.value).not.toHaveProperty("focus");
  });

  it("resets model and effort when the backend changes, leaving the profile alone", () => {
    const { editor, onEdit } = editorFor();
    renderScreen(<ImplementerScreen editor={editor} />);

    fireEvent.click(screen.getByRole("button", { name: /codex/i }));

    const intent = setIntents(onEdit)[0];
    expect(intent).toMatchObject({
      path: "implementer",
      value: {
        profile: SEEDED_WORKFLOW_DEFAULTS.implementer.profile,
        agent: { backend: "codex", reasoningEffort: "medium" },
      },
    });
    expect(intent?.value).not.toMatchObject({ agent: { model: "opus" } });
  });
});

describe("Collaboration screen", () => {
  it("promotes negotiation rounds alone, leaving its siblings on their own tiers", () => {
    const { editor, onEdit } = editorFor({
      workflowConfig: { collaboration: { enabled: true } },
    });
    renderScreen(<CollaborationScreen editor={editor} />);

    // Enabled comes from the workflow, the second agent and the threshold from
    // global — and this edit must not move any of them.
    expect(tierOf("collab-enabled")).toBe("W");
    expect(tierOf("collab-second-agent-model")).toBe("G");
    expect(tierOf("collab-threshold")).toBe("G");

    fireEvent.change(screen.getByLabelText("Negotiation rounds"), {
      target: { value: "4" },
    });

    expect(setIntents(onEdit)).toEqual([
      {
        kind: "set-path",
        tier: "context",
        path: "collaboration.negotiationRounds",
        value: 4,
        granularity: "field",
      },
    ]);
  });

  it("shows the auto-resolve threshold's own consequence and edits it as a field", () => {
    const { editor, onEdit } = editorFor({
      contextOverrides: { collaboration: { negotiationRounds: 3 } },
    });
    renderScreen(<CollaborationScreen editor={editor} />);

    const row = screen.getByTestId("config-row-collab-threshold");
    expect(row.textContent).toContain("Auto-resolve only minor conflicts");
    // The one field this context owns wears no inherited tier chip; the
    // threshold beside it still does.
    expect(tierOf("collab-rounds")).toBeNull();

    fireEvent.click(within(row).getByRole("radio", { name: "blocking" }));

    expect(setIntents(onEdit)).toEqual([
      {
        kind: "set-path",
        tier: "context",
        path: "collaboration.autonomousResolutionThreshold",
        value: "blocking",
        granularity: "field",
      },
    ]);
  });

  it("resets the second agent as its own field, from the group's first row", () => {
    // The second agent is three rows but one cascade FIELD (README §7), so it
    // owes the same reset-to-inherit its three siblings have — otherwise the
    // only way back to the inherited agent is Reset all, which would take the
    // siblings with it.
    const { editor, onEdit } = editorFor({
      contextOverrides: {
        collaboration: {
          secondAgent: {
            backend: "codex",
            model: "gpt-5.4",
            reasoningEffort: "high",
          },
        },
      },
    });
    renderScreen(<CollaborationScreen editor={editor} />);

    fireEvent.click(
      within(
        screen.getByTestId("config-row-collab-second-agent-backend"),
      ).getByRole("button", { name: /Reset this field to inherit/ }),
    );

    expect(onEdit).toHaveBeenCalledWith({
      kind: "reset-path",
      tier: "context",
      path: "collaboration.secondAgent",
      granularity: "field",
    });
  });

  it("resets exactly the field it is asked to, never the block", () => {
    const { editor, onEdit } = editorFor({
      contextOverrides: { collaboration: { negotiationRounds: 3 } },
    });
    renderScreen(<CollaborationScreen editor={editor} />);

    fireEvent.click(
      within(screen.getByTestId("config-row-collab-rounds")).getByRole(
        "button",
        { name: /Reset this field to inherit/ },
      ),
    );

    expect(onEdit).toHaveBeenCalledWith({
      kind: "reset-path",
      tier: "context",
      path: "collaboration.negotiationRounds",
      granularity: "field",
    });
  });
});
