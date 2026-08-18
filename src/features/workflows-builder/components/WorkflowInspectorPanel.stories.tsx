import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useEffect } from "react";
import { fn } from "storybook/test";
import "@/components/workflow-graph/workflow-graph.css";
import {
  createWorkflowDefinition,
  createWorkflowLayout,
} from "@/lib/workflow-graph/test-fixtures";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";
import type {
  WorkflowGraphValidationError,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import WorkflowInspectorPanel, {
  type InspectorTab,
} from "./WorkflowInspectorPanel";

interface StoryArgs {
  tab: InspectorTab;
  selectedContextId: string | null;
  definition: WorkflowSemanticDefinition;
  dirty: boolean;
  validationErrors: WorkflowGraphValidationError[];
}

function StoryHost({
  tab,
  selectedContextId,
  definition,
  dirty,
  validationErrors,
}: StoryArgs): React.JSX.Element {
  useEffect(() => {
    const layout = createWorkflowLayout();
    _useGraphWorkflowBuilderStore.setState({
      persistedDraft: { definition, layout },
      draftDefinition: definition,
      draftLayout: layout,
      selectedContextId,
      selectedTaskId: null,
      dirty,
      validationErrors,
    });
  }, [definition, selectedContextId, dirty, validationErrors]);

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        background: "var(--bg-void)",
      }}
    >
      <div style={{ flex: 1, background: "var(--bg-void)" }} />
      <WorkflowInspectorPanel
        activeTab={tab}
        onTabChange={fn()}
        onSave={fn(async () => {})}
        onDelete={fn()}
        saving={false}
      />
    </div>
  );
}

const meta = {
  title: "Workflows/WorkflowInspectorPanel",
  component: StoryHost,
  parameters: {
    layout: "fullscreen",
  },
  args: {
    tab: "workflow",
    selectedContextId: null,
    definition: createWorkflowDefinition(),
    dirty: false,
    validationErrors: [],
  },
} satisfies Meta<typeof StoryHost>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WorkflowTab = {
  args: {
    tab: "workflow",
    selectedContextId: null,
  },
} satisfies Story;

export const WorkflowTabWithScopedInvariants = {
  args: {
    tab: "workflow",
    selectedContextId: null,
    definition: (() => {
      const def = createWorkflowDefinition();
      def.charter.invariants = [
        { id: "global", statement: "Applies everywhere." },
        {
          id: "implementation-only",
          statement: "Applies only to implementation work.",
          appliesTo: { contextIds: ["context-implement", "context-verify"] },
        },
      ];
      return def;
    })(),
  },
} satisfies Story;

// #69 change 3: charter sources carry structured context-id scoping. One
// source is scoped (cyan context chips), one is global, and one is a stored
// legacy source — prose appliesTo plus the retired accessPolicy — which must
// display as Global without error.
export const WorkflowTabWithScopedSources = {
  args: {
    tab: "workflow",
    selectedContextId: null,
    definition: (() => {
      const def = createWorkflowDefinition();
      def.charter.sourcesOfTruth = [
        {
          rank: 1,
          id: "design-doc",
          label: "Approved design document",
          type: "document",
          locator: ".kiro/specs/workflow-charter/design.md",
          description: "The authoritative architecture for this workflow",
          appliesTo: { contextIds: ["context-implement", "context-verify"] },
        },
        {
          rank: 2,
          id: "conventions",
          label: "Engineering conventions",
          type: "document",
          locator: "AGENTS.md",
          description: "House rules for every context",
        },
        {
          rank: 3,
          id: "legacy-notes",
          label: "Legacy notes",
          type: "other",
          locator: "notes.md",
          description: "Stored before scoping became structured",
          appliesTo: "implementation contexts only",
          accessPolicy: "worktree-relative",
        },
      ];
      return def;
    })(),
  },
} satisfies Story;

export const WorkflowTabScriptValidatorEnabled = {
  args: {
    tab: "workflow",
    selectedContextId: null,
    definition: (() => {
      const def = createWorkflowDefinition();
      def.workflowConfig = {
        ...def.workflowConfig,
        scriptValidator: { commands: ["pre-merge"] },
      };
      return def;
    })(),
  },
} satisfies Story;

export const ContextTab = {
  args: {
    tab: "context",
    selectedContextId: "context-plan",
  },
} satisfies Story;

// Records-shaped criteria (#69 change 4 stage 1): the editor lists each
// {id, statement} record with its generated id and reorder/remove controls.
// The plain ContextTab story above covers the legacy-prose case, which the
// editor shows as one wrapped record.
export const ContextTabWithCriteriaRecords = {
  args: {
    tab: "context",
    selectedContextId: "context-plan",
    definition: (() => {
      const def = createWorkflowDefinition();
      const plan = def.executionContexts.find((c) => c.id === "context-plan")!;
      plan.acceptanceCriteria = [
        {
          id: "ac-1",
          statement: "The plan document lists every affected module.",
        },
        {
          id: "ac-2",
          statement: "Each listed module names its validation command.",
        },
        { id: "ac-3", statement: "Open risks carry a named owner." },
      ];
      return def;
    })(),
  },
} satisfies Story;

export const ContextTabWithValidationError = {
  args: {
    tab: "context",
    selectedContextId: "context-plan",
    definition: (() => {
      const def = createWorkflowDefinition();
      const plan = def.executionContexts.find((c) => c.id === "context-plan")!;
      plan.acceptanceCriteria = "";
      return def;
    })(),
    dirty: true,
    validationErrors: [
      {
        code: "empty-context-acceptance-criteria",
        message: "Acceptance criteria is required.",
        contextId: "context-plan",
      },
    ],
  },
} satisfies Story;

export const ContextTabScriptValidatorEnabled = {
  args: {
    tab: "context",
    selectedContextId: "context-plan",
    definition: (() => {
      const def = createWorkflowDefinition();
      const plan = def.executionContexts.find((c) => c.id === "context-plan")!;
      plan.scriptValidator = { commands: ["pre-merge"] };
      return def;
    })(),
  },
} satisfies Story;

export const ContextTabApprovalAndQuestionsEnabled = {
  args: {
    tab: "context",
    selectedContextId: "context-plan",
    definition: (() => {
      const def = createWorkflowDefinition();
      const plan = def.executionContexts.find((c) => c.id === "context-plan")!;
      plan.humanApprovalGate = { enabled: true };
      plan.askUserQuestions = { enabled: true };
      return def;
    })(),
  },
} satisfies Story;

export const ContextTabCodexImplementerOverride = {
  args: {
    tab: "context",
    selectedContextId: "context-plan",
    definition: (() => {
      const def = createWorkflowDefinition();
      const plan = def.executionContexts.find((c) => c.id === "context-plan")!;
      plan.implementer = {
        id: "implementer",
        profile: { tier: "builtin", id: "general-implementer" },
        agent: {
          backend: "codex",
          model: "gpt-5.4",
          reasoningEffort: "medium",
        },
      };
      return def;
    })(),
  },
} satisfies Story;
