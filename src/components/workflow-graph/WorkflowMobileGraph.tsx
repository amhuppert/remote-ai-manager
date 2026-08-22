"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/ui/cn";
import type { LaneBand } from "@/lib/workflow-graph/lane-bands";
import { FitGlyph, ZoomInGlyph, ZoomOutGlyph } from "./canvas-glyphs";
import { contextNodeAccessibleName } from "./derive-graph";
import type { ExecutionContextNodeData } from "./derive-graph";
import { ContextNodeCard } from "./ExecutionContextNode";
import type { JoinConflictSummary } from "./join-conflict-summary";
import LaneJoinConflictCard from "./LaneJoinConflictCard";
import { BAND_DOT, membershipText } from "./LaneBandLayer";

/**
 * The Graph panel at the mobile breakpoint (design bundle, `Workflow
 * Mobile.dc.html` M1/M2): lanes stack down the panel and their members scroll
 * horizontally inside their own band.
 *
 * The same context card the canvas draws, without React Flow — panning a
 * viewport is not a usable way to read a graph on a phone, so the lane order
 * carries the structure instead. A lane still shows no grade of its own
 * (README §4): the header states membership and a summary OF its members.
 */

/** The zoom cluster's steps. `1` is the card's own size. */
const ZOOM_STEPS = [0.6, 0.75, 1, 1.25] as const;
const DEFAULT_ZOOM_INDEX = 2;

export interface WorkflowMobileGraphNode {
  id: string;
  data: ExecutionContextNodeData;
}

interface WorkflowMobileGraphProps {
  bands: readonly LaneBand[];
  mode: "builder" | "execution";
  nodes: readonly WorkflowMobileGraphNode[];
  selectedContextId: string | null;
  onSelectContext: (contextId: string) => void;
  /**
   * Builder-only: lanes drawn on the canvas that hold nothing yet (README
   * §2.2). They are draft UI, so they carry no membership line.
   */
  emptyLaneNames?: readonly string[];
  /** An extra control rendered on each member card — the touch re-placement entry. */
  renderMemberActions?: (contextId: string) => React.ReactNode;
  /** Long-press on a card — the touch re-placement entry (M1). */
  onLongPressContext?: (contextId: string) => void;
  /**
   * A conflicted join (README §11 — the lane rail states it, at every
   * breakpoint). The stacked list has no band geometry to hang a card beside,
   * so the card leads the list: it is the run's blocking state, and nothing
   * below it can be acted on until it is resolved.
   */
  joinConflict?: JoinConflictSummary | null;
  onOpenLaneWorktree?: (contextId: string) => void;
  onEditOwnership?: (contextId: string) => void;
}

const FLOATING_BTN =
  "inline-flex size-[44px] flex-shrink-0 cursor-pointer items-center justify-center rounded-md border border-solid border-border-default bg-[var(--cc-bg-surface-a92)] p-0 text-text-secondary [backdrop-filter:blur(12px)] transition-colors duration-150 hover:border-border-strong hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]";

