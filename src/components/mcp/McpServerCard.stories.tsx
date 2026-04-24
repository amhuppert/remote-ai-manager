import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import McpServerCard from "./McpServerCard";
import type { McpServerCardActions, McpServerView, McpToolView } from "./types";

const sharedActions: McpServerCardActions = {
  onToggleEnabled: fn(),
  onOverride: fn(),
  onResetToInherit: fn(),
  onToggleTool: fn(),
  onResetTool: fn(),
  onRefreshTools: fn(),
  onExpand: fn(),
};

const CC_GLOBAL_MCP = "/home/alex/.config/cc/.mcp.json";
const CC_PROJECT_MCP = "/home/alex/repos/acme-dashboard/.mcp.json";

function tool(
  name: string,
  opts: Partial<McpToolView> = {},
  description?: string,
): McpToolView {
  return {
    name,
    description,
    enabled: true,
    status: { kind: "inherited", from: "global" },
    ...opts,
  };
}

const playwrightTools: McpToolView[] = [
  tool("browser_navigate", {}, "Navigate to a URL"),
  tool("browser_click", {}, "Click on an element"),
  tool(
    "browser_evaluate",
    {
      enabled: false,
      status: { kind: "disabled", inheritsFrom: "global" },
    },
    "Run arbitrary JS in the page",
  ),
  tool("browser_hover", {}, "Hover on an element"),
  tool("browser_snapshot", {}, "Take a DOM snapshot"),
  tool(
    "browser_type",
    {
      enabled: true,
      status: { kind: "overridden", inheritsFrom: "session" },
    },
    "Type into a focused input",
  ),
];

function baseServer(partial: Partial<McpServerView>): McpServerView {
  return {
    id: "playwright",
    name: "playwright",
    sourceFile: CC_PROJECT_MCP,
    scope: "project",
    enabled: true,
    status: { kind: "inherited", from: "session" },
    toolDiscovery: { kind: "loaded", tools: playwrightTools },
    ...partial,
  };
}

const meta = {
  title: "MCP/McpServerCard",
  component: McpServerCard,
  parameters: {
    layout: "padded",
    backgrounds: { default: "void" },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          maxWidth: 560,
          padding: 16,
          background: "var(--bg-void)",
          minHeight: 400,
        }}
      >
        <Story />
      </div>
    ),
  ],
  args: {
    viewLevel: "session",
    actions: sharedActions,
    defaultOpen: true,
  },
} satisfies Meta<typeof McpServerCard>;

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Inheritance states — the core grammar
// ---------------------------------------------------------------------------

export const ExplicitGlobal = {
  name: "Explicit (Global view)",
  args: {
    viewLevel: "global",
    server: baseServer({
      id: "chrome-devtools",
      name: "chrome-devtools",
      sourceFile: CC_GLOBAL_MCP,
      scope: "global",
      status: { kind: "explicit" },
    }),
  },
} satisfies Story;

export const InheritedFromGlobal = {
  name: "Inherited · Global",
  args: {
    viewLevel: "session",
    server: baseServer({
      status: { kind: "inherited", from: "global" },
      sourceFile: CC_GLOBAL_MCP,
      scope: "global",
    }),
  },
} satisfies Story;

export const InheritedFromProject = {
  name: "Inherited · Project",
  args: {
    viewLevel: "session",
    server: baseServer({
      status: { kind: "inherited", from: "project" },
    }),
  },
} satisfies Story;

export const InheritedFromSession = {
  name: "Inherited · Session (conversation view)",
  args: {
    viewLevel: "conversation",
    server: baseServer({
      status: { kind: "inherited", from: "session" },
    }),
  },
} satisfies Story;

export const OverriddenAtSession = {
  name: "Overridden · Session",
  args: {
    viewLevel: "session",
    server: baseServer({
      status: { kind: "overridden", inheritsFrom: "project" },
      enabled: true,
    }),
  },
} satisfies Story;

export const OverriddenAtConversation = {
  name: "Overridden · Conversation (mixed tool sources)",
  args: {
    viewLevel: "conversation",
    server: baseServer({
      status: { kind: "overridden", inheritsFrom: "session" },
      toolDiscovery: {
        kind: "loaded",
        tools: [
          tool("browser_navigate", {
            status: { kind: "inherited", from: "session" },
          }),
          tool("browser_click", {
            status: { kind: "inherited", from: "session" },
          }),
          tool("browser_evaluate", {
            enabled: false,
            status: { kind: "disabled", inheritsFrom: "session" },
          }),
          tool("browser_type", {
            enabled: true,
            status: { kind: "overridden", inheritsFrom: "session" },
            pending: true,
          }),
        ],
      },
    }),
  },
} satisfies Story;

