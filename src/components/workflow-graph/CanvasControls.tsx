"use client";

import { useCallback } from "react";
import { Panel, useReactFlow, useViewport } from "@xyflow/react";

import { cn } from "@/lib/ui/cn";
import { CANVAS_FIT_VIEW_PADDING } from "@/lib/workflow-graph/lane-band-geometry";
import { ZoomInGlyph, ZoomOutGlyph } from "./canvas-glyphs";

/**
 * The canvas zoom cluster (design bundle B1/E1, bottom-right): zoom out, the
 * current zoom level, zoom in, and fit — one horizontal bordered group rather
 * than React Flow's vendor button stack.
 *
 * The plus and minus marks are drawn as SVG rather than set as `−`/`+`
 * characters: a functional icon is never a Unicode glyph, and each control
 * carries its own label so the glyph stays decorative.
 */
export function zoomPercentLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

const CLUSTER =
  "flex items-center gap-[4px] rounded-md border border-solid border-border-default bg-bg-surface p-[4px] font-mono [margin:16px] max-768:[margin:12px]";

const CONTROL_BASE =
  "inline-flex h-[26px] cursor-pointer items-center justify-center rounded-sm border border-solid border-transparent bg-transparent text-text-secondary transition-colors duration-150 hover:border-border-strong hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";

const ICON_CONTROL = cn(CONTROL_BASE, "w-[26px] p-0");
const TEXT_CONTROL = cn(CONTROL_BASE, "px-[8px] text-[0.7rem] font-medium");

export default function CanvasControls(): React.JSX.Element {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();

  // The same padding the canvases mount with, so the Fit button reproduces the
  // initial framing rather than a second opinion about it.
  const handleFit = useCallback(() => {
    void fitView({ padding: CANVAS_FIT_VIEW_PADDING });
  }, [fitView]);

  return (
    <Panel position="bottom-right" className={CLUSTER}>
      <button
        type="button"
        aria-label="Zoom out"
        onClick={() => zoomOut()}
        className={ICON_CONTROL}
      >
        <ZoomOutGlyph />
      </button>
      <span
        data-testid="canvas-zoom-level"
        className="px-[4px] text-[0.7rem] font-medium text-text-secondary"
      >
        {zoomPercentLabel(zoom)}
      </span>
      <button
        type="button"
        aria-label="Zoom in"
        onClick={() => zoomIn()}
        className={ICON_CONTROL}
      >
        <ZoomInGlyph />
      </button>
      {/* The design labels this control "Fit"; the aria-label spells out what it
          fits so the accessible name stands alone, and it contains the visible
          text so speech input still matches (WCAG 2.5.3). */}
      <button
        type="button"
        aria-label="Fit view"
        onClick={handleFit}
        className={TEXT_CONTROL}
      >
        Fit
      </button>
    </Panel>
  );
}
