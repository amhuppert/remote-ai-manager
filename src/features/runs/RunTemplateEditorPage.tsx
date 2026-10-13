"use client";

import { useId, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Topbar from "@/components/Topbar";
import { RefreshIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { failedRead, ReadFailure } from "@/components/runs/ReadFailure";
import { useProjectModelOptionsQuery } from "@/lib/agent-backends/queries";
import { useAgentProfileLibrary } from "@/lib/agent-profiles/queries";
import { useSaveRunTemplateMutation } from "@/lib/run-templates/mutations";
import {
  useRunTemplateLibraryQuery,
  useRunTemplateQuery,
} from "@/lib/run-templates/queries";
import { runTemplateHref } from "@/lib/runs/hrefs";
import {
  runTemplateTierSchema,
  type RunTemplateTier,
} from "@/lib/runs/schemas";
import { useValidationCommandOptions } from "@/lib/validation/queries";
import type { LaunchableTemplate } from "./components/template/LaunchDialog";
import {
  TemplateEditor,
  type TemplateEditorActions,
} from "./components/template/TemplateEditor";
import { runTemplateBreadcrumbs } from "./RunTemplatesPage";
import { TemplateLaunchDialog } from "./TemplateLaunch";

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1080px] px-2xl py-2xl max-768:px-lg">
      {children}
    </div>
  );
}

/** What the page tracks of one read the editor needs. */
interface TrackedRead {
  what: string;
  query: {
    data: unknown;
    error: unknown;
    isError: boolean;
    isPending: boolean;
    isFetching: boolean;
    errorUpdateCount: number;
    refetch(): Promise<unknown>;
  };
}

/** A refresh that failed while the editor holds an earlier read: the editor stays, with its draft. */
function RefreshFailure({
  what,
  error,
  retrying,
  onRetry,
}: {
  what: string;
  error: unknown;
  retrying: boolean;
  onRetry(): void;
}) {
  const id = useId();
  return (
    <div
      role="alert"
      aria-labelledby={id}
      className="flex shrink-0 flex-wrap items-center gap-md border-x-0 border-t-0 border-b border-solid border-[var(--cc-amber-a25)] bg-bg-surface px-2xl py-sm font-mono text-[0.72rem] leading-relaxed text-text-secondary max-768:px-lg"
    >
      <span className="min-w-0 flex-1">
        <span id={id} className="text-amber">
          Could not refresh {what}.
        </span>{" "}
        {error instanceof Error ? `${error.message}. ` : ""}Showing the last
        version read; unsaved edits are kept.
      </span>
      <Button size="sm" loading={retrying} onClick={onRetry}>
        <RefreshIcon size={13} />
        Retry
      </Button>
    </div>
  );
}

function Editor({
  projectName,
  sessionName,
  tier,
  id,
}: {
  projectName: string;
  sessionName: string;
  tier: RunTemplateTier;
  id: string;
}) {
  const router = useRouter();
  const detail = useRunTemplateQuery(projectName, tier, id);
  const library = useRunTemplateLibraryQuery(projectName);
  const models = useProjectModelOptionsQuery(projectName);
  // A global template is every project's, so it may name only profiles every project has.
  const profiles = useAgentProfileLibrary(
    tier === "global" ? null : projectName,
  );
  // Checks are offered from this project; the launch verifies them where the template runs.
  const checks = useValidationCommandOptions(projectName);
  const save = useSaveRunTemplateMutation(projectName);
  const [launching, setLaunching] = useState<LaunchableTemplate | null>(null);
  const options = useMemo(
    () => ({
      models: models.data ?? [],
      profiles: profiles.data?.profiles ?? [],
      checks: (checks ?? []).map((command) => command.name),
    }),
    [models.data, profiles.data, checks],
  );

  // Seats name backends and profiles, so the editor needs all three reads
  // before it opens. A first read that failed is an error with a retry; a
  // later refresh that fails keeps what was read and the editor's draft.
  const reads: TrackedRead[] = [
    { what: "the template", query: detail },
    { what: "the model options", query: models },
    { what: "the agent profiles", query: profiles },
  ];
  const unread = reads.filter(({ query }) => query.data === undefined);
  const failedFirst = unread.filter(({ query }) => failedRead(query).failed);
  if (failedFirst.length > 0)
    return (
      <Notice>
        <ReadFailure
          message={failedFirst
            .map(
              ({ what, query }) =>
                `Could not load ${what}${query.error instanceof Error ? `: ${query.error.message}` : ""}.`,
            )
            .join(" ")}
          retrying={failedFirst.some(({ query }) => query.isFetching)}
          onRetry={() => {
            for (const { query } of failedFirst) void query.refetch();
          }}
        />
      </Notice>
    );
  if (detail.data === undefined || unread.length > 0)
    return (
      <Notice>
        <p
          role="status"
          className="m-0 font-mono text-[0.75rem] text-text-tertiary"
        >
          Loading the template…
        </p>
      </Notice>
    );

  const stale = reads.filter(({ query }) => query.isError);
  const actions: TemplateEditorActions = {
    onSelectTemplate: (summary) =>
      router.push(
        runTemplateHref(projectName, sessionName, summary.tier, summary.id),
      ),
    // A failed read rejects, so the editor keeps its draft and conflict instead of taking cached data as the latest.
    onReload: async () => {
      const latest = await detail.refetch({ throwOnError: true });
      if (latest.data === undefined)
        throw new Error("Could not reload the template.");
      return latest.data.template;
    },
    onSave: (template, baseRevision) =>
      save.mutateAsync({ tier, id, expectedRevision: baseRevision, template }),
    onLaunch: (template) =>
      setLaunching({
        tier,
        id: template.id,
        name: template.name,
        revision: template.revision,
        parameters: template.parameters,
        contexts: template.workflow.contexts.length,
      }),
  };

  return (
    <>
      {stale.length > 0 ? (
        <RefreshFailure
          what={stale.map(({ what }) => what).join(", ")}
          error={stale[0]?.query.error}
          retrying={stale.some(({ query }) => query.isFetching)}
          onRetry={() => {
            for (const { query } of stale) void query.refetch();
          }}
        />
      ) : null}
      <div className="flex min-h-0 flex-1">
        <TemplateEditor
          templates={library.data?.items ?? []}
          template={detail.data.template}
          tier={tier}
          globals={detail.data.globals}
          options={options}
          actions={actions}
        />
      </div>
      <TemplateLaunchDialog
        projectName={projectName}
        sessionName={sessionName}
        template={launching}
        onClose={() => setLaunching(null)}
      />
    </>
  );
}

/** One run template, edited as forms and launched from this session. */
export default function RunTemplateEditorPage() {
  const params = useParams<{
    name: string;
    session: string;
    tier: string;
    id: string;
  }>();
  const projectName = decodeURIComponent(params.name);
  const sessionName = decodeURIComponent(params.session);
  const id = decodeURIComponent(params.id);
  const tier = runTemplateTierSchema.safeParse(params.tier);
  return (
    <div className="app" data-page="run-template">
      <Topbar
        page="detail"
        breadcrumbs={runTemplateBreadcrumbs(projectName, sessionName)}
      />
      <main className="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-bg-void">
        {tier.success ? (
          <Editor
            projectName={projectName}
            sessionName={sessionName}
            tier={tier.data}
            id={id}
          />
        ) : (
          <Notice>
            <p
              role="alert"
              className="m-0 font-mono text-[0.75rem] text-red-text"
            >
              No run template tier is called “{params.tier}”: use project or
              global.
            </p>
          </Notice>
        )}
      </main>
    </div>
  );
}
