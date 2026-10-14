"use client";

import { CloseIcon, DocumentIcon } from "@/components/icons";
import { DocumentMarkdown } from "@/components/markdown/Markdown";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/Dialog";
import { JsonTree } from "@/components/ui/JsonTree";
import { Button } from "@/components/ui/Button";
import {
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
  TabsTriggerCount,
} from "@/components/ui/Tabs";
import { formatLocalTime } from "@/lib/shared/format-local-time";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import { cn } from "@/lib/ui/cn";
import type {
  ActivityEvent,
  ActivityKind,
  RunCharter,
  RunDocument,
  RunOwner,
} from "@/components/runs/model";
import { PanelHeading } from "./parts";

const activityTone: Record<ActivityKind, string> = {
  launched: "bg-text-tertiary",
  started: "bg-cyan",
  question: "bg-amber",
  answered: "bg-text-tertiary",
  halted: "bg-red",
  resolved: "bg-text-tertiary",
  approval: "bg-amber",
  decided: "bg-green",
  published: "bg-green",
  amended: "bg-text-secondary",
  succeeded: "bg-green",
  paused: "bg-text-secondary",
  resumed: "bg-cyan",
  retried: "bg-cyan",
  cancelled: "bg-text-tertiary",
};

function Activity({
  events,
  onSelectContext,
}: {
  events: ActivityEvent[];
  onSelectContext(key: string): void;
}) {
  return (
    <ol className="relative m-0 flex list-none flex-col gap-0 p-0">
      <span
        aria-hidden="true"
        className="absolute top-[14px] bottom-[14px] left-[62px] w-px bg-border-subtle"
      />
      {[...events]
        .sort((a, b) => b.seq - a.seq)
        .map((event) => (
          <li
            key={event.id}
            className="relative flex items-start gap-md py-[7px]"
          >
            <time
              dateTime={event.at}
              className="w-[46px] shrink-0 pt-[1px] text-right font-mono text-[0.7rem] text-text-tertiary"
            >
              {formatLocalTime(event.at)}
            </time>
            <span
              aria-hidden="true"
              className="relative z-raised mt-[5px] flex size-[9px] shrink-0 items-center justify-center rounded-full bg-bg-surface"
            >
              <span
                className={cn(
                  "size-[7px] rounded-full",
                  activityTone[event.kind],
                )}
              />
            </span>
            <span className="min-w-0 font-mono text-[0.75rem] leading-[1.5] text-text-primary">
              {event.contextKey !== undefined ? (
                <button
                  type="button"
                  onClick={() => onSelectContext(event.contextKey ?? "")}
                  className="mr-[6px] cursor-pointer rounded-sm border-0 bg-transparent p-0 font-mono text-[0.75rem] font-semibold text-cyan underline-offset-2 hover:underline focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
                >
                  {event.contextKey}
                </button>
              ) : null}
              {event.summary}
            </span>
          </li>
        ))}
    </ol>
  );
}

