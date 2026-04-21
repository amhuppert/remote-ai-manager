import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import McpConfigButton from "./McpConfigButton";
import type { McpServerCardActions } from "./types";
import { mkConversationServers, mkServer } from "./fixtures";

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
  title: "MCP/McpConfigButton",
  component: McpConfigButton,
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
          minHeight: 720,
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "flex-end",
        }}
      >
        <Story />
      </div>
    ),
  ],
  args: {
    actions: sharedActions,
    servers: mkConversationServers(),
  },
} satisfies Meta<typeof McpConfigButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  name: "Default (closed)",
  args: {},
} satisfies Story;

export const AllDefaults = {
  name: "All defaults (no overrides)",
  args: {
    servers: [
      mkServer({
        id: "playwright",
        scope: "project",
        status: { kind: "inherited", from: "session" },
      }),
      mkServer({
        id: "chrome-devtools",
        name: "chrome-devtools",
        scope: "user",
        sourceFile: "/home/alex/.claude/settings.json",
        status: { kind: "inherited", from: "global" },
      }),
    ],
  },
} satisfies Story;

export const WithOverrides = {
  name: "With conversation overrides",
  args: {},
} satisfies Story;

export const PendingMidTurn = {
  name: "Pending · mid-turn",
  args: {
    hasPending: true,
    pendingServerIds: ["chrome-devtools"],
  },
} satisfies Story;

export const Empty = {
  name: "No MCP servers discovered",
  args: {
    servers: [],
  },
} satisfies Story;

export const Disabled = {
  name: "Disabled (e.g. turn running, feature off)",
  args: {
    disabled: true,
    disabledTooltip: "MCP configuration is locked while a turn is running",
  },
} satisfies Story;
