import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import MobileBottomBar, { type MobilePanelTab } from "./MobileBottomBar";

const meta = {
  title: "Session/Mobile/Panel navigation",
  component: MobileBottomBar,
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "mobile1" },
  },
  args: {
    mobilePanel: "chat",
    onSwitchPanel: () => {},
    tddEnabled: true,
    onTddToggle: () => {},
    tddDisabled: false,
    onDelete: () => {},
    devServerCounts: { running: 1, total: 2 },
    onDevServers: () => {},
    onRebase: () => {},
  },
  render: function Navigation(args) {
    const [panel, setPanel] = useState<MobilePanelTab>(args.mobilePanel);
    const [tdd, setTdd] = useState(args.tddEnabled);
    return (
      <div className="app" data-page="detail" data-mobile-panel={panel}>
        <main className="p-lg font-mono text-text-primary">
          Selected panel: {panel}
        </main>
        <MobileBottomBar
          {...args}
          mobilePanel={panel}
          onSwitchPanel={setPanel}
          tddEnabled={tdd}
          onTddToggle={setTdd}
        />
      </div>
    );
  },
} satisfies Meta<typeof MobileBottomBar>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Phone: Story = {};
export const Compactions: Story = { args: { mobilePanel: "artifact" } };