function documentOrigin(document: RunDocument): string {
  if (document.source === "publish")
    return `published by ${document.by ?? "a context"}`;
  if (document.source === "amend")
    return document.reason !== undefined
      ? `amended: ${document.reason}`
      : "amended";
  return "declared at launch";
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function Documents({
  documents,
  onOpen,
}: {
  documents: RunDocument[];
  onOpen(path: string, revision: number): void;
}) {
  if (documents.length === 0)
    return (
      <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
        This run has no documents.
      </p>
    );
  return (
    <div className="flex flex-col gap-md">
      <p className="m-0 font-mono text-[0.72rem] leading-[1.55] text-text-secondary">
        What work starting now reads. Running work keeps the revisions it
        started with.
      </p>
      <ul className="m-0 flex list-none flex-col gap-sm p-0">
        {documents.map((document) => (
          <li key={document.path}>
            <button
              type="button"
              onClick={() => onOpen(document.path, document.revision)}
              className="flex w-full cursor-pointer flex-col gap-[6px] rounded-md border border-solid border-border-subtle bg-bg-surface px-md py-sm text-left transition-colors duration-150 hover:border-border-strong hover:bg-bg-raised focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
            >
              <span className="flex min-w-0 flex-wrap items-center gap-sm">
                <span className="text-text-tertiary">
                  <DocumentIcon size={14} />
                </span>
                <span className="min-w-0 font-mono text-[0.78rem] font-medium [overflow-wrap:anywhere] break-words text-text-primary">
                  {document.path}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[0.7rem] text-text-tertiary">
                  revision {document.revision}
                </span>
              </span>
              <span className="font-mono text-[0.72rem] leading-[1.5] text-text-secondary">
                {document.description}
              </span>
              <span className="flex flex-wrap items-center gap-x-md gap-y-[2px] font-mono text-[0.7rem] text-text-tertiary">
                <span
                  className={
                    document.source === "publish" ? "text-cyan" : undefined
                  }
                >
                  {documentOrigin(document)}
                </span>
                <span>{formatBytes(document.bytes)}</span>
                {document.appliesTo !== undefined ? (
                  <span>for {document.appliesTo.join(", ")}</span>
                ) : null}
                {document.readWhen !== undefined ? (
                  <span>read: {document.readWhen.toLowerCase()}</span>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Charter({
  charter,
  contextKey = null,
}: {
  charter: RunCharter | null;
  contextKey?: string | null;
}) {
  if (charter === null)
    return (
      <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
        This run has no charter.
      </p>
    );
  const applies = (item: { appliesTo?: string[] }) =>
    contextKey === null ||
    item.appliesTo === undefined ||
    item.appliesTo.includes(contextKey);
  const invariants = charter.invariants.filter(applies);
  const sources = charter.sources
    .filter(applies)
    .toSorted((a, b) => a.rank - b.rank);
  return (
    <div className="flex flex-col gap-xl">
      <section className="flex flex-col gap-sm">
        <PanelHeading
          trailing={
            <span className="font-mono text-[0.7rem] text-text-tertiary">
              revision {charter.revision}
            </span>
          }
        >
          Mission
        </PanelHeading>
        <p className="m-0 font-mono text-[0.82rem] leading-[1.6] text-text-primary">
          {charter.mission}
        </p>
        {charter.reason !== null ? (
          <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
            Amended: {charter.reason}
          </p>
        ) : null}
      </section>
      <section className="flex flex-col gap-sm">
        <PanelHeading count={invariants.length}>Invariants</PanelHeading>
        <ul className="m-0 flex list-none flex-col gap-sm p-0">
          {invariants.map((invariant) => (
            <li key={invariant.id} className="flex flex-col gap-[3px]">
              <span className="flex items-center gap-sm">
                <code className="font-mono text-[0.72rem] font-semibold text-cyan">
                  {invariant.id}
                </code>
                {invariant.appliesTo !== undefined ? (
                  <span className="font-mono text-[0.7rem] text-text-tertiary">
                    for {invariant.appliesTo.join(", ")}
                  </span>
                ) : null}
              </span>
              <span className="font-mono text-[0.75rem] leading-[1.5] text-text-primary">
                {invariant.statement}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-sm">
        <PanelHeading>Sources of truth</PanelHeading>
        <ol className="m-0 flex list-none flex-col gap-sm p-0">
          {sources.map((source) => (
            <li key={source.rank} className="flex items-start gap-md">
              <span className="inline-flex size-[20px] shrink-0 items-center justify-center rounded-sm bg-bg-raised font-mono text-[0.72rem] font-semibold text-text-secondary">
                {source.rank}
              </span>
              <span className="flex min-w-0 flex-col gap-[2px]">
                <span className="font-mono text-[0.75rem] font-medium text-text-primary">
                  {source.label}
                </span>
                <code className="font-mono text-[0.7rem] [overflow-wrap:anywhere] break-words text-text-tertiary">
                  {source.locator}
                </code>
                <span className="font-mono text-[0.72rem] text-text-secondary">
                  {source.description}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </section>
      {charter.conventions.length > 0 ? (
        <CharterNotes title="Conventions" values={charter.conventions} />
      ) : null}
      {charter.vocabulary.length > 0 ? (
        <CharterNotes title="Vocabulary" values={charter.vocabulary} />
      ) : null}
      {charter.testStrategy !== null ? (
        <CharterNotes title="Test strategy" values={[charter.testStrategy]} />
      ) : null}
      {charter.knownAmbiguities.length > 0 ? (
        <CharterNotes
          title="Known ambiguities"
          values={charter.knownAmbiguities}
        />
      ) : null}
      {charter.nonGoals.length > 0 ? (
        <section className="flex flex-col gap-sm">
          <PanelHeading>Non-goals</PanelHeading>
          <ul className="m-0 flex list-none flex-col gap-sm p-0">
            {charter.nonGoals.map((goal) => (
              <li key={goal}>
                <span className="font-mono text-[0.75rem] leading-relaxed text-text-secondary">
                  {goal}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function CharterNotes({ title, values }: { title: string; values: string[] }) {
  return (
    <section className="flex flex-col gap-sm">
      <PanelHeading>{title}</PanelHeading>
      <ul className="m-0 flex list-none flex-col gap-sm p-0">
        {values.map((value) => (
          <li
            key={value}
            className="font-mono text-[0.75rem] leading-relaxed text-text-primary"
          >
            {value}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The exact charter revision and context-specific bundle a seat received. */
export function CharterDialog({
  charter,
  contextKey,
  onClose,
}: {
  charter: RunCharter | null;
  contextKey: string | null;
  onClose(): void;
}) {
  const { captureOpener, restoreOpener } = useOpenerFocus();
  return (
    <Dialog
      open={charter !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {charter !== null ? (
        <DialogContent
          size="wide"
          mobileSheet="full-height"
          onOpenAutoFocus={captureOpener}
          onCloseAutoFocus={restoreOpener}
        >
          <div className="flex items-start justify-between gap-md">
            <DialogTitle>charter.md</DialogTitle>
            <Button
              touch
              size="sm"
              variant="ghost"
              aria-label="Close charter"
              onClick={onClose}
            >
              <CloseIcon size={14} />
              Close
            </Button>
          </div>
          <DialogDescription>
            Revision {charter.revision}
            {contextKey !== null
              ? ` · frozen for ${contextKey}`
              : " · run charter"}
            . This is the charter the selected invocation started with.
          </DialogDescription>
          <div className="mt-lg max-h-[60vh] overflow-y-auto rounded-md border border-solid border-border-subtle bg-bg-base px-lg py-lg max-768:max-h-[calc(100dvh-160px)]">
            <Charter charter={charter} contextKey={contextKey} />
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/** A frozen document's contents, read in place. */
export function DocumentDialog({
  document,
  onClose,
}: {
  document: RunDocument | null;
  onClose(): void;
}) {
  const { captureOpener, restoreOpener } = useOpenerFocus();
  return (
    <Dialog
      open={document !== null}
      onOpenChange={(open) => (open ? undefined : onClose())}
    >
      {document !== null ? (
        <DialogContent
          size="wide"
          mobileSheet="full-height"
          onOpenAutoFocus={captureOpener}
          onCloseAutoFocus={restoreOpener}
        >
          <div className="flex items-start justify-between gap-md">
            <div className="min-w-0 [overflow-wrap:anywhere] break-words">
              <DialogTitle>{document.path}</DialogTitle>
            </div>
            <Button
              touch
              size="sm"
              variant="ghost"
              aria-label="Close document"
              onClick={onClose}
            >
              <CloseIcon size={14} />
              Close
            </Button>
          </div>
          <DialogDescription>
            Revision {document.revision} · {documentOrigin(document)} ·{" "}
            {document.description}
          </DialogDescription>
          <div className="mt-lg max-h-[60vh] overflow-y-auto rounded-md border border-solid border-border-subtle bg-bg-base px-lg py-md max-768:max-h-[calc(100dvh-160px)]">
            <DocumentMarkdown content={document.contents} />
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/** The run as a whole, when no context is selected. */
export function RunOverview({
  activity,
  documents,
  charter,
  definition,
  definitionRevision,
  owner,
  onSelectContext,
  onOpenDocument,
}: {
  activity: ActivityEvent[];
  documents: RunDocument[];
  charter: RunCharter | null;
  definition: Record<string, unknown> | null;
  definitionRevision: number;
  owner: RunOwner;
  onSelectContext(key: string): void;
  onOpenDocument(path: string, revision: number): void;
}) {
  return (
    <TabsRoot defaultValue="activity" layoutClassName="flex flex-col">
      <TabsList layoutClassName="mb-lg self-start max-w-full overflow-x-auto">
        <TabsTrigger value="activity">Activity</TabsTrigger>
        <TabsTrigger value="documents">
          Documents
          <TabsTriggerCount>{documents.length}</TabsTriggerCount>
        </TabsTrigger>
        {charter !== null ? (
          <TabsTrigger value="charter">Charter</TabsTrigger>
        ) : null}
        {definition !== null ? (
          <TabsTrigger value="definition">Definition</TabsTrigger>
        ) : null}
      </TabsList>
      <TabsContent value="activity">
        <Activity events={activity} onSelectContext={onSelectContext} />
      </TabsContent>
      <TabsContent value="documents">
        <Documents documents={documents} onOpen={onOpenDocument} />
      </TabsContent>
      <TabsContent value="charter">
        <Charter charter={charter} />
      </TabsContent>
      <TabsContent value="definition">
        <div className="flex flex-col gap-md">
          <p className="m-0 font-mono text-[0.72rem] leading-[1.55] text-text-secondary">
            Revision {definitionRevision}, as written. {owner.title} amends it;
            contexts already started keep theirs.
          </p>
          <div className="relative rounded-md border border-solid border-border-subtle bg-bg-base">
            <JsonTree value={definition} defaultCollapsedDepth={3} copyable />
          </div>
        </div>
      </TabsContent>
    </TabsRoot>
  );
}
