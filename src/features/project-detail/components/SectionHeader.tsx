"use client";

import { IconButton } from "@/components/ui/IconButton";

interface SectionHeaderProps {
  filteredCount: number;
  tokenCount: number;
  selectionSize: number;
  bulkActionKind: "archive" | "unarchive";
  isBulkPending: boolean;
  onClearFilters: () => void;
  onDeselect: () => void;
  onBulkArchive: () => void;
  onBulkUnarchive: () => void;
  onBulkDelete: () => void;
}

const labelClass =
  "font-mono text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-text-secondary";
const countClass = "font-mono text-[0.7rem] text-text-tertiary";
const linkClass =
  "font-mono text-[0.7rem] text-text-secondary bg-transparent border-0 px-[6px] hover:text-cyan";

export default function SectionHeader({
  filteredCount,
  tokenCount,
  selectionSize,
  bulkActionKind,
  isBulkPending,
  onClearFilters,
  onDeselect,
  onBulkArchive,
  onBulkUnarchive,
  onBulkDelete,
}: SectionHeaderProps): React.JSX.Element {
  if (selectionSize > 0) {
    return (
      <div
        className="mx-xl flex items-center gap-md rounded-md border border-solid border-cyan-dim bg-bg-elevated px-[12px] py-[8px] shadow-[inset_0_0_14px_-6px_var(--color-cyan-glow)] transition-[background,border-color] duration-150 ease-[ease] max-768:mx-md"
        role="region"
        aria-label="Bulk actions"
      >
        <span className="inline-flex items-center gap-[8px] font-mono text-[0.74rem] font-semibold text-cyan">
          <span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-cyan px-[6px] text-[0.7rem] font-bold text-text-inverse">
            {selectionSize}
          </span>
        </span>
        <span className="font-mono text-[0.8rem] font-semibold text-cyan">
          sessions selected
        </span>
        <div className="ml-auto flex items-center gap-[6px]">
          <button type="button" className={linkClass} onClick={onDeselect}>
            Deselect all
          </button>
          {bulkActionKind === "unarchive" ? (
            <IconButton
              variant="pill"
              onClick={onBulkUnarchive}
              disabled={isBulkPending}
            >
              Unarchive {selectionSize}
            </IconButton>
          ) : (
            <IconButton
              variant="pill"
              onClick={onBulkArchive}
              disabled={isBulkPending}
            >
              Archive {selectionSize}
            </IconButton>
          )}
          <IconButton
            variant="pill"
            onClick={onBulkDelete}
            disabled={isBulkPending}
          >
            Delete {selectionSize}
          </IconButton>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-md px-xl pt-md pb-sm max-768:px-md max-768:pb-xs"
      role="region"
      aria-label="Sessions"
    >
      <span className={labelClass}>Sessions</span>
      <span className={countClass}>{filteredCount}</span>
      {tokenCount > 0 && (
        <>
          <span className={countClass}>
            · {tokenCount} filter{tokenCount === 1 ? "" : "s"} applied
          </span>
          <button type="button" className={linkClass} onClick={onClearFilters}>
            Clear
          </button>
        </>
      )}
    </div>
  );
}
