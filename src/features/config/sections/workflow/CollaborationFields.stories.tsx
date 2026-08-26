import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import type { WorkflowCollaborationConfig } from "@/lib/workflow-graph/collaboration-schemas";
import { ConfigSubsection } from "../../components/ConfigSubsection";
import { CollaborationFields } from "./CollaborationFields";

const SEEDED: WorkflowCollaborationConfig = {
  enabled: false,
  secondAgent: {
    backend: "claude",
    modelSelection: {
      modelId: "sonnet",
      parameters: { effort: "medium" },
    },
  },
  negotiationRounds: 3,
  autonomousResolutionThreshold: "minor",
};

const CUSTOM: WorkflowCollaborationConfig = {
  enabled: true,
  secondAgent: {
    backend: "codex",
    modelSelection: {
      modelId: "gpt-5.4",
      parameters: { reasoning: "high", fast: "false" },
    },
  },
  negotiationRounds: 6,
  autonomousResolutionThreshold: "blocking",
};

function GlobalFieldsHarness({
  initialValue,
  isDefault,
}: {
  initialValue: WorkflowCollaborationConfig;
  isDefault: boolean;
}) {
  const [value, setValue] = useState<WorkflowCollaborationConfig>(initialValue);
  return (
    <div style={{ width: 520, padding: 16, background: "var(--bg-surface)" }}>
      <ConfigSubsection
        id="collaboration"
        title="Collaboration"
        isDefault={isDefault}
      >
        <CollaborationFields value={value} onChange={setValue} />
      </ConfigSubsection>
    </div>
  );
}

const meta = {
  title: "Config/CollaborationFields",
  component: CollaborationFields,
  args: { value: SEEDED, onChange: fn() },
} satisfies Meta<typeof CollaborationFields>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <GlobalFieldsHarness initialValue={SEEDED} isDefault={true} />,
};

export const Modified: Story = {
  render: () => <GlobalFieldsHarness initialValue={CUSTOM} isDefault={false} />,
};
