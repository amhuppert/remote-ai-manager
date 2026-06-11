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
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 390, margin: "0 auto" }}>
        <style>{`
          /* Force mobile styles in story */
          .mobile-action-menu-trigger {
            display: flex !important;
            align-items: center;
            justify-content: center;
            width: 36px;
            height: 36px;
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-sm);
            background: transparent;
            color: var(--text-secondary);
            font-size: 1.1rem;
            cursor: pointer;
            padding: 0;
            line-height: 1;
            letter-spacing: 2px;
          }
          .mobile-action-menu-trigger:hover {
            background: var(--bg-hover);
            color: var(--text-primary);
            border-color: var(--border-default);
          }
        `}</style>
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
