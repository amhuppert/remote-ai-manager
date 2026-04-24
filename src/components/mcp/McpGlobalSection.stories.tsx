import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import McpGlobalSection from "./McpGlobalSection";
import type { McpServerCardActions } from "./types";
import { mkGlobalServers } from "./fixtures";

const sharedActions: McpServerCardActions = {
  onToggleEnabled: fn(),
  onOverride: fn(),
  onResetToInherit: fn(),
  onToggleTool: fn(),
  onResetTool: fn(),
  onRefreshTools: fn(),
  onExpand: fn(),
};

const meta = {
  title: "MCP/McpGlobalSection",
  component: McpGlobalSection,
  parameters: {
    layout: "padded",
    backgrounds: { default: "void" },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          maxWidth: 760,
          padding: 24,
          background: "var(--bg-void)",
        }}
      >
        <Story />
      </div>
    ),
  ],
  args: {
    actions: sharedActions,
  },
} satisfies Meta<typeof McpGlobalSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  name: "Default",
  args: {
    servers: mkGlobalServers(),
  },
} satisfies Story;

export const Empty = {
  name: "No global servers",
  args: {
    servers: [],
  },
} satisfies Story;

export const WithNotice = {
  name: "With a discovery notice",
  args: {
    servers: mkGlobalServers(),
    notice: (
      <span>
        ⚠ Failed to parse <code>~/.config/cc/.mcp.json</code> — fix the file and
        reload.
      </span>
    ),
  },
} satisfies Story;
