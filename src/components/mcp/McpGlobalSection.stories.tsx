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
    onBackendFilterChange: fn(),
  },
} satisfies Meta<typeof McpGlobalSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  name: "Default — mixed backends",
  args: {
    servers: mkGlobalServers(),
  },
} satisfies Story;

export const Empty = {
  name: "No user-level servers",
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
        ⚠ Failed to parse <code>~/.codex/config.toml</code> — fix the file and
        reload.
      </span>
    ),
  },
} satisfies Story;

export const ClaudeFilter = {
  name: "Filtered to Claude backend",
  args: {
    servers: mkGlobalServers(),
    backendFilter: "claude",
  },
} satisfies Story;
