import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { AgentCapabilitiesConfigurator } from "./AgentCapabilitiesConfigurator";
import type { AgentCapabilityLayerOption } from "./AgentCapabilityPanel";

// Deterministic layer set for the drawer-shell chrome (header title/subtitle,
// the grouped Shared/Claude/Codex tablist, and the scope footer). The panel body
// below the chrome is rendered by the data-fetching containers; in Storybook it
// shows its loading/error state, which is unaffected by this slice (drawer-shell
// migration only). The stories exist to review the migrated chrome at the
// conventions doc's fixed viewports.
const layerOptions: readonly AgentCapabilityLayerOption[] = [
  { label: "Global", scope: { level: "global" } },
  {
    label: "Project",
    scope: { level: "project", projectName: "remote-ai-manager" },
  },
  {
    label: "Session",
    scope: {
      level: "session",
      projectName: "remote-ai-manager",
      sessionName: "capabilities",
    },
  },
  {
    label: "Conversation",
    scope: {
      level: "conversation",
      projectName: "remote-ai-manager",
      sessionName: "capabilities",
      conversationId: "conv-1",
    },
  },
];

const meta = {
  title: "Agent Capabilities/AgentCapabilitiesConfigurator",
  component: AgentCapabilitiesConfigurator,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AgentCapabilitiesConfigurator>;

export default meta;

type Story = StoryObj<typeof meta>;

// Full-page (config mount) chrome: large title, full-width tabs row, scope footer.
export const Inline: Story = {
  args: { layerOptions },
  render: (args) => (
    <div style={{ height: "100vh" }}>
      <AgentCapabilitiesConfigurator {...args} />
    </div>
  ),
};

// Drawer chrome: compact title, stacked per-agent tab groups, compact footer —
// rendered inside a fixed right-hand panel that mirrors the portaled drawer frame
// (border-left + drop shadow) so the drawer-mode chrome can be reviewed in place.
export const Drawer: Story = {
  args: { layerOptions, drawer: true, onClose: () => {} },
  render: (args) => (
    <div style={{ height: "100vh", position: "relative" }}>
      <aside className="fixed top-0 right-0 bottom-0 z-dropdown flex w-[min(720px,100vw)] flex-col border-y-0 border-r-0 border-l border-solid border-border-default bg-bg-base shadow-[-16px_0_48px_var(--cc-black-a55)]">
        <AgentCapabilitiesConfigurator {...args} />
      </aside>
    </div>
  ),
};
