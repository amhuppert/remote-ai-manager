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

const listClass =
  "flex flex-col bg-bg-base border border-solid border-border-subtle rounded-md max-h-[260px] overflow-y-auto " +
  "data-[disabled=true]:opacity-50 data-[disabled=true]:pointer-events-none";

const optionClass =
  "group flex items-center gap-sm py-sm px-md border-0 bg-transparent cursor-pointer text-left min-h-[36px] " +
  "transition-[background] duration-[120ms] ease-[ease] " +
  "[&:not(:last-child)]:[border-bottom:1px_solid_var(--border-dim)] " +
  "data-[selected=true]:bg-cyan-glow data-[selected=false]:hover:bg-bg-elevated " +
  "max-768:min-h-[var(--touch-target-min)]";

const radioClass =
  "shrink-0 w-[14px] h-[14px] rounded-full border-[1.5px] border-solid border-border-default transition-all duration-[120ms] ease-[ease] " +
  "group-data-[selected=true]:border-cyan group-data-[selected=true]:bg-cyan " +
  "group-data-[selected=true]:[box-shadow:inset_0_0_0_2.5px_var(--bg-base),0_0_6px_var(--cyan-glow)]";

const contentClass = "flex flex-col gap-px min-w-0";

const labelClass =
  "font-mono text-[0.78rem] font-medium text-text-secondary truncate group-data-[selected=true]:text-text-primary";

const sublabelClass =
  "font-mono text-[0.7rem] font-normal text-text-tertiary truncate";

const defaultTagClass = "text-[0.7rem] font-normal text-text-tertiary ml-xs";

export default function BranchSelector({
  sessions,
  selectedParent,
  onSelect,
  disabled = false,
}: BranchSelectorProps): React.JSX.Element {
  return (
    <div
      className={listClass}
      data-disabled={disabled}
      role="radiogroup"
      aria-label="Branch from"
    >
      {/* Default: main */}
      <button
        type="button"
        className={optionClass}
        data-selected={selectedParent === null}
        role="radio"
        aria-checked={selectedParent === null}
        onClick={() => onSelect(null)}
        disabled={disabled}
      >
        <span className={radioClass} />
        <span className={contentClass}>
          <span className={labelClass}>
            main <span className={defaultTagClass}>default</span>
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
            className={optionClass}
            data-selected={isSelected}
            role="radio"
            aria-checked={isSelected}
            onClick={() => onSelect(session.sessionName)}
            disabled={disabled}
          >
            <span className={radioClass} />
            <span className={contentClass}>
              <span className={labelClass}>{session.branchName}</span>
              <span className={sublabelClass}>
                session: {session.sessionName}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
