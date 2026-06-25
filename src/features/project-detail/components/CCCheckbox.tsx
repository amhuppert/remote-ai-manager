"use client";

import { Checkbox } from "@/components/ui/Checkbox";

interface CCCheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
}

// Thin adapter over the Radix-backed `Checkbox` primitive (role="checkbox" +
// aria-checked incl. `mixed`, native Space toggle, the cyan 16px box). Keeps the
// boolean `checked`/`indeterminate`/`onChange` API its consumers (SessionRow /
// SessionRows) already pass, and stops click propagation so toggling a row's
// selection box never also triggers the row's own click handler.
export default function CCCheckbox({
  checked,
  indeterminate = false,
  onChange,
  ariaLabel,
}: CCCheckboxProps): React.JSX.Element {
  const checkedState: boolean | "indeterminate" = checked
    ? true
    : indeterminate
      ? "indeterminate"
      : false;
  return (
    <Checkbox
      checked={checkedState}
      aria-label={ariaLabel ?? "Select"}
      onCheckedChange={(next) => onChange(next === true)}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
