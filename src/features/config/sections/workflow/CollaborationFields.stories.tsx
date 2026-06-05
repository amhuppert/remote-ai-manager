import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import "@/features/config/styles/config-editor.css";
import type { WorkflowCollaborationConfig } from "@/lib/workflows/schemas";
import { ConfigSubsection } from "../../components/ConfigSubsection";
import { CollaborationFields } from "./CollaborationFields";

const SEEDED: WorkflowCollaborationConfig = {
  secondAgent: {
    backend: "claude",
    model: "sonnet",
    reasoningEffort: "medium",
  },
  negotiationRounds: 3,
  autonomousResolutionThreshold: "minor",
};

const CUSTOM: WorkflowCollaborationConfig = {
  secondAgent: { backend: "codex", model: "gpt-5.4", reasoningEffort: "high" },
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
