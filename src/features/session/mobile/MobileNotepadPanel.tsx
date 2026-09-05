"use client";

import { useMemo, useState } from "react";
import NotepadPanel from "@/features/session/conversation/NotepadPanel";
import { createClientLogger } from "@/lib/logging/client-logger";
import { cn } from "@/lib/ui/cn";
import { Button } from "@/components/ui/Button";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import { Dialog, DialogContent } from "@/components/ui/Dialog";
import { NotepadPreview } from "@/components/notepad/NotepadPreview";
import { formatRelativeTime } from "@/lib/shared/format-relative-time";
import {
  useNotepadDetailQuery,
  useNotepadPanelListQuery,
  useNotepadRevisionsQuery,
} from "@/lib/notepads/queries";
import {
  useCreateNotepadMutation,
  useUpdateNotepadMutation,
} from "@/lib/notepads/mutations";
import type {
  NotepadListItem,
  NotepadScope,
  NotepadWriteMode,
} from "@/lib/notepads/schemas";
import {
  useCloseNotepad,
  useOpenNotepad,
  useOpenNotepadId,
} from "@/stores/session-detail.store";

export interface MobileNotepadPanelProps {
  projectName: string;
  sessionName: string;
  conversationId: string;
}

const log = createClientLogger("mobile-notepad-panel");

const WRITE_MODE_LABEL: Record<NotepadWriteMode, string> = {
  "read-only": "read only",
  "append-only": "append only",
  "full-edit": "full edit",
};

const SECTION_HEADER_CLASS =
  "flex items-center bg-bg-raised px-[16px] py-[4px] font-mono text-[0.68rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase";

/**
 * The mobile Notepad surface (design prototype page 07): a full-screen panel
 * behind the bottom-bar Notepad entry — browse, open, read, and the agent
 * write-mode control. The management view exposes editing and organization.
 * Hidden above the mobile breakpoint — desktop notepads live in the right pane.
 */
