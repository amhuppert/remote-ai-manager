"use client";

import { useMemo, useState } from "react";

import { useProjectMcpConfigQuery } from "@/lib/queries";

import McpServersModal from "./McpServersModal";
import { adaptServerViewsForLevel } from "./view-adapter";
import { useMcpActions } from "./use-mcp-actions";

interface ProjectMcpButtonProps {
  projectName: string;
}

/**
 * Button that lives on the project actions bar and opens the shared MCP
 * servers modal wired to the project-level query + mutations. Overrides here
 * cascade into every session (and every conversation within those sessions)
 * that does not declare its own override.
 */
export default function ProjectMcpButton({
  projectName,
}: ProjectMcpButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  const query = useProjectMcpConfigQuery(projectName, { enabled: open });

  const servers = useMemo(() => {
    if (!query.data) return [];
    return adaptServerViewsForLevel(query.data, "project");
  }, [query.data]);

  const actions = useMcpActions({ level: "project", projectName }, servers);

  const overrideCount = servers.filter(
    (s) => s.status.kind === "overridden" || s.status.kind === "disabled",
  ).length;

  return (
    <>
      <button
        type="button"
        className={`btn btn-sm${overrideCount > 0 ? " has-overrides" : ""}`}
        onClick={() => setOpen(true)}
        title={
          overrideCount > 0
            ? `MCP servers — ${overrideCount} override${overrideCount === 1 ? "" : "s"} at project`
            : "MCP servers"
        }
      >
        MCP
        {overrideCount > 0 ? (
          <span className="btn-badge">{overrideCount}</span>
        ) : null}
      </button>
      <McpServersModal
        open={open}
        onClose={() => setOpen(false)}
        viewLevel="project"
        servers={servers}
        actions={actions}
        title="Project MCP configuration"
        subtitle={projectName}
        banner={
          <span>
            Project-level overrides apply to every session in this project.
          </span>
        }
      />
    </>
  );
}
