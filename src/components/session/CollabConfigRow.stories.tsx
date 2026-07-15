import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import CollabConfigRow, {
  type CollabConfigRowConfig,
  type CollabConfigRowProps,
} from "@/components/session/CollabConfigRow";

function StatefulConfigRow(
  props: Omit<CollabConfigRowProps, "config" | "onChange"> & {
    initialConfig: CollabConfigRowConfig;
  },
): React.JSX.Element {
  const { initialConfig, ...rest } = props;
  const [config, setConfig] = useState<CollabConfigRowConfig>(initialConfig);
  return <CollabConfigRow {...rest} config={config} onChange={setConfig} />;
}

const meta = {
  title: "Collab/CollabConfigRow",
  component: CollabConfigRow,
  args: {
    onChange: fn(),
    onDismiss: fn(),
    originatingAgent: "claude",
    config: {
      secondAgent: "codex",
      negotiationRounds: 3,
      autonomousResolutionThreshold: "major",
    },
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 880, padding: 24 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CollabConfigRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  render: (args) => (
    <StatefulConfigRow
      onDismiss={args.onDismiss}
      originatingAgent={args.originatingAgent}
      initialConfig={args.config}
    />
  ),
} satisfies Story;

export const CodexAsSecond = {
  args: {
    originatingAgent: "claude",
    config: {
      secondAgent: "codex",
      negotiationRounds: 5,
      autonomousResolutionThreshold: "major",
    },
  },
  render: (args) => (
    <StatefulConfigRow
      onDismiss={args.onDismiss}
      originatingAgent={args.originatingAgent}
      initialConfig={args.config}
    />
  ),
} satisfies Story;

export const RoundsAtMin = {
  args: {
    originatingAgent: "claude",
    config: {
      secondAgent: "codex",
      negotiationRounds: 1,
      autonomousResolutionThreshold: "none",
    },
  },
  render: (args) => (
    <StatefulConfigRow
      onDismiss={args.onDismiss}
      originatingAgent={args.originatingAgent}
      initialConfig={args.config}
    />
  ),
} satisfies Story;

export const RoundsAtMax = {
  args: {
    originatingAgent: "codex",
    config: {
      secondAgent: "claude",
      negotiationRounds: 20,
      autonomousResolutionThreshold: "blocking",
    },
  },
  render: (args) => (
    <StatefulConfigRow
      onDismiss={args.onDismiss}
      originatingAgent={args.originatingAgent}
      initialConfig={args.config}
    />
  ),
} satisfies Story;

export const ThresholdMinor = {
  args: {
    originatingAgent: "claude",
    config: {
      secondAgent: "codex",
      negotiationRounds: 3,
      autonomousResolutionThreshold: "minor",
    },
  },
  render: (args) => (
    <StatefulConfigRow
      onDismiss={args.onDismiss}
      originatingAgent={args.originatingAgent}
      initialConfig={args.config}
    />
  ),
} satisfies Story;
