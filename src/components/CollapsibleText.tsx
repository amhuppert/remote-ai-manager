"use client";

import { useRef, useState, useEffect, useCallback } from "react";

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
    <div className="collapsible-text">
      <div
        ref={contentRef}
        className={`collapsible-text-content${needsCollapse ? " collapsed" : ""}`}
        style={needsCollapse ? { maxHeight: maxCollapsedHeight } : undefined}
      >
        {children}
      </div>
      {isOverflowing && (
        <button
          className="collapsible-text-toggle"
          onClick={() => setIsExpanded((prev) => !prev)}
          type="button"
        >
          {isExpanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
