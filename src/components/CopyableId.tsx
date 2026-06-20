"use client";

import { useState, useCallback } from "react";
import { CopyIcon, CheckIcon } from "@/components/icons";
import { cn } from "@/lib/ui/cn";

const COPY_ICON_SIZE = 14;

interface CopyableIdProps {
  /** Full ID value to copy */
  value: string;
  /** Label shown before the value. Omit for a bare value+icon target. */
  label?: string;
  /** Number of characters to show before truncating (default: 8) */
  truncateAt?: number;
  /** Override the displayed text (copies `value`, shows `displayValue`) */
  displayValue?: string;
  /** Accessible label for the copy action (falls back to the visible text). */
  ariaLabel?: string;
}

export default function CopyableId({
  value,
  label,
  truncateAt = 8,
  displayValue,
  ariaLabel,
}: CopyableIdProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      void navigator.clipboard.writeText(value).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    },
    [value],
  );

  const display =
    displayValue ??
    (value.length > truncateAt ? `${value.slice(0, truncateAt)}\u2026` : value);

  return (
    <div
      className={cn(
        "group/cid relative -mx-[4px] -my-px flex cursor-pointer items-center gap-[4px] rounded-sm px-[4px] py-px text-[0.72rem] transition-[background] duration-150 ease-[ease] hover:bg-bg-hover",
        copied && "copied",
      )}
      onClick={handleCopy}
      data-tooltip={copied ? "Copied ✓" : value}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
    >
      {label && (
        <span className="font-mono text-[0.7rem] tracking-[0.04em] text-text-tertiary uppercase">
          {label}
        </span>
      )}
      <span className="font-mono tracking-[0.02em] text-text-primary">
        {display}
      </span>
      <span
        className={cn(
          "inline-flex items-center transition-opacity duration-150 ease-[ease]",
          copied
            ? "text-green opacity-100"
            : "text-text-secondary opacity-0 group-hover/cid:opacity-100",
        )}
        aria-hidden="true"
      >
        {copied ? (
          <CheckIcon size={COPY_ICON_SIZE} />
        ) : (
          <CopyIcon size={COPY_ICON_SIZE} />
        )}
      </span>
    </div>
  );
}
