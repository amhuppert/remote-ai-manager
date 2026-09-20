import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import CollabConfigRow, {
  type CollabConfigRowConfig,
  type CollabConfigRowProps,
} from "@/components/session/CollabConfigRow";
import {
  getConfiguredBackendModelCatalog,
  getStaticBackendModelCatalog,
  type BackendSelectionDefaultsById,
} from "@/lib/agent-backends/catalog";
import { defaultSelectionForModel } from "@/lib/agent-backends/model-selection";

const CLAUDE_CATALOG = getStaticBackendModelCatalog("claude");
const CODEX_CATALOG = getStaticBackendModelCatalog("codex");
const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: defaultSelectionForModel(CLAUDE_CATALOG, "opus"),
  codex: defaultSelectionForModel(CODEX_CATALOG, "gpt-5.4"),
  cursor: { modelId: "composer-2.5", parameters: {} },
};
const MODEL_CATALOGS: CollabConfigRowProps["modelCatalogs"] = {
  claude: CLAUDE_CATALOG,
  codex: CODEX_CATALOG,
  cursor: getConfiguredBackendModelCatalog("cursor"),
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
    modelCatalogs: MODEL_CATALOGS,
    agentOne: {
      backend: "claude",
      modelSelection: {
        modelId: "fable",
        parameters: { effort: "xhigh" },
      },
    },
    config: {
      agentTwo: {
        backend: "codex",
        modelSelection: BACKEND_DEFAULTS.codex,
      },
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
  modelCatalogs: CollabConfigRowProps["modelCatalogs"];
  config: CollabConfigRowConfig;
}): React.JSX.Element {
  return (
    <StatefulConfigRow
      onDismiss={args.onDismiss}
      originatingAgent={args.originatingAgent}
      {...(args.agentOne !== undefined ? { agentOne: args.agentOne } : {})}
      backendDefaults={args.backendDefaults}
      modelCatalogs={args.modelCatalogs}
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
    agentOne: {
      backend: "claude",
      modelSelection: {
        modelId: "fable",
        parameters: { effort: "max" },
      },
    },
    config: {
      agentTwo: {
        backend: "claude",
        modelSelection: BACKEND_DEFAULTS.claude,
      },
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
        modelSelection: {
          modelId: "gpt-5.6-sol",
          parameters: { reasoning: "xhigh", fast: "true" },
        },
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
      agentTwo: {
        backend: "codex",
        modelSelection: BACKEND_DEFAULTS.codex,
      },
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
      modelSelection: {
        modelId: "gpt-5.6-sol",
        parameters: { reasoning: "ultra", fast: "true" },
      },
    },
    config: {
      agentTwo: {
        backend: "claude",
        modelSelection: BACKEND_DEFAULTS.claude,
      },
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
      agentTwo: {
        backend: "codex",
        modelSelection: BACKEND_DEFAULTS.codex,
      },
      negotiationRounds: 3,
      autonomousResolutionThreshold: "minor",
    },
  },
  render: statefulRender,
} satisfies Story;
