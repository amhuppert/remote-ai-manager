"use client";

import { useParams } from "next/navigation";
import "@/components/workflow-graph/workflow-graph.css";
import "./styles/session-workflow.css";
import { useSessionQuery } from "@/lib/sessions/queries";
import { useGraphWorkflowHistoryQuery } from "@/lib/workflows/queries";
import Topbar from "@/components/Topbar";
import { useWorkflowMobilePanel } from "@/components/workflow-graph/useWorkflowMobilePanel";
import { WorkflowMobileTabBar } from "@/components/workflow-graph/WorkflowMobileTabBar";
import ConnectedGraphWorkflowPanel from "./components/ConnectedGraphWorkflowPanel";

export type ExecutionMobilePanel = "graph" | "inspector" | "log";

const executionMobileTabs = [
  { value: "graph" as const, label: "Graph" },
  { value: "inspector" as const, label: "Inspector" },
  { value: "log" as const, label: "Log" },
];

export default function SessionWorkflowPage() {
  const params = useParams<{ name: string; session: string }>();
  const projectName = params.name;
  const sessionName = decodeURIComponent(params.session);
  const decodedProjectName = decodeURIComponent(projectName);

  const sessionQuery = useSessionQuery(projectName, sessionName);
  const session = sessionQuery.data ?? null;
  const historyQuery = useGraphWorkflowHistoryQuery(projectName, sessionName);
  const hasGraphWorkflow =
    session?.graphWorkflowExecution != null ||
    (historyQuery.data?.length ?? 0) > 0;

  const { isMobile, mobilePanel, setMobilePanel, autoSwitchPanel } =
    useWorkflowMobilePanel<ExecutionMobilePanel>("graph");

  return (
    <div className="app" data-page="workflow" data-mobile-panel={mobilePanel}>
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
        {sessionQuery.isPending ? (
          <div className="empty-state">
            <div className="empty-state-title">Loading workflow...</div>
          </div>
        ) : !hasGraphWorkflow ? (
          <div className="empty-state">
            <div className="empty-state-title">No workflow configured</div>
            <div className="empty-state-desc">
              Start a graph workflow for this session to monitor it here.
            </div>
          </div>
        ) : (
          <div className="wb-execution-container">
            <ConnectedGraphWorkflowPanel
              projectName={projectName}
              sessionName={sessionName}
              isMobile={isMobile}
              mobilePanel={mobilePanel}
              autoSwitchPanel={autoSwitchPanel}
            />
          </div>
        )}
      </main>
      {isMobile && hasGraphWorkflow && (
        <WorkflowMobileTabBar<ExecutionMobilePanel>
          tabs={executionMobileTabs}
          activePanel={mobilePanel}
          onChange={setMobilePanel}
        />
      )}
    </div>
  );
}
