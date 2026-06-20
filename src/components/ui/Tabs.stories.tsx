import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Tabs, Tab, TabCount } from "./Tabs";

const meta = {
  title: "UI/Tabs",
  component: Tabs,
  parameters: {
    // The inactive count inherits the tab's color (text-secondary on bg-surface)
    // instead of fading via opacity, so it — and the labels — meet WCAG AA text
    // contrast. a11y is enforced ("error" fails the Storybook test project on any
    // violation).
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

const items = [
  { id: "active", label: "Active", count: 3 },
  { id: "idle", label: "Idle", count: 12 },
  { id: "archived", label: "Archived", count: 0 },
];

/** Active vs inactive tabs, each with a count badge that takes the tab's color when active. */
export const Interactive: Story = {
  render: () => {
    const [active, setActive] = useState("active");
    return (
      <Tabs>
        {items.map((it) => {
          const isActive = it.id === active;
          return (
            <Tab key={it.id} active={isActive} onClick={() => setActive(it.id)}>
              {it.label}
              <TabCount active={isActive}>{it.count}</TabCount>
            </Tab>
          );
        })}
      </Tabs>
    );
  },
};

/** Both data-* states shown side by side without interaction. */
export const States: Story = {
  render: () => (
    <Tabs>
      <Tab active>
        Active<TabCount active>3</TabCount>
      </Tab>
      <Tab>
        Inactive<TabCount>12</TabCount>
      </Tab>
    </Tabs>
  ),
};

/** layoutClassName stretches the strip via external geometry (width). */
export const LayoutPlacement: Story = {
  render: () => (
    <div style={{ width: 360 }}>
      <Tabs layoutClassName="w-full">
        <Tab active>One</Tab>
        <Tab>Two</Tab>
      </Tabs>
    </div>
  ),
};
