import { describe, expect, it } from "vitest";

import type {
  McpConfigLevel,
  McpOverrides,
  McpToolInventoryResult,
} from "@/lib/schemas";

import {
  mergeOverrideChain,
  resolveView,
  type McpOverrideChain,
} from "./resolver";
import type { McpServerDefinition } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noOverrides(): McpOverrides {
  return { servers: {} };
}

function chain(partial: Partial<McpOverrideChain> = {}): McpOverrideChain {
  return {
    global: partial.global ?? noOverrides(),
    ...(partial.project !== undefined ? { project: partial.project } : {}),
    ...(partial.session !== undefined ? { session: partial.session } : {}),
    ...(partial.conversation !== undefined
      ? { conversation: partial.conversation }
      : {}),
  };
}

function mkDefinition(
  partial: Partial<McpServerDefinition> & { serverKey: string },
): McpServerDefinition {
  return {
    nativeId: partial.nativeId ?? partial.serverKey,
    transport: partial.transport ?? "stdio",
    config: partial.config ?? {
      transport: "stdio",
      command: "echo",
      args: ["hi"],
    },
    sourceRefs: partial.sourceRefs ?? [
      {
        scope: "global",
        filePath: "/cc-config/.mcp.json",
      },
    ],
    configSignature: partial.configSignature ?? `sig-${partial.serverKey}`,
    reserved: partial.reserved ?? false,
    diagnostics: partial.diagnostics ?? [],
    ...partial,
  };
}

function readyInventory(...toolNames: string[]): McpToolInventoryResult {
  return {
    state: "ready",
    tools: toolNames.map((name) => ({ name })),
    diagnostics: [],
    refreshedAt: "2026-04-21T00:00:00.000Z",
  };
}

function notLoadedInventory(): McpToolInventoryResult {
  return {
    state: "not-loaded",
    tools: [],
    diagnostics: [],
  };
}

// ===========================================================================
// Cascade merge
// ===========================================================================

describe("mergeOverrideChain", () => {
  it("returns empty map when no level has overrides", () => {
    const result = mergeOverrideChain(
      chain({ global: noOverrides() }),
      "conversation",
    );
    expect(result.size).toBe(0);
  });

  it("applies global overrides at global view", () => {
    const result = mergeOverrideChain(
      chain({
        global: { servers: { kagi: { enabled: false } } },
      }),
      "global",
    );
    expect(result.get("kagi")).toEqual(
      expect.objectContaining({
        serverKey: "kagi",
        enabled: false,
        enabledOriginLevel: "global",
      }),
    );
  });

  it("does not apply project overrides at global view", () => {
    const result = mergeOverrideChain(
      chain({
        global: noOverrides(),
        project: { servers: { kagi: { enabled: false } } },
      }),
      "global",
    );
    expect(result.size).toBe(0);
  });

  it("applies global+project at project view", () => {
    const result = mergeOverrideChain(
      chain({
        global: { servers: { kagi: { enabled: true } } },
        project: { servers: { kagi: { enabled: false } } },
      }),
      "project",
    );
    expect(result.get("kagi")).toEqual(
      expect.objectContaining({
        enabled: false,
        enabledOriginLevel: "project",
      }),
    );
  });

  it("child level overrides parent enabled value (last write wins)", () => {
    const result = mergeOverrideChain(
      chain({
        global: { servers: { kagi: { enabled: false } } },
        project: { servers: { kagi: { enabled: true } } },
        session: { servers: { kagi: { enabled: false } } },
        conversation: { servers: { kagi: { enabled: true } } },
      }),
      "conversation",
    );
    expect(result.get("kagi")?.enabled).toBe(true);
    expect(result.get("kagi")?.enabledOriginLevel).toBe("conversation");
  });

  it("falls through to the nearest ancestor when child has no override for that field", () => {
    const result = mergeOverrideChain(
      chain({
        global: { servers: { kagi: { enabled: false } } },
        project: {
          servers: { kagi: { tools: { search: { enabled: true } } } },
        },
      }),
      "project",
    );
    const row = result.get("kagi");
    expect(row?.enabled).toBe(false);
    expect(row?.enabledOriginLevel).toBe("global");
    expect(row?.enabledTools).toContain("search");
    expect(row?.toolOriginLevels["search"]).toBe("project");
  });

  it("patches per-tool overrides field by field (does not clobber sibling tools)", () => {
    const result = mergeOverrideChain(
      chain({
        global: {
          servers: {
            kagi: {
              tools: {
                search: { enabled: true },
                summarize: { enabled: true },
              },
            },
          },
        },
        project: {
          servers: { kagi: { tools: { search: { enabled: false } } } },
        },
      }),
      "project",
    );
    const row = result.get("kagi");
    expect(row?.enabledTools).toEqual(expect.arrayContaining(["summarize"]));
    expect(row?.disabledTools).toEqual(expect.arrayContaining(["search"]));
    expect(row?.toolOriginLevels["summarize"]).toBe("global");
    expect(row?.toolOriginLevels["search"]).toBe("project");
  });

  it("emits enabledTools/disabledTools verbatim from the override chain", () => {
    const result = mergeOverrideChain(
      chain({
        global: {
          servers: {
            kagi: {
              tools: {
                a: { enabled: true },
                b: { enabled: false },
              },
            },
          },
        },
      }),
      "conversation",
    );
    const row = result.get("kagi");
    expect(row?.enabledTools).toEqual(expect.arrayContaining(["a"]));
    expect(row?.disabledTools).toEqual(expect.arrayContaining(["b"]));
    expect(row?.enabledTools).not.toContain("b");
    expect(row?.disabledTools).not.toContain("a");
  });

  it("does not mutate the input overrides", () => {
    const input = chain({
      global: { servers: { kagi: { enabled: true } } },
      project: { servers: { kagi: { enabled: false } } },
    });
    const snapshot = JSON.parse(JSON.stringify(input));
    mergeOverrideChain(input, "conversation");
    expect(input).toEqual(snapshot);
  });
});

