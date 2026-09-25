"use client";

import { useId } from "react";

import { RadioGroup, RadioGroupOption } from "@/components/ui/RadioGroup";
import type { MemoryIndexMode } from "@/lib/memory/schemas";

import {
  isMemoryIndexMode,
  MEMORY_INDEX_MODE_ORDER,
  MEMORY_INDEX_MODES,
} from "./memory-index-mode";

export interface MemoryIndexModeFieldProps {
  value: MemoryIndexMode;
  onValueChange(value: MemoryIndexMode): void;
  disabled?: boolean;
}

export default function MemoryIndexModeField({
  value,
  onValueChange,
  disabled = false,
}: MemoryIndexModeFieldProps): React.JSX.Element {
  const labelId = useId();
  const hintId = useId();
  return (
    <div className="flex flex-col gap-xs">
      <span
        id={labelId}
        className="font-mono text-[0.7rem] tracking-[0.05em] text-text-tertiary uppercase"
      >
        Index inclusion
      </span>
      <RadioGroup
        aria-labelledby={labelId}
        aria-describedby={hintId}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (isMemoryIndexMode(next)) onValueChange(next);
        }}
      >
        {MEMORY_INDEX_MODE_ORDER.map((mode) => (
          <RadioGroupOption
            key={mode}
            value={mode}
            label={MEMORY_INDEX_MODES[mode].label}
            description={MEMORY_INDEX_MODES[mode].description}
            layoutClassName="max-768:min-h-[44px]"
          />
        ))}
      </RadioGroup>
      <p id={hintId} className="m-0 font-mono text-[0.7rem] text-text-tertiary">
        Inclusion also depends on scope, eligibility, and the
        conversation&apos;s memory policy.
      </p>
    </div>
  );
}
