"use client";

import { useMemo } from "react";
import { useNodes, ViewportPortal, type Node } from "@xyflow/react";

import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { cn } from "@/lib/ui/cn";
import {
  withEphemeralLaneBands,
  type EphemeralLane,
} from "@/lib/workflow-graph/ephemeral-lanes";
import {
  computeLaneBandBoxes,
  LANE_BAND_GAP,
  LANE_BAND_HEADER_WIDTH,
  resolveLaneStatementAnchor,
  type LaneBandBox,
  type LaneBandNodeBox,
} from "@/lib/workflow-graph/lane-band-geometry";
import type {
  LaneBand,
  LaneBandPublication,
  LaneBandPublicationState,
  LaneBandState,
} from "@/lib/workflow-graph/lane-bands";
import {
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
} from "@/lib/workflow-graph/layout";
import EphemeralLaneBand from "./EphemeralLaneBand";
import LaneJoinConflictCard from "./LaneJoinConflictCard";
import type { JoinConflictSummary } from "./join-conflict-summary";
import type { GraphWorkflowLoopGroup } from "@/lib/workflow-graph/definition-schemas";
import {
  computeLoopGroupBoxes,
  expandLoopNodeBoxes,
} from "@/lib/workflow-graph/loop-group-geometry";
import LoopGroupSurface from "./LoopGroupSurface";

/**
 * The lane band layer (design bundle, `Workflow Builder.dc.html` B1 and
 * `Workflow Execution.dc.html` E1): a full-width rounded surface behind each
 * lane's nodes with a fixed header column on the left.
 *
 * A band never shows a grade of its own — the header's grade text is always a
 * summary OF its members ("3 members · 2 owning · 1 full"), which is why the
 * membership label and the summary render as one line and never separately.
 */

export type LaneBandMode = "builder" | "execution";

/**
 * The band a drag is currently over, and whether it can take the context
 * (design bundle B2). A band highlights only while a node is being dragged
 * across it, which is why this is a prop rather than band state.
 */
export interface LaneBandDropTarget {
  readonly laneName: string;
  readonly accepted: boolean;
}

const DROP_TARGET_SURFACE: Record<"accepted" | "refused", string> = {
  accepted:
    "border border-dashed border-cyan bg-[var(--cc-cyan-a05)] shadow-[inset_0_0_0_1px_var(--cc-cyan-a25)]",
  refused:
    "border border-dashed border-[var(--cc-red-a25)] bg-[var(--cc-red-a10)]",
};

const DROP_TARGET_CAPTION: Record<"accepted" | "refused", string> = {
  accepted: "drop to re-place here",
  refused: "cannot accept this context",
};

/** Band surface: border, left accent and fill. Builder bands stay neutral. */
const BAND_SURFACE: Record<LaneBandMode, Record<LaneBandState, string>> = {
  builder: {
    active: "border border-solid border-border-subtle",
    merged: "border border-solid border-border-subtle",
    pending: "border border-solid border-border-subtle",
    session: "border border-dashed border-border-default",
  },
  execution: {
    active:
      "border border-solid border-[var(--cc-cyan-a25)] border-l-2 border-l-[var(--cyan)] bg-[var(--cc-cyan-a05)]",
    merged:
      "border border-solid border-border-subtle border-l-2 border-l-[var(--green-dim)]",
    pending: "border border-solid border-border-subtle",
    session: "border border-dashed border-border-default",
  },
};

/** The band's runtime dot. Shared so the mobile lane list colours it the same. */
export const BAND_DOT: Record<LaneBandState, string> = {
  active: "bg-cyan",
  merged: "bg-green",
  pending: "bg-[var(--text-tertiary)]",
  session: "bg-[var(--text-tertiary)]",
};

const STATUS_TONE: Record<string, StatusChipTone> = {
  active: "cyan",
  merged: "green",
  halted: "red",
  pending: "neutral",
};

/** The publication pill's tone. Cyan while merging — it is work in flight. */
const PUBLICATION_TONE: Record<LaneBandPublicationState, StatusChipTone> = {
  pending: "neutral",
  running: "cyan",
  published: "green",
  failed: "red",
};

/**
 * The band header's one membership line. A lane has no grade (README §4), so
 * this is always membership plus a summary OF the members' grades — never a
 * grade the band claims for itself.
 */
export function membershipText(band: LaneBand): string {
  return band.gradeSummary
    ? `${band.membershipLabel} · ${band.gradeSummary}`
    : band.membershipLabel;
}

