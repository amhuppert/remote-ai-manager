"use client";

import { SessionRunsCard } from "@/components/runs/RunCards";
import { failedRead, ReadFailure } from "@/components/runs/ReadFailure";
import { runsPageHref } from "@/lib/runs/hrefs";
import { useSessionRunsQuery } from "@/lib/runs/queries";

/** The session's runs on its overview, each a way into the run page. */
export function SessionRuns({
  projectName,
  sessionName,
}: {
  projectName: string;
  sessionName: string;
}) {
  const runs = useSessionRunsQuery(projectName, sessionName);
  const read = failedRead(runs);
  if (read.failed)
    return (
      <ReadFailure
        message="Could not load runs."
        retrying={read.retrying}
        onRetry={() => void runs.refetch()}
      />
    );
  if (runs.data === undefined) return null;
  return (
    <SessionRunsCard
      runs={runs.data}
      hrefOf={(runId) => runsPageHref(projectName, sessionName, runId)}
    />
  );
}
