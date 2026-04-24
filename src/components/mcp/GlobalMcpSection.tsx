"use client";

import { useMemo } from "react";

import { useGlobalMcpConfigQuery } from "@/lib/queries";

import McpGlobalSection from "./McpGlobalSection";
import { adaptServerViewsForLevel } from "./view-adapter";
import { useMcpActions } from "./use-mcp-actions";

/**
 * Container for the global MCP section embedded into the system configuration
 * page. Wires the `/api/config/mcp` query + mutation pair into the existing
 * presentational section.
 */
export default function GlobalMcpSection(): React.JSX.Element {
  const query = useGlobalMcpConfigQuery();

  const servers = useMemo(() => {
    if (!query.data) return [];
    return adaptServerViewsForLevel(query.data, "global");
  }, [query.data]);

  const actions = useMcpActions({ level: "global" }, servers);

  const notice = query.isError ? (
    <span>
      Failed to load MCP servers: {query.error?.message ?? "unknown error"}
    </span>
  ) : query.isPending ? (
    <span>Loading MCP servers from Command Center .mcp.json…</span>
  ) : undefined;

  return (
    <McpGlobalSection servers={servers} actions={actions} notice={notice} />
  );
}
