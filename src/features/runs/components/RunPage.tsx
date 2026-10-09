"use client";

import { useState } from "react";
import { ArrowUpRightIcon, CloseIcon, RefreshIcon } from "@/components/icons";
import { DialogContent, DialogTitle, Dialog } from "@/components/ui/Dialog";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import { useMediaQueryMatch } from "@/hooks/use-media-query";
import { DiagramIcon, ListIcon } from "../icons";
import type { RunDetail, RunSummary } from "../model";
import { runStatus } from "../present";
import { AttentionPanel } from "./AttentionPanel";
import { ContextInspector, type ContextActions } from "./ContextInspector";
import { ContextList } from "./ContextList";
import { RunDiagram } from "./RunDiagram";
import { RunHeader, type RunControls } from "./RunHeader";
import { CharterDialog, DocumentDialog, RunOverview } from "./RunOverview";
import { RunsRail } from "./RunsRail";

export type RunPageActions = RunControls &
  Omit<ContextActions, "onOpenDocument" | "onOpenCharter"> & {
    onSelectRun(runId: string): void;
    onRetryLane(lane: string): void | Promise<void>;
    onBrowseTemplates?(): void;
  };

type View = "list" | "diagram";

function UnavailableEvidence({
  title,
  onClose,
}: {
  title: string | null;
  onClose(): void;
}) {
  const { captureOpener, restoreOpener } = useOpenerFocus();
  return (
    <Dialog
      open={title !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        onOpenAutoFocus={captureOpener}
        onCloseAutoFocus={restoreOpener}
        aria-describedby={undefined}
      >
        <div className="flex flex-col gap-lg">
          <DialogTitle>{title}</DialogTitle>
          <p
            role="status"
            className="m-0 font-mono text-[0.8rem] leading-relaxed text-text-secondary"
          >
            This revision’s contents are not loaded. Its recorded identity is
            preserved; a newer revision cannot stand in for this evidence.
          </p>
          <Button
            touch
            variant="default"
            onClick={onClose}
            layoutClassName="self-end"
          >
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Summary({ run }: { run: RunDetail }) {
  const skipped = run.contexts.filter(
    (context) => context.state.kind === "skipped",
  ).length;
  const waiting = run.contexts.filter(
    (context) => context.state.kind === "waiting",
  ).length;
  return (
    <span className="font-mono text-[0.7rem] text-text-tertiary max-640:hidden">
      {run.contexts.length} contexts
      {waiting > 0 ? ` · ${waiting} not started` : ""}
      {skipped > 0 ? ` · ${skipped} skipped` : ""}
    </span>
  );
}

/**
 * A session's runs: the rail of runs, the selected run's status, what needs
 * the person, its contexts as a list or a read-only diagram, and an
 * inspector for the selected context or, with none selected, the run itself.
 */
function RunContent({
  runs,
  run,
  actions,
  initialContext = null,
  initialView = "list",
  now,
  loading = false,
  error,
  onRetry,
}: {
  runs: RunSummary[];
  run: RunDetail;
  actions: RunPageActions;
  initialContext?: string | null;
  initialView?: View;
  now?: number;
  loading?: boolean;
  error?: string | null;
  onRetry?(): void;
}) {
  const [selected, setSelected] = useState<string | null>(initialContext);
  const [actionSelection, setActionSelection] = useState(0);
  const [view, setView] = useState<View>(initialView);
  // The diagram wants the width; the rail folds while it shows and returns with the list.
  const [railCollapsed, setRailCollapsed] = useState(initialView === "diagram");
  const [documentRef, setDocumentRef] = useState<{
    path: string;
    revision: number;
  } | null>(null);
  const [charterRef, setCharterRef] = useState<{
    revision: number;
    contextKey: string;
  } | null>(null);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const { captureOpener, restoreOpener } = useOpenerFocus();
  const narrow = useMediaQueryMatch("(max-width: 1180px)");
  const compactRail = useMediaQueryMatch("(max-width: 960px)");

  const isAgent = run.kind === "agent";
  const selectedContext = isAgent
    ? null
    : (run.contexts.find((context) => context.key === selected) ?? null);
  const overviewInDialog = view === "diagram" && selectedContext === null;
  const suspended =
    run.status.kind === "paused" || run.status.kind === "stopping";
  const openDocumentAt = (path: string, revision: number) =>
    setDocumentRef({ path, revision });
  const contextActions: ContextActions = {
    ...actions,
    onOpenDocument: openDocumentAt,
    onOpenCharter: (revision, contextKey) =>
      setCharterRef({ revision, contextKey }),
  };
  const openDocument =
    [...run.documents, ...run.documentHistory].find(
      (document) =>
        document.path === documentRef?.path &&
        document.revision === documentRef.revision,
    ) ?? null;
  const openCharter =
    [
      ...(run.charter === null ? [] : [run.charter]),
      ...run.charterHistory,
    ].find((charter) => charter.revision === charterRef?.revision) ?? null;

  const select = (key: string) => {
    if (isAgent) return;
    if (selected !== key) setActionSelection(0);
    if (narrow) captureOpener();
    setOverviewOpen(false);
    setSelected(key);
  };

  const selectCurrentAction = (key: string) => {
    if (narrow && !isAgent) captureOpener();
    setOverviewOpen(false);
    setSelected(key);
    setActionSelection((selection) => selection + 1);
  };

  const overview = (
    <RunOverview
      activity={run.activity}
      documents={run.documents}
      charter={run.charter}
      definition={run.definition}
      definitionRevision={run.definitionRevision}
      owner={run.owner}
      onSelectContext={select}
      onOpenDocument={openDocumentAt}
    />
  );
  const inspector =
    selectedContext !== null ? (
      <ContextInspector
        key={selectedContext.key}
        actionRequest={actionSelection}
        now={now}
        context={selectedContext}
        owner={run.owner}
        actions={contextActions}
        runSuspended={suspended}
        onClose={narrow ? undefined : () => setSelected(null)}
      />
    ) : (
      <div className="flex flex-col gap-lg">
        <div className="flex flex-col gap-[4px]">
          <span className="font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-tertiary uppercase">
            Run
          </span>
          <span className="font-mono text-[0.72rem] text-text-secondary">
            {isAgent
              ? "Its activity and documents."
              : "Select a context to inspect it, or read the run's activity and documents."}
          </span>
        </div>
        {overview}
      </div>
    );

  const otherAttention = runs.filter(
    (summary) => summary.runId !== run.runId && summary.attention > 0,
  ).length;
  const switcher = compactRail ? (
    <div className="flex min-w-0 flex-wrap items-center gap-sm">
      <Select value={run.runId} onValueChange={actions.onSelectRun}>
        <SelectTrigger aria-label="Run" layoutClassName="max-w-[240px] min-w-0">
          <SelectValue>{run.title}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {runs.map((summary) => (
            <SelectItem key={summary.runId} value={summary.runId}>
              {summary.title} · {runStatus(summary.status).label}
              {summary.attention > 0 ? ` · ${summary.attention} need you` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {otherAttention > 0 ? (
        <span className="inline-flex items-center gap-[5px] font-mono text-[0.7rem] text-amber">
          <span
            aria-hidden="true"
            className="size-[5px] rounded-full bg-amber"
          />
          {otherAttention} other{" "}
          {otherAttention === 1 ? "run needs" : "runs need"} you
        </span>
      ) : null}
    </div>
  ) : undefined;

  return (
    <div className="flex h-full min-h-0 w-full bg-bg-void">
      {compactRail ? null : (
        <aside
          data-collapsed={railCollapsed}
          className="w-[256px] shrink-0 overflow-y-auto border-y-0 border-r border-l-0 border-solid border-border-dim bg-bg-base px-sm py-xl transition-[width] duration-200 data-[collapsed=true]:w-[60px] data-[collapsed=true]:px-[12px]"
        >
          <RunsRail
            runs={runs}
            selectedId={run.runId}
            onSelect={actions.onSelectRun}
            collapsed={railCollapsed}
            onToggle={() => setRailCollapsed((collapsed) => !collapsed)}
          />
        </aside>
      )}
      <main className="flex min-w-0 flex-1 flex-col gap-xl overflow-y-auto px-2xl py-xl max-768:px-lg max-768:py-lg">
        {loading || error ? (
          <div
            role={error ? "alert" : "status"}
            className="flex flex-wrap items-center gap-md rounded-md border border-solid border-border-default bg-bg-surface px-lg py-md font-mono text-[0.75rem] leading-relaxed text-text-secondary"
          >
            <span className="min-w-0 flex-1">
              {error
                ? `Could not refresh: ${error}. Showing the last received update.`
                : "Refreshing progress. Showing the last received update."}
            </span>
            {error && onRetry ? (
              <Button touch size="sm" onClick={onRetry}>
                <RefreshIcon size={13} />
                Retry refresh
              </Button>
            ) : null}
          </div>
        ) : null}
        <RunHeader run={run} controls={actions} now={now} leading={switcher} />
        <AttentionPanel
          items={run.attention}
          owner={run.owner}
          actions={{
            onSelectContext: selectCurrentAction,
            onRetryLane: actions.onRetryLane,
            onOpenConversation: actions.onOpenConversation,
            onResume: actions.onResume,
          }}
        />
        {isAgent ? (
          <>
            {run.contexts[0] !== undefined ? (
              <ContextInspector
                key={run.contexts[0].key}
                actionRequest={actionSelection}
                now={now}
                context={run.contexts[0]}
                owner={run.owner}
                actions={contextActions}
                runSuspended={suspended}
                embedded
              />
            ) : null}
          </>
        ) : (
          <section className="flex min-h-0 flex-col gap-md">
            <div className="flex flex-wrap items-center gap-sm">
              <SegmentedControl
                value={view}
                onValueChange={(value) => {
                  const next: View = value === "diagram" ? "diagram" : "list";
                  setView(next);
                  setRailCollapsed(next === "diagram");
                }}
                aria-label="Show contexts as"
              >
                <SegmentedControlItem value="list">
                  <ListIcon size={13} />
                  List
                </SegmentedControlItem>
                <SegmentedControlItem value="diagram">
                  <DiagramIcon size={13} />
                  Diagram
                </SegmentedControlItem>
              </SegmentedControl>
              <Summary run={run} />
              {narrow || view === "diagram" ? (
                <Button
                  touch
                  size="sm"
                  variant="ghost"
                  layoutClassName="ml-auto"
                  onClick={() => {
                    captureOpener();
                    setSelected(null);
                    setOverviewOpen(true);
                  }}
                >
                  Run details
                </Button>
              ) : null}
            </div>
            {view === "list" ? (
              <ContextList
                contexts={run.contexts}
                lanes={run.lanes}
                loops={run.loops}
                selectedKey={selected}
                onSelect={select}
                onRetryLane={actions.onRetryLane}
              />
            ) : (
              <div className="h-[560px] max-768:h-[440px]">
                <RunDiagram
                  contexts={run.contexts}
                  edges={run.edges}
                  lanes={run.lanes}
                  loops={run.loops}
                  selectedKey={selected}
                  onSelect={select}
                />
              </div>
            )}
          </section>
        )}
        {isAgent && narrow ? (
          <div className="flex flex-col gap-lg">{overview}</div>
        ) : null}
      </main>
      {narrow || overviewInDialog ? null : (
        <aside className="w-[460px] shrink-0 overflow-y-auto border-y-0 border-r-0 border-l border-solid border-border-dim bg-bg-base px-xl py-xl">
          {inspector}
        </aside>
      )}
      {(narrow || overviewInDialog) && !isAgent ? (
        <Dialog
          open={(narrow && selectedContext !== null) || overviewOpen}
          onOpenChange={(open) => {
            if (open) return;
            setSelected(null);
            setOverviewOpen(false);
          }}
        >
          <DialogContent
            unstyled
            onOpenAutoFocus={captureOpener}
            onCloseAutoFocus={restoreOpener}
            aria-describedby={undefined}
            anchor="stretch"
            contentClassName="absolute top-0 right-0 bottom-0 flex w-[min(480px,100vw)] flex-col overflow-y-auto border-y-0 border-r-0 border-l border-solid border-border-default bg-bg-base px-xl py-xl shadow-[var(--cc-shadow-popover)] max-768:w-full max-768:px-lg"
          >
            <DialogTitle asChild>
              <h2 className="sr-only">{selectedContext?.title ?? run.title}</h2>
            </DialogTitle>
            <div className="mb-lg flex items-center justify-between gap-md border-x-0 border-t-0 border-b border-solid border-border-dim pb-md">
              <span className="font-mono text-[0.7rem] tracking-[0.1em] text-text-secondary uppercase">
                {selectedContext ? "Context details" : "Run details"}
              </span>
              <Button
                touch
                size="sm"
                aria-label="Close details"
                variant="ghost"
                onClick={() => {
                  setSelected(null);
                  setOverviewOpen(false);
                }}
              >
                <CloseIcon size={14} />
                Close
              </Button>
            </div>
            {inspector}
          </DialogContent>
        </Dialog>
      ) : null}
      <DocumentDialog
        document={openDocument}
        onClose={() => setDocumentRef(null)}
      />
      <CharterDialog
        charter={openCharter}
        contextKey={charterRef?.contextKey ?? null}
        onClose={() => setCharterRef(null)}
      />
      <UnavailableEvidence
        title={
          documentRef !== null && openDocument === null
            ? `${documentRef.path} · revision ${documentRef.revision}`
            : charterRef !== null && openCharter === null
              ? `Charter · revision ${charterRef.revision}`
              : null
        }
        onClose={() => {
          setDocumentRef(null);
          setCharterRef(null);
        }}
      />
    </div>
  );
}

/** Query state belongs to the host; changing runs starts a fresh inspection. */
export function RunPage(props: {
  runs: RunSummary[];
  run: RunDetail | null;
  actions: RunPageActions;
  /** The run the address names, while its page is not shown yet. */
  selectedRunId?: string | null;
  initialContext?: string | null;
  initialView?: View;
  now?: number;
  loading?: boolean;
  error?: string | null;
  onRetry?(): void;
  /** A retry asked for is reading again. */
  retrying?: boolean;
}) {
  if (props.run !== null)
    return <RunContent key={props.run.runId} {...props} run={props.run} />;
  const notice = <NoRun {...props} />;
  // The session's runs stay beside a run that is loading or could not be read, to choose another.
  if (props.runs.length === 0) return notice;
  return (
    <div className="flex h-full min-h-0 w-full bg-bg-void">
      <aside className="w-[256px] shrink-0 overflow-y-auto border-y-0 border-r border-l-0 border-solid border-border-dim bg-bg-base px-sm py-xl max-768:hidden">
        <RunsRail
          runs={props.runs}
          selectedId={props.selectedRunId ?? ""}
          onSelect={props.actions.onSelectRun}
        />
      </aside>
      <div className="flex min-w-0 flex-1">{notice}</div>
    </div>
  );
}

function NoRun(props: Parameters<typeof RunPage>[0]) {
  const forRun = props.runs.length > 0;
  return (
    <main className="flex h-full min-h-[420px] w-full items-center justify-center bg-bg-void px-xl py-3xl">
      <section
        aria-busy={props.loading || undefined}
        className="flex w-full max-w-[560px] flex-col items-start gap-lg rounded-lg border border-solid border-border-subtle bg-bg-surface p-2xl max-640:p-xl"
      >
        <span className="flex size-[44px] items-center justify-center rounded-lg border border-solid border-border-default bg-bg-raised text-cyan">
          <DiagramIcon size={24} />
        </span>
        <div className="flex flex-col gap-sm">
          <span className="font-mono text-[0.7rem] tracking-[0.12em] text-text-tertiary uppercase">
            Runs · this session
          </span>
          <h1 className="m-0 font-display text-[1.5rem] font-bold text-text-primary">
            {props.loading
              ? forRun
                ? "Loading the run"
                : "Loading runs"
              : props.error
                ? forRun
                  ? "This run could not be loaded"
                  : "Runs could not be loaded"
                : forRun
                  ? "Choose a run"
                  : "A place for delegated work"}
          </h1>
          <p
            role={props.error ? "alert" : "status"}
            className="m-0 font-mono text-[0.82rem] leading-relaxed text-text-secondary"
          >
            {props.loading
              ? "Getting the latest progress and decisions."
              : (props.error ??
                (forRun
                  ? "Pick one of this session's runs to follow its progress and decisions."
                  : "Launch a saved workflow, or ask a conversation to delegate a task. Follow progress, inspect the work, and make decisions here."))}
          </p>
        </div>
        {props.error && props.onRetry ? (
          <Button touch loading={props.retrying} onClick={props.onRetry}>
            <RefreshIcon size={14} />
            Try again
          </Button>
        ) : !props.loading && !forRun && props.actions.onBrowseTemplates ? (
          <Button
            touch
            variant="primary"
            onClick={props.actions.onBrowseTemplates}
          >
            Browse templates
            <ArrowUpRightIcon size={14} />
          </Button>
        ) : null}
      </section>
    </main>
  );
}
