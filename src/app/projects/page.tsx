import { discoverProjects } from "@/lib/discovery";
import { readConfig } from "@/lib/config";
import { detectHooksStatus } from "@/lib/hooks";
import { getArchivedProjects } from "@/lib/state";
import Topbar from "@/components/Topbar";
import ProjectsGridClient from "./ProjectsGridClient";

export const dynamic = "force-dynamic";

export default async function ProjectsPage(): Promise<React.JSX.Element> {
  const [projects, config, hooksStatus, archivedSet] = await Promise.all([
    discoverProjects(),
    readConfig(),
    detectHooksStatus(),
    getArchivedProjects(),
  ]);

  const projectCount = projects.length;
  const subtitle = `${config.baseDir} — ${projectCount} ${projectCount === 1 ? "repository" : "repositories"} discovered`;

  const runningCount = projects.filter((p) => p.hasRunningSession).length;

  return (
    <div className="app" data-page="projects">
      <Topbar
        page="projects"
        breadcrumbs={[{ label: "projects", href: "/projects" }]}
        globalStatus={
          <>
            <div className="status-indicator">
              <div
                className={`status-dot${hooksStatus.installed ? "" : " warning"}`}
              />
              {hooksStatus.installed ? "hooks active" : "hooks missing"}
            </div>
            {runningCount > 0 && (
              <div className="status-indicator">
                <div className="status-dot warning" />
                {runningCount} session{runningCount !== 1 ? "s" : ""} running
              </div>
            )}
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
              {!hooksStatus.hasUserPromptSubmit && !hooksStatus.hasStop
                ? " Both UserPromptSubmit and Stop hooks are missing."
                : !hooksStatus.hasUserPromptSubmit
                  ? " UserPromptSubmit hook is missing."
                  : " Stop hook is missing."}
            </span>
          </div>
        )}

        <div className="page-header stagger-in">
          <h1 className="page-title">
            Ground <span className="accent">Control</span>
          </h1>
          <p className="page-subtitle">{subtitle}</p>
        </div>

        {projectCount > 0 ? (
          <ProjectsGridClient
            projects={projects}
            archivedPaths={[...archivedSet]}
          />
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">&#128269;</div>
            <div className="empty-state-title">No projects discovered</div>
            <div className="empty-state-desc">
              No git repositories found in {config.baseDir}. Ensure the base
              directory is configured correctly and contains repositories.
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
