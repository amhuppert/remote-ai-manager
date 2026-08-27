"use client";

import { useState } from "react";
import { cn } from "@/lib/ui/cn";
import { Button } from "@/components/ui/Button";
import { EmptyState, EmptyStateTitle } from "@/components/ui/EmptyState";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import { formatRelativeTime } from "@/lib/shared/format-relative-time";
import { diffNotepadLines } from "@/lib/notepads/line-diff";
import {
  useNotepadRevisionResolutionQuery,
  useNotepadRevisionsQuery,
} from "@/lib/notepads/queries";
import type { NotepadRevision } from "@/lib/notepads/schemas";

export interface NotepadHistoryProps {
  notepadId: string;
  /** The notepad's current head revision — badged and never restorable. */
  headRevision: number;
  /**
   * Restore is owned by the open view, not the drawer: a restore is a local
   * user-authored write whose SSE echo must be adjudicated alongside the
   * autosave echoes the open view already tracks.
   */
  onRestore(revision: number): void;
  restorePending: boolean;
  /**
   * A revision to present in versus-previous mode — the single destination
   * every diff affordance (the landed-update strip's View diff, the collision
   * notice's Review) routes to. Null when history was opened directly.
   */
  diffTarget?: number | null;
}

/**
 * Which text the preview shows for the selected revision (spec D13):
 * `snapshot` is the revision's content as saved; `previous` diffs it against
 * its predecessor (what the revision changed); `current` diffs the head
 * against it (what restoring it would change).
 */
type PreviewMode = "snapshot" | "previous" | "current";

/**
 * Rows the drawer lists (matches the server's default window). The listing is
 * a browse surface only: selection is id-addressed and never limited to this
 * page.
 */
const HISTORY_WINDOW = 50;

function authorLabel(revision: NotepadRevision): string {
  return revision.authorKind === "user" ? "you" : "agent";
}

function renderDiff(from: string, to: string): React.JSX.Element[] {
  return diffNotepadLines(from, to).map((line, index) =>
    line.kind === "removed" ? (
      <del
        key={index}
        className="block rounded-sm bg-red-glow text-red-text line-through decoration-current"
      >
        {line.text || " "}
      </del>
    ) : line.kind === "added" ? (
      <ins
        key={index}
        className="block rounded-sm bg-green-glow text-green no-underline"
      >
        {line.text || " "}
      </ins>
    ) : (
      <span key={index} className="block text-text-tertiary">
        {line.text || " "}
      </span>
    ),
  );
}

/**
 * A failed predecessor/head resolution stated as such: rendering the snapshot
 * under a diff mode would make a failed request look like a valid diff view.
 */
function diffLoadFailure(retry: () => void): React.JSX.Element {
  return (
    <span className="block text-text-tertiary">
      Couldn&apos;t load this diff.{" "}
      <button
        type="button"
        onClick={retry}
        className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[0.72rem] text-cyan underline focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[2px]"
      >
        Retry
      </button>
    </span>
  );
}

/**
 * Bounded revision history for the open notepad: every persisted change with
 * its author attribution, newest first. Selecting a revision previews its
 * snapshot or a computed diff; restore is immediate — no confirm dialog,
 * because a restore is a new head that leaves earlier history unchanged, so
 * nothing is lost.
 *
 * Selection is a revision number resolved by id through the notepads API
 * (`?at=`): the selected revision and its immediate predecessor are fetched
 * when they fall outside the listed page, so the snapshot, versus-previous,
 * and versus-current views stay offered and correct however far the head has
 * advanced past the page — a View diff target never ages out.
 */
