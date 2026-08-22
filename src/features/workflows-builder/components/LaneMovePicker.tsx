"use client";

import { useMemo, useState } from "react";

import { AlertTriangleIcon, CloseIcon, PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/Dialog";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/ui/cn";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import {
  defaultEphemeralLaneName,
  resolveEphemeralLaneName,
} from "@/lib/workflow-graph/ephemeral-lanes";
import { laneDropPreviewLabel } from "@/lib/workflow-graph/lane-drop";
import { resolveLaneChoiceDrop, type LaneDragDrop } from "./lane-drag";

/**
 * Touch re-placement's lane picker (design bundle M1: "a long-press on the node,
 * then a lane picker — the same validation, the same refusal copy").
 *
 * A phone cannot drag a card across a band, so the gesture names its target
 * instead of aiming at it. Everything downstream of that naming is the drag's:
 * each row carries the drag's own preview label and its accepted-or-refused
 * verdict — the hover pill, read before the choice rather than during it — and
 * the choice itself resolves through `resolveLaneChoiceDrop`, so the two routes
 * cannot disagree about what a placement costs or why one was refused.
 *
 * A refused row stays pressable on purpose. Disabling it would leave an author
 * with a lane they cannot use and no sentence saying why; pressing it writes
 * nothing and hands the reason and the remedy back to the canvas, which says
 * them in the same card a refused drag leaves behind.
 */

export interface LaneMovePickerProps {
  readonly definition: WorkflowSemanticDefinition;
  /** The context being re-placed; `null` closes the picker. */
  readonly contextId: string | null;
  /** Every lane on the canvas — authored bands and empty ones alike. */
  readonly laneNames: readonly string[];
  /** The verdict on the author's choice, for the canvas to apply and announce. */
  readonly onResolve: (drop: LaneDragDrop) => void;
  readonly onClose: () => void;
}

interface LaneChoice {
  readonly laneName: string;
  readonly drop: LaneDragDrop;
  readonly previewLabel: string;
  readonly current: boolean;
}

const ROW_BASE =
  "flex min-h-[44px] w-full cursor-pointer flex-col items-start gap-xs rounded-md border border-solid px-[12px] py-[10px] text-left font-mono transition-colors duration-150 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]";

const ROW_TONE: Record<"accepted" | "refused" | "current", string> = {
  accepted:
    "border-border-subtle bg-bg-surface hover:border-border-strong hover:bg-bg-raised",
  refused: "border-[var(--cc-red-a25)] bg-[var(--cc-red-a10)] hover:border-red",
  current: "cursor-default border-[var(--cc-cyan-a40)] bg-[var(--cc-cyan-a08)]",
};

export default function LaneMovePicker({
  definition,
  contextId,
  laneNames,
  onResolve,
  onClose,
}: LaneMovePickerProps): React.JSX.Element {
  const context = definition.executionContexts.find(
    (entry) => entry.id === contextId,
  );

  const choices = useMemo<LaneChoice[]>(() => {
    if (contextId === null) return [];
    return laneNames.map((laneName) => {
      const drop = resolveLaneChoiceDrop(definition, contextId, laneName);
      return {
        laneName,
        drop,
        previewLabel: laneDropPreviewLabel(definition, contextId, laneName),
        current: context?.placement?.lane === laneName,
      };
    });
  }, [context, contextId, definition, laneNames]);

  return (
    <Dialog
      open={contextId !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent mobileSheet data-testid="lane-move-picker">
        {/* A touch surface has no Escape key, so leaving without choosing has
            to be a control rather than a tap on the scrim. */}
        <header className="mb-sm flex items-start gap-md">
          <DialogTitle layoutClassName="min-w-0 flex-1">
            {context ? `Move “${context.title}” to a lane` : "Move to a lane"}
          </DialogTitle>
          <DialogClose asChild>
            <IconButton aria-label="Close">
              <CloseIcon />
            </IconButton>
          </DialogClose>
        </header>
        <DialogDescription>
          Re-placing writes only the lane. The grade and its owned paths carry
          across unchanged.
        </DialogDescription>

        <ul className="m-0 flex list-none flex-col gap-sm p-0">
          {choices.map((choice) => (
            <li key={choice.laneName}>
              <LaneChoiceRow
                choice={choice}
                onChoose={() => {
                  onResolve(choice.drop);
                  onClose();
                }}
              />
            </li>
          ))}
        </ul>

        <NewLaneRow
          laneNames={laneNames}
          onChoose={(laneName) => {
            if (contextId === null) return;
            onResolve(resolveLaneChoiceDrop(definition, contextId, laneName));
            onClose();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function LaneChoiceRow({
  choice,
  onChoose,
}: {
  choice: LaneChoice;
  onChoose: () => void;
}): React.JSX.Element {
  const outcome = choice.current
    ? "current"
    : choice.drop.kind === "refused"
      ? "refused"
      : "accepted";

  return (
    <button
      type="button"
      data-lane-option={choice.laneName}
      data-drop-outcome={outcome}
      disabled={choice.current}
      {...(choice.current ? { "aria-current": "true" as const } : {})}
      onClick={onChoose}
      className={cn(ROW_BASE, ROW_TONE[outcome], "disabled:cursor-default")}
    >
      <span className="text-[0.8rem] font-semibold text-text-primary">
        {choice.laneName}
      </span>
      <span className="text-[0.7rem] leading-[1.55] font-normal text-text-tertiary">
        {choice.current ? "current lane" : choice.previewLabel}
      </span>
      {outcome === "refused" && (
        <span className="flex items-center gap-xs text-[0.7rem] leading-[1.55] font-medium text-red">
          <AlertTriangleIcon size={11} className="shrink-0" />
          cannot accept this context
        </span>
      )}
    </button>
  );
}

/**
 * The new-lane entry (README §2.2). It invents no lane record: the name is
 * validated by the same module an empty band on the canvas names itself with,
 * and the context lands on it by the ordinary `placement.lane` write — which is
 * also why a name that already exists simply means that lane.
 */
function NewLaneRow({
  laneNames,
  onChoose,
}: {
  laneNames: readonly string[];
  onChoose: (laneName: string) => void;
}): React.JSX.Element {
  const [text, setText] = useState(() => defaultEphemeralLaneName(laneNames));
  const [refusal, setRefusal] = useState<string | null>(null);

  function commit() {
    const resolution = resolveEphemeralLaneName({
      name: text,
      currentName: "",
      taken: laneNames,
    });
    if (resolution.outcome === "refused") {
      setRefusal(resolution.message);
      return;
    }
    setRefusal(null);
    onChoose(resolution.laneName);
  }

  return (
    <div className="mt-md flex flex-col gap-sm border-x-0 border-t border-b-0 border-solid border-border-dim pt-md font-mono">
      <label className="flex flex-col gap-xs text-[0.7rem] font-medium text-text-tertiary">
        New lane name
        <input
          type="text"
          aria-label="New lane name"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
          className="min-h-[44px] w-full rounded-sm border border-solid border-border-default bg-bg-surface px-[10px] py-[6px] font-mono text-[0.75rem] font-normal text-text-primary transition-[border-color] duration-150 outline-none focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)]"
        />
      </label>
      {refusal && (
        <span
          role="alert"
          data-testid="lane-move-picker-refusal"
          className="flex items-start gap-xs text-[0.7rem] leading-[1.55] font-normal text-red"
        >
          <AlertTriangleIcon size={12} className="mt-[2px] shrink-0" />
          {refusal}
        </span>
      )}
      <Button
        type="button"
        variant="default"
        size="sm"
        touch
        onClick={commit}
        layoutClassName="self-start"
      >
        <PlusIcon size={12} />
        Move to the new lane
      </Button>
    </div>
  );
}
