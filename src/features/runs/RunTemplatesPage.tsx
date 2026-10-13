"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Topbar from "@/components/Topbar";
import { failedRead, ReadFailure } from "@/components/runs/ReadFailure";
import { useRunTemplateLibraryQuery } from "@/lib/run-templates/queries";
import type { RunTemplateSummary } from "@/lib/run-templates/schemas";
import { runTemplateHref, runTemplatesHref } from "@/lib/runs/hrefs";
import { TemplateLibrary } from "./components/template/TemplateLibrary";
import { TemplateLaunchDialog } from "./TemplateLaunch";

/** The breadcrumbs above a session's run template pages; the editor's heading names its template. */
export function runTemplateBreadcrumbs(
  projectName: string,
  sessionName: string,
) {
  return [
    { label: "projects", href: "/projects" },
    {
      label: projectName,
      href: `/projects/${encodeURIComponent(projectName)}`,
      isProject: true,
    },
    {
      label: sessionName,
      href: `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`,
      isSession: true,
    },
    // One crumb for the library keeps the bar on one line beside its actions.
    {
      label: "Templates",
      href: runTemplatesHref(projectName, sessionName),
    },
  ];
}

/** A session's run templates: the project's and the global ones, to configure or launch here. */
export default function RunTemplatesPage() {
  const params = useParams<{ name: string; session: string }>();
  const projectName = decodeURIComponent(params.name);
  const sessionName = decodeURIComponent(params.session);
  const router = useRouter();
  const library = useRunTemplateLibraryQuery(projectName);
  const read = failedRead(library);
  const [launching, setLaunching] = useState<RunTemplateSummary | null>(null);

  return (
    <div className="app" data-page="run-templates">
      <Topbar
        page="detail"
        breadcrumbs={runTemplateBreadcrumbs(projectName, sessionName)}
      />
      <main className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto bg-bg-void">
        {read.failed ? (
          <div className="mx-auto w-full max-w-[1080px] px-2xl py-2xl max-768:px-lg">
            <ReadFailure
              message="Could not load run templates."
              retrying={read.retrying}
              onRetry={() => void library.refetch()}
            />
          </div>
        ) : library.data === undefined ? (
          <p
            role="status"
            className="mx-auto my-0 w-full max-w-[1080px] px-2xl py-2xl font-mono text-[0.75rem] text-text-tertiary max-768:px-lg"
          >
            Loading run templates…
          </p>
        ) : (
          <TemplateLibrary
            templates={library.data.items}
            diagnostics={library.data.diagnostics}
            onConfigure={(template) =>
              router.push(
                runTemplateHref(
                  projectName,
                  sessionName,
                  template.tier,
                  template.id,
                ),
              )
            }
            onLaunch={setLaunching}
          />
        )}
      </main>
      <TemplateLaunchDialog
        projectName={projectName}
        sessionName={sessionName}
        template={launching}
        onClose={() => setLaunching(null)}
      />
    </div>
  );
}
