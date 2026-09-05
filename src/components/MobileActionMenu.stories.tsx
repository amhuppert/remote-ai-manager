"use client";

import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import MobileActionMenu from "./MobileActionMenu";

const meta = {
  title: "Mobile/MobileActionMenu",
  component: MobileActionMenu,
  args: {
    tddEnabled: false,
    onTddToggle: fn(),
    onDelete: fn(),
    devServerCounts: { running: 1, total: 2 },
    onDevServers: fn(),
  },
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "mobile1" },
  },
  decorators: [
    (Story) => (
      <div className="app p-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MobileActionMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const TddEnabled: Story = {
  args: {
    tddEnabled: true,
  },
};

export const NoDevServers: Story = {
  args: {
    devServerCounts: { running: 0, total: 0 },
  },
};
