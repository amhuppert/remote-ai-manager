import { notFound } from "next/navigation";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getProjectSessions } from "@/lib/state";
import { detectHooksStatus } from "@/lib/hooks";
import Topbar from "@/components/Topbar";
import SessionsList from "./SessionsList";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ name: string }>;
}

export default async function SessionsPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { name } = await params;
  const projectPath = await resolveProjectPath(name);

  if (!projectPath) {
    notFound();
  }

  const [sessions, hooksStatus] = await Promise.all([
    getProjectSessions(projectPath),
    detectHooksStatus(),
  ]);
  const activeSessions = sessions.filter((s) => !s.archived);

  return (
    <div className="app" data-page="sessions">
      <Topbar
        page="sessions"
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          {
            label: decodeURIComponent(name),
            href: `/projects/${encodeURIComponent(name)}`,
          },
        ]}
        globalStatus={
          <>
            <div className="status-indicator">
              <div
                className={`status-dot${hooksStatus.installed ? "" : " warning"}`}
              />
              {hooksStatus.installed ? "hooks active" : "hooks missing"}
            </div>
          </>
        }
      />
      <main className="main">
        {!hooksStatus.installed && (
          <div className="hooks-banner">
            <span className="banner-icon">&#9888;</span>
            <span className="banner-text">
              Claude Code hooks are not configured. Session transcripts and
              metadata will not be captured automatically.
            </span>
          </div>
        )}

        <div className="page-header stagger-in">
          <h1 className="page-title">{decodeURIComponent(name)}</h1>
          <p className="page-subtitle">
            {projectPath} &mdash; {activeSessions.length} session
            {activeSessions.length !== 1 ? "s" : ""}
          </p>
        </div>

        <SessionsList projectName={name} initialSessions={activeSessions} />
      </main>
    </div>
  );
}
