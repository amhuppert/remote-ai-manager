"use client";

const btnClass =
  "inline-flex min-h-[30px] cursor-pointer appearance-none items-center justify-center rounded-[4px] border border-solid border-border-subtle bg-[var(--cc-white-a02)] px-md py-xs font-mono text-[11px] tracking-[0.04em] text-text-secondary [transition:border-color_120ms_ease,color_120ms_ease,background_120ms_ease] enabled:hover:border-cyan enabled:hover:bg-[var(--cc-cyan-a06)] enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 max-768:min-h-[44px] max-768:min-w-[44px]";

export interface CollabPassageControlsProps {
  total: number;
  currentIndex: number;
  onPrev: () => void;
  onNext: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}

export default function CollabPassageControls({
  total,
  currentIndex,
  onPrev,
  onNext,
  onExpandAll,
  onCollapseAll,
}: CollabPassageControlsProps): React.JSX.Element | null {
  if (total === 0) return null;
  const canPrev = currentIndex > 0;
  const canNext = currentIndex < total - 1;
  return (
    <div
      className="mr-xs inline-flex flex-wrap items-center gap-md"
      role="group"
      aria-label="Collaboration navigation"
    >
      <div className="inline-flex items-center gap-xs" data-cluster="collapse">
        <button
          type="button"
          className={btnClass}
          onClick={onCollapseAll}
          aria-label="Collapse all cards"
        >
          Collapse all
        </button>
        <button
          type="button"
          className={btnClass}
          onClick={onExpandAll}
          aria-label="Expand all cards"
        >
          Expand all
        </button>
      </div>
      <div className="inline-flex items-center gap-xs" data-cluster="nav">
        <button
          type="button"
          className={btnClass}
          onClick={onPrev}
          disabled={!canPrev}
          aria-label="Previous card"
        >
          ‹ Prev
        </button>
        <span
          className="min-w-[36px] px-xs text-center font-mono text-[11px] text-text-secondary"
          aria-label={`Card ${currentIndex + 1} of ${total}`}
        >
          {currentIndex + 1}/{total}
        </span>
        <button
          type="button"
          className={btnClass}
          onClick={onNext}
          disabled={!canNext}
          aria-label="Next card"
        >
          Next ›
        </button>
      </div>
    </div>
  );
}
