"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import "@/components/workflow-graph/workflow-graph.css";
import {
  useGraphWorkflowExecutionQuery,
  useGraphWorkflowHistoryQuery,
} from "@/lib/workflows/queries";
import Topbar from "@/components/Topbar";
import WorkRailMain from "@/components/WorkRailMain";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
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

  const executionQuery = useGraphWorkflowExecutionQuery(
    projectName,
    sessionName,
  );
  const historyQuery = useGraphWorkflowHistoryQuery(projectName, sessionName);
  const hasGraphWorkflow =
    executionQuery.data != null || (historyQuery.data?.length ?? 0) > 0;

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
            isProject: true,
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

      <WorkRailMain
        projectName={decodedProjectName}
        sessionName={sessionName}
        contentClassName="flex flex-col overflow-hidden max-768:pb-[calc(56px+env(safe-area-inset-bottom,0px))]"
      >
        {executionQuery.isPending ? (
          <EmptyState>
            <EmptyStateTitle>Loading workflow...</EmptyStateTitle>
          </EmptyState>
        ) : !hasGraphWorkflow ? (
          <EmptyState>
            <EmptyStateTitle>No workflow configured</EmptyStateTitle>
            <EmptyStateDesc>
              Start a graph workflow for this session to monitor it here.
            </EmptyStateDesc>
            <Link
              href={`/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/templates`}
              className="mt-md inline-flex items-center gap-sm rounded-md border border-solid border-cyan bg-cyan px-[18px] py-[10px] font-mono text-[0.78rem] font-semibold text-text-inverse no-underline transition-all duration-150 ease-[ease] hover:bg-cyan-dim hover:shadow-[0_0_20px_var(--color-cyan-glow)]"
            >
              Browse templates
            </Link>
          </EmptyState>
        ) : (
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <ConnectedGraphWorkflowPanel
              projectName={projectName}
              sessionName={sessionName}
              isMobile={isMobile}
              mobilePanel={mobilePanel}
              autoSwitchPanel={autoSwitchPanel}
            />
          </div>
        )}
      </WorkRailMain>
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
