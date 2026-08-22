"use client";

import { useState } from "react";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import { placementAuthoringIssue } from "@/components/workflow-config/PlacementEditor";
import type {
  ContextPlacement,
  GraphWorkflowExecutionContextDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { isConfigLocked } from "./affordance";
import {
  CHIP_PILL,
  CHIP_REMOVE,
  CONFIG_BUTTON_BOX,
  ConfigTextInput,
  type ConfigEditableChip,
} from "./ConfigControls";
import { ConfigControlRow, ConfigRowGroup } from "./ConfigRow";
import { CloseIcon, PlusIcon } from "./icons";
import type {
  ContextRuntimeFacts,
  ContextStructuralEditor,
} from "./structural-editor";
import { cn } from "@/lib/ui/cn";
import { textPart } from "./value-parts";

/**
 * Placement — the lane a context runs on and the write grade it runs with
 * (Config Panel `placementRows()`).
 *
 * The same two fields a lane drag writes, which is why the lane hint says so:
 * crossing a swimlane edits `placement.lane` and nothing else, and this screen
 * is the other way to make that identical edit. Grade belongs to the CONTEXT,
 * never to the lane (README §4).
 *
 * Save gating stays with `placementAuthoringIssue` — the function both hosts
 * already gate on — so the lane grammar the author is shown while typing is the
 * one the server will refuse with.
 */

const LANE_HINT =
  "Contexts sharing a lane share one worktree and land through one join. Dragging this context to another lane on the canvas edits this field and nothing else.";

const OWNED_PATHS_HINT =
  "Literal repo-relative paths, never globs. Each entry covers itself and everything beneath it.";

/** README §4's concurrency rules, in the author's terms, per grade. */
const GRADE_HINT: Record<ContextPlacement["mode"], string> = {
  full: "Writes anywhere in the lane worktree — requires exclusive occupancy of the lane while it runs.",
  owned:
    "Writes only inside the listed paths. Runs beside other owning members whose canonical paths are disjoint.",
  readOnly:
    "Writes nothing; delivers through its output schema alone. Required on the reserved session lane, allowed on any lane.",
};

const GRADE_LABEL: Record<ContextPlacement["mode"], string> = {
  full: "Full",
  owned: "Owning",
  readOnly: "Read-only",
};

/**
 * Move to a grade carrying the paths the target grade can hold.
 *
 * A grade change never invents a write surface and never rewrites one: moving
 * to `owned` starts empty (the author says what it owns), and moving away drops
 * the paths because `.strict()` refuses a stray `ownedPaths` on the other two.
 */
function withGrade(
  placement: ContextPlacement,
  mode: ContextPlacement["mode"],
): ContextPlacement {
  if (mode === placement.mode) return placement;
  if (mode !== "owned") return { lane: placement.lane, mode };
  return { lane: placement.lane, mode: "owned", ownedPaths: [] };
}

const RUNTIME_ROWS: readonly {
  key: keyof ContextRuntimeFacts;
  label: string;
  /** A row that is noise until it has something to say. */
  onlyWhenPresent?: true;
}[] = [
  { key: "lane", label: "Lane" },
  { key: "branch", label: "Branch" },
  { key: "worktree", label: "Worktree" },
  { key: "isolation", label: "Isolation" },
  { key: "activity", label: "Activity" },
  { key: "merge", label: "Merge" },
  { key: "cleanup", label: "Cleanup" },
  { key: "join", label: "Join" },
  { key: "batch", label: "Batch" },
  { key: "mergeError", label: "Merge error", onlyWhenPresent: true },
];

/**
 * The owned-path set: removable chips plus one add field.
 *
 * A path is a LITERAL repo-relative prefix — a metacharacter is an ordinary
 * filename character here — so nothing lints path shape beyond emptiness and
 * duplication; the backend adapter is the layer that knows what the sandbox can
 * enforce, and the accept-time gate reports its refusals with a locator.
 */
function OwnedPathsEditor({
  paths,
  onChange,
  disabled,
}: {
  paths: readonly string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const entry = draft.trim();
  const canAdd = !disabled && entry.length > 0 && !paths.includes(entry);

  const chips: ConfigEditableChip[] = paths.map((path) => ({
    id: path,
    label: path,
    onRemove: () => onChange(paths.filter((each) => each !== path)),
  }));

  function add() {
    if (!canAdd) return;
    onChange([...paths, entry]);
    setDraft("");
  }

  return (
    <div className="flex flex-col gap-[7px]">
      <div className="flex flex-wrap items-center gap-[5px]">
        {chips.map((chip) => (
          <span key={chip.id} className={CHIP_PILL}>
            {chip.label}
            <button
              type="button"
              onClick={chip.onRemove}
              disabled={disabled}
              aria-label={`Remove ${chip.label}`}
              className={cn(
                CHIP_REMOVE,
                "hover:enabled:text-red disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              <CloseIcon size={10} />
            </button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-[6px]">
        <ConfigTextInput
          value={draft}
          onChange={setDraft}
          ariaLabel="Add owned path"
          placeholder="src/feature"
          disabled={disabled}
        />
        <button
          type="button"
          onClick={add}
          disabled={!canAdd}
          className={cn(
            CONFIG_BUTTON_BOX,
            "h-[26px] rounded-full border-dashed px-[10px]",
          )}
        >
          <PlusIcon size={11} />
          Add path
        </button>
      </div>
    </div>
  );
}

export function PlacementScreen({
  editor,
}: {
  editor: ContextStructuralEditor;
}): React.JSX.Element {
  const { context, onContextChange } = editor;
  const locked = isConfigLocked(editor.affordance);
  const placement = context.placement;
  const issue = placementAuthoringIssue(placement);

  function editPlacement(next: ContextPlacement): void {
    // Spread the whole context so nothing this screen does not author is lost
    // (README §6) — placement is the only field it writes.
    const patch: GraphWorkflowExecutionContextDefinition = {
      ...context,
      placement: next,
    };
    onContextChange(patch);
  }

  return (
    <>
      <ConfigRowGroup label="Lane and grade">
        <ConfigControlRow
          rowId="placement-lane"
          label="Lane"
          hint={LANE_HINT}
          control={
            <ConfigTextInput
              value={placement.lane}
              onChange={(lane) => editPlacement({ ...placement, lane })}
              ariaLabel="Lane name"
              placeholder="lane-name"
              disabled={locked}
            />
          }
        />
        <ConfigControlRow
          rowId="placement-grade"
          label="Write grade"
          hint={GRADE_HINT[placement.mode]}
          disabled={locked}
        >
          <SegmentedControl
            aria-label="Write grade"
            value={placement.mode}
            disabled={locked}
            onValueChange={(next) => {
              if (next === "full" || next === "owned" || next === "readOnly") {
                editPlacement(withGrade(placement, next));
              }
            }}
            layoutClassName="w-full"
          >
            {(["full", "owned", "readOnly"] as const).map((mode) => (
              <SegmentedControlItem
                key={mode}
                value={mode}
                layoutClassName="flex-1"
              >
                {GRADE_LABEL[mode]}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </ConfigControlRow>
        {issue === null ? null : (
          <ConfigControlRow rowId="placement-issue-row" label="Not yet valid">
            <p
              data-testid="placement-issue"
              role="alert"
              className="m-0 font-mono text-[0.7rem] leading-[1.5] text-red"
            >
              {issue}
            </p>
          </ConfigControlRow>
        )}
      </ConfigRowGroup>

      {placement.mode === "owned" ? (
        <ConfigRowGroup label="Write surface">
          <ConfigControlRow
            rowId="placement-owned-paths"
            label="Owned paths"
            hint={OWNED_PATHS_HINT}
            disabled={locked}
          >
            <OwnedPathsEditor
              paths={placement.ownedPaths}
              onChange={(ownedPaths) =>
                editPlacement({
                  lane: placement.lane,
                  mode: "owned",
                  ownedPaths,
                })
              }
              disabled={locked}
            />
          </ConfigControlRow>
        </ConfigRowGroup>
      ) : null}

      {editor.host === "execution" && editor.runtime ? (
        <ConfigRowGroup label="Runtime">
          {RUNTIME_ROWS.filter(
            (row) =>
              row.onlyWhenPresent !== true ||
              (editor.runtime?.[row.key] ?? "") !== "",
          ).map(({ key, label }) => (
            <ConfigControlRow
              key={key}
              rowId={`runtime-${key}`}
              label={label}
              parts={[textPart(editor.runtime?.[key] || "—")]}
              disabled
            />
          ))}
        </ConfigRowGroup>
      ) : null}
    </>
  );
}