/**
 * The header's status pill. Builder mode has no runtime to report, so the only
 * pill a draft band carries is the session lane's `reserved` — the one lane
 * fact that is true before anything runs.
 */
function statusLabel(band: LaneBand, mode: LaneBandMode): string | null {
  if (band.reserved) {
    return mode === "execution" ? "reserved · read-only" : "reserved";
  }
  if (mode === "builder") return null;
  return band.runtime?.status ?? null;
}

function runtimeLines(band: LaneBand): string[] {
  const runtime = band.runtime;
  if (!runtime) return [];
  return [
    runtime.branchLabel,
    runtime.worktreeLabel,
    runtime.joinLabel,
    runtime.publicationLabel,
  ].filter((line): line is string => line !== null);
}

export interface LaneBandSurfaceProps {
  readonly band: LaneBand;
  readonly box: LaneBandBox;
  readonly mode: LaneBandMode;
  /** Set while a node is being dragged over THIS band. */
  readonly dropState?: "accepted" | "refused" | null;
}

export function LaneBandSurface({
  band,
  box,
  mode,
  dropState,
}: LaneBandSurfaceProps): React.JSX.Element {
  const status = statusLabel(band, mode);
  const membership = membershipText(band);
  const lines = mode === "execution" ? runtimeLines(band) : [];
  const caption = dropState ? DROP_TARGET_CAPTION[dropState] : null;
  const named = status
    ? `Lane ${band.laneName}, ${status} — ${membership}`
    : `Lane ${band.laneName} — ${membership}`;
  const accessibleName = caption ? `${named} — ${caption}` : named;

  return (
    <div
      role="group"
      aria-label={accessibleName}
      data-testid="lane-band"
      data-lane-name={band.laneName}
      data-lane-state={band.state}
      {...(band.reserved ? { "data-reserved": "true" } : {})}
      {...(dropState ? { "data-drop-state": dropState } : {})}
      className={cn(
        "pointer-events-none absolute rounded-[10px] font-mono",
        dropState
          ? DROP_TARGET_SURFACE[dropState]
          : BAND_SURFACE[mode][band.state],
      )}
      style={{
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
      }}
    >
      <div
        // Single-side border: the other three sides are zeroed explicitly
        // (tailwind-conventions §1.5 — no global border reset).
        className="flex h-full flex-col gap-[5px] border-x-0 border-y-0 border-r border-solid border-border-dim px-[14px] py-[12px]"
        style={{ width: LANE_BAND_HEADER_WIDTH }}
      >
        <div className="flex items-center gap-[7px]">
          {mode === "execution" && (
            <span
              aria-hidden="true"
              data-testid="lane-band-dot"
              className={cn(
                "h-[7px] w-[7px] shrink-0 rounded-full",
                BAND_DOT[band.state],
                // Liveness, NOT occupancy: `state` stays `active` for a halted
                // lane because the lane still holds the work, so the pulse has
                // to read the runtime status the header pill reports.
                band.runtime?.status === "active" && "lane-band-live-dot",
              )}
            />
          )}
          <span
            data-testid="lane-band-name"
            className={cn(
              "min-w-0 overflow-hidden text-[0.8rem] font-semibold text-ellipsis whitespace-nowrap",
              dropState === "accepted" && "text-cyan",
              dropState === "refused" && "text-red",
              !dropState && "text-text-primary",
            )}
          >
            {band.laneName}
          </span>
        </div>

        {status && (
          <StatusChip
            tone={
              band.reserved ? "neutral" : (STATUS_TONE[status] ?? "neutral")
            }
            data-testid="lane-band-status"
            layoutClassName="self-start"
          >
            {status}
          </StatusChip>
        )}

        <span
          data-testid="lane-band-membership"
          className="text-[0.7rem] leading-[1.6] font-normal text-text-tertiary"
        >
          {membership}
        </span>

        {lines.length > 0 && (
          <div
            data-testid="lane-band-runtime"
            className="flex min-w-0 flex-col text-[0.7rem] leading-[1.6] font-normal text-text-tertiary"
          >
            {lines.map((line) => (
              <span
                key={line}
                title={line}
                className="overflow-hidden text-ellipsis whitespace-nowrap"
              >
                {line}
              </span>
            ))}
          </div>
        )}

        {band.reserved && mode === "builder" && !caption && (
          <span className="text-[0.7rem] leading-[1.6] font-normal text-text-tertiary">
            admits read-only contexts only
          </span>
        )}

        {caption && (
          <span
            data-testid="lane-band-drop-caption"
            className={cn(
              "text-[0.7rem] leading-[1.6] font-medium",
              dropState === "accepted" ? "text-cyan" : "text-red",
            )}
          >
            {caption}
          </span>
        )}
      </div>
    </div>
  );
}