// ===========================================================================
// Orphan detection
// ===========================================================================

describe("resolveView — orphan detection", () => {
  function resolve(
    overrideChain: McpOverrideChain,
    opts: {
      discovered: readonly McpServerDefinition[];
      level?: McpConfigLevel;
      toolInventories?: Record<string, McpToolInventoryResult>;
    },
  ) {
    return resolveView({
      level: opts.level ?? "conversation",
      overrides: overrideChain,
      discovered: opts.discovered,
      discoveryDiagnostics: [],
      toolInventories: opts.toolInventories ?? {},
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
    });
  }

  it("marks an override as orphaned when no discovered definition matches the serverKey", () => {
    const view = resolve(
      chain({
        global: { servers: { ghost: { enabled: false } } },
      }),
      { discovered: [] },
    );
    const row = view.servers.find((s) => s.serverKey === "ghost");
    expect(row).toBeDefined();
    expect(row?.orphaned).toBe(true);
  });

  it("does not mark a server orphaned when a discovered definition exists", () => {
    const view = resolve(
      chain({
        global: { servers: { kagi: { enabled: false } } },
      }),
      {
        discovered: [mkDefinition({ serverKey: "kagi" })],
      },
    );
    const row = view.servers.find((s) => s.serverKey === "kagi");
    expect(row?.orphaned).toBe(false);
  });

  it("keeps orphaned server rows visible in the view model (not filtered)", () => {
    const view = resolve(
      chain({
        global: { servers: { ghost: { enabled: true } } },
      }),
      { discovered: [] },
    );
    expect(view.servers.some((s) => s.serverKey === "ghost")).toBe(true);
  });

  it("marks a tool override orphaned ONLY when discovery state is ready and tool is absent", () => {
    const view = resolve(
      chain({
        conversation: {
          servers: {
            kagi: { tools: { missing_tool: { enabled: false } } },
          },
        },
      }),
      {
        discovered: [mkDefinition({ serverKey: "kagi" })],
        toolInventories: { kagi: readyInventory("search", "summarize") },
      },
    );
    const row = view.servers.find((s) => s.serverKey === "kagi");
    const toolRow = row?.tools.tools.find((t) => t.name === "missing_tool");
    expect(toolRow).toBeDefined();
    expect(toolRow?.orphaned).toBe(true);
  });

  it("marks a tool override orphaned when discovery state is stale and tool is absent", () => {
    const view = resolve(
      chain({
        conversation: {
          servers: {
            kagi: { tools: { missing_tool: { enabled: false } } },
          },
        },
      }),
      {
        discovered: [mkDefinition({ serverKey: "kagi" })],
        toolInventories: {
          kagi: { ...readyInventory("search"), state: "stale" },
        },
      },
    );
    const toolRow = view.servers
      .find((s) => s.serverKey === "kagi")
      ?.tools.tools.find((t) => t.name === "missing_tool");
    expect(toolRow?.orphaned).toBe(true);
  });

  it("does NOT mark tool orphaned when discovery state is not-loaded", () => {
    const view = resolve(
      chain({
        conversation: {
          servers: {
            kagi: { tools: { anything: { enabled: false } } },
          },
        },
      }),
      {
        discovered: [mkDefinition({ serverKey: "kagi" })],
        toolInventories: { kagi: notLoadedInventory() },
      },
    );
    const toolRow = view.servers
      .find((s) => s.serverKey === "kagi")
      ?.tools.tools.find((t) => t.name === "anything");
    expect(toolRow?.orphaned).toBe(false);
  });

  it("does NOT mark tool orphaned when discovery state is loading or error", () => {
    for (const state of ["loading", "error"] as const) {
      const view = resolve(
        chain({
          conversation: {
            servers: {
              kagi: { tools: { anything: { enabled: false } } },
            },
          },
        }),
        {
          discovered: [mkDefinition({ serverKey: "kagi" })],
          toolInventories: {
            kagi: { state, tools: [], diagnostics: [] },
          },
        },
      );
      const toolRow = view.servers
        .find((s) => s.serverKey === "kagi")
        ?.tools.tools.find((t) => t.name === "anything");
      expect(toolRow?.orphaned).toBe(false);
    }
  });

  it("does NOT mark tool orphaned when ready and tool name is present", () => {
    const view = resolve(
      chain({
        conversation: {
          servers: {
            kagi: { tools: { search: { enabled: false } } },
          },
        },
      }),
      {
        discovered: [mkDefinition({ serverKey: "kagi" })],
        toolInventories: { kagi: readyInventory("search") },
      },
    );
    const toolRow = view.servers
      .find((s) => s.serverKey === "kagi")
      ?.tools.tools.find((t) => t.name === "search");
    expect(toolRow?.orphaned).toBe(false);
  });
});

