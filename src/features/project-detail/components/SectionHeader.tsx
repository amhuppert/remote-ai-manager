"use client";

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
        className="v3-section-header bulk-mode"
        role="region"
        aria-label="Bulk actions"
      >
        <span className="bulk-count">
          <span className="n">{selectionSize}</span>
        </span>
        <span className="label">sessions selected</span>
        <div className="bulk-grp">
          <button type="button" className="bulk-link" onClick={onDeselect}>
            Deselect all
          </button>
          {bulkActionKind === "unarchive" ? (
            <button
              type="button"
              className="cc-ibtn"
              onClick={onBulkUnarchive}
              disabled={isBulkPending}
            >
              Unarchive {selectionSize}
            </button>
          ) : (
            <button
              type="button"
              className="cc-ibtn"
              onClick={onBulkArchive}
              disabled={isBulkPending}
            >
              Archive {selectionSize}
            </button>
          )}
          <button
            type="button"
            className="cc-ibtn danger"
            onClick={onBulkDelete}
            disabled={isBulkPending}
          >
            Delete {selectionSize}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="v3-section-header" role="region" aria-label="Sessions">
      <span className="label">Sessions</span>
      <span className="count">{filteredCount}</span>
      {tokenCount > 0 && (
        <>
          <span className="count">
            · {tokenCount} filter{tokenCount === 1 ? "" : "s"} applied
          </span>
          <button type="button" className="bulk-link" onClick={onClearFilters}>
            Clear
          </button>
        </>
      )}
    </div>
  );
}
