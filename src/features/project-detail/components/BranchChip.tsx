"use client";

import { useState } from "react";
import { CopyIcon, CheckIcon } from "@/components/icons";

interface BranchChipProps {
  branch: string;
  /** Optional override for clipboard.writeText (test seam). */
  writeToClipboard?: (text: string) => Promise<void>;
}

const COPY_FEEDBACK_MS = 1200;

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
      className={"s-branch" + (copied ? " copied" : "")}
      title={branch}
      onClick={handleCopy}
      aria-label="Copy branch name"
    >
      <span className="branch-name">{branch}</span>
      <span
        className={"branch-copy" + (copied ? " copied" : "")}
        aria-hidden="true"
      >
        {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
      </span>
    </button>
  );
}
