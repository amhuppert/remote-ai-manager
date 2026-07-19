"use client";

import Topbar from "@/components/Topbar";
import { EmptyState, EmptyStateTitle } from "@/components/ui/EmptyState";

export interface LoadingSessionViewProps {
  projectName: string;
  sessionName: string;
  decodedProjectName: string;
  /** Empty-state headline; also covers terminal states like "Session not found.". */
  title?: string;
}

export default function LoadingSessionView({
  projectName,
  sessionName,
  decodedProjectName,
  title = "Loading session...",
}: LoadingSessionViewProps): React.JSX.Element {
  return (
    <div className="app" data-page="detail">
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
        ]}
      />
      <main className="main">
        <EmptyState>
          <EmptyStateTitle>{title}</EmptyStateTitle>
        </EmptyState>
      </main>
    </div>
  );
}
