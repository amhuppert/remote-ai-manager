"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import {
  NotepadEditor,
  type NotepadEditorHandle,
} from "@/components/notepad/NotepadEditor";
import { NotepadPreview } from "@/components/notepad/NotepadPreview";
import { useNotepadDetailQuery } from "@/lib/notepads/queries";
import {
  useRestoreNotepadRevisionMutation,
  useUpdateNotepadMutation,
  useWriteNotepadContentMutation,
} from "@/lib/notepads/mutations";
import type {
  Notepad,
  NotepadAuthorKind,
  NotepadWriteMode,
} from "@/lib/notepads/schemas";
import {
  useCloseNotepad,
  useNotepadExternalWrite,
} from "@/stores/session-detail.store";
import NotepadHistory from "./NotepadHistory";
import { NameInput } from "./NotepadPanel";

export interface NotepadOpenViewProps {
  notepadId: string;
  projectName: string;
  sessionName: string;
  conversationId: string;
  active: boolean;
}

const WRITE_MODE_LABEL: Record<NotepadWriteMode, string> = {
  "read-only": "read only",
  "append-only": "append only",
  "full-edit": "full edit",
};

/** One editing burst persists as one revision: idle flush with a max-wait. */
const AUTOSAVE_IDLE_MS = 1500;
const AUTOSAVE_MAX_WAIT_MS = 5000;
/** A failed flush retries after a beat instead of hammering the route. */
const AUTOSAVE_RETRY_MS = 5000;
/**
 * Failed-flush retries are bounded so a closed view cannot keep retrying
 * forever from its detached autosave state; a fresh keystroke re-arms them.
 */
const AUTOSAVE_MAX_RETRIES = 3;

/**
 * The live-update surface over the editor (design prototype page 04): a landed
 * external write over a clean buffer, the collision notice over a dirty one,
 * and the nothing-lost reassurance once the colliding draft saves.
 */
type LiveBanner =
  | { kind: "landed"; revision: number; authorKind: NotepadAuthorKind }
  | { kind: "collision"; revision: number; authorKind: NotepadAuthorKind }
  | {
      kind: "saved";
      savedRevision: number;
      preservedRevision: number;
      preservedAuthorKind: NotepadAuthorKind;
    };

function authorKindLabel(authorKind: NotepadAuthorKind): string {
  return authorKind === "user" ? "you" : "agent";
}

interface CollidingWrite {
  revision: number;
  authorKind: NotepadAuthorKind;
}

/** The colliding write the banner should track is always the newest one. */
function newestWrite(
  a: CollidingWrite | null,
  b: CollidingWrite | null,
): CollidingWrite | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.revision >= b.revision ? a : b;
}

interface AutosaveState {
  /** The latest serialized canonical text — what the next flush persists. */
  text: string;
  /** The text the server last acknowledged as the head. */
  savedText: string;
  /** The head revision the next flush states as its base. */
  baseRevision: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  /**
   * The in-flight flush request including its settle bookkeeping, awaitable
   * by a restore: a flush already posted must land beneath the restore, so
   * the restore waits for this before sending. Null when no flush is out.
   */
  flight: Promise<void> | null;
  /**
   * A restore of ours is awaiting its response. Restores are user-authored
   * local writes exactly like autosave flushes, so their SSE echoes need the
   * same parking-and-adjudication treatment.
   */
  restoreInFlight: boolean;
  /**
   * User-authored change events that arrived while one of our writes (a flush
   * or a restore) was in flight. The event stream carries no client identity,
   * so our own write's echo and another session's user write look identical
   * until our response reveals our revision; these park until that
   * adjudication.
   */
  pendingExternalEvents: CollidingWrite[];
  retriesLeft: number;
  initialized: boolean;
}

