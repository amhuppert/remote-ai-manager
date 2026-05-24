"use client";

import { useState, useCallback } from "react";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import { extractCopyText } from "./copy-message-text";

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
      className={`msg-action-btn${copied ? " msg-action-btn--copied" : ""}`}
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
