"use client";

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
  const cls = ["cc-checkbox"];
  if (checked) cls.push("checked");
  if (indeterminate && !checked) cls.push("indeterminate");
  const ariaChecked: boolean | "mixed" = checked
    ? true
    : indeterminate
      ? "mixed"
      : false;
  return (
    <button
      type="button"
      className={cls.join(" ")}
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