export default function WorkflowMobileGraph({
  bands,
  mode,
  nodes,
  selectedContextId,
  onSelectContext,
  emptyLaneNames = [],
  renderMemberActions,
  onLongPressContext,
  joinConflict = null,
  onOpenLaneWorktree,
  onEditOwnership,
}: WorkflowMobileGraphProps): React.JSX.Element {
  const [zoomIndex, setZoomIndex] = useState<number>(DEFAULT_ZOOM_INDEX);
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoom = ZOOM_STEPS[zoomIndex] ?? 1;

  const nodeById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node] as const)),
    [nodes],
  );

  // Fit is what "back to the whole graph" means on a list: the smallest step,
  // scrolled to the top, so every lane is on screen at once.
  const handleFit = useCallback(() => {
    setZoomIndex(0);
    const scroller = scrollRef.current;
    if (scroller === null) return;
    scroller.scrollTop = 0;
    scroller.scrollLeft = 0;
  }, []);

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="workflow-mobile-graph"
    >
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto p-md"
      >
        <div
          className="flex flex-col gap-md"
          style={{
            transform: `scale(${zoom})`,
            transformOrigin: "top left",
            width: `${100 / zoom}%`,
          }}
        >
          {joinConflict !== null && (
            <LaneJoinConflictCard
              summary={joinConflict}
              onOpenLaneWorktree={onOpenLaneWorktree}
              onEditOwnership={onEditOwnership}
              layoutClassName="max-w-none"
            />
          )}
          {bands.map((band) => (
            <MobileLaneBand
              key={band.laneName}
              band={band}
              mode={mode}
              nodeById={nodeById}
              selectedContextId={selectedContextId}
              onSelectContext={onSelectContext}
              {...(renderMemberActions ? { renderMemberActions } : {})}
              {...(onLongPressContext ? { onLongPressContext } : {})}
            />
          ))}
          {emptyLaneNames.map((laneName) => (
            <div
              key={`empty:${laneName}`}
              data-testid="mobile-lane-band"
              data-lane={laneName}
              className="flex items-center gap-sm rounded-lg border border-dashed border-border-default px-[11px] py-[9px]"
            >
              <span className="font-mono text-[0.78rem] font-semibold text-text-primary">
                {laneName}
              </span>
              <span className="font-mono text-[0.7rem] text-text-tertiary">
                empty · drop a context here
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* §12: the graph's own controls float above the bottom toolbar rather
          than competing with it for the tab row. */}
      <div className="pointer-events-none absolute right-md bottom-md flex items-center gap-sm">
        <div className="pointer-events-auto flex items-center gap-sm">
          <button
            type="button"
            className={FLOATING_BTN}
            onClick={handleFit}
            aria-label="Fit graph"
            title="Fit graph"
          >
            <FitGlyph size={16} />
          </button>
          <button
            type="button"
            className={FLOATING_BTN}
            onClick={() => setZoomIndex((index) => Math.max(0, index - 1))}
            disabled={zoomIndex === 0}
            aria-label="Zoom out"
            title="Zoom out"
          >
            <ZoomOutGlyph size={16} />
          </button>
          <button
            type="button"
            className={FLOATING_BTN}
            onClick={() =>
              setZoomIndex((index) =>
                Math.min(ZOOM_STEPS.length - 1, index + 1),
              )
            }
            disabled={zoomIndex === ZOOM_STEPS.length - 1}
            aria-label="Zoom in"
            title="Zoom in"
          >
            <ZoomInGlyph size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

function MobileLaneBand({
  band,
  mode,
  nodeById,
  selectedContextId,
  onSelectContext,
  renderMemberActions,
  onLongPressContext,
}: {
  band: LaneBand;
  mode: "builder" | "execution";
  nodeById: ReadonlyMap<string, WorkflowMobileGraphNode>;
  selectedContextId: string | null;
  onSelectContext: (contextId: string) => void;
  renderMemberActions?: (contextId: string) => React.ReactNode;
  onLongPressContext?: (contextId: string) => void;
}): React.JSX.Element {
  const members = band.memberContextIds
    .map((contextId) => nodeById.get(contextId))
    .filter((node): node is WorkflowMobileGraphNode => node !== undefined);

  return (
    <section
      data-testid="mobile-lane-band"
      data-lane={band.laneName}
      data-lane-state={band.state}
      aria-label={`Lane ${band.laneName} — ${membershipText(band)}`}
      className={cn(
        "overflow-hidden rounded-lg",
        band.reserved
          ? "border border-dashed border-border-default"
          : "border border-solid border-border-subtle",
      )}
    >
      <div className="flex items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim bg-bg-surface px-[11px] py-[9px]">
        {mode === "execution" && (
          <span
            aria-hidden="true"
            className={cn("size-[6px] rounded-full", BAND_DOT[band.state])}
          />
        )}
        <span
          data-testid="mobile-lane-band-name"
          className="font-mono text-[0.78rem] font-semibold text-text-primary"
        >
          {band.laneName}
        </span>
        <span
          data-testid="mobile-lane-band-membership"
          className="min-w-0 truncate font-mono text-[0.7rem] text-text-tertiary"
        >
          {membershipText(band)}
        </span>
      </div>

      {members.length > 0 && (
        <ul className="m-0 flex list-none gap-sm overflow-x-auto p-[11px] [-webkit-overflow-scrolling:touch]">
          {members.map((node) => (
            <li key={node.id} className="flex flex-shrink-0 flex-col gap-xs">
              <MobileLaneMember
                node={node}
                selected={node.id === selectedContextId}
                onSelect={onSelectContext}
                {...(onLongPressContext ? { onLongPressContext } : {})}
              />
              {renderMemberActions?.(node.id)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** How long a press has to be held before it means "move this", in ms. */
const LONG_PRESS_MS = 500;

function MobileLaneMember({
  node,
  selected,
  onSelect,
  onLongPressContext,
}: {
  node: WorkflowMobileGraphNode;
  selected: boolean;
  onSelect: (contextId: string) => void;
  onLongPressContext?: (contextId: string) => void;
}): React.JSX.Element {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedRef = useRef(false);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startPress = useCallback(() => {
    if (!onLongPressContext) return;
    firedRef.current = false;
    clear();
    timerRef.current = setTimeout(() => {
      firedRef.current = true;
      onLongPressContext(node.id);
    }, LONG_PRESS_MS);
  }, [clear, node.id, onLongPressContext]);

  return (
    <button
      type="button"
      data-testid="mobile-lane-member"
      data-context-id={node.id}
      aria-label={contextNodeAccessibleName(node.data)}
      {...(selected ? { "aria-current": "true" as const } : {})}
      onClick={() => {
        // A press that already opened the lane picker is not also a selection.
        if (firedRef.current) {
          firedRef.current = false;
          return;
        }
        onSelect(node.id);
      }}
      onPointerDown={startPress}
      onPointerUp={clear}
      onPointerCancel={clear}
      onPointerLeave={clear}
      // A scroll inside the lane must not read as a press-and-hold.
      onPointerMove={clear}
      className="flex-shrink-0 cursor-pointer appearance-none border-0 bg-transparent p-0 text-left focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]"
    >
      <ContextNodeCard data={node.data} selected={selected} />
    </button>
  );
}
