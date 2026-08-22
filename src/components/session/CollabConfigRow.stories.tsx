import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import CollabConfigRow, {
  type CollabConfigRowConfig,
  type CollabConfigRowProps,
} from "@/components/session/CollabConfigRow";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/catalog";

const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "opus", effort: "high" },
  codex: { modelId: "gpt-5.4", effort: "high", codexFastMode: false },
  cursor: { modelId: "composer-2.5", effort: "high" },
};

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
    backendDefaults: BACKEND_DEFAULTS,
    agentOne: { backend: "claude", model: "fable", effort: "xhigh" },
    config: {
      agentTwo: { backend: "codex", model: "gpt-5.4", effort: "high" },
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

function statefulRender(args: {
  onDismiss: CollabConfigRowProps["onDismiss"];
  originatingAgent: CollabConfigRowProps["originatingAgent"];
  agentOne?: CollabConfigRowProps["agentOne"];
  backendDefaults: CollabConfigRowProps["backendDefaults"];
  config: CollabConfigRowConfig;
}): React.JSX.Element {
  return (
    <StatefulConfigRow
      onDismiss={args.onDismiss}
      originatingAgent={args.originatingAgent}
      {...(args.agentOne !== undefined ? { agentOne: args.agentOne } : {})}
      backendDefaults={args.backendDefaults}
      initialConfig={args.config}
    />
  );
}

export const Default = {
  render: statefulRender,
} satisfies Story;

export const SameBackendPair = {
  args: {
    originatingAgent: "claude",
    agentOne: { backend: "claude", model: "fable", effort: "max" },
    config: {
      agentTwo: { backend: "claude", model: "opus", effort: "high" },
      negotiationRounds: 3,
      autonomousResolutionThreshold: "major",
    },
  },
  render: statefulRender,
} satisfies Story;

export const CodexAgentTwoFastMode = {
  args: {
    originatingAgent: "claude",
    config: {
      agentTwo: {
        backend: "codex",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        fastMode: true,
      },
      negotiationRounds: 5,
      autonomousResolutionThreshold: "major",
    },
  },
  render: statefulRender,
} satisfies Story;

export const RoundsAtMin = {
  args: {
    originatingAgent: "claude",
    config: {
      agentTwo: { backend: "codex", model: "gpt-5.4", effort: "high" },
      negotiationRounds: 1,
      autonomousResolutionThreshold: "none",
    },
  },
  render: statefulRender,
} satisfies Story;

export const RoundsAtMax = {
  args: {
    originatingAgent: "codex",
    agentOne: {
      backend: "codex",
      model: "gpt-5.6-sol",
      effort: "ultra",
      fastMode: true,
    },
    config: {
      agentTwo: { backend: "claude", model: "opus", effort: "high" },
      negotiationRounds: 20,
      autonomousResolutionThreshold: "blocking",
    },
  },
  render: statefulRender,
} satisfies Story;

export const ThresholdMinor = {
  args: {
    originatingAgent: "claude",
    config: {
      agentTwo: { backend: "codex", model: "gpt-5.4", effort: "high" },
      negotiationRounds: 3,
      autonomousResolutionThreshold: "minor",
    },
  },
  render: statefulRender,
} satisfies Story;
