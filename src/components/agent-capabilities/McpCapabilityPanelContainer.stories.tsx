import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";

import { mcpConfigKeys } from "@/lib/mcp/query-keys";
import type {
  McpConfigViewResponse,
  McpInheritanceStatus,
  McpServerView as ApiServerView,
  McpToolView as ApiToolView,
  ToolDiscoveryState,
} from "@/lib/mcp/schemas";

import { McpCapabilityPanelContainer } from "./McpCapabilityPanelContainer";
import type { AgentCapabilityLayerOption } from "./AgentCapabilityPanel";

// Seeded session-scope view exercising the MCP capability panel chrome that the
// drawer/configurator stories cannot reach (they only render its loading/error
// body): real server rows with the shared switch + inheritance chip, the
// per-server tool summary, the strikethrough disabled row, and — once a row is
// expanded — the tool rows with per-tool switches, inheritance chips, and a
// disabled/pending tool. Session view level so the inheritance chips attribute a
// concrete parent ("project"/"global"). The data is seeded into the query cache
// so the connected container renders without a (non-existent) fetch.

const CC_GLOBAL_MCP = "/home/alex/.config/cc/.mcp.json";
const CC_PROJECT_MCP = "/home/alex/repos/acme-dashboard/.mcp.json";

function apiTool(
  name: string,
  partial: Partial<ApiToolView> = {},
): ApiToolView {
  return {
    name,
    enabled: partial.enabled ?? true,
    inherited: partial.inherited ?? true,
    inheritanceStatus: partial.inheritanceStatus ?? "inherited",
    orphaned: partial.orphaned ?? false,
    pending: partial.pending ?? false,
    description: partial.description,
  };
}

function apiServer(
  partial: Partial<ApiServerView> & { serverKey: string },
): ApiServerView {
  const inheritanceStatus: McpInheritanceStatus =
    partial.inheritanceStatus ?? "inherited";
  const toolState: ToolDiscoveryState = partial.tools?.state ?? "not-loaded";
  return {
    serverKey: partial.serverKey,
    displayName: partial.displayName ?? partial.serverKey,
    nativeId: partial.nativeId ?? partial.serverKey,
    transport: partial.transport ?? "stdio",
    enabled: partial.enabled ?? true,
    compatibility: partial.compatibility ?? {
      backends: [
        { backend: "claude", supported: true },
        {
          backend: "codex",
          supported: false,
          reason: "Codex does not support SSE",
        },
        { backend: "cursor", supported: true },
      ],
    },
    inheritanceStatus,
    sourceRefs: partial.sourceRefs ?? [
      { scope: "global", filePath: CC_GLOBAL_MCP },
    ],
    reserved: partial.reserved ?? false,
    orphaned: partial.orphaned ?? false,
    pending: partial.pending ?? false,
    tools: partial.tools ?? { state: toolState, tools: [], diagnostics: [] },
    diagnostics: partial.diagnostics ?? [],
  };
}

const sessionView: McpConfigViewResponse = {
  level: "session",
  servers: [
    apiServer({
      serverKey: "playwright",
      sourceRefs: [{ scope: "project", filePath: CC_PROJECT_MCP }],
      inheritanceStatus: "inherited",
      tools: {
        state: "ready",
        tools: [
          apiTool("browser_navigate", { description: "Navigate to a URL" }),
          apiTool("browser_click", { description: "Click on an element" }),
          apiTool("browser_snapshot", { description: "Take a DOM snapshot" }),
        ],
        diagnostics: [],
      },
    }),
    apiServer({
      serverKey: "chrome-devtools",
      inheritanceStatus: "overridden",
      tools: {
        state: "ready",
        tools: [
          apiTool("list_pages", { inheritanceStatus: "inherited" }),
          apiTool("take_screenshot", {
            enabled: false,
            inherited: false,
            inheritanceStatus: "disabled",
            description: "Capture a page screenshot",
          }),
          apiTool("navigate_page", {
            inheritanceStatus: "inherited",
            pending: true,
          }),
        ],
        diagnostics: [],
      },
    }),
    apiServer({
      serverKey: "gmail",
      enabled: false,
      inheritanceStatus: "disabled",
      tools: { state: "not-loaded", tools: [], diagnostics: [] },
    }),
    apiServer({
      serverKey: "linear-mcp",
      inheritanceStatus: "inherited",
      tools: { state: "not-loaded", tools: [], diagnostics: [] },
    }),
  ],
  diagnostics: [],
  pendingServerKeys: [],
};

const layerOptions: readonly AgentCapabilityLayerOption[] = [
  { label: "Global", scope: { level: "global" } },
  {
    label: "Project",
    scope: { level: "project", projectName: "acme-dashboard" },
  },
  {
    label: "Session",
    scope: {
      level: "session",
      projectName: "acme-dashboard",
      sessionName: "capabilities",
    },
  },
];

function seededClient(entries: Array<[QueryKey, unknown]>): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  for (const [key, value] of entries) client.setQueryData(key, value);
  return client;
}

const meta = {
  title: "Agent Capabilities/McpCapabilityPanelContainer",
  component: McpCapabilityPanelContainer,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <QueryClientProvider
        client={seededClient([
          [
            mcpConfigKeys.session("acme-dashboard", "capabilities"),
            sessionView,
          ],
        ])}
      >
        <div style={{ height: "100vh" }}>
          <Story />
        </div>
      </QueryClientProvider>
    ),
  ],
} satisfies Meta<typeof McpCapabilityPanelContainer>;

export default meta;

type Story = StoryObj<typeof meta>;

const sessionScope = {
  level: "session" as const,
  projectName: "acme-dashboard",
  sessionName: "capabilities",
};

// Collapsed server rows: switches, inheritance chips, per-server tool summary,
// the strikethrough disabled row, the filter pills + search + scope note.
export const ServerRows: Story = {
  args: { layerOptions, selectedScope: sessionScope },
};

// Same data; the capture harness expands the `chrome-devtools` row (via its
// `[data-server-id] button[aria-expanded]` chevron) to reveal the tool rows:
// per-tool switches, per-tool inheritance chips, and a disabled + pending tool.
export const ExpandedTools: Story = {
  args: { layerOptions, selectedScope: sessionScope },
};
