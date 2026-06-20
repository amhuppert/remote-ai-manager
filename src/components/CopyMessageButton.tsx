"use client";

import { useState, useCallback } from "react";
import { cn } from "@/lib/ui/cn";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import { extractCopyText } from "./copy-message-text";

// Shared hover-action button recipe (Copy + Fork). The ≤768px touch sizing
// (legacy globals `.msg-action-btn { width/height: 44px }`, svg 16px, and the
// tooltip `::after` hidden) is re-homed here as `max-768:` variants.
export const msgActionBtnClass =
  "relative flex items-center justify-center w-[24px] h-[24px] p-0 border border-solid border-transparent rounded-sm bg-transparent text-text-tertiary cursor-pointer transition-all duration-[120ms] ease-[ease] enabled:hover:bg-bg-hover enabled:hover:text-text-secondary enabled:hover:border-border-default disabled:opacity-30 disabled:cursor-default max-768:w-[44px] max-768:h-[44px] max-768:[&_svg]:w-[16px] max-768:[&_svg]:h-[16px] max-768:after:hidden";

interface CopyMessageButtonProps {
  content: MessageContentBlock[];
}

export default function CopyMessageButton({ content }: CopyMessageButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const text = extractCopyText(content);
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [content]);

  return (
    <button
      type="button"
      className={cn(msgActionBtnClass, "data-[copied=true]:text-green")}
      data-copied={copied}
      onClick={handleCopy}
      data-tooltip={copied ? "Copied ✓" : "Copy"}
      title="Copy message as Markdown"
    >
      {copied ? (
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M1.5 5.5L4 8L8.5 2"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <rect
            x="4"
            y="3"
            width="6"
            height="7.5"
            rx="1"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <path
            d="M2 8.5V2.5C2 1.95 2.45 1.5 3 1.5H7.5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}
