import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import "@/components/workflow-graph/workflow-graph.css";
import type { WorkflowCollaborationConfig } from "@/lib/workflow-graph/collaboration-schemas";
import InspectorConfigBlock, {
  type InspectorConfigBlockSource,
} from "./InspectorConfigBlock";
import { CollaborationEditor } from "@/components/workflow-config/FieldEditors";

const BASE: WorkflowCollaborationConfig = {
  enabled: false,
  secondAgent: {
    backend: "claude",
    model: "sonnet",
    reasoningEffort: "medium",
  },
  negotiationRounds: 3,
  autonomousResolutionThreshold: "minor",
};

const CUSTOM: WorkflowCollaborationConfig = {
  enabled: true,
  secondAgent: { backend: "codex", model: "gpt-5.4", reasoningEffort: "high" },
  negotiationRounds: 5,
  autonomousResolutionThreshold: "major",
};

function summarize(config: WorkflowCollaborationConfig): string {
  return config.enabled ? "on" : "off";
}

function InspectorBlockHarness({
  initialSource,
  initialValue,
}: {
  initialSource: InspectorConfigBlockSource;
  initialValue: WorkflowCollaborationConfig;
}) {
  const [source, setSource] =
    useState<InspectorConfigBlockSource>(initialSource);
  const [value, setValue] = useState<WorkflowCollaborationConfig>(initialValue);

  return (
    <div style={{ width: 340, padding: 16, background: "var(--bg-surface)" }}>
      <div className="flex flex-col gap-sm" data-scope="workflow">
        <InspectorConfigBlock
          label="Collaboration"
          summary={summarize(value)}
          source={source}
          headerSwitch={{
            checked: value.enabled,
            onCheckedChange: (enabled) => {
              setValue((current) => ({ ...current, enabled }));
              setSource("context-override");
            },
            ariaLabel: "Collaboration enabled",
          }}
          onOverride={() => setSource("context-override")}
          onReset={() => setSource("global")}
        >
          <CollaborationEditor
            value={value}
            onChange={setValue}
            readOnly={source !== "context-override"}
          />
        </InspectorConfigBlock>
      </div>
    </div>
  );
}

const meta = {
  title: "Workflows/CollaborationConfigBlock",
  component: CollaborationEditor,
  args: { value: BASE, onChange: fn() },
} satisfies Meta<typeof CollaborationEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InheritedGlobal: Story = {
  render: () => (
    <InspectorBlockHarness initialSource="global" initialValue={BASE} />
  ),
};

export const InheritedWorkflow: Story = {
  render: () => (
    <InspectorBlockHarness initialSource="workflow" initialValue={BASE} />
  ),
};

export const Overridden: Story = {
  render: () => (
    <InspectorBlockHarness
      initialSource="context-override"
      initialValue={CUSTOM}
    />
  ),
};
