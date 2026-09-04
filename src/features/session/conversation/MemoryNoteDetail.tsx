"use client";

import { useMemo, useState } from "react";

import ConfirmDialog from "@/components/ConfirmDialog";
import { MultilineInput } from "@/components/MultilineInput";
import { Button } from "@/components/ui/Button";
import { EmptyState, EmptyStateTitle } from "@/components/ui/EmptyState";
import { StatusChip } from "@/components/ui/StatusChip";
import { describeMemoryAge, renderMemoryStatusLine } from "@/lib/memory/age";
import { formatLocalTime } from "@/lib/shared/format-local-time";
import {
  staleRevisionOf,
  useArchiveMemoryNoteMutation,
  useCreateMemoryNoteMutation,
  useDecideMemoryProposalMutation,
  useDeleteMemoryNoteMutation,
  useMarkMemoryReviewedMutation,
  usePromoteMemoryNoteMutation,
  useRestoreMemoryNoteMutation,
  useUpdateMemoryNoteMutation,
  type MemoryNoteEdit,
} from "@/lib/memory/mutations";
import {
  useMemoryNoteQuery,
  useMemoryRevisionsQuery,
  type MemoryNoteDetail as MemoryNoteDetailPayload,
} from "@/lib/memory/queries";
import type { MemoryScopeRef } from "@/lib/memory/query-keys";
import type {
  MemoryLink,
  MemoryNote,
  MemoryNoteRevision,
} from "@/lib/memory/schemas";

import MemoryArtifactChips from "./MemoryArtifactChips";

type MemoryNoteDetailLineage = MemoryNoteDetailPayload["lineage"];

export interface MemoryNoteDetailProps {
  scopeRef: MemoryScopeRef;
  /** Internal id: the handle the panel addresses by, so a rename holds. */
  memoryId: string;
  onClose(): void;
  /** Follow a promotion or supersession to the record that replaced this one. */
  onOpenNote(memoryId: string): void;
}

/**
 * One note, open for repair. Every write here is a compare-and-swap stating the
 * revision it read, so a concurrent agent edit is refused rather than silently
 * overwritten — and the refusal names the revision that won, which is what the
 * conflict banner offers to adopt.
 */
export default function MemoryNoteDetail({
  scopeRef,
  memoryId,
  onClose,
  onOpenNote,
}: MemoryNoteDetailProps): React.JSX.Element {
  const detail = useMemoryNoteQuery(scopeRef, memoryId);
  const revisions = useMemoryRevisionsQuery(scopeRef, memoryId);

  if (detail.isLoading) {
    return (
      <EmptyState layoutClassName="min-h-0 flex-1">
        <EmptyStateTitle>Loading note…</EmptyStateTitle>
      </EmptyState>
    );
  }
  if (detail.isError || detail.data === undefined) {
    return (
      <EmptyState layoutClassName="min-h-0 flex-1">
        <EmptyStateTitle>Could not load this note</EmptyStateTitle>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Back
        </Button>
      </EmptyState>
    );
  }

  return (
    <LoadedNoteDetail
      scopeRef={scopeRef}
      note={detail.data.note}
      links={detail.data.links}
      lineage={detail.data.lineage}
      revisions={revisions.data ?? []}
      onClose={onClose}
      onOpenNote={onOpenNote}
    />
  );
}

interface LoadedNoteDetailProps {
  scopeRef: MemoryScopeRef;
  note: MemoryNote;
  links: readonly MemoryLink[];
  lineage: MemoryNoteDetailLineage;
  revisions: readonly MemoryNoteRevision[];
  onClose(): void;
  onOpenNote(memoryId: string): void;
}

