"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/ui/cn";
import { Button } from "@/components/ui/Button";
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import { formatRelativeTime } from "@/lib/shared/format-relative-time";
import { useNotepadPanelListQuery } from "@/lib/notepads/queries";
import {
  useCreateNotepadMutation,
  useDeleteNotepadMutation,
  useUpdateNotepadMutation,
} from "@/lib/notepads/mutations";
import type { NotepadListItem, NotepadScope } from "@/lib/notepads/schemas";
import {
  useNotepadSort,
  useOpenNotepad,
  useOpenNotepadId,
  useSetNotepadSort,
} from "@/stores/session-detail.store";
import NotepadOpenView, {
  type NotepadAutosaveTiming,
} from "./NotepadOpenView";

export interface NotepadPanelProps {
  projectName: string;
  sessionName: string;
  /** Active conversation identity for the editor's reference picker. */
  conversationId: string;
  /** Queries are gated on the Notepad tab being the active right-pane tab. */
  active: boolean;
  /** Forwarded to the open view; see `NotepadOpenViewProps.autosaveTiming`. */
  autosaveTiming?: Partial<NotepadAutosaveTiming>;
}

const PANEL_CLASS =
  "flex min-h-0 flex-1 flex-col rounded-b-lg border border-solid border-border-subtle bg-bg-surface";

const SECTION_HEADER_CLASS =
  "px-[12px] pt-[10px] pb-[4px] font-mono text-[0.68rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase";

/**
 * The Notepad right-pane surface: browse the reachable notepads (global + this
 * session's project) and open one for split-screen editing beside the
 * conversation transcript.
 */
