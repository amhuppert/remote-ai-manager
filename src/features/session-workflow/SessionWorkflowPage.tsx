"use client";

import Link from "next/link";
import { Suspense, useCallback, useMemo } from "react";
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
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
import ArchivedExecutionsList from "./components/ArchivedExecutionsList";
import { useSessionQuery } from "@/lib/sessions/queries";

export type ExecutionMobilePanel = "graph" | "inspector" | "log";

const executionMobileTabs = [
  { value: "graph" as const, label: "Graph" },
  { value: "inspector" as const, label: "Inspector" },
  { value: "log" as const, label: "Log" },
];

function SessionWorkflowPageContent() {
  const params = useParams<{ name: string; session: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectName = params.name;
  const sessionName = decodeURIComponent(params.session);
  const decodedProjectName = decodeURIComponent(projectName);

  const executionQuery = useGraphWorkflowExecutionQuery(
    projectName,
    sessionName,
  );
  const historyQuery = useGraphWorkflowHistoryQuery(projectName, sessionName);
  const sessionQuery = useSessionQuery(projectName, sessionName);
  const sessionConversationIds = useMemo<ReadonlySet<string> | null>(
    () =>
      sessionQuery.data === undefined
        ? null
        : new Set(
            sessionQuery.data.conversations.map(
              (conversation) => conversation.id,
            ),
          ),
    [sessionQuery.data],
  );
  const history = useMemo(
    () =>
      [...(historyQuery.data ?? [])].sort(
        (left, right) =>
          Date.parse(right.startedAt) - Date.parse(left.startedAt),
      ),
    [historyQuery.data],
  );
  const explicitExecutionId = searchParams.get("execution")?.trim() || null;
  const selectedExecutionId =
    explicitExecutionId ??
    executionQuery.data?.id ??
    history[0]?.executionId ??
    null;
  const hasGraphWorkflow =
    explicitExecutionId !== null ||
    executionQuery.data != null ||
    history.length > 0;
  const handleSelectExecution = useCallback(
    (executionId: string) => {
      const next = new URLSearchParams(searchParams.toString());
      next.set("execution", executionId);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

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
        {executionQuery.isPending &&
        historyQuery.isPending &&
        explicitExecutionId === null ? (
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
          <div className="flex h-full min-h-0 overflow-hidden max-768:flex-col">
            <ArchivedExecutionsList
              projectName={projectName}
              sessionName={sessionName}
              current={executionQuery.data ?? null}
              executions={history}
              sessionConversationIds={sessionConversationIds}
              selectedExecutionId={selectedExecutionId}
              onSelect={handleSelectExecution}
            />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <ConnectedGraphWorkflowPanel
                projectName={projectName}
                sessionName={sessionName}
                selectedExecutionId={selectedExecutionId}
                isMobile={isMobile}
                mobilePanel={mobilePanel}
                autoSwitchPanel={autoSwitchPanel}
              />
            </div>
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

export default function SessionWorkflowPage() {
  return (
    <Suspense
      fallback={
        <EmptyState>
          <EmptyStateTitle>Loading workflow...</EmptyStateTitle>
        </EmptyState>
      }
    >
      <SessionWorkflowPageContent />
    </Suspense>
  );
}