export default function NotepadHistory({
  notepadId,
  headRevision,
  onRestore,
  restorePending,
  diffTarget = null,
}: NotepadHistoryProps): React.JSX.Element {
  const revisionsQuery = useNotepadRevisionsQuery(notepadId, {
    limit: HISTORY_WINDOW,
  });
  const [selectedRevision, setSelectedRevision] = useState<number | null>(
    diffTarget,
  );
  const [previewMode, setPreviewMode] = useState<PreviewMode>(
    diffTarget === null ? "snapshot" : "previous",
  );

  // Every diff affordance lands here: the target revision selected, its
  // versus-previous diff shown. Render-time adjustment (not an effect) per
  // the "adjusting state when a prop changes" pattern, so a target arriving
  // while history is already open re-routes the preview in the same pass.
  const [lastDiffTarget, setLastDiffTarget] = useState(diffTarget);
  if (diffTarget !== lastDiffTarget) {
    setLastDiffTarget(diffTarget);
    if (diffTarget !== null) {
      setSelectedRevision(diffTarget);
      setPreviewMode("previous");
    }
  }

  const revisions = revisionsQuery.data ?? [];
  const listedRow = (revision: number): NotepadRevision | null =>
    revisions.find((rev) => rev.revision === revision) ?? null;

  const selectedIsHead = selectedRevision === headRevision;
  // Id-addressed resolution: the selected revision and its immediate
  // predecessor by number, fetched even when they fall outside the listed
  // page. The predecessor ALWAYS comes from this resolution — the listed page
  // may hold the selection but not its predecessor (the oldest listed row).
  const selectedResolution = useNotepadRevisionResolutionQuery(
    notepadId,
    selectedRevision,
  );
  // The head snapshot backs versus-current. The head is normally the newest
  // listed row; resolve it by id for the transient window where the listing
  // has not yet refetched a freshly advanced head.
  const headResolution = useNotepadRevisionResolutionQuery(
    notepadId,
    selectedRevision !== null &&
      !selectedIsHead &&
      listedRow(headRevision) === null
      ? headRevision
      : null,
  );

  const selected =
    selectedRevision === null
      ? null
      : (listedRow(selectedRevision) ??
        selectedResolution.data?.target ??
        null);
  const predecessor = selectedResolution.data?.predecessor ?? null;
  const headSnapshot = selectedIsHead
    ? selected
    : (listedRow(headRevision) ?? headResolution.data?.target ?? null);
  // What the versus-previous diff runs from. Only the create revision
  // legitimately has no predecessor — its versus-previous is the whole
  // snapshot added. (A user restore records baseRevision null too, so
  // origin — never baseRevision — discriminates the create case.) Null while
  // the resolution is still in flight, where the preview says so rather than
  // diffing from a lying empty string.
  const previousFrom =
    selected === null
      ? null
      : selected.origin === "create"
        ? ""
        : (predecessor?.content ?? null);

  return (
    <div
      data-testid="notepad-history"
      className="flex max-h-[45%] shrink-0 flex-col border-0 border-b border-solid border-border-subtle bg-bg-base"
    >
      {revisionsQuery.isLoading ? (
        <EmptyState layoutClassName="my-md">
          <EmptyStateTitle>Loading history…</EmptyStateTitle>
        </EmptyState>
      ) : revisions.length === 0 ? (
        <EmptyState layoutClassName="my-md">
          <EmptyStateTitle>No revisions yet</EmptyStateTitle>
        </EmptyState>
      ) : (
        <ul className="m-0 min-h-0 list-none overflow-y-auto p-0">
          {revisions.map((revision) => {
            const isHead = revision.revision === headRevision;
            const isSelected = revision.revision === selectedRevision;
            return (
              <li key={revision.id} className="m-0 list-none p-0">
                <button
                  type="button"
                  aria-label={`Select revision ${revision.revision}`}
                  aria-pressed={isSelected}
                  onClick={() => {
                    setSelectedRevision(isSelected ? null : revision.revision);
                    // A different revision's diff is a different question —
                    // start it from the snapshot again.
                    setPreviewMode("snapshot");
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-baseline gap-sm border-0 border-b border-solid border-border-subtle bg-transparent px-[12px] py-[6px] text-left transition-colors duration-150 ease-[ease] hover:bg-bg-hover focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px]",
                    isSelected && "bg-bg-hover",
                  )}
                >
                  <span className="shrink-0 font-mono text-[0.72rem] font-semibold text-cyan">
                    r{revision.revision}
                  </span>
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-baseline gap-[4px] font-mono text-[0.72rem]",
                      revision.authorKind === "user"
                        ? "text-amber"
                        : "text-cyan",
                    )}
                  >
                    <span
                      aria-hidden
                      className="inline-block h-[6px] w-[6px] self-center rounded-full bg-current"
                    />
                    {authorLabel(revision)}
                  </span>
                  <span className="shrink-0 font-mono text-[0.68rem] text-text-tertiary">
                    {revision.origin}
                  </span>
                  {isHead ? (
                    <span className="shrink-0 rounded-full border border-solid border-border-default px-[6px] font-mono text-[0.62rem] tracking-[0.05em] text-text-secondary uppercase">
                      current
                    </span>
                  ) : null}
                  <span className="ml-auto shrink-0 font-mono text-[0.68rem] text-text-tertiary">
                    {formatRelativeTime(revision.createdAt)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selected ? (
        <div className="flex min-h-0 shrink-0 flex-col gap-[6px] border-0 border-t border-solid border-border-subtle px-[12px] py-[8px]">
          <SegmentedControl
            aria-label="Revision preview mode"
            value={previewMode}
            onValueChange={(value) => {
              if (
                value === "snapshot" ||
                value === "previous" ||
                value === "current"
              ) {
                setPreviewMode(value);
              }
            }}
          >
            <SegmentedControlItem value="snapshot">
              snapshot
            </SegmentedControlItem>
            <SegmentedControlItem value="previous">
              vs previous
            </SegmentedControlItem>
            {/* The head has nothing a restore would change against itself. */}
            {!selectedIsHead ? (
              <SegmentedControlItem value="current">
                vs current
              </SegmentedControlItem>
            ) : null}
          </SegmentedControl>

          <pre className="m-0 max-h-[160px] min-h-0 overflow-y-auto font-mono text-[0.72rem] leading-[1.6] [overflow-wrap:anywhere] whitespace-pre-wrap text-text-primary">
            {previewMode === "snapshot" ? (
              selected.content
            ) : previewMode === "previous" ? (
              previousFrom !== null ? (
                renderDiff(previousFrom, selected.content)
              ) : selectedResolution.isError ? (
                diffLoadFailure(() => void selectedResolution.refetch())
              ) : (
                <span className="block text-text-tertiary">Loading diff…</span>
              )
            ) : headSnapshot !== null ? (
              renderDiff(headSnapshot.content, selected.content)
            ) : headResolution.isError ? (
              diffLoadFailure(() => void headResolution.refetch())
            ) : (
              <span className="block text-text-tertiary">Loading diff…</span>
            )}
          </pre>
          <div className="flex items-center gap-sm">
            <Button
              variant="default"
              size="sm"
              disabled={selectedIsHead || restorePending}
              onClick={() => {
                if (selectedIsHead) return;
                onRestore(selected.revision);
              }}
            >
              {selectedIsHead
                ? "current"
                : restorePending
                  ? "Restoring…"
                  : `Restore r${selected.revision}`}
            </Button>
            <span className="font-mono text-[0.68rem] text-text-tertiary">
              {selectedIsHead
                ? "this revision is the head"
                : "copies this snapshot forward as the new head — nothing behind it changes"}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