export default function NotepadPanel({
  projectName,
  sessionName,
  conversationId,
  active,
  autosaveTiming,
}: NotepadPanelProps): React.JSX.Element {
  const openNotepadId = useOpenNotepadId();

  return (
    <div className={PANEL_CLASS} data-testid="notepad-panel">
      {openNotepadId !== null ? (
        <NotepadOpenView
          key={openNotepadId}
          notepadId={openNotepadId}
          projectName={projectName}
          sessionName={sessionName}
          conversationId={conversationId}
          active={active}
          {...(autosaveTiming === undefined ? {} : { autosaveTiming })}
        />
      ) : (
        <NotepadBrowseView projectName={projectName} active={active} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Browse list
// ---------------------------------------------------------------------------

interface NotepadBrowseViewProps {
  projectName: string;
  active: boolean;
}

function NotepadBrowseView({
  projectName,
  active,
}: NotepadBrowseViewProps): React.JSX.Element {
  const sort = useNotepadSort();
  const setSort = useSetNotepadSort();
  const openNotepad = useOpenNotepad();
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NotepadListItem | null>(
    null,
  );

  const listQuery = useNotepadPanelListQuery(projectName, sort, showArchived, {
    enabled: active,
  });
  const updateMutation = useUpdateNotepadMutation();
  const deleteMutation = useDeleteNotepadMutation();

  const rows = useMemo(() => listQuery.data ?? [], [listQuery.data]);
  const sections = useMemo(() => {
    const current = rows.filter((row) => !row.archived);
    return {
      pinned: current.filter((row) => row.pinned),
      // Server order preserved: the requested sort applies across scopes, so
      // regrouping by scope here would override it. Scope shows per row.
      unpinned: current.filter((row) => !row.pinned),
      archived: rows.filter((row) => row.archived),
    };
  }, [rows]);

  const renderRow = (row: NotepadListItem) => (
    <NotepadRow
      key={row.id}
      row={row}
      renaming={renamingId === row.id}
      deleting={deleteMutation.isPending && deleteMutation.variables === row.id}
      onOpen={() => openNotepad(row.id)}
      onStartRename={() => setRenamingId(row.id)}
      onRename={(name) => {
        setRenamingId(null);
        if (name.length > 0 && name !== row.name) {
          updateMutation.mutate({ notepadId: row.id, fields: { name } });
        }
      }}
      onCancelRename={() => setRenamingId(null)}
      onTogglePin={() =>
        updateMutation.mutate({
          notepadId: row.id,
          fields: { pinned: !row.pinned },
        })
      }
      onToggleArchive={() =>
        updateMutation.mutate({
          notepadId: row.id,
          fields: { archived: !row.archived },
        })
      }
      onDelete={() => setDeleteTarget(row)}
    />
  );

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-sm border-0 border-b border-solid border-border-subtle px-[12px] py-[8px]">
        <span className="font-mono text-[0.72rem] font-semibold tracking-[0.05em] text-text-secondary uppercase">
          Notepads
        </span>
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          {rows.length}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-sm">
          <SegmentedControl
            value={sort}
            onValueChange={(value) => {
              if (value === "name" || value === "recency") setSort(value);
            }}
            aria-label="Sort notepads"
          >
            <SegmentedControlItem value="recency">recency</SegmentedControlItem>
            <SegmentedControlItem value="name">name</SegmentedControlItem>
          </SegmentedControl>
          <Button
            touch
            variant="ghost"
            size="sm"
            aria-pressed={showArchived}
            onClick={() => setShowArchived((value) => !value)}
          >
            Archived
          </Button>
          <Button
            touch
            variant="default"
            size="sm"
            onClick={() => setCreating(true)}
          >
            New
          </Button>
        </div>
      </div>

      {creating ? (
        <NotepadCreateForm
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
          <Button
            touch
            variant="default"
            size="sm"
            onClick={() => setCreating(true)}
          >
            New notepad
          </Button>
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pb-sm">
          {sections.pinned.length > 0 ? (
            <>
              <div className={SECTION_HEADER_CLASS}>Pinned</div>
              {sections.pinned.map(renderRow)}
            </>
          ) : null}
          {sections.unpinned.length > 0 ? (
            <>
              {sections.pinned.length > 0 ? (
                <div className={SECTION_HEADER_CLASS}>Others</div>
              ) : null}
              {sections.unpinned.map(renderRow)}
            </>
          ) : null}
          {showArchived && sections.archived.length > 0 ? (
            <>
              <div className={SECTION_HEADER_CLASS}>
                Archived {sections.archived.length}
              </div>
              {sections.archived.map(renderRow)}
            </>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete notepad"
        message={
          deleteTarget
            ? `Permanently delete "${deleteTarget.name}"? References to it will show a missing state.`
            : ""
        }
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface NotepadRowProps {
  row: NotepadListItem;
  renaming: boolean;
  deleting: boolean;
  onOpen(): void;
  onStartRename(): void;
  onRename(name: string): void;
  onCancelRename(): void;
  onTogglePin(): void;
  onToggleArchive(): void;
  onDelete(): void;
}

function NotepadRow({
  row,
  renaming,
  deleting,
  onOpen,
  onStartRename,
  onRename,
  onCancelRename,
  onTogglePin,
  onToggleArchive,
  onDelete,
}: NotepadRowProps): React.JSX.Element {
  if (renaming) {
    return (
      <div className="flex items-center gap-sm px-[12px] py-[4px]">
        <NameInput
          initialValue={row.name}
          onCommit={onRename}
          onCancel={onCancelRename}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group flex items-center",
        deleting && "pointer-events-none opacity-40",
      )}
      aria-busy={deleting || undefined}
    >
      <button
        type="button"
        aria-label={`Open notepad ${row.name}`}
        onClick={onOpen}
        className="flex min-h-[36px] min-w-0 flex-1 cursor-pointer items-baseline gap-sm border-0 bg-transparent px-[12px] py-[7px] text-left transition-colors duration-150 ease-[ease] hover:bg-bg-hover focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px] max-768:min-h-[44px]"
      >
        <span className="min-w-0 flex-1 truncate font-mono text-[0.78rem] font-medium text-text-primary max-768:[overflow-wrap:anywhere] max-768:whitespace-normal">
          {row.name}
        </span>
        {row.scope === "global" ? (
          <span className="shrink-0 rounded-full border border-solid border-border-default px-[6px] font-mono text-[0.62rem] tracking-[0.05em] text-text-tertiary uppercase">
            global
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-[0.68rem] text-text-tertiary">
          {deleting ? "Deleting…" : formatRelativeTime(row.updatedAt)}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Actions for ${row.name}`}
            className="mr-[8px] inline-flex h-[24px] w-[24px] shrink-0 cursor-pointer items-center justify-center rounded-sm border border-solid border-transparent bg-transparent font-mono text-[0.78rem] text-text-tertiary transition-colors duration-150 ease-[ease] group-hover:border-border-default hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px] max-768:size-[44px]"
          >
            ⋯
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem touch onSelect={onStartRename}>
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem touch onSelect={onTogglePin}>
            {row.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuItem touch onSelect={onToggleArchive}>
            {row.archived ? "Unarchive" : "Archive"}
          </DropdownMenuItem>
          <DropdownMenuItem touch danger onSelect={onDelete}>
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Uncontrolled-ish name editor: Enter commits, Escape cancels, blur commits. */
export function NameInput({
  initialValue,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  onCommit(name: string): void;
  onCancel(): void;
}): React.JSX.Element {
  const [value, setValue] = useState(initialValue);
  return (
    <input
      // eslint-disable-next-line jsx-a11y/no-autofocus -- entering rename mode is an explicit user act; focus belongs in the field
      autoFocus
      aria-label="New name"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => onCommit(value.trim())}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit(value.trim());
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      className="min-w-0 flex-1 rounded-sm border border-solid border-border-default bg-bg-base px-[8px] py-[4px] font-mono text-[0.78rem] text-text-primary focus:border-cyan-dim focus:[outline:none]"
    />
  );
}

// ---------------------------------------------------------------------------
// Create form
// ---------------------------------------------------------------------------

interface NotepadCreateFormProps {
  projectName: string;
  onCreated(notepadId: string): void;
  onCancel(): void;
}

function NotepadCreateForm({
  projectName,
  onCreated,
  onCancel,
}: NotepadCreateFormProps): React.JSX.Element {
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
    <div className="flex shrink-0 flex-col gap-sm border-0 border-b border-solid border-border-subtle bg-bg-base px-[12px] py-[10px]">
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
        className="rounded-sm border border-solid border-border-default bg-bg-surface px-[8px] py-[5px] font-mono text-[0.78rem] text-text-primary placeholder:text-text-tertiary focus:border-cyan-dim focus:[outline:none]"
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
        <div className="ml-auto flex flex-wrap items-center gap-sm">
          <Button touch variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            touch
            variant="default"
            size="sm"
            disabled={createMutation.isPending || name.trim().length === 0}
            onClick={submit}
          >
            {createMutation.isPending ? "Creating…" : "Create"}
          </Button>
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
