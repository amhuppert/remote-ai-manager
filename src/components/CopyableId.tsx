"use client";

import { useState, useCallback } from "react";
import { CopyIcon, CheckIcon } from "@/components/icons";

interface CopyableIdProps {
  /** Full value copied to the clipboard. */
  value: string;
  /** Label shown before the value. Omit for a bare value+icon target. */
  label?: string;
  /** Number of characters to show before truncating (default: 8) */
  truncateAt?: number;
  /** Override the displayed text (copies `value`, shows `displayValue`) */
  displayValue?: string;
  /** Extra class appended to the root for context-specific styling. */
  className?: string;
  /** Accessible label for the copy action (falls back to the visible text). */
  ariaLabel?: string;
}

const COPY_ICON_SIZE = 14;

export default function CopyableId({
  value,
  label,
  truncateAt = 8,
  displayValue,
  className,
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
    (value.length > truncateAt ? `${value.slice(0, truncateAt)}…` : value);

  return (
    <div
      className={`si-item copyable-id${copied ? " copied" : ""}${
        className ? ` ${className}` : ""
      }`}
      onClick={handleCopy}
      data-tooltip={copied ? "Copied ✓" : value}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
    >
      {label && <span className="si-label">{label}</span>}
      <span className="si-val copyable-id-val">{display}</span>
      <span className="copyable-id-icon" aria-hidden="true">
        {copied ? (
          <CheckIcon size={COPY_ICON_SIZE} />
        ) : (
          <CopyIcon size={COPY_ICON_SIZE} />
        )}
      </span>
    </div>
  );
}
