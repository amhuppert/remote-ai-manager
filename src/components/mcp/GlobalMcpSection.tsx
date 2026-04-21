"use client";

import { useMemo, useState } from "react";

import { useGlobalMcpConfigQuery } from "@/lib/queries";

import McpGlobalSection from "./McpGlobalSection";
import { adaptServerViewsForLevel } from "./view-adapter";
import { useMcpActions } from "./use-mcp-actions";
import type { McpBackendId } from "./types";

/**
 * Container for the global MCP section embedded into the system configuration
 * page. Wires the `/api/config/mcp` query + mutation pair into the existing
 * presentational section.
 */
export default function GlobalMcpSection(): React.JSX.Element {
  const [backendFilter, setBackendFilter] = useState<McpBackendId | "all">(
    "all",
  );

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
    <span>Loading MCP servers from user-level config files…</span>
  ) : undefined;

  return (
    <McpGlobalSection
      servers={servers}
      actions={actions}
      backendFilter={backendFilter}
      onBackendFilterChange={setBackendFilter}
      notice={notice}
    />
  );
}
