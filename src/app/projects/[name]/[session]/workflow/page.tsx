"use client";

import { useParams } from "next/navigation";
import "@/components/workflow-graph/workflow-graph.css";
import { useSessionQuery, useWorkflowQuery } from "@/lib/queries";
import Topbar from "@/components/Topbar";
import ConnectedWorkflowPanel from "./ConnectedWorkflowPanel";
import ConnectedGraphWorkflowPanel from "./ConnectedGraphWorkflowPanel";

export default function WorkflowPage() {
  const params = useParams<{ name: string; session: string }>();
  const projectName = params.name;
  const sessionName = decodeURIComponent(params.session);
  const decodedProjectName = decodeURIComponent(projectName);

  const workflowQuery = useWorkflowQuery(projectName, sessionName);
  const workflow = workflowQuery.data ?? null;
  const sessionQuery = useSessionQuery(projectName, sessionName);
  const session = sessionQuery.data ?? null;
  const hasGraphWorkflow =
    session?.graphWorkflowExecution != null ||
    (session?.graphWorkflowExecutionHistory.length ?? 0) > 0;

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
        {workflowQuery.isPending || sessionQuery.isPending ? (
          <div className="empty-state">
            <div className="empty-state-title">Loading workflow...</div>
          </div>
        ) : workflow == null && !hasGraphWorkflow ? (
          <div className="empty-state">
            <div className="empty-state-title">No workflow configured</div>
            <div className="empty-state-desc">
              Start a Ralph Loop or graph workflow for this session to monitor
              it here.
            </div>
          </div>
        ) : (
          <div className="wb-execution-container">
            {workflow ? (
              <ConnectedWorkflowPanel
                projectName={projectName}
                sessionName={sessionName}
              />
            ) : null}
            {hasGraphWorkflow ? (
              <ConnectedGraphWorkflowPanel
                projectName={projectName}
                sessionName={sessionName}
              />
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}
