import Topbar from "@/components/Topbar";

import AgentsLibraryPage from "./AgentsLibraryPage";

interface AgentsLibraryRouteProps {
  params: Promise<{ name: string }>;
}

/**
 * `/projects/[name]/agents` — the profile library's management surface.
 *
 * Mounted inside a project because the page shows all three scopes at once and
 * the project tier only exists to be listed when a project is in scope; the
 * route tree is what puts it there (`library.list(projectPath)`).
 */
export default async function AgentsLibraryRoute({
  params,
}: AgentsLibraryRouteProps): Promise<React.JSX.Element> {
  const { name } = await params;
  const decodedProjectName = decodeURIComponent(name);

  return (
    <div className="app" data-page="agents">
      <Topbar
        page="detail"
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          {
            label: decodedProjectName,
            href: `/projects/${encodeURIComponent(name)}`,
            isProject: true,
          },
          {
            label: "Agents",
            href: `/projects/${encodeURIComponent(name)}/agents`,
          },
        ]}
      />
      <main className="min-h-0 w-full flex-1 overflow-auto">
        <AgentsLibraryPage projectName={name} />
      </main>
    </div>
  );
}
