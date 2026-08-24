"use client";

import { cn } from "@/lib/ui/cn";
import type { MarkdownAnnotationTone } from "@/components/document-viewer/annotation-contract";

interface CommentGutterPinProps {
  /** Top offset (px) within the scroll content, aligned to the block. */
  top: number;
  /** Drives the marker color: active (cyan) vs settled (green). */
  tone: MarkdownAnnotationTone;
  /** Number of comments anchored to this block. */
  count: number;
  onClick: () => void;
  title?: string;
}

function BubbleGlyph(): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="shrink-0"
    >
      <path d="M2 3h12v7.5H6.5L3.5 13v-2.5H2z" />
    </svg>
  );
}

/**
 * A single left-gutter comment marker, absolutely positioned within the scroll
 * content so it tracks its block on scroll. A small pill carrying a comment
 * glyph and the count, reading cyan when pending and green when sent (req 6.1,
 * 6.2) — matching the design prototype's gutter pin.
 */
export default function CommentGutterPin({
  top,
  tone,
  count,
  onClick,
  title,
}: CommentGutterPinProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{ top }}
      className={cn(
        "pointer-events-auto absolute left-[14px] inline-flex min-h-[24px] min-w-[24px] -translate-y-[2px] cursor-pointer items-center justify-center gap-[2px] rounded-md border border-solid px-[5px] font-mono text-[0.62rem] leading-none font-bold tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan max-768:min-h-[44px] max-768:min-w-[44px]",
        tone === "settled"
          ? "border-green-dim bg-green-glow text-green"
          : "border-cyan bg-cyan-glow text-cyan",
      )}
    >
      <BubbleGlyph />
      {count}
    </button>
  );
}
