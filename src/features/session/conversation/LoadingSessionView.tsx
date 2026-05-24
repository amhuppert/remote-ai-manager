"use client";

import Topbar from "@/components/Topbar";

export interface LoadingSessionViewProps {
  projectName: string;
  sessionName: string;
  decodedProjectName: string;
}

export default function LoadingSessionView({
  projectName,
  sessionName,
  decodedProjectName,
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
          },
          {
            label: sessionName,
            href: `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`,
            isSession: true,
          },
        ]}
      />
      <main className="main">
        <div className="empty-state">
          <div className="empty-state-title">Loading session...</div>
        </div>
      </main>
    </div>
  );
}
