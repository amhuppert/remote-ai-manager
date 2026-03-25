"use client";

interface BranchOption {
  sessionName: string;
  branchName: string;
}

interface BranchSelectorProps {
  /** Active sessions available as branch parents */
  sessions: BranchOption[];
  /** Currently selected parent session name, or null for main */
  selectedParent: string | null;
  /** Called when user selects a branch — null means main */
  onSelect: (sessionName: string | null) => void;
  /** Disable all interactions */
  disabled?: boolean;
}

export default function BranchSelector({
  sessions,
  selectedParent,
  onSelect,
  disabled = false,
}: BranchSelectorProps): React.JSX.Element {
  return (
    <div
      className={`branch-selector${disabled ? " branch-selector--disabled" : ""}`}
      role="radiogroup"
      aria-label="Branch from"
    >
      {/* Default: main */}
      <button
        type="button"
        className={`branch-selector__option${selectedParent === null ? " branch-selector__option--selected" : ""}`}
        role="radio"
        aria-checked={selectedParent === null}
        onClick={() => onSelect(null)}
        disabled={disabled}
      >
        <span className="branch-selector__radio" />
        <span className="branch-selector__content">
          <span className="branch-selector__label">
            main <span className="branch-selector__default-tag">default</span>
          </span>
        </span>
      </button>

      {/* Session options */}
      {sessions.map((session) => {
        const isSelected = selectedParent === session.sessionName;
        return (
          <button
            key={session.sessionName}
            type="button"
            className={`branch-selector__option${isSelected ? " branch-selector__option--selected" : ""}`}
            role="radio"
            aria-checked={isSelected}
            onClick={() => onSelect(session.sessionName)}
            disabled={disabled}
          >
            <span className="branch-selector__radio" />
            <span className="branch-selector__content">
              <span className="branch-selector__label">
                {session.branchName}
              </span>
              <span className="branch-selector__sublabel">
                session: {session.sessionName}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
