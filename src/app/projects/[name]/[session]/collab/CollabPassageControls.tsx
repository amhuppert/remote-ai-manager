"use client";

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
      className="collab-passage-controls"
      role="group"
      aria-label="Collaboration navigation"
    >
      <div className="collab-passage-controls-cluster" data-cluster="collapse">
        <button
          type="button"
          className="collab-passage-controls-btn"
          onClick={onCollapseAll}
          aria-label="Collapse all cards"
        >
          Collapse all
        </button>
        <button
          type="button"
          className="collab-passage-controls-btn"
          onClick={onExpandAll}
          aria-label="Expand all cards"
        >
          Expand all
        </button>
      </div>
      <div className="collab-passage-controls-cluster" data-cluster="nav">
        <button
          type="button"
          className="collab-passage-controls-btn"
          onClick={onPrev}
          disabled={!canPrev}
          aria-label="Previous card"
        >
          ‹ Prev
        </button>
        <span
          className="collab-passage-controls-counter"
          aria-label={`Card ${currentIndex + 1} of ${total}`}
        >
          {currentIndex + 1}/{total}
        </span>
        <button
          type="button"
          className="collab-passage-controls-btn"
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
