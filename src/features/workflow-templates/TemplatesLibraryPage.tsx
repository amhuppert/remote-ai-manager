"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import Topbar from "@/components/Topbar";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import { useProjectTemplatesQuery } from "@/lib/workflows/queries";
import { useStartGraphWorkflowMutation } from "@/lib/workflows/mutations";
import TemplateLibrary, {
  type TemplateLaunchOutcome,
  type TemplateSelection,
} from "./components/TemplateLibrary";
import { mapLaunchOutcome } from "./launch-outcome";

export default function TemplatesLibraryPage(): React.JSX.Element {
  const params = useParams<{ name: string; session: string }>();
  const projectName = params.name;
  const sessionName = decodeURIComponent(params.session);
  const decodedProjectName = decodeURIComponent(projectName);

  const sessionHref = `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`;
  const workflowHref = `${sessionHref}/workflow`;

  const templatesQuery = useProjectTemplatesQuery(projectName);
  const startMutation = useStartGraphWorkflowMutation(projectName, sessionName);

  const [selectedTemplate, setSelectedTemplate] =
    useState<TemplateSelection | null>(null);
  const [launchOutcome, setLaunchOutcome] = useState<TemplateLaunchOutcome>({
    status: "idle",
  });

  async function handleLaunch(input: {
    id: string;
    revision: number;
    tier: "project" | "global";
    parameters: Record<string, string>;
  }): Promise<void> {
    setLaunchOutcome({ status: "starting" });
    try {
      const result = await startMutation.mutateAsync({
        definitionId: input.id,
        definitionRevision: input.revision,
        tier: input.tier,
        parameters: input.parameters,
      });
      setLaunchOutcome(
        mapLaunchOutcome(
          result.kind === "started" ? { kind: "success" } : result,
        ),
      );
    } catch (error) {
      setLaunchOutcome(mapLaunchOutcome({ kind: "error", error }));
    }
  }

  return (
    <div className="app" data-page="templates">
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
            href: sessionHref,
            isSession: true,
          },
          {
            label: "Templates",
            href: `${sessionHref}/templates`,
          },
        ]}
      />

      <main className="min-h-0 w-full flex-1 overflow-auto p-lg">
        <div className="mx-auto flex max-w-[760px] flex-col gap-md">
          {templatesQuery.isPending ? (
            <EmptyState>
              <EmptyStateTitle>Loading templates...</EmptyStateTitle>
            </EmptyState>
          ) : templatesQuery.isError ? (
            <EmptyState>
              <EmptyStateIcon aria-hidden>!</EmptyStateIcon>
              <EmptyStateTitle>Could not load templates</EmptyStateTitle>
              <EmptyStateDesc>
                {templatesQuery.error instanceof Error
                  ? templatesQuery.error.message
                  : "The template library could not be loaded."}
              </EmptyStateDesc>
            </EmptyState>
          ) : (
            <>
              {(launchOutcome.status === "started" ||
                launchOutcome.status === "awaiting_approval") && (
                <div
                  role="status"
                  className={
                    launchOutcome.status === "started"
                      ? "flex flex-wrap items-center justify-between gap-sm rounded-md border border-solid border-green-dim bg-green-glow p-sm font-mono text-[0.78rem] text-green"
                      : "flex flex-wrap items-center justify-between gap-sm rounded-md border border-solid border-amber-dim bg-amber-glow p-sm font-mono text-[0.78rem] text-amber"
                  }
                >
                  <span className="font-semibold">
                    {launchOutcome.status === "started"
                      ? `Workflow started for ${sessionName}.`
                      : `Workflow parked for approval in ${sessionName}.`}
                  </span>
                  <Link
                    href={workflowHref}
                    className={
                      launchOutcome.status === "started"
                        ? "font-semibold text-green underline hover:text-green-dim!"
                        : "font-semibold text-amber underline hover:text-amber-dim!"
                    }
                  >
                    Open workflow monitor →
                  </Link>
                </div>
              )}
              <TemplateLibrary
                items={templatesQuery.data}
                selectedTemplate={selectedTemplate}
                onSelectTemplate={setSelectedTemplate}
                launchOutcome={launchOutcome}
                onLaunch={(input) => {
                  void handleLaunch(input);
                }}
              />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
