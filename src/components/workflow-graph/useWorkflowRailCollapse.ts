"use client";

import { useCallback, useState } from "react";
import { useMediaQueryMatch } from "@/hooks/use-media-query";

/** §12: below this width the rails collapse to strips before anything else changes. */
const NARROW_QUERY = "(max-width: 1100px)";
/** At and below this width the rail is not a rail at all — it is the panel. */
const MOBILE_QUERY = "(max-width: 768px)";

export interface WorkflowRailCollapse {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  /**
   * The rail is expanded at a width where it would squeeze the canvas, so it
   * floats over the canvas instead of taking width from it.
   */
  overlay: boolean;
}

/**
 * The §12 collapse ladder for one side rail: expanded above 1100px, a strip at
 * 1100px and below, and a full panel at the mobile breakpoint where the bottom
 * tab bar decides what is on screen.
 */
export function useWorkflowRailCollapse(): WorkflowRailCollapse {
  const isNarrow = useMediaQueryMatch(NARROW_QUERY);
  const isMobile = useMediaQueryMatch(MOBILE_QUERY);
  // One remembered choice per width regime. Collapsing a rail to reach the
  // canvas at 900px says nothing about the 1440px layout, and a single state
  // would make crossing the breakpoint overwrite the other layout's choice.
  const [wideCollapsed, setWideCollapsed] = useState(false);
  const [narrowCollapsed, setNarrowCollapsed] = useState(true);

  const collapsed = isMobile
    ? false
    : isNarrow
      ? narrowCollapsed
      : wideCollapsed;

  const setCollapsed = useCallback(
    (next: boolean) => {
      if (isNarrow) setNarrowCollapsed(next);
      else setWideCollapsed(next);
    },
    [isNarrow],
  );

  return {
    collapsed,
    setCollapsed,
    overlay: isNarrow && !isMobile && !collapsed,
  };
}