function toNodeBoxes(
  nodes: readonly Node[],
  pinned: LaneBandPinnedNode | null | undefined,
): LaneBandNodeBox[] {
  return nodes.map((node) => ({
    id: node.id,
    // A node being dragged out of its band must not drag the band with it, so
    // the drag pins it where it started for as long as the gesture lasts.
    x: pinned?.id === node.id ? pinned.x : node.position.x,
    y: pinned?.id === node.id ? pinned.y : node.position.y,
    // Before React Flow measures a node it has no size; the card's authored
    // dimensions keep the band from collapsing on the first frame.
    width: node.measured?.width || node.width || DEFAULT_NODE_WIDTH,
    height: node.measured?.height || node.height || DEFAULT_NODE_HEIGHT,
  }));
}

/** A node held at the position it had when the current drag started. */
export interface LaneBandPinnedNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** The merge arrow the publication pill leads with (E1 uses `wi-merge`). */
function MergeIcon(): React.JSX.Element {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="4.5" cy="4" r="1.8" strokeWidth="1.3" />
      <circle cx="4.5" cy="12.5" r="1.8" strokeWidth="1.3" />
      <circle cx="12" cy="8.25" r="1.8" strokeWidth="1.3" />
      <path d="M4.5 5.8v4.9" strokeWidth="1.3" />
      <path d="M6.3 4h1.6c1.3 0 2.3 1 2.3 2.3v.3" strokeWidth="1.3" />
      <path d="M6.3 12.5h1.6c1.3 0 2.3-1 2.3-2.3V10" strokeWidth="1.3" />
    </svg>
  );
}

/**
 * E1's publication pill: one statement of the whole run's final publish, set
 * below the lane it publishes into. Separate from the band headers because it
 * describes the relation BETWEEN lanes, which no single header can state.
 */
function PublicationPill({
  publication,
  box,
}: {
  publication: LaneBandPublication;
  box: LaneBandBox;
}): React.JSX.Element {
  return (
    // The wrapper owns canvas placement only; the pill itself is the shared
    // StatusChip, which is where the chip geometry and tone live.
    <div
      className="pointer-events-none absolute"
      style={{
        left: box.x + LANE_BAND_HEADER_WIDTH,
        top: box.y + box.height + LANE_BAND_GAP,
      }}
    >
      <StatusChip
        role="note"
        data-testid="lane-band-publication"
        data-publication-state={publication.state}
        tone={PUBLICATION_TONE[publication.state]}
        icon={<MergeIcon />}
      >
        {publication.label}
      </StatusChip>
    </div>
  );
}

export interface LaneBandLayerProps {
  readonly bands: readonly LaneBand[];
  readonly mode: LaneBandMode;
  readonly loopGroups?: readonly GraphWorkflowLoopGroup[];
  /** The run's final publish; absent in the builder, which has no runtime. */
  readonly publication?: LaneBandPublication | null;
  /**
   * A conflicted join, stated on the lane it was merging into (README §11).
   * Absent in the builder and on every run whose joins are healthy.
   */
  readonly joinConflict?: JoinConflictSummary | null;
  readonly onOpenLaneWorktree?: (contextId: string) => void;
  readonly onEditOwnership?: (contextId: string) => void;
  readonly dropTarget?: LaneBandDropTarget | null;
  readonly pinnedNode?: LaneBandPinnedNode | null;
  /** Empty lanes the author has drawn (README §2.2). Builder mode only. */
  readonly ephemeralLanes?: readonly EphemeralLane[];
  readonly onRenameEphemeralLane?: (id: string, name: string) => void;
  readonly onMergeEphemeralLane?: (id: string, notice: string) => void;
  readonly onRemoveEphemeralLane?: (id: string) => void;
}