// ===========================================================================
// View-model assembly
// ===========================================================================

describe("resolveView — inheritance status at global view", () => {
  it("global-scope server with no override → explicit", () => {
    const view = resolveView({
      level: "global",
      overrides: chain(),
      discovered: [mkDefinition({ serverKey: "kagi" })],
      discoveryDiagnostics: [],
      toolInventories: {},
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
    });
    const row = view.servers.find((s) => s.serverKey === "kagi");
    expect(row?.inheritanceStatus).toBe("explicit");
    expect(row?.enabled).toBe(true);
  });

  it("server disabled at global → disabled", () => {
    const view = resolveView({
      level: "global",
      overrides: chain({
        global: { servers: { kagi: { enabled: false } } },
      }),
      discovered: [mkDefinition({ serverKey: "kagi" })],
      discoveryDiagnostics: [],
      toolInventories: {},
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
    });
    const row = view.servers.find((s) => s.serverKey === "kagi");
    expect(row?.inheritanceStatus).toBe("disabled");
    expect(row?.enabled).toBe(false);
  });
});

describe("resolveView — inheritance status at project view", () => {
  const projectSrc: McpServerDefinition = mkDefinition({
    serverKey: "playwright",
    sourceRefs: [{ scope: "project", filePath: "/repo/.mcp.json" }],
  });
  const globalSrc: McpServerDefinition = mkDefinition({
    serverKey: "chrome-devtools",
    sourceRefs: [{ scope: "global", filePath: "/cc-config/.mcp.json" }],
  });

  function viewAt(overrideChain: McpOverrideChain) {
    return resolveView({
      level: "project",
      overrides: overrideChain,
      discovered: [projectSrc, globalSrc],
      discoveryDiagnostics: [],
      toolInventories: {},
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
    });
  }

  it("project-scope server, no override → explicit", () => {
    const view = viewAt(chain());
    expect(
      view.servers.find((s) => s.serverKey === "playwright")?.inheritanceStatus,
    ).toBe("explicit");
  });

  it("global-scope server, no override → inherited", () => {
    const view = viewAt(chain());
    expect(
      view.servers.find((s) => s.serverKey === "chrome-devtools")
        ?.inheritanceStatus,
    ).toBe("inherited");
  });

  it("global-scope server with project override enabled=true → overridden", () => {
    const view = viewAt(
      chain({
        project: { servers: { "chrome-devtools": { enabled: true } } },
      }),
    );
    expect(
      view.servers.find((s) => s.serverKey === "chrome-devtools")
        ?.inheritanceStatus,
    ).toBe("overridden");
  });

  it("global-scope server with project override enabled=false → disabled", () => {
    const view = viewAt(
      chain({
        project: { servers: { "chrome-devtools": { enabled: false } } },
      }),
    );
    expect(
      view.servers.find((s) => s.serverKey === "chrome-devtools")
        ?.inheritanceStatus,
    ).toBe("disabled");
  });

  it("global-scope server disabled at global → inherited (disabled) at project view", () => {
    const view = viewAt(
      chain({
        global: { servers: { "chrome-devtools": { enabled: false } } },
      }),
    );
    const row = view.servers.find((s) => s.serverKey === "chrome-devtools");
    expect(row?.inheritanceStatus).toBe("inherited");
    expect(row?.enabled).toBe(false);
  });
});

