import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Tabs, Tab, TabCount } from "./Tabs";

const meta = {
  title: "UI/Tabs",
  component: Tabs,
  parameters: {
    // The inactive count pill is opacity-0.85 by design (legacy `.cc-tab-count`),
    // which axe flags for faded contrast. That opacity is frozen parity, so a11y
    // stays advisory here ("todo", the project default) rather than failing the
    // Storybook test project on legacy debt. Tab labels themselves are clean.
    a11y: { test: "todo" },
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

/** Active vs inactive tabs, each with a count badge whose opacity steps up when active. */
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
