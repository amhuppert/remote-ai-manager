"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/ui/cn";

interface CollapsibleTextProps {
  maxCollapsedHeight?: number;
  children: React.ReactNode;
}

export default function CollapsibleText({
  maxCollapsedHeight = 120,
  children,
}: CollapsibleTextProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const checkOverflow = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    setIsOverflowing(el.scrollHeight > maxCollapsedHeight + 8);
  }, [maxCollapsedHeight]);

  useEffect(() => {
    checkOverflow();

    const el = contentRef.current;
    if (!el) return;

    const observer = new ResizeObserver(checkOverflow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [checkOverflow, children]);

  const needsCollapse = isOverflowing && !isExpanded;

  return (
    <div className="relative">
      <div
        ref={contentRef}
        className={cn(
          "overflow-hidden transition-[max-height] duration-200 ease-[ease]",
          needsCollapse &&
            "[mask-image:linear-gradient(to_bottom,black_60%,transparent_100%)] [-webkit-mask-image:linear-gradient(to_bottom,black_60%,transparent_100%)]",
        )}
        style={needsCollapse ? { maxHeight: maxCollapsedHeight } : undefined}
      >
        {children}
      </div>
      {isOverflowing && (
        <button
          className="mt-xs block cursor-pointer border-none bg-transparent p-0 font-mono text-[0.7rem] font-medium text-cyan-dim transition-colors duration-150 ease-[ease] hover:text-cyan"
          onClick={() => setIsExpanded((prev) => !prev)}
          type="button"
        >
          {isExpanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