describe("resolveView — inheritance status at session/conversation views", () => {
  const globalSrc = mkDefinition({
    serverKey: "chrome-devtools",
    sourceRefs: [{ scope: "global", filePath: "/cc-config/.mcp.json" }],
  });
  const projectSrc = mkDefinition({
    serverKey: "playwright",
    sourceRefs: [{ scope: "project", filePath: "/repo/.mcp.json" }],
  });

  it("server with session override → overridden at session view", () => {
    const view = resolveView({
      level: "session",
      overrides: chain({
        session: { servers: { "chrome-devtools": { enabled: true } } },
      }),
      discovered: [globalSrc],
      discoveryDiagnostics: [],
      toolInventories: {},
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
    });
    expect(
      view.servers.find((s) => s.serverKey === "chrome-devtools")
        ?.inheritanceStatus,
    ).toBe("overridden");
  });

  it("server with conversation override → overridden at conversation view", () => {
    const view = resolveView({
      level: "conversation",
      overrides: chain({
        conversation: { servers: { "chrome-devtools": { enabled: true } } },
      }),
      discovered: [globalSrc],
      discoveryDiagnostics: [],
      toolInventories: {},
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
    });
    expect(
      view.servers.find((s) => s.serverKey === "chrome-devtools")
        ?.inheritanceStatus,
    ).toBe("overridden");
  });

  it("server with project override, viewed at session → inherited", () => {
    const view = resolveView({
      level: "session",
      overrides: chain({
        project: { servers: { "chrome-devtools": { enabled: true } } },
      }),
      discovered: [globalSrc],
      discoveryDiagnostics: [],
      toolInventories: {},
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
    });
    expect(
      view.servers.find((s) => s.serverKey === "chrome-devtools")
        ?.inheritanceStatus,
    ).toBe("inherited");
  });

  it("project-scope definition with no override → inherited at session view", () => {
    const view = resolveView({
      level: "session",
      overrides: chain(),
      discovered: [projectSrc],
      discoveryDiagnostics: [],
      toolInventories: {},
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
    });
    expect(
      view.servers.find((s) => s.serverKey === "playwright")?.inheritanceStatus,
    ).toBe("inherited");
  });

  it("project-scope definition with no override → inherited at conversation view", () => {
    const view = resolveView({
      level: "conversation",
      overrides: chain(),
      discovered: [projectSrc],
      discoveryDiagnostics: [],
      toolInventories: {},
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
    });
    expect(
      view.servers.find((s) => s.serverKey === "playwright")?.inheritanceStatus,
    ).toBe("inherited");
  });
});

