"use client";

// Inline-utility reproduction of the legacy `.cc-checkbox` leaf recipe (no
// matching ui/ primitive — ratified inline-utilities migration). The 16px box +
// hover/cyan-fill state, and the checked checkmark / indeterminate dash drawn
// with an `::after` pseudo, are reproduced byte-for-byte via `after:` arbitrary
// utilities. The checkmark is an L of left+bottom borders rotated -45°; the dash
// is a flat bar — both centred by the flex container's static position (no
// inset). Visual state is gated on `data-checked` / `data-indeterminate` so the
// class string stays static (no-dynamic-class).
const CHECKBOX_CLASS =
  "relative inline-flex size-[16px] shrink-0 cursor-pointer items-center justify-center " +
  "rounded-[3px] border border-solid border-border-default bg-bg-base " +
  "transition-all duration-[120ms] ease-[ease] hover:border-cyan-dim " +
  "data-[checked=true]:border-cyan data-[checked=true]:bg-cyan " +
  "data-[indeterminate=true]:border-cyan data-[indeterminate=true]:bg-cyan " +
  "data-[checked=true]:after:absolute data-[checked=true]:after:h-[4px] data-[checked=true]:after:w-[8px] " +
  "data-[checked=true]:after:content-[''] " +
  "data-[checked=true]:after:[border-left:1.6px_solid_var(--color-text-inverse)] " +
  "data-[checked=true]:after:[border-bottom:1.6px_solid_var(--color-text-inverse)] " +
  "data-[checked=true]:after:[transform:rotate(-45deg)_translate(0,-1px)] " +
  "data-[indeterminate=true]:after:absolute data-[indeterminate=true]:after:h-[1.6px] data-[indeterminate=true]:after:w-[8px] " +
  "data-[indeterminate=true]:after:bg-text-inverse data-[indeterminate=true]:after:content-['']";

interface CCCheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
}

export default function CCCheckbox({
  checked,
  indeterminate = false,
  onChange,
  ariaLabel,
}: CCCheckboxProps): React.JSX.Element {
  const showIndeterminate = indeterminate && !checked;
  const ariaChecked: boolean | "mixed" = checked
    ? true
    : indeterminate
      ? "mixed"
      : false;
  return (
    <button
      type="button"
      className={CHECKBOX_CLASS}
      data-checked={checked}
      data-indeterminate={showIndeterminate}
      role="checkbox"
      aria-checked={ariaChecked}
      aria-label={ariaLabel ?? "Select"}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    />
  );
}
