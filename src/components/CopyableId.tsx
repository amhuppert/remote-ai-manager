"use client";

import { useState, useCallback } from "react";

interface CopyableIdProps {
  /** Full ID value to copy */
  value: string;
  /** Label shown before the value */
  label: string;
  /** Number of characters to show before truncating (default: 8) */
  truncateAt?: number;
  /** Override the displayed text (copies `value`, shows `displayValue`) */
  displayValue?: string;
}

export default function CopyableId({
  value,
  label,
  truncateAt = 8,
  displayValue,
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
      className="si-item copyable-id"
      onClick={handleCopy}
      data-tooltip={copied ? "Copied ✓" : value}
      role="button"
      tabIndex={0}
    >
      <span className="si-label">{label}</span>
      <span className="si-val copyable-id-val">{display}</span>
      <span className="copyable-id-icon">{copied ? "\u2713" : "\u2398"}</span>
    </div>
  );
}
