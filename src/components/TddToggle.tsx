"use client";

interface TddToggleProps {
  /** Whether TDD mode is enabled */
  enabled: boolean;
  /** Callback when toggle is clicked */
  onChange: (enabled: boolean) => void;
  /** Whether the toggle is disabled (e.g. during mutation) */
  disabled?: boolean;
  /** Compact mode for info strips — omits label, shows just the switch + "TDD" */
  compact?: boolean;
}

/**
 * Toggle switch for Red-Green TDD methodology.
 *
 * Two variants:
 * - **Default**: Full row with switch + "Red-green TDD" label (for modals)
 * - **Compact**: Small inline button with switch + "TDD" label (for info strips / tables)
 */
export default function TddToggle({
  enabled,
  onChange,
  disabled = false,
  compact = false,
}: TddToggleProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={`tdd-toggle${compact ? " tdd-toggle--compact" : ""}${enabled ? " tdd-toggle--on" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange(!enabled);
      }}
      disabled={disabled}
      data-tooltip={
        compact
          ? enabled
            ? "Red-green TDD enabled (click to disable)"
            : "Red-green TDD disabled (click to enable)"
          : undefined
      }
      aria-pressed={enabled}
      aria-label="Toggle red-green TDD"
    >
      <span className="tdd-toggle__track" aria-hidden="true">
        <span className="tdd-toggle__knob" />
      </span>
      <span className="tdd-toggle__label">
        {compact ? "TDD" : "Red-green TDD"}
      </span>
    </button>
  );
}