describe("resolveView — reserved gateway servers", () => {
  const gateway = mkDefinition({
    serverKey: "cc-roadmap",
    reserved: true,
    sourceRefs: [],
  });

  it("marks gateway server reserved=true in the view model", () => {
    const view = resolveView({
      level: "conversation",
      overrides: chain(),
      discovered: [gateway],
      discoveryDiagnostics: [],
      toolInventories: {},
      gatewayServerKeys: ["cc-roadmap"],
      reservedGatewayServerKeys: ["cc-roadmap"],
      pendingServerKeys: [],
    });
    const row = view.servers.find((s) => s.serverKey === "cc-roadmap");
    expect(row?.reserved).toBe(true);
  });

  it("reserved flag propagates from definition.reserved as well as reservedGatewayServerKeys", () => {
    const view = resolveView({
      level: "conversation",
      overrides: chain(),
      discovered: [mkDefinition({ serverKey: "cc-planner", reserved: true })],
      discoveryDiagnostics: [],
      toolInventories: {},
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
    });
    expect(
      view.servers.find((s) => s.serverKey === "cc-planner")?.reserved,
    ).toBe(true);
  });
});

describe("resolveView — scope grouping and source refs", () => {
  it("preserves the discovered sourceRefs on each row for UI scope grouping", () => {
    const globalSrc = mkDefinition({
      serverKey: "chrome-devtools",
      sourceRefs: [{ scope: "global", filePath: "/cc-config/.mcp.json" }],
    });
    const view = resolveView({
      level: "project",
      overrides: chain(),
      discovered: [globalSrc],
      discoveryDiagnostics: [],
      toolInventories: {},
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
    });
    const row = view.servers.find((s) => s.serverKey === "chrome-devtools");
    expect(row?.sourceRefs).toEqual(globalSrc.sourceRefs);
  });
});

