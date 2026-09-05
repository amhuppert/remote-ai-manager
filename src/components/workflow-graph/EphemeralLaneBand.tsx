"use client";

import { useState } from "react";
import { AlertTriangleIcon, CloseIcon } from "@/components/icons";
import { cn } from "@/lib/ui/cn";
import {
  resolveEphemeralLaneName,
  type EphemeralLane,
} from "@/lib/workflow-graph/ephemeral-lanes";
import type { LaneBandBox } from "@/lib/workflow-graph/lane-band-geometry";
import { LANE_BAND_HEADER_WIDTH } from "@/lib/workflow-graph/lane-band-geometry";

/**
 * An empty lane's band (design bundle B2, "Ephemeral lane").
 *
 * A dashed band with the lane's name in an input rather than in text, because
 * naming it is the only thing an author can do to it — nothing else about an
 * empty lane exists to edit. The band says "0 members · nothing to save yet"
 * for the same reason the toolbar still says "All changes saved": there is no
 * authored entity here, so there is nothing a Save could persist.
 *
 * The name is committed on Enter or blur rather than per keystroke: an existing
 * name MERGES the band away (§2.2), and doing that mid-word would delete the
 * band under the author's cursor while they were still typing past it.
 */

export interface EphemeralLaneBandProps {
  readonly lane: EphemeralLane;
  readonly box?: LaneBandBox;
  /** Every other lane name on the canvas — an existing one means "use it". */
  readonly taken: readonly string[];
  readonly onRename: (id: string, name: string) => void;
  /** The name was an existing lane's: the band goes, and the notice says why. */
  readonly onMerge: (id: string, notice: string) => void;
  readonly onRemove: (id: string) => void;
  /** Set while a node is being dragged over this band. */
  readonly dropState?: "accepted" | "refused" | null;
}

const DROP_CAPTION: Record<"accepted" | "refused", string> = {
  accepted: "drop to re-place here",
  refused: "cannot accept this context",
};

export default function EphemeralLaneBand({
  lane,
  box,
  taken,
  onRename,
  onMerge,
  onRemove,
  dropState,
}: EphemeralLaneBandProps): React.JSX.Element {
  const [text, setText] = useState(lane.name);
  const [refusal, setRefusal] = useState<string | null>(null);

  function commit() {
    const resolution = resolveEphemeralLaneName({
      name: text,
      currentName: lane.name,
      taken,
    });
    if (resolution.outcome === "refused") {
      setRefusal(resolution.message);
      return;
    }
    setRefusal(null);
    if (resolution.outcome === "merged") {
      onMerge(lane.id, resolution.notice);
      return;
    }
    setText(resolution.laneName);
    if (resolution.outcome === "renamed") {
      onRename(lane.id, resolution.laneName);
    }
  }

  function cancel() {
    setText(lane.name);
    setRefusal(null);
  }

  const caption = dropState ? DROP_CAPTION[dropState] : null;

  return (
    <div
      role="group"
      aria-label={`Lane ${lane.name}, empty — 0 members, nothing to save yet`}
      data-testid="ephemeral-lane-band"
      data-lane-name={lane.name}
      {...(dropState ? { "data-drop-state": dropState } : {})}
      className={cn(
        "pointer-events-auto items-start gap-md rounded-[10px] border border-dashed px-[14px] py-[12px] font-mono",
        box ? "absolute flex" : "grid grid-cols-[minmax(0,1fr)_44px]",
        dropState === "accepted" &&
          "border-cyan bg-[var(--cc-cyan-a05)] shadow-[inset_0_0_0_1px_var(--cc-cyan-a25)]",
        dropState === "refused" &&
          "border-[var(--cc-red-a25)] bg-[var(--cc-red-a10)]",
        !dropState && "border-border-strong",
      )}
      style={
        box
          ? { left: box.x, top: box.y, width: box.width, height: box.height }
          : undefined
      }
    >
      <div
        className="flex shrink-0 flex-col gap-xs"
        style={box ? { width: LANE_BAND_HEADER_WIDTH } : undefined}
      >
        <label className="flex flex-col gap-xs text-[0.7rem] font-medium text-text-tertiary">
          lane name
          <input
            type="text"
            aria-label="Lane name"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
              if (event.key === "Escape") cancel();
              // The canvas reads Escape as "abandon the drag" and Delete as
              // "delete the selection"; neither is what a key pressed inside
              // this field means.
              event.stopPropagation();
            }}
            className="w-full rounded-sm border border-solid border-border-default bg-bg-surface px-[9px] py-[5px] font-mono text-[0.72rem] font-normal text-text-primary transition-[border-color] duration-150 outline-none focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)] max-768:min-h-[44px]"
          />
        </label>
      </div>

      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-xs",
          box ? "pt-[18px]" : "col-span-2 row-start-2",
        )}
      >
        <span
          data-testid="ephemeral-lane-membership"
          className="text-[0.7rem] leading-[1.6] font-normal text-text-tertiary"
        >
          0 members · nothing to save yet
        </span>
        {refusal && (
          <span
            role="alert"
            data-testid="ephemeral-lane-refusal"
            className="flex items-start gap-xs text-[0.7rem] leading-[1.55] font-normal text-red"
          >
            <AlertTriangleIcon size={12} className="mt-[2px] shrink-0" />
            {refusal}
          </span>
        )}
        {caption && (
          <span
            data-testid="ephemeral-lane-drop-caption"
            className={cn(
              "text-[0.7rem] leading-[1.6] font-medium",
              dropState === "accepted" ? "text-cyan" : "text-red",
            )}
          >
            {caption}
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={() => onRemove(lane.id)}
        aria-label={`Remove lane ${lane.name}`}
        className="col-start-2 row-start-1 inline-flex size-[20px] shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-text-tertiary transition-colors duration-150 hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px] max-768:size-[44px]"
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
}