export const Disabled = {
  name: "Disabled at this level",
  args: {
    viewLevel: "session",
    server: baseServer({
      id: "gmail",
      name: "gmail",
      sourceFile: CC_GLOBAL_MCP,
      scope: "global",
      enabled: false,
      status: { kind: "disabled", inheritsFrom: "global" },
      toolDiscovery: {
        kind: "loaded",
        tools: [
          tool("authenticate", { enabled: false }, "Begin OAuth flow"),
          tool("complete_authentication", { enabled: false }, "Finish OAuth"),
        ],
      },
    }),
  },
} satisfies Story;

// ---------------------------------------------------------------------------
// Diagnostic / state variants
// ---------------------------------------------------------------------------

export const RuntimeError = {
  name: "Runtime error",
  args: {
    viewLevel: "conversation",
    server: baseServer({
      id: "playwright",
      status: { kind: "inherited", from: "session" },
      runtimeError: "Failed to spawn: ENOENT — playwright binary not found",
      toolDiscovery: { kind: "error", message: "Server not connected" },
    }),
  },
} satisfies Story;

export const LoadingTools = {
  name: "Loading tools",
  args: {
    server: baseServer({
      status: { kind: "inherited", from: "global" },
      toolDiscovery: { kind: "loading" },
    }),
  },
} satisfies Story;

export const IdleTools = {
  name: "Idle (tools not yet discovered)",
  args: {
    server: baseServer({
      status: { kind: "inherited", from: "project" },
      toolDiscovery: { kind: "idle" },
    }),
  },
} satisfies Story;

export const NoTools = {
  name: "Server exposes no tools",
  args: {
    server: baseServer({
      id: "notify",
      name: "notify",
      sourceFile: CC_GLOBAL_MCP,
      scope: "global",
      status: { kind: "explicit" },
      toolDiscovery: { kind: "loaded", tools: [] },
    }),
  },
} satisfies Story;

export const PendingMidTurn = {
  name: "Pending · mid-turn",
  args: {
    viewLevel: "conversation",
    server: baseServer({
      status: { kind: "overridden", inheritsFrom: "session" },
      pending: true,
      toolDiscovery: {
        kind: "loaded",
        tools: [
          tool("browser_navigate", {
            status: { kind: "inherited", from: "session" },
          }),
          tool("browser_evaluate", {
            enabled: false,
            status: { kind: "overridden", inheritsFrom: "session" },
            pending: true,
          }),
        ],
      },
    }),
  },
} satisfies Story;

export const CollapsedInherited = {
  name: "Collapsed · inherited (default state)",
  args: {
    defaultOpen: false,
    server: baseServer({
      status: { kind: "inherited", from: "global" },
    }),
  },
} satisfies Story;

// ---------------------------------------------------------------------------
// Composite: small list (previews the surface-level layout)
// ---------------------------------------------------------------------------

export const ListPreview = {
  name: "List preview — mixed inheritance states",
  args: {
    server: baseServer({}),
  },
  render: (args) => (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <McpServerCard
        viewLevel="conversation"
        actions={args.actions}
        defaultOpen={false}
        server={baseServer({
          id: "playwright",
          status: { kind: "inherited", from: "project" },
        })}
      />
      <McpServerCard
        viewLevel="conversation"
        actions={args.actions}
        defaultOpen={true}
        server={baseServer({
          id: "chrome-devtools",
          name: "chrome-devtools",
          sourceFile: CC_GLOBAL_MCP,
          scope: "global",
          status: { kind: "overridden", inheritsFrom: "session" },
          toolDiscovery: {
            kind: "loaded",
            tools: [
              tool("list_pages", {
                status: { kind: "inherited", from: "session" },
              }),
              tool(
                "take_screenshot",
                {
                  enabled: false,
                  status: { kind: "overridden", inheritsFrom: "session" },
                },
                "Capture a page screenshot",
              ),
              tool("navigate_page", {
                status: { kind: "inherited", from: "session" },
              }),
            ],
          },
        })}
      />
      <McpServerCard
        viewLevel="conversation"
        actions={args.actions}
        defaultOpen={false}
        server={baseServer({
          id: "gmail",
          name: "gmail",
          sourceFile: CC_GLOBAL_MCP,
          scope: "global",
          enabled: false,
          status: { kind: "disabled", inheritsFrom: "global" },
          toolDiscovery: { kind: "idle" },
        })}
      />
    </div>
  ),
} satisfies Story;
