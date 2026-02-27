"use client";

import { useParams } from "next/navigation";
import { useWorkflowQuery } from "@/lib/queries";
import Topbar from "@/components/Topbar";
import ConnectedWorkflowPanel from "./ConnectedWorkflowPanel";

export default function WorkflowPage() {
  const params = useParams<{ name: string; session: string }>();
  const projectName = params.name;
  const sessionName = decodeURIComponent(params.session);
  const decodedProjectName = decodeURIComponent(projectName);

  const workflowQuery = useWorkflowQuery(projectName, sessionName);
  const workflow = workflowQuery.data ?? null;

  return (
    <div className="app" data-page="workflow">
      <Topbar
        page="detail"
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          {
            label: decodedProjectName,
            href: `/projects/${encodeURIComponent(projectName)}`,
          },
          {
            label: sessionName,
            href: `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`,
            isSession: true,
          },
          {
            label: "Workflow",
            href: `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/workflow`,
          },
        ]}
      />

      <main className="main">
        {workflowQuery.isPending ? (
          <div className="empty-state">
            <div className="empty-state-title">Loading workflow...</div>
          </div>
        ) : workflow == null ? (
          <div className="empty-state">
            <div className="empty-state-title">No workflow configured</div>
            <div className="empty-state-desc">
              Start a Ralph Loop workflow from any conversation by asking
              Claude.
            </div>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              minHeight: 0,
              overflow: "auto",
            }}
          >
            <ConnectedWorkflowPanel
              projectName={projectName}
              sessionName={sessionName}
            />
          </div>
        )}
      </main>
    </div>
  );
}
