"use client";

import { useState } from "react";
import { Switch } from "@/components/ui/Switch";

// The label-grid row and the two bare controls every workflow-config editor is
// built from. They live apart from the editors so the assignment editors can
// use them without importing the module that composes them.

export interface EditorBaseProps<T> {
  value: T;
  onChange: (next: T) => void;
  readOnly?: boolean;
}

// Label-grid row: label in a fixed left column, control on the right, hint
// under the control column. Mobile stacks all three in one column.
export function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-[10px] gap-y-xs max-768:grid-cols-[minmax(0,1fr)]">
      <div className="font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
        {label}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-xs">
        {children}
      </div>
      {hint ? (
        <div className="col-start-2 font-mono text-[0.7rem] leading-[1.5] text-text-tertiary max-768:col-start-1">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export function ToggleControl({
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <Switch
      checked={value}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={ariaLabel}
    />
  );
}

export function NumericInput({
  value,
  onChange,
  disabled,
  min,
  placeholder,
  ariaLabel,
}: {
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  disabled?: boolean;
  min?: number;
  placeholder?: string;
  ariaLabel: string;
}) {
  const [local, setLocal] = useState<string>(
    value !== undefined ? String(value) : "",
  );
  const [prev, setPrev] = useState<number | undefined>(value);
  if (prev !== value) {
    setPrev(value);
    setLocal(value !== undefined ? String(value) : "");
  }
  return (
    <input
      type="number"
      className="w-[110px] rounded-sm border border-solid border-border-default bg-bg-surface px-[10px] py-[7px] font-mono text-[0.75rem] text-text-primary transition-[border-color] duration-150 outline-none focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)] disabled:cursor-not-allowed disabled:opacity-60 max-768:min-h-[44px]"
      disabled={disabled}
      value={local}
      min={min}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(event) => {
        const text = event.target.value;
        setLocal(text);
        if (text === "") {
          onChange(undefined);
          return;
        }
        const parsed = Number(text);
        if (Number.isFinite(parsed)) onChange(parsed);
      }}
    />
  );
}