/**
 * One open notepad: header (back, inline rename, agent write mode, history,
 * export) over the chip-bearing editor with its live preview. The write-mode
 * control governs agents only — the user's own edits are never mode-checked.
 *
 * Edits persist without a save action: serialization is debounced (~1.5s idle
 * with a max-wait) and flushed on close/blur, each flush posting the canonical
 * text with the base revision the editor loaded. A user write is always
 * accepted server-side — a stale base still lands as the new head — and the
 * returned head revision is adopted as the next flush's base.
 */
export default function NotepadOpenView({
  notepadId,
  projectName,
  sessionName,
  conversationId,
  active,
}: NotepadOpenViewProps): React.JSX.Element {
  const closeNotepad = useCloseNotepad();
  const detailQuery = useNotepadDetailQuery(notepadId, { enabled: active });
  const updateMutation = useUpdateNotepadMutation();
  const writeContentMutation = useWriteNotepadContentMutation();
  const restoreMutation = useRestoreNotepadRevisionMutation();

  const editorRef = useRef<NotepadEditorHandle>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [liveBanner, setLiveBanner] = useState<LiveBanner | null>(null);
  /** The revision a diff affordance routed to history, or null when none. */
  const [historyDiffTarget, setHistoryDiffTarget] = useState<number | null>(
    null,
  );
  const externalWrite = useNotepadExternalWrite();

  const openHistoryAtDiff = useCallback((revision: number) => {
    setLiveBanner(null);
    setHistoryDiffTarget(revision);
    setHistoryOpen(true);
  }, []);

  const notepad = detailQuery.data;

  const autosaveRef = useRef<AutosaveState>({
    text: "",
    savedText: "",
    baseRevision: 0,
    idleTimer: null,
    maxTimer: null,
    inFlight: false,
    flight: null,
    restoreInFlight: false,
    pendingExternalEvents: [],
    retriesLeft: AUTOSAVE_MAX_RETRIES,
    initialized: false,
  });
  // Bumped when a flush settles, so effects gated on inFlight re-evaluate:
  // a head that advanced externally during the flight must be adoptable the
  // moment the flight ends, not only when some unrelated render happens.
  const [flushEpoch, setFlushEpoch] = useState(0);
  // Adopt the loaded head exactly once; later refetches must not clobber the
  // buffer the user is editing (external revisions arrive via setContent).
  if (notepad && !autosaveRef.current.initialized) {
    autosaveRef.current.text = notepad.content;
    autosaveRef.current.savedText = notepad.content;
    autosaveRef.current.baseRevision = notepad.revision;
    autosaveRef.current.initialized = true;
  }

  /**
   * Drops our own write's echo from the parked events and, when no other
   * local write is still in flight, empties the queue and returns the newest
   * genuinely external write. While another of our writes is pending, parked
   * events stay parked — that write's response adjudicates them.
   */
  const settleParkedEvents = useCallback(
    (ownRevision: number | null): CollidingWrite | null => {
      const state = autosaveRef.current;
      if (ownRevision !== null) {
        state.pendingExternalEvents = state.pendingExternalEvents.filter(
          (event) => event.revision !== ownRevision,
        );
      }
      if (state.inFlight || state.restoreInFlight) return null;
      const external =
        state.pendingExternalEvents.reduce<CollidingWrite | null>(
          newestWrite,
          null,
        );
      state.pendingExternalEvents = [];
      return external;
    },
    [],
  );

  /**
   * Banner state after one of our writes (flush or restore) landed as
   * `savedRevision`. Newest colliding write wins: an older parked user event
   * must not displace a later write the banner already tracks — the indicator
   * (and its View diff) names the revision the editor lands on.
   */
  const reconcileBannerAfterOwnWrite = useCallback(
    (
      savedRevision: number,
      external: CollidingWrite | null,
      dirty: boolean,
    ): void => {
      setLiveBanner((banner) => {
        const colliding = newestWrite(
          external,
          banner?.kind === "collision"
            ? { revision: banner.revision, authorKind: banner.authorKind }
            : null,
        );
        if (colliding === null) return banner;
        if (colliding.revision > savedRevision) {
          // The other party's write outranks ours: it is the head and our
          // save is the history entry — clean, it lands in the editor;
          // dirty, the draft still collides with it.
          return {
            kind: dirty ? "collision" : "landed",
            revision: colliding.revision,
            authorKind: colliding.authorKind,
          };
        }
        // Our write landed over the colliding revision: it is the new head
        // and the colliding revision sits safely in history.
        return {
          kind: "saved",
          savedRevision,
          preservedRevision: colliding.revision,
          preservedAuthorKind: colliding.authorKind,
        };
      });
    },
    [],
  );

  /** External writes surfaced with no own write to compare against. */
  const reconcileBannerExternalOnly = useCallback(
    (external: CollidingWrite | null, dirty: boolean): void => {
      if (external === null) return;
      setLiveBanner((banner) => {
        const colliding = newestWrite(
          external,
          banner?.kind === "collision"
            ? { revision: banner.revision, authorKind: banner.authorKind }
            : null,
        );
        if (colliding === null) return banner;
        return {
          kind: dirty ? "collision" : "landed",
          revision: colliding.revision,
          authorKind: colliding.authorKind,
        };
      });
    },
    [],
  );

  const writeContentRef = useRef(writeContentMutation.mutateAsync);
  writeContentRef.current = writeContentMutation.mutateAsync;

  const flush = useCallback(() => {
    const state = autosaveRef.current;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    if (state.maxTimer) clearTimeout(state.maxTimer);
    state.idleTimer = null;
    state.maxTimer = null;
    if (!state.initialized || state.inFlight) return;
    // A requested restore owns the head: committing the pre-restore draft now
    // would overwrite the revision the user explicitly chose. The restore's
    // settle paths re-run flush for anything still unsaved.
    if (state.restoreInFlight) return;
    if (state.text === state.savedText) return;

    const content = state.text;
    state.inFlight = true;
    // mutateAsync, not mutate: per-call mutate callbacks never run once the
    // mutation observer unmounts, but the close-flush must still chase an edit
    // typed while a save was in flight. The returned promise settles either
    // way, and the captured state object outlives the component.
    // The whole chain (response + bookkeeping) is the awaitable flight, so a
    // restore waiting on it resumes with the base revision already adopted.
    state.flight = writeContentRef
      .current({ notepadId, content, baseRevision: state.baseRevision })
      .then((saved) => {
        state.flight = null;
        // A response can settle after a restore already adopted a newer head;
        // regressing to this older base would resurrect the flushed draft and
        // re-post it over the restored revision.
        if (saved.revision > state.baseRevision) {
          state.baseRevision = saved.revision;
          state.savedText = content;
        }
        state.retriesLeft = AUTOSAVE_MAX_RETRIES;
        state.inFlight = false;
        // Our response reveals our own revision: a parked user-authored event
        // with that revision was our echo; any other parked event is another
        // party's genuine write.
        const external = settleParkedEvents(saved.revision);
        const dirty = state.text !== state.savedText;
        reconcileBannerAfterOwnWrite(saved.revision, external, dirty);
        setFlushEpoch((epoch) => epoch + 1);
        // An edit made mid-flight goes out immediately rather than waiting
        // for another keystroke.
        if (dirty) flush();
      })
      .catch(() => {
        state.flight = null;
        state.inFlight = false;
        const willRetry =
          state.text !== state.savedText && state.retriesLeft > 0;
        // A failed HTTP response does not prove the write failed to commit:
        // our echo may be among the parked events. When a retry is coming,
        // leave them parked — the retry's response adjudicates them. Only
        // classify when no retry will run, as the best remaining effort.
        if (!willRetry) {
          reconcileBannerExternalOnly(
            settleParkedEvents(null),
            state.text !== state.savedText,
          );
        }
        setFlushEpoch((epoch) => epoch + 1);
        if (willRetry) {
          state.retriesLeft -= 1;
          state.idleTimer = setTimeout(flush, AUTOSAVE_RETRY_MS);
        }
      });
  }, [
    notepadId,
    settleParkedEvents,
    reconcileBannerAfterOwnWrite,
    reconcileBannerExternalOnly,
  ]);

  const handleContentChange = useCallback(
    (text: string) => {
      const state = autosaveRef.current;
      state.text = text;
      state.retriesLeft = AUTOSAVE_MAX_RETRIES;
      setDraft(text);
      if (state.idleTimer) clearTimeout(state.idleTimer);
      state.idleTimer = setTimeout(flush, AUTOSAVE_IDLE_MS);
      state.maxTimer ??= setTimeout(flush, AUTOSAVE_MAX_WAIT_MS);
    },
    [flush],
  );

  // Flush on close (unmount — the view is keyed by notepad id) and on blur.
  useEffect(() => {
    window.addEventListener("blur", flush);
    return () => {
      window.removeEventListener("blur", flush);
      flush();
    };
  }, [flush]);

  /** A restore (or applied external revision) becomes the editor's new base. */
  const adoptHead = useCallback((head: Notepad) => {
    const state = autosaveRef.current;
    state.text = head.content;
    state.savedText = head.content;
    state.baseRevision = head.revision;
    editorRef.current?.setContent(head.content);
    setDraft(head.content);
  }, []);

  const restoreRef = useRef(restoreMutation.mutate);
  restoreRef.current = restoreMutation.mutate;

  /**
   * True from the Restore click until its settle: the editor is read-only for
   * this window, because an edit typed under a pending restore would be
   * clobbered the moment the restored head is adopted — refusing input is the
   * only way nothing gets silently discarded.
   */
  const [restoring, setRestoring] = useState(false);

  /**
   * Restores run here rather than in the history drawer so their SSE echoes
   * get the same adjudication as autosave echoes: a restore is our own
   * user-authored write, and its change event arriving before this response
   * must not be mislabeled as another party's landed or colliding write.
   */
  const handleRestore = useCallback(
    (revision: number) => {
      const state = autosaveRef.current;
      if (state.restoreInFlight) return;
      state.restoreInFlight = true;
      setRestoring(true);
      void (async () => {
        // A flush already posted must land beneath the restore, not race it
        // to the service: wait for its response (and base bookkeeping), so
        // the restore commits after it and stays the head. A timer-armed
        // flush that has NOT posted yet is different — restoreInFlight defers
        // it, and success abandons the draft the user restored over.
        while (state.flight !== null) {
          await state.flight;
        }
        restoreRef.current(
          { notepadId, revision },
          {
            onSuccess: (head) => {
              state.restoreInFlight = false;
              setRestoring(false);
              // The response reveals the restore's own revision: drop its
              // echo, surface any genuinely external write parked during the
              // flight.
              const external = settleParkedEvents(head.revision);
              adoptHead(head);
              // The landed indicator names the head the view actually
              // adopted.
              reconcileBannerAfterOwnWrite(head.revision, external, false);
            },
            onError: () => {
              state.restoreInFlight = false;
              setRestoring(false);
              reconcileBannerExternalOnly(
                settleParkedEvents(null),
                state.text !== state.savedText,
              );
              // The restore never landed, so the draft it deferred still
              // stands — resume autosaving it.
              if (state.text !== state.savedText) flush();
            },
          },
        );
      })();
    },
    [
      notepadId,
      adoptHead,
      flush,
      settleParkedEvents,
      reconcileBannerAfterOwnWrite,
      reconcileBannerExternalOnly,
    ],
  );

  // Attribute an external head advance the moment its change event arrives:
  // clean buffer → the landed-write strip; dirty buffer → the collision
  // notice. Content is not touched here — the clean case adopts it below once
  // the invalidated detail query delivers it.
  useEffect(() => {
    if (!externalWrite || externalWrite.notepadId !== notepadId) return;
    const state = autosaveRef.current;
    if (!state.initialized) return;
    if (externalWrite.revision <= state.baseRevision) return;
    // A user-authored event during our own flight (an autosave flush or a
    // restore) is ambiguous: it may be our write's SSE echo outrunning its
    // HTTP response, or another session's genuine write — the event carries
    // no client identity. Park it; our response reveals our revision and
    // adjudicates.
    if (
      externalWrite.authorKind === "user" &&
      (state.inFlight || state.restoreInFlight)
    ) {
      state.pendingExternalEvents.push({
        revision: externalWrite.revision,
        authorKind: externalWrite.authorKind,
      });
      return;
    }
    const dirty =
      state.text !== state.savedText || state.inFlight || state.restoreInFlight;
    setLiveBanner({
      kind: dirty ? "collision" : "landed",
      revision: externalWrite.revision,
      authorKind: externalWrite.authorKind,
    });
  }, [externalWrite, notepadId]);

  // Apply an externally advanced head to the open editor — but only over a
  // clean buffer. Unsaved local edits are never clobbered: the dirty buffer
  // stays as typed, and its next flush becomes the new head (the external
  // revision already sits in history).
  // flushEpoch re-runs this when a flight settles: an external head cached
  // during the flight must be adopted then, not on a later unrelated render.
  useEffect(() => {
    if (!notepad) return;
    const state = autosaveRef.current;
    if (!state.initialized) return;
    if (notepad.revision <= state.baseRevision) return;
    if (state.text !== state.savedText || state.inFlight) return;
    // A restore in flight adopts its own response; adopting a cached head
    // underneath it would thrash the buffer between two heads.
    if (state.restoreInFlight) return;
    adoptHead(notepad);
  }, [notepad, adoptHead, flushEpoch]);

  const currentText = draft ?? notepad?.content ?? "";

  const copyAsMarkdown = useCallback(() => {
    // Flush first so the copied text and the persisted canonical text agree.
    flush();
    // The autosave buffer, not editor serialization: the buffer starts as the
    // stored text verbatim and only becomes serializer output after a real
    // edit, so an unedited notepad copies byte-identical to its agent-visible
    // form (the editor round-trip normalizes CRLF and other syntax).
    const state = autosaveRef.current;
    const text = state.initialized ? state.text : currentText;
    void navigator.clipboard.writeText(text);
  }, [flush, currentText]);

  if (detailQuery.isLoading) {
    return (
      <EmptyState layoutClassName="min-h-0 flex-1">
        <EmptyStateTitle>Loading notepad…</EmptyStateTitle>
      </EmptyState>
    );
  }

  if (!notepad) {
    return (
      <EmptyState layoutClassName="min-h-0 flex-1">
        <EmptyStateTitle>Notepad not found</EmptyStateTitle>
        <EmptyStateDesc>
          It may have been deleted. Go back to browse the rest.
        </EmptyStateDesc>
        <Button variant="default" size="sm" onClick={closeNotepad}>
          Back to notepads
        </Button>
      </EmptyState>
    );
  }

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-x-sm gap-y-[4px] border-0 border-b border-solid border-border-subtle px-[10px] py-[6px]">
        <button
          type="button"
          aria-label="Back to notepads"
          onClick={closeNotepad}
          className="inline-flex h-[24px] shrink-0 cursor-pointer items-center gap-[4px] rounded-sm border border-solid border-transparent bg-transparent px-[4px] font-mono text-[0.72rem] text-text-secondary transition-colors duration-150 ease-[ease] hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px]"
        >
          ‹ Notepads
        </button>
        {renaming ? (
          <NameInput
            initialValue={notepad.name}
            onCommit={(name) => {
              setRenaming(false);
              if (name.length > 0 && name !== notepad.name) {
                updateMutation.mutate({ notepadId, fields: { name } });
              }
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <button
            type="button"
            aria-label="Rename notepad"
            title="Rename"
            onClick={() => setRenaming(true)}
            className="min-w-0 flex-1 cursor-text truncate border-0 bg-transparent px-0 text-left font-mono text-[0.82rem] font-semibold text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[2px]"
          >
            {notepad.name}
          </button>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-[6px]">
          <Select
            value={notepad.writeMode}
            onValueChange={(value) => {
              if (
                value === "read-only" ||
                value === "append-only" ||
                value === "full-edit"
              ) {
                updateMutation.mutate({
                  notepadId,
                  fields: { writeMode: value },
                });
              }
            }}
          >
            <SelectTrigger aria-label="Agent write mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                value="read-only"
                description="agents can read, never write"
              >
                {WRITE_MODE_LABEL["read-only"]}
              </SelectItem>
              <SelectItem
                value="append-only"
                description="agents add to the end, never rewrite"
              >
                {WRITE_MODE_LABEL["append-only"]}
              </SelectItem>
              <SelectItem
                value="full-edit"
                description="agents edit anywhere · history covers restores"
              >
                {WRITE_MODE_LABEL["full-edit"]}
              </SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={historyOpen}
            onClick={() => {
              // A manual open starts neutral — no revision pre-selected.
              setHistoryDiffTarget(null);
              setHistoryOpen((value) => !value);
            }}
          >
            History
          </Button>
          <Button variant="ghost" size="sm" onClick={copyAsMarkdown}>
            Copy as Markdown
          </Button>
        </div>
      </div>

      {liveBanner ? (
        <div
          data-testid="notepad-live-banner"
          className="flex shrink-0 flex-wrap items-center gap-x-sm gap-y-[4px] border-0 border-b border-solid border-border-subtle bg-bg-base px-[10px] py-[6px] font-mono text-[0.72rem]"
        >
          {liveBanner.kind === "landed" ? (
            <>
              <span className="text-cyan">
                {authorKindLabel(liveBanner.authorKind)} wrote rev{" "}
                {liveBanner.revision} · just now
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-[6px]">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openHistoryAtDiff(liveBanner.revision)}
                >
                  View diff
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setLiveBanner(null)}
                >
                  Dismiss
                </Button>
              </div>
            </>
          ) : liveBanner.kind === "collision" ? (
            <>
              <span className="min-w-0 flex-1 text-text-primary">
                <span className="text-amber">
                  {authorKindLabel(liveBanner.authorKind)} wrote rev{" "}
                  {liveBanner.revision} while you were editing.
                </span>{" "}
                <span className="text-text-secondary">
                  Your draft is untouched and will save as the new head. Rev{" "}
                  {liveBanner.revision} is already in history.
                </span>
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-[6px]">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openHistoryAtDiff(liveBanner.revision)}
                >
                  Review rev {liveBanner.revision}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setLiveBanner(null)}
                >
                  Dismiss
                </Button>
              </div>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1 text-text-secondary">
                Saved as rev {liveBanner.savedRevision}. Rev{" "}
                {liveBanner.preservedRevision} (
                {authorKindLabel(liveBanner.preservedAuthorKind)}) is preserved
                in history — nothing lost.
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLiveBanner(null)}
              >
                Dismiss
              </Button>
            </>
          )}
        </div>
      ) : null}

      {historyOpen ? (
        <NotepadHistory
          notepadId={notepadId}
          headRevision={notepad.revision}
          onRestore={handleRestore}
          restorePending={restoring}
          diffTarget={historyDiffTarget}
        />
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        <NotepadEditor
          ref={editorRef}
          notepadId={notepadId}
          initialContent={notepad.content}
          readOnly={restoring}
          onContentChange={handleContentChange}
          projectName={projectName}
          sessionName={sessionName}
          conversationId={conversationId}
        />
        <div className="flex shrink-0 items-center border-0 border-t border-solid border-border-subtle px-[10px] py-[4px]">
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={previewOpen}
            onClick={() => setPreviewOpen((value) => !value)}
          >
            Preview
          </Button>
        </div>
        {previewOpen ? (
          <div className="max-h-[45%] min-h-0 shrink-0 overflow-y-auto border-0 border-t border-solid border-border-subtle bg-bg-base px-[14px] py-[10px]">
            <NotepadPreview notepadId={notepadId} content={currentText} />
          </div>
        ) : null}
      </div>
    </>
  );
}
