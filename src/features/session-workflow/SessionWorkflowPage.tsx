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
import { IconButton } from "@/components/ui/IconButton";
import { ChevronRightIcon } from "@/components/workflow-config-panel/icons";
import { RailOverlaySpacer } from "@/components/workflow-graph/RailOverlay";
import { useWorkflowMobilePanel } from "@/components/workflow-graph/useWorkflowMobilePanel";
import { useWorkflowRailCollapse } from "@/components/workflow-graph/useWorkflowRailCollapse";
import { WorkflowMobileTabBar } from "@/components/workflow-graph/WorkflowMobileTabBar";
import ConnectedGraphWorkflowPanel from "./components/ConnectedGraphWorkflowPanel";
import ArchivedExecutionsList from "./components/ArchivedExecutionsList";
import { partitionExecutionRail } from "./components/execution-rail";
import { useSessionQuery } from "@/lib/sessions/queries";

export type ExecutionMobilePanel = "graph" | "inspector" | "log";

const executionMobileTabs = [
  { value: "graph" as const, label: "Graph", icon: "graph" as const },
  { value: "inspector" as const, label: "Inspector", icon: "panel" as const },
  { value: "log" as const, label: "Log", icon: "log" as const },
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

  // The chip states which run is on screen and whether it still holds the
  // lease. Tenure is the rail's split, so it is read from the same partition
  // the rail renders rather than re-derived from status — a paused or resumably
  // halted run is Current, and terminality is not the question.
  const rail = useMemo(
    () =>
      partitionExecutionRail(
        executionQuery.data === undefined || executionQuery.data === null
          ? null
          : { ...executionQuery.data, executionId: executionQuery.data.id },
        history,
      ),
    [executionQuery.data, history],
  );
  const executionChipLabel =
    selectedExecutionId === null
      ? undefined
      : `${selectedExecutionId.slice(0, 8)} · ${
          rail.current?.executionId === selectedExecutionId
            ? "Current"
            : "History"
        }`;
  const selectedDefinition =
    selectedExecutionId === executionQuery.data?.id
      ? {
          id: executionQuery.data.seedDefinitionId,
          revision: executionQuery.data.seedDefinitionRevision,
        }
      : (() => {
          const selected = history.find(
            (item) => item.executionId === selectedExecutionId,
          );
          return selected
            ? {
                id: selected.definitionId,
                revision: selected.definitionRevision,
              }
            : null;
        })();

  const renderExecutionsSheet = useCallback(
    (close: () => void) => (
      <ArchivedExecutionsList
        presentation="sheet"
        projectName={projectName}
        sessionName={sessionName}
        current={executionQuery.data ?? null}
        executions={history}
        sessionConversationIds={sessionConversationIds}
        selectedExecutionId={selectedExecutionId}
        onSelect={(executionId) => {
          // M2: one act — dismiss the sheet, put the chosen run on the graph,
          // and write it to the URL so the choice survives a reload and a share.
          close();
          autoSwitchPanel("graph");
          handleSelectExecution(executionId);
        }}
      />
    ),
    [
      autoSwitchPanel,
      executionQuery.data,
      handleSelectExecution,
      history,
      projectName,
      selectedExecutionId,
      sessionConversationIds,
      sessionName,
    ],
  );
  // The rail collapses to a strip that keeps its own way back (§12); the page
  // owns the state because the strip replaces the rail in the page's grid.
  const {
    collapsed: executionsRailCollapsed,
    setCollapsed: setExecutionsRailCollapsed,
    overlay: executionsRailOverlay,
  } = useWorkflowRailCollapse();

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
        contentClassName="flex flex-col overflow-hidden max-768:pb-[calc(64px+env(safe-area-inset-bottom,0px))]"
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
              className="mt-md inline-flex items-center gap-sm rounded-md border border-solid border-cyan bg-cyan px-[18px] py-[10px] font-mono text-[0.78rem] font-semibold text-text-inverse no-underline transition-all duration-150 ease-[ease] hover:bg-cyan-dim hover:shadow-[0_0_20px_var(--color-cyan-glow)] max-768:min-h-[44px]"
            >
              Browse templates
            </Link>
          </EmptyState>
        ) : (
          <div className="relative flex h-full min-h-0 overflow-hidden max-768:flex-col">
            {executionsRailOverlay && (
              <RailOverlaySpacer side="left" stripWidth="36" />
            )}
            {isMobile ? null : executionsRailCollapsed ? (
              <div className="flex w-[36px] shrink-0 flex-col items-center border-y-0 border-r border-l-0 border-solid border-border-subtle bg-bg-base py-sm max-768:hidden">
                <IconButton
                  variant="square"
                  aria-label="Expand executions rail"
                  title="Expand executions rail"
                  onClick={() => setExecutionsRailCollapsed(false)}
                >
                  <ChevronRightIcon />
                </IconButton>
              </div>
            ) : (
              <ArchivedExecutionsList
                projectName={projectName}
                sessionName={sessionName}
                current={executionQuery.data ?? null}
                executions={history}
                sessionConversationIds={sessionConversationIds}
                selectedExecutionId={selectedExecutionId}
                onSelect={handleSelectExecution}
                overlay={executionsRailOverlay}
                {...(isMobile
                  ? {}
                  : { onCollapse: () => setExecutionsRailCollapsed(true) })}
              />
            )}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {selectedDefinition?.id != null && (
                <div className="flex min-h-[36px] shrink-0 items-center justify-end border-x-0 border-t-0 border-b border-solid border-border-dim bg-bg-base px-md font-mono text-[0.68rem] text-text-tertiary">
                  <Link
                    href={`/projects/${encodeURIComponent(projectName)}/workflows?definition=${encodeURIComponent(selectedDefinition.id)}`}
                    className="font-semibold text-cyan no-underline hover:underline"
                  >
                    Source definition
                  </Link>
                  <span className="ml-xs">r{selectedDefinition.revision}</span>
                </div>
              )}
              <ConnectedGraphWorkflowPanel
                projectName={projectName}
                sessionName={sessionName}
                selectedExecutionId={selectedExecutionId}
                isMobile={isMobile}
                mobilePanel={mobilePanel}
                autoSwitchPanel={autoSwitchPanel}
                {...(executionChipLabel === undefined
                  ? {}
                  : { executionChipLabel })}
                renderExecutionsSheet={renderExecutionsSheet}
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
          label="Execution panels"
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
