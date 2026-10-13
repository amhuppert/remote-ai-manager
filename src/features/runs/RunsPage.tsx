"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Topbar from "@/components/Topbar";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import { runsPageHref, runTemplatesHref } from "@/lib/runs/hrefs";
import {
  useRunControlMutation,
  useRunDecisionMutation,
} from "@/lib/runs/mutations";
import { useRunPageQuery, useSessionRunsQuery } from "@/lib/runs/queries";
import { dispositionOf, invocationIdOf } from "./actions";
import { RunPage, type RunPageActions } from "./components/RunPage";
import type { RunSummary } from "@/components/runs/model";

/** The run a page opens without one named: the newest still running, else the newest. */
function defaultRun(runs: readonly RunSummary[]): string | null {
  return (
    runs.find((run) => run.finishedAt === null)?.runId ?? runs[0]?.runId ?? null
  );
}

/** The time now, moving on each half minute: elapsed and waiting times read in minutes. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function errorText(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  return error instanceof Error ? error.message : "The run could not be read.";
}

function RunsPageContent() {
  const params = useParams<{ name: string; session: string }>();
  const projectName = decodeURIComponent(params.name);
  const sessionName = decodeURIComponent(params.session);
  const router = useRouter();
  const search = useSearchParams();

  const runs = useSessionRunsQuery(projectName, sessionName);
  const named = search.get("run");
  const opening = named === null ? defaultRun(runs.data ?? []) : null;
  // The opening choice is put in the address once, so a newer run starting
  // later does not move the page off the run the person is reading.
  useEffect(() => {
    if (opening !== null)
      router.replace(runsPageHref(projectName, sessionName, opening));
  }, [opening, projectName, sessionName, router]);
  const runId = named ?? opening;
  const page = useRunPageQuery(projectName, sessionName, runId);
  const control = useRunControlMutation(projectName, sessionName);
  const decide = useRunDecisionMutation(projectName, sessionName);
  const now = useMinuteClock();

  /** The run the person sees and acts on; a decision or disposition names its context's started Context. */
  const shown = page.data ?? null;
  const displayed = () => {
    if (shown === null) throw new Error("The run is not loaded yet");
    return shown;
  };
  const steer = async (
    request: Parameters<typeof control.mutateAsync>[0]["control"],
  ) => {
    await control.mutateAsync({ runId: displayed().runId, control: request });
  };
  const decideOn = async (
    key: string,
    decision: Omit<
      Parameters<typeof decide.mutateAsync>[0]["decision"],
      "contextId"
    >,
  ) => {
    const run = displayed();
    await decide.mutateAsync({
      runId: run.runId,
      decision: { ...decision, contextId: invocationIdOf(run, key) },
    });
  };

  const actions: RunPageActions = {
    onSelectRun: (selected) =>
      router.replace(runsPageHref(projectName, sessionName, selected)),
    onPause: () => steer({ action: "pause" }),
    onResume: () => steer({ action: "resume" }),
    onCancel: () => steer({ action: "cancel" }),
    onRetryLane: (lane) => steer({ action: "retry", lane }),
    onApplyRemedy: (key, choice) =>
      steer({
        action: "resume",
        dispositions: [
          {
            contextId: invocationIdOf(displayed(), key),
            occurrence: choice.occurrence,
            disposition: dispositionOf(choice),
          },
        ],
      }),
    onApprove: (key, candidateId) =>
      decideOn(key, { candidateId, decision: "approved" }),
    onReject: (key, candidateId, notes) =>
      decideOn(key, {
        candidateId,
        decision: "rejected",
        ...(notes.trim() !== "" ? { notes: notes.trim() } : {}),
      }),
    onBrowseTemplates: () =>
      router.push(runTemplatesHref(projectName, sessionName)),
    onOpenConversation: (conversationId) =>
      router.push(
        conversationsPageHref({ conversationId, projectName, sessionName }),
      ),
  };

  const sessionHref = `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`;
  return (
    <div className="app" data-page="runs">
      <Topbar
        page="detail"
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          {
            label: projectName,
            href: `/projects/${encodeURIComponent(projectName)}`,
            isProject: true,
          },
          { label: sessionName, href: sessionHref, isSession: true },
          { label: "Runs", href: runsPageHref(projectName, sessionName) },
        ]}
      />
      {/* The run page brings its own rail of runs; the conversation rail would crowd its inspector. */}
      <main className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
        <RunPage
          runs={runs.data ?? []}
          run={shown}
          selectedRunId={runId}
          initialContext={search.get("context")}
          actions={actions}
          now={now}
          loading={runs.isPending || (runId !== null && page.isPending)}
          error={errorText(runs.error ?? page.error)}
          retrying={runs.isFetching || page.isFetching}
          onRetry={() => {
            void runs.refetch();
            if (runId !== null) void page.refetch();
          }}
        />
      </main>
    </div>
  );
}

/** A session's runs: the rail of its runs beside the one selected (design r2 amendment 17). */
export default function RunsPage() {
  return (
    <Suspense fallback={null}>
      <RunsPageContent />
    </Suspense>
  );
}
