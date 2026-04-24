import { describe, it, expect } from "vitest";

import type {
  McpConfigViewResponse,
  McpServerView as ApiServerView,
} from "@/types";

import { adaptServerViewsForLevel } from "./view-adapter";

function apiServer(
  partial: Partial<ApiServerView> & { serverKey: string },
): ApiServerView {
  return {
    serverKey: partial.serverKey,
    displayName: partial.displayName ?? partial.serverKey,
    nativeId: partial.nativeId ?? partial.serverKey,
    transport: partial.transport ?? "stdio",
    enabled: partial.enabled ?? true,
    inheritanceStatus: partial.inheritanceStatus ?? "inherited",
    sourceRefs: partial.sourceRefs ?? [
      {
        scope: "global",
        filePath: "/home/alex/.config/cc/.mcp.json",
      },
    ],
    reserved: partial.reserved ?? false,
    orphaned: partial.orphaned ?? false,
    pending: partial.pending ?? false,
    tools: partial.tools ?? { state: "not-loaded", tools: [], diagnostics: [] },
    diagnostics: partial.diagnostics ?? [],
  };
}

function apiView(
  level: McpConfigViewResponse["level"],
  servers: ApiServerView[],
): McpConfigViewResponse {
  return {
    level,
    servers,
    diagnostics: [],
    pendingServerKeys: [],
  };
}

describe("adaptServerViewsForLevel", () => {
  it("maps inherited status to discriminated union with parent level", () => {
    const view = apiView("conversation", [
      apiServer({ serverKey: "playwright", inheritanceStatus: "inherited" }),
    ]);
    const rows = adaptServerViewsForLevel(view, "conversation");
    const server = rows[0]!;
    expect(server.status).toEqual({ kind: "inherited", from: "session" });
  });

  it("maps overridden to discriminated union carrying immediate parent as inheritsFrom", () => {
    const view = apiView("session", [
      apiServer({ serverKey: "chrome", inheritanceStatus: "overridden" }),
    ]);
    const rows = adaptServerViewsForLevel(view, "session");
    const server = rows[0]!;
    expect(server.status).toEqual({
      kind: "overridden",
      inheritsFrom: "project",
    });
  });

  it("maps disabled similarly", () => {
    const view = apiView("project", [
      apiServer({ serverKey: "gmail", inheritanceStatus: "disabled" }),
    ]);
    const rows = adaptServerViewsForLevel(view, "project");
    const server = rows[0]!;
    expect(server.status).toEqual({ kind: "disabled", inheritsFrom: "global" });
  });

  it("renders an ancestor-disabled server as inherited at deeper views (not current-level disabled)", () => {
    const view = apiView("session", [
      apiServer({
        serverKey: "gmail",
        enabled: false,
        inheritanceStatus: "inherited",
      }),
    ]);
    const rows = adaptServerViewsForLevel(view, "session");
    const server = rows[0]!;
    expect(server.enabled).toBe(false);
    expect(server.status).toEqual({ kind: "inherited", from: "project" });
  });

  it("maps explicit at global view without parent", () => {
    const view = apiView("global", [
      apiServer({ serverKey: "chrome", inheritanceStatus: "explicit" }),
    ]);
    const rows = adaptServerViewsForLevel(view, "global");
    const server = rows[0]!;
    expect(server.status).toEqual({ kind: "explicit" });
  });

  it("hides reserved gateway servers", () => {
    const view = apiView("conversation", [
      apiServer({ serverKey: "cc-roadmap", reserved: true }),
      apiServer({ serverKey: "playwright", reserved: false }),
    ]);
    const servers = adaptServerViewsForLevel(view, "conversation");
    expect(servers.map((s) => s.id)).toEqual(["playwright"]);
  });

  it("maps global scope from first sourceRef", () => {
    const view = apiView("global", [
      apiServer({
        serverKey: "chrome",
        sourceRefs: [
          {
            scope: "global",
            filePath: "/home/alex/.config/cc/.mcp.json",
          },
        ],
      }),
    ]);
    const rows = adaptServerViewsForLevel(view, "global");
    const server = rows[0]!;
    expect(server.scope).toBe("global");
    expect(server.sourceFile).toBe("/home/alex/.config/cc/.mcp.json");
  });

  it("maps project scope from first sourceRef", () => {
    const view = apiView("session", [
      apiServer({
        serverKey: "playwright",
        sourceRefs: [
          {
            scope: "project",
            filePath: "/home/alex/repo/.mcp.json",
          },
        ],
      }),
    ]);
    const rows = adaptServerViewsForLevel(view, "session");
    const server = rows[0]!;
    expect(server.scope).toBe("project");
    expect(server.sourceFile).toBe("/home/alex/repo/.mcp.json");
  });

  it("maps tools.state 'not-loaded' to toolDiscovery.idle", () => {
    const view = apiView("conversation", [
      apiServer({
        serverKey: "playwright",
        tools: { state: "not-loaded", tools: [], diagnostics: [] },
      }),
    ]);
    const rows = adaptServerViewsForLevel(view, "conversation");
    const server = rows[0]!;
    expect(server.toolDiscovery.kind).toBe("idle");
  });

  it("maps tools.state 'ready' to toolDiscovery.loaded and forwards tool rows", () => {
    const view = apiView("conversation", [
      apiServer({
        serverKey: "playwright",
        tools: {
          state: "ready",
          tools: [
            {
              name: "browser_click",
              enabled: true,
              inherited: true,
              inheritanceStatus: "inherited",
              orphaned: false,
              pending: false,
            },
          ],
          diagnostics: [],
        },
      }),
    ]);
    const rows = adaptServerViewsForLevel(view, "conversation");
    const server = rows[0]!;
    expect(server.toolDiscovery.kind).toBe("loaded");
    if (server.toolDiscovery.kind === "loaded") {
      expect(server.toolDiscovery.tools).toEqual([
        {
          name: "browser_click",
          description: undefined,
          enabled: true,
          status: { kind: "inherited", from: "session" },
          pending: false,
        },
      ]);
    }
  });
});
