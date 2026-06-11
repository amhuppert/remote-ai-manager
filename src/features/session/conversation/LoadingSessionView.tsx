"use client";

import Topbar from "@/components/Topbar";

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
          <div className="empty-state-title">{title}</div>
        </div>
      </main>
    </div>
  );
}
