"use client";

import { useState } from "react";
import { CopyIcon, CheckIcon } from "@/components/icons";
import { cn } from "@/lib/ui/cn";

interface BranchChipProps {
  branch: string;
  /** Optional override for clipboard.writeText (test seam). */
  writeToClipboard?: (text: string) => Promise<void>;
}

const COPY_FEEDBACK_MS = 1200;

// The mobile size/padding overrides come from the legacy
// `.v3-row .v3-branch .s-branch` rule; baked in here because BranchChip only
// renders inside a session row.
const chipBase =
  "group inline-flex items-center gap-[6px] py-[3px] pr-[8px] pl-[9px] bg-bg-base hover:bg-bg-hover border border-solid rounded-full font-mono text-[0.7rem] max-w-[240px] cursor-pointer transition-[background,border-color,color] duration-[120ms] ease-[ease] max-768:max-w-full max-768:text-[0.68rem] max-768:py-[2px] max-768:pr-[7px] max-768:pl-[8px]";
const chipRest =
  "border-border-subtle text-text-secondary hover:border-border-default hover:text-text-primary";
const chipCopied = "border-green text-green";

export default function BranchChip({
  branch,
  writeToClipboard,
}: BranchChipProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const write =
      writeToClipboard ??
      ((text: string) => navigator.clipboard.writeText(text));
    try {
      await write(branch);
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      // Swallow clipboard rejection (permissions / insecure context). UI just doesn't flash.
    }
  };

  return (
    <button
      type="button"
      data-copied={copied}
      className={cn(chipBase, copied ? chipCopied : chipRest)}
      title={branch}
      onClick={handleCopy}
      aria-label="Copy branch name"
    >
      <span className="min-w-0 flex-1 truncate">{branch}</span>
      <span
        className={cn(
          "inline-flex size-[16px] shrink-0 items-center justify-center transition-colors duration-[120ms] ease-[ease]",
          copied
            ? "text-green"
            : "text-text-tertiary group-hover:text-text-primary",
        )}
        aria-hidden="true"
      >
        {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
      </span>
    </button>
  );
}
