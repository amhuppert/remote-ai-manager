import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import McpServersModal from "./McpServersModal";
import type { McpServerCardActions } from "./types";
import { mkSessionServers, mkProjectServers } from "./fixtures";

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
  title: "MCP/McpServersModal",
  component: McpServersModal,
  parameters: {
    layout: "fullscreen",
    backgrounds: { default: "void" },
  },
  args: {
    open: true,
    onClose: fn(),
    actions: sharedActions,
    onBackendFilterChange: fn(),
  },
} satisfies Meta<typeof McpServersModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SessionLevel = {
  name: "Session level — most common",
  args: {
    viewLevel: "session",
    title: "Session MCP configuration",
    subtitle: "add-payments-flow · /home/alex/repos/acme-dashboard",
    servers: mkSessionServers(),
    banner:
      "Changes take effect in the next turn of any active conversation in this session.",
  },
} satisfies Story;

export const ProjectLevel = {
  name: "Project level — defaults for all sessions",
  args: {
    viewLevel: "project",
    title: "Project MCP configuration",
    subtitle: "acme-dashboard · /home/alex/repos/acme-dashboard",
    servers: mkProjectServers(),
    banner:
      "Project-level toggles set defaults inherited by every session in this project.",
  },
} satisfies Story;

export const Empty = {
  name: "Empty state",
  args: {
    viewLevel: "session",
    title: "Session MCP configuration",
    subtitle: "new-session",
    servers: [],
  },
} satisfies Story;

export const WithCodexFilter = {
  name: "Codex filter applied",
  args: {
    viewLevel: "session",
    title: "Session MCP configuration",
    subtitle: "add-payments-flow",
    servers: mkSessionServers(),
    backendFilter: "codex",
  },
} satisfies Story;