export default function MobileNotepadPanel({
  projectName,
  sessionName,
  conversationId,
}: MobileNotepadPanelProps): React.JSX.Element {
  const openNotepadId = useOpenNotepadId();
  const [managing, setManaging] = useState(false);

  return (
    <div
      data-testid="mobile-notepad-panel"
      className="hidden min-h-0 min-w-0 flex-1 flex-col bg-bg-surface max-768:flex"
    >
      <div className="flex shrink-0 justify-end border-b border-solid border-border-subtle px-sm py-xs">
        <Button
          touch
          size="sm"
          variant="ghost"
          onClick={() => {
            log.debug("management.toggled", { open: !managing });
            setManaging(!managing);
          }}
        >
          {managing ? "Back to reading" : "Manage notepads"}
        </Button>
      </div>
      {managing ? (
        <NotepadPanel
          projectName={projectName}
          sessionName={sessionName}
          conversationId={conversationId}
          active
        />
      ) : openNotepadId !== null ? (
        <MobileNotepadReadView key={openNotepadId} notepadId={openNotepadId} />
      ) : (
        <MobileNotepadBrowseView projectName={projectName} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Glyphs (design prototype page 07, frame A)
// ---------------------------------------------------------------------------

function ScopeGlyph({ scope }: { scope: NotepadScope }): React.JSX.Element {
  if (scope === "project") {
    return (
      <svg
        role="img"
        aria-label="Project scope"
        width="15"
        height="15"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="shrink-0 text-blue"
      >
        <path d="M9.5 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z" />
        <path d="M9.5 2v3.5H13" />
        <path d="M5.5 8.5h5M5.5 11h3.5" />
      </svg>
    );
  }
  return (
    <svg
      role="img"
      aria-label="Global scope"
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      className="shrink-0 text-text-tertiary"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c2 2.2 2 9.8 0 12-2-2.2-2-9.8 0-12z" />
    </svg>
  );
}

/** Shown only for non-default modes: the default (full edit) carries no lock. */
function WriteModeLock({
  writeMode,
}: {
  writeMode: NotepadWriteMode;
}): React.JSX.Element | null {
  if (writeMode === "full-edit") return null;
  return (
    <svg
      role="img"
      aria-label={`agents: ${WRITE_MODE_LABEL[writeMode]}`}
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      className="shrink-0 text-text-tertiary"
    >
      <rect x="4" y="7.5" width="8" height="6" rx="1" />
      <path d="M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

interface MobileNotepadBrowseViewProps {
  projectName: string;
}

function MobileNotepadBrowseView({
  projectName,
}: MobileNotepadBrowseViewProps): React.JSX.Element {
  const openNotepad = useOpenNotepad();
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [creating, setCreating] = useState(false);

  // Archived rows always ride the fetch: the collapsed Archived row names its
  // count before the section is expanded. Sort is fixed to recency — the
  // mobile browse has no sort control and its section header says "Recent".
  const listQuery = useNotepadPanelListQuery(projectName, "recency", true);

  const rows = useMemo(() => listQuery.data ?? [], [listQuery.data]);
  const sections = useMemo(() => {
    const current = rows.filter((row) => !row.archived);
    return {
      pinned: current.filter((row) => row.pinned),
      recent: current.filter((row) => !row.pinned),
      archived: rows.filter((row) => row.archived),
      currentCount: current.length,
    };
  }, [rows]);

  const renderRow = (row: NotepadListItem) => (
    <MobileNotepadRow
      key={row.id}
      row={row}
      onOpen={() => openNotepad(row.id)}
    />
  );

  return (
    <>
      <div className="flex min-h-[48px] shrink-0 items-center gap-sm border-0 border-b border-solid border-border-subtle bg-bg-base px-[16px] py-[4px]">
        <span className="font-mono text-[0.78rem] font-semibold tracking-[0.08em] text-text-secondary uppercase">
          Notepads
        </span>
        <span className="font-mono text-[0.72rem] text-text-tertiary">
          {sections.currentCount}
        </span>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="ml-auto inline-flex min-h-[44px] shrink-0 cursor-pointer items-center gap-[6px] rounded-sm border border-solid border-border-default bg-bg-raised px-[14px] font-mono text-[0.76rem] text-text-primary transition-colors duration-150 ease-[ease] hover:bg-bg-hover focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px]"
        >
          <svg
            aria-hidden="true"
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M8 3v10M3 8h10" />
          </svg>
          New
        </button>
      </div>

      {creating ? (
        <MobileNotepadCreateForm
          projectName={projectName}
          onCreated={(notepadId) => {
            setCreating(false);
            openNotepad(notepadId);
          }}
          onCancel={() => setCreating(false)}
        />
      ) : null}

      {listQuery.isLoading ? (
        <EmptyState layoutClassName="min-h-0 flex-1">
          <EmptyStateTitle>Loading notepads…</EmptyStateTitle>
        </EmptyState>
      ) : listQuery.isError ? (
        <EmptyState layoutClassName="min-h-0 flex-1">
          <EmptyStateTitle>Could not load notepads</EmptyStateTitle>
        </EmptyState>
      ) : rows.length === 0 && !creating ? (
        <EmptyState layoutClassName="min-h-0 flex-1">
          <EmptyStateTitle>No notepads</EmptyStateTitle>
          <EmptyStateDesc>
            Durable, reference-aware notes. They outlive this session and follow
            the project.
          </EmptyStateDesc>
          <Button variant="default" size="sm" onClick={() => setCreating(true)}>
            New notepad
          </Button>
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {sections.pinned.length > 0 ? (
            <>
              <div className={SECTION_HEADER_CLASS}>Pinned</div>
              {sections.pinned.map(renderRow)}
            </>
          ) : null}
          {sections.recent.length > 0 ? (
            <>
              {sections.pinned.length > 0 ? (
                <div className={SECTION_HEADER_CLASS}>Recent</div>
              ) : null}
              {sections.recent.map(renderRow)}
            </>
          ) : null}
          {sections.archived.length > 0 ? (
            <>
              <button
                type="button"
                aria-expanded={archivedExpanded}
                onClick={() => setArchivedExpanded((value) => !value)}
                className="flex min-h-[48px] w-full cursor-pointer items-center gap-sm border-0 border-t border-solid border-border-subtle bg-transparent px-[16px] py-[4px] text-left font-mono text-[0.74rem] text-text-tertiary transition-colors duration-150 ease-[ease] hover:bg-bg-hover focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px]"
              >
                <svg
                  aria-hidden="true"
                  width="10"
                  height="10"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className={cn(
                    "shrink-0 transition-transform duration-150 ease-[ease]",
                    archivedExpanded && "rotate-90",
                  )}
                >
                  <path d="M6 3l5 5-5 5" />
                </svg>
                Archived {sections.archived.length}
              </button>
              {archivedExpanded ? sections.archived.map(renderRow) : null}
            </>
          ) : null}
        </div>
      )}
    </>
  );
}

interface MobileNotepadRowProps {
  row: NotepadListItem;
  onOpen(): void;
}

function MobileNotepadRow({
  row,
  onOpen,
}: MobileNotepadRowProps): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={`Open notepad ${row.name}`}
      onClick={onOpen}
      className="flex min-h-[48px] w-full cursor-pointer items-center gap-[10px] border-0 bg-transparent px-[16px] py-[4px] text-left transition-colors duration-150 ease-[ease] hover:bg-bg-hover focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px]"
    >
      <ScopeGlyph scope={row.scope} />
      <span className="min-w-0 flex-1 truncate font-mono text-[0.84rem] font-medium text-text-primary">
        {row.name}
      </span>
      <WriteModeLock writeMode={row.writeMode} />
      <span className="shrink-0 font-mono text-[0.72rem] text-text-tertiary">
        {formatRelativeTime(row.updatedAt)}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

interface MobileNotepadCreateFormProps {
  projectName: string;
  onCreated(notepadId: string): void;
  onCancel(): void;
}

function MobileNotepadCreateForm({
  projectName,
  onCreated,
  onCancel,
}: MobileNotepadCreateFormProps): React.JSX.Element {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<NotepadScope>("project");
  const createMutation = useCreateNotepadMutation();

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || createMutation.isPending) return;
    createMutation.mutate(
      {
        scope,
        ...(scope === "project" ? { projectName } : {}),
        name: trimmed,
      },
      { onSuccess: (notepad) => onCreated(notepad.id) },
    );
  };

  return (
    <div className="flex shrink-0 flex-col gap-sm border-0 border-b border-solid border-border-subtle bg-bg-base px-[16px] py-[10px]">
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus -- the form appears from an explicit "New" action; focus belongs in the field
        autoFocus
        aria-label="Notepad name"
        placeholder="Notepad name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        className="min-h-[44px] rounded-sm border border-solid border-border-default bg-bg-surface px-[12px] font-mono text-[0.82rem] text-text-primary placeholder:text-text-tertiary focus:border-cyan-dim focus:[outline:none]"
      />
      <div className="flex items-center gap-sm">
        <SegmentedControl
          value={scope}
          onValueChange={(value) => {
            if (value === "project" || value === "global") setScope(value);
          }}
          aria-label="Notepad scope"
        >
          <SegmentedControlItem value="project">project</SegmentedControlItem>
          <SegmentedControlItem value="global">global</SegmentedControlItem>
        </SegmentedControl>
        <div className="ml-auto flex items-center gap-sm">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex min-h-[44px] cursor-pointer items-center rounded-sm border border-solid border-transparent bg-transparent px-[14px] font-mono text-[0.78rem] text-text-secondary transition-colors duration-150 ease-[ease] hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={createMutation.isPending || name.trim().length === 0}
            onClick={submit}
            className="inline-flex min-h-[44px] cursor-pointer items-center rounded-sm border border-solid border-border-default bg-bg-raised px-[14px] font-mono text-[0.78rem] text-text-primary transition-colors duration-150 ease-[ease] hover:bg-bg-hover disabled:cursor-default disabled:opacity-50 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px]"
          >
            {createMutation.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
      {createMutation.isError ? (
        <div role="alert" className="font-mono text-[0.72rem] text-red-text">
          {createMutation.error.message}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read (design prototype page 07, frames B and C)
// ---------------------------------------------------------------------------

interface MobileNotepadReadViewProps {
  notepadId: string;
}

function MobileNotepadReadView({
  notepadId,
}: MobileNotepadReadViewProps): React.JSX.Element {
  const closeNotepad = useCloseNotepad();
  const detailQuery = useNotepadDetailQuery(notepadId);
  // The head revision's author for the meta line; writes invalidate the same
  // cache keys, so external updates land here without extra wiring.
  const revisionsQuery = useNotepadRevisionsQuery(notepadId, { limit: 1 });
  const updateMutation = useUpdateNotepadMutation();
  const [sheetOpen, setSheetOpen] = useState(false);
  const notepad = detailQuery.data;

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

  const headAuthorKind = revisionsQuery.data?.[0]?.authorKind;
  const metaLine = [
    `rev ${notepad.revision}`,
    ...(headAuthorKind ? [headAuthorKind === "user" ? "you" : "agent"] : []),
    formatRelativeTime(notepad.updatedAt),
  ].join(" · ");

  return (
    <>
      <div className="flex min-h-[48px] shrink-0 items-center gap-sm border-0 border-b border-solid border-border-subtle bg-bg-base px-[12px] py-[4px]">
        <button
          type="button"
          aria-label="Back to notepads"
          onClick={closeNotepad}
          className="inline-flex h-[44px] w-[44px] shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-text-secondary transition-colors duration-150 ease-[ease] hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px]"
        >
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M10 3L5 8l5 5" />
          </svg>
        </button>
        <ScopeGlyph scope={notepad.scope} />
        <span className="min-w-0 flex-1 truncate font-mono text-[0.86rem] font-semibold text-text-primary">
          {notepad.name}
        </span>
        <span className="shrink-0 rounded-full border border-solid border-border-subtle px-[8px] py-[2px] font-mono text-[0.64rem] tracking-[0.06em] text-text-tertiary uppercase">
          {notepad.scope}
        </span>
      </div>

      <div className="flex min-h-[44px] shrink-0 items-center gap-sm border-0 border-b border-solid border-border-subtle bg-bg-base px-[16px] py-[4px]">
        <span className="inline-flex items-center gap-[6px] font-mono text-[0.72rem] text-text-tertiary">
          <span
            aria-hidden="true"
            className="h-[6px] w-[6px] rounded-full bg-green"
          />
          {metaLine}
        </span>
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="ml-auto inline-flex min-h-[36px] shrink-0 cursor-pointer items-center gap-[6px] rounded-full border border-solid border-border-subtle bg-transparent px-[12px] font-mono text-[0.72rem] text-text-tertiary transition-colors duration-150 ease-[ease] hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px]"
        >
          <WriteModeIcon mode={notepad.writeMode} size={12} />
          agents: {WRITE_MODE_LABEL[notepad.writeMode]}
          <svg
            aria-hidden="true"
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-bg-surface px-[18px] py-[16px]">
        <NotepadPreview notepadId={notepadId} content={notepad.content} />
      </div>

      <div className="flex shrink-0 items-center gap-sm border-0 border-t border-solid border-border-subtle bg-bg-base px-[16px] py-[8px] font-mono text-[0.68rem] text-text-tertiary">
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          className="shrink-0"
        >
          <circle cx="8" cy="8" r="6" />
          <path d="M8 5v3.5M8 11h.01" />
        </svg>
        reading view — editing lives on desktop this slice
      </div>

      {sheetOpen ? (
        <WriteModeSheet
          current={notepad.writeMode}
          onSelect={(mode) => {
            setSheetOpen(false);
            if (mode !== notepad.writeMode) {
              updateMutation.mutate({ notepadId, fields: { writeMode: mode } });
            }
          }}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Write-mode sheet (frame C) — the one mutating control on mobile
// ---------------------------------------------------------------------------

const WRITE_MODES: {
  mode: NotepadWriteMode;
  description: string;
}[] = [
  { mode: "read-only", description: "agents can read, never write" },
  { mode: "append-only", description: "agents add to the end, never rewrite" },
  {
    mode: "full-edit",
    description: "agents edit anywhere · history covers restores",
  },
];

function WriteModeIcon({
  mode,
  size,
}: {
  mode: NotepadWriteMode;
  size: number;
}): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      className="shrink-0"
    >
      {mode === "read-only" ? (
        <>
          <rect x="4" y="7.5" width="8" height="6" rx="1" />
          <path d="M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2" />
        </>
      ) : mode === "append-only" ? (
        <path d="M8 4v8M4 8h8" />
      ) : (
        <path d="M11.5 2.5l2 2L6 12l-2.6.6L4 10z" />
      )}
    </svg>
  );
}

interface WriteModeSheetProps {
  current: NotepadWriteMode;
  onSelect(mode: NotepadWriteMode): void;
  onClose(): void;
}

/**
 * The same three modes, one-line explanations, and closing sentence as the
 * desktop write-mode menu, presented as a bottom sheet. Selection applies
 * immediately and the sheet dismisses. Composes the `ui/Dialog` unstyled
 * edge-anchored variant like CollabControlSheet: Radix owns the focus trap and
 * Escape/outside-press dismissal while the card docks to the bottom.
 */
function WriteModeSheet({
  current,
  onSelect,
  onClose,
}: WriteModeSheetProps): React.JSX.Element {
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        unstyled
        anchor="stretch"
        aria-label="Agent write mode"
        contentClassName="fixed inset-x-0 bottom-0 flex max-h-[70vh] motion-safe:animate-[slideUpSheet_0.25s_ease] flex-col overflow-y-auto rounded-t-lg border-x-0 border-t border-b-0 border-solid border-border-default bg-bg-surface pb-[calc(var(--spacing-sm)+env(safe-area-inset-bottom,0px))]"
      >
        <div className="mt-sm mb-[4px] h-[4px] w-[36px] shrink-0 self-center rounded-[2px] bg-border-strong" />
        <div className="px-[18px] py-[8px] font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
          Agent write mode
        </div>
        {WRITE_MODES.map(({ mode, description }) => {
          const active = mode === current;
          return (
            <button
              key={mode}
              type="button"
              onClick={() => onSelect(mode)}
              className={cn(
                "flex min-h-[56px] cursor-pointer items-start gap-[12px] border-0 border-l-2 border-solid bg-transparent px-[18px] py-[10px] text-left transition-colors duration-150 ease-[ease] hover:bg-bg-hover focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px]",
                active ? "border-l-cyan bg-bg-hover" : "border-l-transparent",
              )}
            >
              <span className="mt-[2px] text-text-secondary">
                <WriteModeIcon mode={mode} size={16} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                <span className="font-mono text-[0.84rem] font-semibold text-text-primary">
                  {WRITE_MODE_LABEL[mode]}
                </span>
                <span className="font-mono text-[0.72rem] leading-[1.5] text-text-tertiary">
                  {description}
                </span>
              </span>
              {active ? (
                <svg
                  aria-hidden="true"
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="mt-[4px] shrink-0 text-cyan"
                >
                  <path d="M3 8.5l3.5 3.5L13 5" />
                </svg>
              ) : null}
            </button>
          );
        })}
        <div className="mt-[6px] border-0 border-t border-solid border-border-subtle px-[18px] pt-[10px] pb-[4px] font-mono text-[0.7rem] text-text-tertiary">
          governs agents only — you can always edit
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mx-[18px] mt-[10px] mb-[6px] min-h-[48px] cursor-pointer rounded-md border border-solid border-border-default bg-transparent font-mono text-[0.8rem] text-text-secondary transition-colors duration-150 ease-[ease] hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px]"
        >
          Cancel
        </button>
      </DialogContent>
    </Dialog>
  );
}