describe("resolveView — tool list view", () => {
  const def = mkDefinition({ serverKey: "kagi" });

  it("emits tools with per-tool enabled + inherited flags from inventory", () => {
    const view = resolveView({
      level: "conversation",
      overrides: chain({
        conversation: {
          servers: {
            kagi: { tools: { search: { enabled: false } } },
          },
        },
      }),
      discovered: [def],
      discoveryDiagnostics: [],
      toolInventories: { kagi: readyInventory("search", "summarize") },
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
    });
    const row = view.servers.find((s) => s.serverKey === "kagi");
    const search = row?.tools.tools.find((t) => t.name === "search");
    const summarize = row?.tools.tools.find((t) => t.name === "summarize");
    expect(search?.enabled).toBe(false);
    expect(search?.inherited).toBe(false);
    expect(search?.inheritanceStatus).toBe("disabled");
    expect(summarize?.enabled).toBe(true);
    expect(summarize?.inherited).toBe(true);
    expect(summarize?.inheritanceStatus).toBe("inherited");
    expect(row?.tools.state).toBe("ready");
  });

  it("tool override at global appears INHERITED at project/session/conversation views", () => {
    for (const level of ["project", "session", "conversation"] as const) {
      const view = resolveView({
        level,
        overrides: chain({
          global: {
            servers: {
              kagi: { tools: { search: { enabled: false } } },
            },
          },
        }),
        discovered: [def],
        discoveryDiagnostics: [],
        toolInventories: { kagi: readyInventory("search") },
        gatewayServerKeys: [],
        reservedGatewayServerKeys: [],
        pendingServerKeys: [],
      });
      const search = view.servers
        .find((s) => s.serverKey === "kagi")
        ?.tools.tools.find((t) => t.name === "search");
      expect(search?.enabled, `${level}.enabled`).toBe(false);
      expect(search?.inherited, `${level}.inherited`).toBe(true);
      expect(search?.inheritanceStatus, `${level}.status`).toBe("inherited");
    }
  });

  it("tool override AT the view level is overridden (not inherited)", () => {
    const view = resolveView({
      level: "project",
      overrides: chain({
        project: {
          servers: {
            kagi: { tools: { search: { enabled: true } } },
          },
        },
      }),
      discovered: [def],
      discoveryDiagnostics: [],
      toolInventories: { kagi: readyInventory("search") },
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
    });
    const search = view.servers
      .find((s) => s.serverKey === "kagi")
      ?.tools.tools.find((t) => t.name === "search");
    expect(search?.enabled).toBe(true);
    expect(search?.inherited).toBe(false);
    expect(search?.inheritanceStatus).toBe("overridden");
  });

  it("tool override at global appears EXPLICIT at global view", () => {
    const view = resolveView({
      level: "global",
      overrides: chain({
        global: {
          servers: {
            kagi: { tools: { search: { enabled: true } } },
          },
        },
      }),
      discovered: [def],
      discoveryDiagnostics: [],
      toolInventories: { kagi: readyInventory("search") },
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
    });
    const search = view.servers
      .find((s) => s.serverKey === "kagi")
      ?.tools.tools.find((t) => t.name === "search");
    expect(search?.enabled).toBe(true);
    expect(search?.inherited).toBe(false);
    expect(search?.inheritanceStatus).toBe("explicit");
  });

  it("tool with no override anywhere is inherited at non-global views and explicit at global view", () => {
    const projectView = resolveView({
      level: "project",
      overrides: chain(),
      discovered: [def],
      discoveryDiagnostics: [],
      toolInventories: { kagi: readyInventory("search") },
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
    });
    const searchProject = projectView.servers
      .find((s) => s.serverKey === "kagi")
      ?.tools.tools.find((t) => t.name === "search");
    expect(searchProject?.inherited).toBe(true);
    expect(searchProject?.inheritanceStatus).toBe("inherited");

    const globalView = resolveView({
      level: "global",
      overrides: chain(),
      discovered: [def],
      discoveryDiagnostics: [],
      toolInventories: { kagi: readyInventory("search") },
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
    });
    const searchGlobal = globalView.servers
      .find((s) => s.serverKey === "kagi")
      ?.tools.tools.find((t) => t.name === "search");
    expect(searchGlobal?.inherited).toBe(true);
    expect(searchGlobal?.inheritanceStatus).toBe("explicit");
  });

  it("reports tool state as not-loaded when no inventory is attached", () => {
    const view = resolveView({
      level: "conversation",
      overrides: chain(),
      discovered: [def],
      discoveryDiagnostics: [],
      toolInventories: {},
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
    });
    const row = view.servers.find((s) => s.serverKey === "kagi");
    expect(row?.tools.state).toBe("not-loaded");
    expect(row?.tools.tools).toEqual([]);
  });
});

describe("resolveView — pending indicator", () => {
  it("marks a server row pending when its serverKey is in pendingServerKeys", () => {
    const def = mkDefinition({ serverKey: "kagi" });
    const view = resolveView({
      level: "conversation",
      overrides: chain(),
      discovered: [def],
      discoveryDiagnostics: [],
      toolInventories: {},
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: ["kagi"],
    });
    expect(view.servers.find((s) => s.serverKey === "kagi")?.pending).toBe(
      true,
    );
    expect(view.pendingServerKeys).toEqual(["kagi"]);
  });
});

describe("resolveView — response-level fields", () => {
  it("forwards scope identifiers into the response", () => {
    const view = resolveView({
      level: "conversation",
      overrides: chain(),
      discovered: [],
      discoveryDiagnostics: [],
      toolInventories: {},
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
      projectName: "repo",
      sessionName: "main",
      conversationId: "c1",
    });
    expect(view.level).toBe("conversation");
    expect(view.projectName).toBe("repo");
    expect(view.sessionName).toBe("main");
    expect(view.conversationId).toBe("c1");
  });

  it("aggregates discovery diagnostics into the response", () => {
    const view = resolveView({
      level: "global",
      overrides: chain(),
      discovered: [],
      discoveryDiagnostics: [
        {
          severity: "warning",
          code: "mcp.source.malformed",
          message: "bad json",
        },
      ],
      toolInventories: {},
      gatewayServerKeys: [],
      reservedGatewayServerKeys: [],
      pendingServerKeys: [],
    });
    expect(view.diagnostics).toHaveLength(1);
  });
});