export default function LaneBandLayer({
  bands,
  mode,
  loopGroups,
  publication = null,
  joinConflict = null,
  onOpenLaneWorktree,
  onEditOwnership,
  dropTarget,
  pinnedNode,
  ephemeralLanes,
  onRenameEphemeralLane,
  onMergeEphemeralLane,
  onRemoveEphemeralLane,
}: LaneBandLayerProps): React.JSX.Element | null {
  const nodes = useNodes();
  const lanes = useMemo(() => ephemeralLanes ?? [], [ephemeralLanes]);
  const nodeBoxes = useMemo(
    () => toNodeBoxes(nodes, pinnedNode),
    [nodes, pinnedNode],
  );
  const loopBoxes = useMemo(
    () => computeLoopGroupBoxes(loopGroups ?? [], bands, nodeBoxes),
    [loopGroups, bands, nodeBoxes],
  );
  const boxes = useMemo(() => {
    return computeLaneBandBoxes(
      withEphemeralLaneBands(bands, lanes),
      expandLoopNodeBoxes(nodeBoxes, loopGroups ?? []),
    );
  }, [bands, lanes, nodeBoxes, loopGroups]);

  if (boxes.length === 0) return null;

  const bandByName = new Map(bands.map((band) => [band.laneName, band]));
  const publicationBox =
    publication === null
      ? null
      : resolveLaneStatementAnchor(boxes, publication.targetLaneName);
  const boxByName = new Map(boxes.map((box) => [box.laneName, box]));
  // The join card hangs beside the target lane's band. A final publish merges
  // into the reserved session lane, which ordinarily draws no band at all, so
  // the card takes the same fallback the publication pill does rather than
  // disappearing on exactly the conflict that stopped the run.
  const joinConflictBox =
    joinConflict === null
      ? null
      : resolveLaneStatementAnchor(boxes, joinConflict.laneLabel);
  const dropStateFor = (laneName: string): "accepted" | "refused" | null =>
    dropTarget?.laneName === laneName
      ? dropTarget.accepted
        ? "accepted"
        : "refused"
      : null;

  return (
    <ViewportPortal>
      {/* The viewport is a stacking context, so a negative index keeps the
          bands behind every edge and node while still panning and zooming
          with them. */}
      <div
        data-testid="lane-band-layer"
        className="pointer-events-none absolute top-0 left-0 z-[-1]"
      >
        {boxes.flatMap((box) => {
          const band = bandByName.get(box.laneName);
          return band
            ? [
                <LaneBandSurface
                  key={box.laneName}
                  band={band}
                  box={box}
                  mode={mode}
                  dropState={dropStateFor(box.laneName)}
                />,
              ]
            : [];
        })}
        {publicationBox !== null && publication !== null && (
          <PublicationPill publication={publication} box={publicationBox} />
        )}
        {loopBoxes.map((box) => (
          <LoopGroupSurface key={box.key} box={box} />
        ))}
      </div>
      {/* The join card carries real controls, so like the ephemeral band it
          sits in a layer a pointer and Tab can reach rather than behind the
          nodes. It sits immediately RIGHT of the band of the lane the join was
          merging into: every band spans the same column, from the header to the
          widest node plus padding, so the far side of that column is the one
          place on the canvas no node can ever occupy. Anywhere inside the band
          would cover a member card. */}
      {joinConflictBox !== null && joinConflict !== null && (
        <div
          data-testid="lane-join-conflict-layer"
          className="pointer-events-none absolute top-0 left-0"
        >
          <div
            data-testid="lane-join-conflict-anchor"
            className="absolute"
            style={{
              left: joinConflictBox.x + joinConflictBox.width + LANE_BAND_GAP,
              top: joinConflictBox.y,
            }}
          >
            {/* An absolutely positioned card would otherwise shrink-to-fit
                against a zero-width containing block. */}
            <LaneJoinConflictCard
              summary={joinConflict}
              onOpenLaneWorktree={onOpenLaneWorktree}
              onEditOwnership={onEditOwnership}
              layoutClassName="w-[420px]"
            />
          </div>
        </div>
      )}
      {/* An empty band carries a name INPUT, so unlike every other band it has
          to be reachable by a pointer and by Tab — which a negative index would
          make impossible. It holds no nodes, so nothing can be behind it. */}
      {lanes.length > 0 && (
        <div
          data-testid="ephemeral-lane-band-layer"
          className="pointer-events-none absolute top-0 left-0"
        >
          {lanes.flatMap((lane) => {
            const box = boxByName.get(lane.name);
            return box
              ? [
                  <EphemeralLaneBand
                    key={lane.id}
                    lane={lane}
                    box={box}
                    taken={[
                      ...bands.map((band) => band.laneName),
                      ...lanes
                        .filter((other) => other.id !== lane.id)
                        .map((other) => other.name),
                    ]}
                    onRename={onRenameEphemeralLane ?? (() => {})}
                    onMerge={onMergeEphemeralLane ?? (() => {})}
                    onRemove={onRemoveEphemeralLane ?? (() => {})}
                    dropState={dropStateFor(lane.name)}
                  />,
                ]
              : [];
          })}
        </div>
      )}
    </ViewportPortal>
  );
}
