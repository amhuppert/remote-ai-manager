import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import McpInfoChip from "./McpInfoChip";
import { mkSessionServers, mkServer } from "./fixtures";

const meta = {
  title: "MCP/McpInfoChip",
  component: McpInfoChip,
  parameters: {
    layout: "padded",
    backgrounds: { default: "void" },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          padding: 16,
          background: "var(--bg-void)",
          display: "flex",
          gap: 12,
          alignItems: "center",
        }}
      >
        <Story />
      </div>
    ),
  ],
  args: {
    onClick: fn(),
  },
} satisfies Meta<typeof McpInfoChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  name: "Default (all inherited)",
  args: {
    servers: [
      mkServer({ status: { kind: "inherited", from: "project" } }),
      mkServer({
        id: "gmail",
        status: { kind: "inherited", from: "global" },
      }),
    ],
  },
} satisfies Story;

export const WithOverrides = {
  name: "Has overrides at this level",
  args: {
    servers: mkSessionServers(),
  },
} satisfies Story;

export const Pending = {
  name: "Change pending mid-turn",
  args: {
    servers: [
      mkServer({
        pending: true,
        status: { kind: "overridden", inheritsFrom: "project" },
      }),
      mkServer({
        id: "gmail",
        status: { kind: "inherited", from: "global" },
      }),
    ],
  },
} satisfies Story;

export const Empty = {
  name: "No servers",
  args: {
    servers: [],
  },
} satisfies Story;

export const Compact = {
  name: "Compact variant",
  args: {
    servers: mkSessionServers(),
    compact: true,
  },
} satisfies Story;
