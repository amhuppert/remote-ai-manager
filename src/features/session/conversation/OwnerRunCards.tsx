"use client";

import type { RunSummary } from "@/components/runs/model";
import { failedRead, ReadFailure } from "@/components/runs/ReadFailure";
import { OwnedRunsRegion, OwnerRunCard } from "@/components/runs/RunCards";
import { runsPageHref } from "@/lib/runs/hrefs";
import { useRunControlMutation } from "@/lib/runs/mutations";
import { useRunPageQuery, useSessionRunsQuery } from "@/lib/runs/queries";

interface Place {
  projectName: string;
  sessionName: string;
}

function OwnedRun({
  projectName,
  sessionName,
  run,
}: Place & { run: RunSummary }) {
  // What needs the person is listed on the run's page; a run needing nothing reads none.
  const page = useRunPageQuery(
    projectName,
    sessionName,
    run.attention > 0 ? run.runId : null,
  );
  const control = useRunControlMutation(projectName, sessionName);
  const read = failedRead(page);
  return (
    <OwnerRunCard
      run={run}
      attention={page.data?.attention ?? []}
      hrefOf={(contextKey) =>
        runsPageHref(projectName, sessionName, run.runId, contextKey)
      }
      onControl={async (request) => {
        await control.mutateAsync({ runId: run.runId, control: request });
      }}
      readFailure={
        read.failed ? (
          <ReadFailure
            message="Could not read what this run needs."
            retrying={read.retrying}
            onRetry={() => void page.refetch()}
          />
        ) : undefined
      }
    />
  );
}

/**
 * The runs a conversation owns and that are still going, above its composer,
 * those that need the person first: what each needs, acted on in place or on
 * the run page.
 */
export function OwnerRunCards({
  projectName,
  sessionName,
  conversationId,
}: Place & { conversationId: string }) {
  const runs = useSessionRunsQuery(projectName, sessionName);
  const read = failedRead(runs);
  const owned = (runs.data ?? [])
    .filter(
      (run) =>
        run.owner.conversationId === conversationId && run.finishedAt === null,
    )
    .sort((a, b) => Number(b.attention > 0) - Number(a.attention > 0));
  // A failed read matters here only where it may hide this conversation's runs.
  const hiding = read.failed && (runs.data === undefined || owned.length > 0);
  if (owned.length === 0 && !hiding) return null;
  return (
    <OwnedRunsRegion>
      {hiding ? (
        <ReadFailure
          message="Could not load this conversation's runs."
          retrying={read.retrying}
          onRetry={() => void runs.refetch()}
        />
      ) : null}
      {owned.map((run) => (
        <OwnedRun
          key={run.runId}
          projectName={projectName}
          sessionName={sessionName}
          run={run}
        />
      ))}
    </OwnedRunsRegion>
  );
}
