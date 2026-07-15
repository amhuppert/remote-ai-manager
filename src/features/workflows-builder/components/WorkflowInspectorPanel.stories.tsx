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

export const WorkflowTabScriptValidatorEnabled = {
  args: {
    tab: "workflow",
    selectedContextId: null,
    definition: (() => {
      const def = createWorkflowDefinition();
      def.workflowConfig = {
        ...def.workflowConfig,
        scriptValidator: { enabled: true },
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
      plan.scriptValidator = { enabled: true };
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
        backend: "codex",
        model: "gpt-5.4",
        reasoningEffort: "medium",
      };
      return def;
    })(),
  },
} satisfies Story;
