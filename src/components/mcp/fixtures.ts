import type { McpServerView, McpToolView, McpInheritanceStatus } from "./types";

const CC_GLOBAL_MCP = "/home/alex/.config/cc/.mcp.json";
const CC_PROJECT_MCP = "/home/alex/repos/acme-dashboard/.mcp.json";

function mkTool(
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
  mkTool("browser_navigate", {}, "Navigate to a URL"),
  mkTool("browser_click", {}, "Click on an element"),
  mkTool(
    "browser_evaluate",
    { enabled: false, status: { kind: "disabled", inheritsFrom: "global" } },
    "Run arbitrary JS in the page",
  ),
  mkTool("browser_snapshot", {}, "Take a DOM snapshot"),
];

export function mkServer(partial: Partial<McpServerView> = {}): McpServerView {
  return {
    id: "playwright",
    name: "playwright",
    sourceFile: CC_GLOBAL_MCP,
    scope: "global",
    enabled: true,
    status: { kind: "inherited", from: "global" } as McpInheritanceStatus,
    toolDiscovery: { kind: "loaded", tools: playwrightTools },
    ...partial,
  };
}

/** Realistic list: a mix of scopes and inheritance states. */
export function mkConversationServers(): McpServerView[] {
  return [
    mkServer({
      id: "playwright",
      name: "playwright",
      scope: "project",
      sourceFile: CC_PROJECT_MCP,
      status: { kind: "inherited", from: "session" },
    }),
    mkServer({
      id: "chrome-devtools",
      name: "chrome-devtools",
      scope: "global",
      sourceFile: CC_GLOBAL_MCP,
      status: { kind: "overridden", inheritsFrom: "session" },
      toolDiscovery: {
        kind: "loaded",
        tools: [
          mkTool("list_pages", {
            status: { kind: "inherited", from: "session" },
          }),
          mkTool(
            "take_screenshot",
            {
              enabled: false,
              status: { kind: "overridden", inheritsFrom: "session" },
            },
            "Capture a page screenshot",
          ),
          mkTool("navigate_page", {
            status: { kind: "inherited", from: "session" },
            pending: true,
          }),
        ],
      },
    }),
    mkServer({
      id: "gmail",
      name: "gmail",
      scope: "global",
      sourceFile: CC_GLOBAL_MCP,
      enabled: false,
      status: { kind: "disabled", inheritsFrom: "global" },
      toolDiscovery: { kind: "idle" },
    }),
    mkServer({
      id: "linear-mcp",
      name: "linear-mcp",
      scope: "global",
      sourceFile: CC_GLOBAL_MCP,
      status: { kind: "inherited", from: "global" },
      toolDiscovery: { kind: "idle" },
    }),
    mkServer({
      id: "notify",
      name: "notify",
      scope: "global",
      sourceFile: CC_GLOBAL_MCP,
      status: { kind: "inherited", from: "global" },
      toolDiscovery: { kind: "loaded", tools: [] },
    }),
  ];
}

export function mkSessionServers(): McpServerView[] {
  return [
    mkServer({
      id: "playwright",
      scope: "project",
      sourceFile: CC_PROJECT_MCP,
      status: { kind: "inherited", from: "project" },
    }),
    mkServer({
      id: "chrome-devtools",
      name: "chrome-devtools",
      scope: "global",
      sourceFile: CC_GLOBAL_MCP,
      status: { kind: "overridden", inheritsFrom: "project" },
    }),
    mkServer({
      id: "gmail",
      name: "gmail",
      scope: "global",
      sourceFile: CC_GLOBAL_MCP,
      enabled: false,
      status: { kind: "disabled", inheritsFrom: "global" },
    }),
  ];
}

export function mkProjectServers(): McpServerView[] {
  return [
    mkServer({
      id: "playwright",
      scope: "project",
      sourceFile: CC_PROJECT_MCP,
      status: { kind: "explicit" },
    }),
    mkServer({
      id: "linear-mcp",
      name: "linear-mcp",
      scope: "project",
      sourceFile: CC_PROJECT_MCP,
      status: { kind: "explicit" },
      toolDiscovery: { kind: "idle" },
    }),
    mkServer({
      id: "chrome-devtools",
      name: "chrome-devtools",
      scope: "global",
      sourceFile: CC_GLOBAL_MCP,
      status: { kind: "inherited", from: "global" },
    }),
  ];
}

export function mkGlobalServers(): McpServerView[] {
  return [
    mkServer({
      id: "chrome-devtools",
      name: "chrome-devtools",
      scope: "global",
      sourceFile: CC_GLOBAL_MCP,
      status: { kind: "explicit" },
    }),
    mkServer({
      id: "gmail",
      name: "gmail",
      scope: "global",
      sourceFile: CC_GLOBAL_MCP,
      enabled: false,
      status: { kind: "disabled" },
      toolDiscovery: { kind: "idle" },
    }),
    mkServer({
      id: "linear-mcp",
      name: "linear-mcp",
      scope: "global",
      sourceFile: CC_GLOBAL_MCP,
      status: { kind: "explicit" },
      toolDiscovery: { kind: "idle" },
    }),
  ];
}
