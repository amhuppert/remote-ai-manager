"use client";

import Topbar from "@/components/Topbar";
import WorkRailMain from "@/components/WorkRailMain";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import { useDevServerOverviewQuery } from "@/lib/dev-server/queries";
import {
  DevServerOverview,
  DevServerOverviewHeader,
} from "./DevServerOverview";
import { useDevServerOverviewActions } from "./use-dev-server-overview-actions";

export default function DevServersPage(): React.JSX.Element {
  const overview = useDevServerOverviewQuery();
  const actions = useDevServerOverviewActions();
  const projects = overview.data?.projects ?? [];
  const hasDevServers = projects.some(
    (project) => project.servers.length > 0 || project.configError !== null,
  );

  return (
    <div className="app" data-page="dev-servers">
      <Topbar
        page="dev-servers"
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          { label: "dev servers" },
        ]}
      />
      <WorkRailMain enableRailSearchHotkey={false}>
        <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-xl p-sm max-768:gap-lg max-768:p-0">
          <DevServerOverviewHeader projects={projects} />
          {overview.isPending ? (
            <EmptyState>
              <EmptyStateTitle>Loading dev servers…</EmptyStateTitle>
            </EmptyState>
          ) : overview.isError ? (
            <p role="alert" className="m-0 font-mono text-[0.75rem] text-red">
              Could not load dev servers: {overview.error.message}
            </p>
          ) : !hasDevServers ? (
            <EmptyState>
              <EmptyStateTitle>No dev servers configured</EmptyStateTitle>
              <EmptyStateDesc>
                Add a devServers entry to a project&apos;s CommandCenter.json.
              </EmptyStateDesc>
            </EmptyState>
          ) : (
            <DevServerOverview
              projects={projects}
              pendingStopIds={actions.pendingStopIds}
              notices={actions.notices}
              isStoppingUnmanaged={actions.isStoppingUnmanaged}
              onStart={actions.startServer}
              onStop={actions.stopServer}
              onDismissNotice={actions.dismissNotice}
              onStopUnmanagedAndRetry={actions.stopUnmanagedAndRetry}
            />
          )}
        </div>
      </WorkRailMain>
    </div>
  );
}