function LoadedNoteDetail({
  scopeRef,
  note,
  links,
  lineage,
  revisions,
  onClose,
  onOpenNote,
}: LoadedNoteDetailProps): React.JSX.Element {
  const [pendingAct, setPendingAct] = useState<
    "none" | "supersede" | "promote" | "delete"
  >("none");
  const [successorHook, setSuccessorHook] = useState("");
  const [promotedSlug, setPromotedSlug] = useState("");

  // The editor holds the snapshot its draft was derived from, so "dirty" is a
  // comparison against what was read rather than against whatever the head has
  // since become.
  const [editor, setEditor] = useState(() => ({
    base: note,
    draft: draftOf(note),
  }));
  const adopt = (saved: MemoryNote): void =>
    setEditor({ base: saved, draft: draftOf(saved) });
  // The head can advance under an open pane — another surface's write arrives
  // over SSE and the detail query refetches. Adopting the new text is right
  // only while the pane is clean; a dirty draft keeps its edits and finds out
  // at save time, which is exactly what the CAS refusal is for. Adjusting
  // during render (not in an effect) keeps the pane from painting the stale
  // text for a frame first.
  if (
    editor.base.revision !== note.revision &&
    isClean(editor.draft, editor.base)
  ) {
    adopt(note);
  }
  const draft = editor.draft;
  const setDraft = (next: (current: NoteDraft) => NoteDraft): void =>
    setEditor((current) => ({ ...current, draft: next(current.draft) }));

  const update = useUpdateMemoryNoteMutation();
  const markReviewed = useMarkMemoryReviewedMutation();
  const archive = useArchiveMemoryNoteMutation();
  const restore = useRestoreMemoryNoteMutation();
  const promote = usePromoteMemoryNoteMutation();
  const decide = useDecideMemoryProposalMutation();
  const remove = useDeleteMemoryNoteMutation();
  const create = useCreateMemoryNoteMutation();

  /**
   * The compare-and-swap token is the revision the pane READ, not whatever the
   * head has since become. Sending the refetched head would let a dirty draft
   * silently overwrite the concurrent write it never saw — which is exactly the
   * collision the CAS refusal exists to name.
   */
  const base = {
    ref: scopeRef,
    handle: note.id,
    baseRevision: editor.base.revision,
  };
  const now = new Date().toISOString();
  /**
   * A re-lease restores its claim to every conversation's ambient block, so
   * the act reports what it put back rather than leaving the operator to go
   * read it (R2.2). Null after a note-level review, which re-asserts nothing.
   */
  const reLeased = markReviewed.data?.statusReLease ?? null;

  const conflict = useMemo(
    () =>
      staleRevisionOf(update.error) ??
      staleRevisionOf(archive.error) ??
      staleRevisionOf(restore.error) ??
      staleRevisionOf(markReviewed.error) ??
      staleRevisionOf(decide.error) ??
      staleRevisionOf(promote.error),
    [
      update.error,
      archive.error,
      restore.error,
      markReviewed.error,
      decide.error,
      promote.error,
    ],
  );
  const refusal = firstRefusal([
    update.error,
    archive.error,
    restore.error,
    markReviewed.error,
    decide.error,
    promote.error,
    create.error,
    remove.error,
  ]);

  const changed = editOf(draft, editor.base);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex shrink-0 flex-wrap items-center gap-sm border-0 border-b border-solid border-border-subtle px-[12px] py-[8px]">
        <Button variant="ghost" size="sm" onClick={onClose}>
          ← Library
        </Button>
        <StatusChip tone="neutral">{note.scope}</StatusChip>
        <StatusChip tone="neutral">{note.kind}</StatusChip>
        {note.lifecycle === "active" ? null : (
          <StatusChip
            tone={note.lifecycle === "proposed" ? "amber" : "neutral"}
          >
            {note.lifecycle}
          </StatusChip>
        )}
        <span className="font-mono text-[0.68rem] text-text-tertiary">
          {note.slug} · rev {note.revision} ·{" "}
          {describeMemoryAge(note.updatedAt, now)}
        </span>
      </div>

      {conflict !== null ? (
        <div
          role="alert"
          className="shrink-0 border-0 border-b border-solid border-border-subtle bg-amber-glow px-[12px] py-[8px] font-mono text-[0.72rem] text-amber"
        >
          Another writer advanced {conflict.slug} to revision{" "}
          {conflict.currentRevision}; your edit was refused and nothing was
          written. Reload to see it, then re-apply your change.
        </div>
      ) : refusal !== null ? (
        <div
          role="alert"
          className="shrink-0 border-0 border-b border-solid border-border-subtle bg-red-glow px-[12px] py-[8px] font-mono text-[0.72rem] text-red-text"
        >
          {refusal}
        </div>
      ) : null}

      {lineage.supersededBy === null ? null : (
        <div className="shrink-0 border-0 border-b border-solid border-border-subtle px-[12px] py-[8px] font-mono text-[0.72rem] text-text-tertiary">
          Replaced by{" "}
          <span className="text-text-secondary">{lineage.supersededBy}</span> —
          read that note instead.
        </div>
      )}
      {lineage.supersedes === null ? null : (
        <div className="shrink-0 border-0 border-b border-solid border-border-subtle px-[12px] py-[8px] font-mono text-[0.72rem] text-text-tertiary">
          Supersedes{" "}
          <span className="text-text-secondary">{lineage.supersedes}</span>
        </div>
      )}

      <div className="flex flex-col gap-sm px-[12px] py-[10px]">
        <label className="flex flex-col gap-[4px] font-mono text-[0.68rem] tracking-[0.05em] text-text-tertiary uppercase">
          Hook
          <input
            aria-label="Hook"
            value={draft.hook}
            onChange={(event) =>
              setDraft((current) => ({ ...current, hook: event.target.value }))
            }
            className={FIELD_CLASS}
          />
        </label>
        <label className="flex flex-col gap-[4px] font-mono text-[0.68rem] tracking-[0.05em] text-text-tertiary uppercase">
          Body
          <MultilineInput
            aria-label="Body"
            rows={8}
            value={draft.body}
            onValueChange={(body) =>
              setDraft((current) => ({ ...current, body }))
            }
            className={FIELD_CLASS}
          />
        </label>
        <label className="flex flex-col gap-[4px] font-mono text-[0.68rem] tracking-[0.05em] text-text-tertiary uppercase">
          Status note
          <input
            aria-label="Status note"
            placeholder="the perishable half, leased separately"
            value={draft.statusNote}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                statusNote: event.target.value,
              }))
            }
            className={FIELD_CLASS}
          />
        </label>
        {note.statusNote !== null ? (
          <p className="m-0 font-mono text-[0.7rem] text-text-tertiary">
            {renderMemoryStatusLine(note.statusNote, now)}
          </p>
        ) : null}
        {reLeased === null ? null : (
          <p
            data-testid="memory-status-re-lease"
            className="m-0 font-mono text-[0.7rem] text-text-secondary"
          >
            Re-asserted {renderMemoryStatusLine(reLeased, now)} — leased until{" "}
            {formatLocalTime(reLeased.reviewAfter)}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-sm">
          <Button
            variant="default"
            size="sm"
            disabled={changed === null || update.isPending}
            onClick={() => {
              if (changed === null) return;
              update.mutate({ ...base, fields: changed }, { onSuccess: adopt });
            }}
          >
            {update.isPending ? "Saving…" : "Save note"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={changed === null}
            onClick={() => adopt(editor.base)}
          >
            Revert
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-sm border-0 border-t border-solid border-border-subtle px-[12px] py-[8px]">
        {note.lifecycle === "proposed" ? (
          <>
            <Button
              variant="default"
              size="sm"
              loading={decide.isPending}
              onClick={() => decide.mutate({ ...base, decision: "approve" })}
            >
              Approve
            </Button>
            <Button
              variant="ghost"
              size="sm"
              loading={decide.isPending}
              onClick={() =>
                decide.mutate(
                  { ...base, decision: "reject" },
                  { onSuccess: adopt },
                )
              }
            >
              Reject
            </Button>
          </>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          loading={markReviewed.isPending}
          onClick={() =>
            markReviewed.mutate(
              { ...base, target: "note" },
              { onSuccess: ({ note: reviewed }) => adopt(reviewed) },
            )
          }
        >
          Mark reviewed
        </Button>
        {note.statusNote !== null ? (
          <Button
            variant="ghost"
            size="sm"
            loading={markReviewed.isPending}
            onClick={() =>
              markReviewed.mutate(
                { ...base, target: "statusNote" },
                { onSuccess: ({ note: reviewed }) => adopt(reviewed) },
              )
            }
          >
            Mark status reviewed
          </Button>
        ) : null}
        {note.scope === "session" ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setPendingAct((act) => (act === "promote" ? "none" : "promote"))
            }
          >
            Promote…
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            setPendingAct((act) => (act === "supersede" ? "none" : "supersede"))
          }
        >
          Supersede…
        </Button>
        {note.lifecycle === "archived" ? null : (
          <Button
            variant="ghost"
            size="sm"
            loading={archive.isPending}
            onClick={() => archive.mutate({ ...base }, { onSuccess: adopt })}
          >
            Archive
          </Button>
        )}
        <Button
          variant="danger"
          size="sm"
          // The confirmation closes as soon as it is confirmed (Radix routes
          // the Action through onOpenChange), so the delete's pending state is
          // shown here — at the control that opened it — rather than nowhere.
          loading={remove.isPending}
          onClick={() => setPendingAct("delete")}
        >
          Delete…
        </Button>
      </div>

      {pendingAct === "promote" ? (
        <div className={FORM_CLASS}>
          <p className="m-0 font-mono text-[0.7rem] text-text-tertiary">
            Promotion creates a project-scope note superseding this one. A slug
            already taken at project scope is refused by name — choose another
            rather than accepting a suffix.
          </p>
          <input
            aria-label="Promoted slug"
            placeholder="project-scope slug (optional)"
            value={promotedSlug}
            onChange={(event) => setPromotedSlug(event.target.value)}
            className={FIELD_CLASS}
          />
          <div className="flex items-center gap-sm">
            <Button
              variant="default"
              size="sm"
              loading={promote.isPending}
              onClick={() =>
                promote.mutate(
                  {
                    ...base,
                    ...(promotedSlug.trim() === ""
                      ? {}
                      : { slug: promotedSlug.trim() }),
                  },
                  {
                    onSuccess: (outcome) => {
                      setPendingAct("none");
                      onOpenNote(outcome.promoted.id);
                    },
                  },
                )
              }
            >
              Promote to project
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPendingAct("none")}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {pendingAct === "supersede" ? (
        <div className={FORM_CLASS}>
          <p className="m-0 font-mono text-[0.7rem] text-text-tertiary">
            The successor is created and this note archived in one act, so the
            pair can never be left half-done.
          </p>
          <input
            aria-label="Replacement hook"
            placeholder="what the replacement claims"
            value={successorHook}
            onChange={(event) => setSuccessorHook(event.target.value)}
            className={FIELD_CLASS}
          />
          <div className="flex items-center gap-sm">
            <Button
              variant="default"
              size="sm"
              disabled={successorHook.trim() === ""}
              loading={create.isPending}
              onClick={() =>
                create.mutate(
                  {
                    ref: scopeRef,
                    scope: note.scope,
                    kind: note.kind,
                    hook: successorHook.trim(),
                    body: editor.base.body,
                    supersedes: note.id,
                  },
                  {
                    onSuccess: (successor) => {
                      setPendingAct("none");
                      setSuccessorHook("");
                      onOpenNote(successor.id);
                    },
                  },
                )
              }
            >
              Create successor
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPendingAct("none")}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <MemoryArtifactChips projectName={scopeRef.projectName} links={links} />

      {revisions.length > 0 ? (
        <div className="border-0 border-t border-solid border-border-subtle px-[12px] py-[8px]">
          <span className="font-mono text-[0.68rem] tracking-[0.05em] text-text-tertiary uppercase">
            History
          </span>
          <ul className="m-0 flex list-none flex-col gap-[4px] p-0 pt-[6px]">
            {revisions.map((entry) => (
              <li
                key={entry.revision}
                className="flex items-center gap-sm font-mono text-[0.7rem] text-text-tertiary"
              >
                <span className="min-w-0 flex-1 truncate">
                  rev {entry.revision} · {entry.origin} ·{" "}
                  {describeMemoryAge(entry.createdAt, now)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={restore.isPending}
                  onClick={() =>
                    restore.mutate(
                      { ...base, revision: entry.revision },
                      { onSuccess: adopt },
                    )
                  }
                >
                  {`Restore revision ${entry.revision}`}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ConfirmDialog
        open={pendingAct === "delete"}
        title="Delete memory note"
        message={`Permanently delete "${note.hook}"? Its revision history goes with it. Archiving is the reversible removal.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          setPendingAct("none");
          remove.mutate(
            { ref: scopeRef, handle: note.id, memoryId: note.id },
            { onSuccess: onClose },
          );
        }}
        onCancel={() => setPendingAct("none")}
      />
    </div>
  );
}

const FIELD_CLASS =
  "w-full rounded-sm border border-solid border-border-default bg-bg-base px-[8px] py-[5px] font-mono text-[0.78rem] normal-case tracking-normal text-text-primary placeholder:text-text-tertiary focus:border-cyan-dim focus:[outline:none]";

const FORM_CLASS =
  "flex flex-col gap-sm border-0 border-t border-solid border-border-subtle bg-bg-base px-[12px] py-[10px]";

interface NoteDraft {
  hook: string;
  body: string;
  statusNote: string;
}

function draftOf(note: MemoryNote): NoteDraft {
  return {
    hook: note.hook,
    body: note.body,
    statusNote: note.statusNote?.text ?? "",
  };
}

function isClean(draft: NoteDraft, note: MemoryNote): boolean {
  const saved = draftOf(note);
  return (
    draft.hook === saved.hook &&
    draft.body === saved.body &&
    draft.statusNote === saved.statusNote
  );
}

/**
 * Only the fields the human actually changed. Sending the untouched ones would
 * make every save a rewrite of the whole record, and a status line the user
 * never opened would be re-stamped as freshly written.
 */
function editOf(draft: NoteDraft, note: MemoryNote): MemoryNoteEdit | null {
  const saved = draftOf(note);
  const edit: MemoryNoteEdit = {};
  if (draft.hook !== saved.hook) edit.hook = draft.hook;
  if (draft.body !== saved.body) edit.body = draft.body;
  if (draft.statusNote !== saved.statusNote) {
    edit.statusNote = draft.statusNote.trim() === "" ? null : draft.statusNote;
  }
  return Object.keys(edit).length === 0 ? null : edit;
}

/** The first non-CAS refusal message, so a typed refusal is shown verbatim. */
function firstRefusal(errors: readonly unknown[]): string | null {
  for (const error of errors) {
    if (error instanceof Error && staleRevisionOf(error) === null) {
      return error.message;
    }
  }
  return null;
}
