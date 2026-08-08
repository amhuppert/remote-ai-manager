"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import {
  contextPlacementSchema,
  type ContextPlacement,
} from "@/lib/workflow-graph/definition-schemas";
import {
  laneIdViolation,
  SESSION_LANE_NAME,
} from "@/lib/workflow-graph/lane-identity";
import { FieldRow, type EditorBaseProps } from "./FieldPrimitives";

// Where a context runs and what it may write (lwp R1). One editor for both
// authoring tiers — the builder's draft definition and the live execution's
// working definition — because placement means the same thing in each: a lane
// name plus a write grade. The tiers differ only in WHEN an edit is allowed,
// which the host decides through `readOnly`.

const HINT_CLASS = "font-mono text-[0.7rem] leading-[1.5] text-text-tertiary";

const MODE_HINT: Record<ContextPlacement["mode"], string> = {
  full: "Writes anywhere in the lane's worktree — needs the lane to itself while a sibling could run.",
  owned:
    "Writes only inside the listed paths. Each entry covers itself and everything beneath it.",
  readOnly: `Writes nothing: runs on the "${SESSION_LANE_NAME}" lane and delivers through its output schema alone.`,
};

/**
 * Why this placement cannot be submitted yet, or null when it is complete.
 *
 * Exported because both hosts gate Save on it: the builder blocks a draft the
 * accept-time gate would refuse, and the live editor blocks an `update-context`
 * op the frontier would refuse. Lane grammar is re-checked HERE rather than
 * only server-side so the author sees an illegal branch segment while typing;
 * the server refusal stays authoritative.
 */
export function placementAuthoringIssue(
  placement: ContextPlacement,
): string | null {
  if (!contextPlacementSchema.safeParse(placement).success) {
    return placement.mode === "owned" && placement.ownedPaths.length === 0
      ? 'An owning placement needs at least one owned path — or use "read-only" for a context with no write surface.'
      : "This placement is not a legal declaration.";
  }
  if (placement.lane === SESSION_LANE_NAME) {
    return placement.mode === "readOnly"
      ? null
      : `The reserved "${SESSION_LANE_NAME}" lane admits read-only contexts only.`;
  }
  const violation = laneIdViolation(placement.lane);
  return violation === null
    ? null
    : `Lane names become branch and worktree path segments: it ${violation}.`;
}

/** Move to a grade, carrying the paths the author already typed where it fits. */
function withMode(
  placement: ContextPlacement,
  mode: ContextPlacement["mode"],
): ContextPlacement {
  if (mode === placement.mode) return placement;
  if (mode !== "owned") return { lane: placement.lane, mode };
  return {
    lane: placement.lane,
    mode: "owned",
    ownedPaths: placement.mode === "owned" ? placement.ownedPaths : [],
  };
}

export function PlacementEditor({
  value,
  onChange,
  readOnly,
}: EditorBaseProps<ContextPlacement>): React.JSX.Element {
  const issue = placementAuthoringIssue(value);

  return (
    <div className="flex flex-col gap-sm" data-testid="placement-editor">
      <FieldRow
        label="Lane"
        hint="Contexts sharing a lane share one worktree and land through one join."
      >
        <input
          type="text"
          className="w-[170px] rounded-sm border border-solid border-border-default bg-bg-surface px-[10px] py-[5px] font-mono text-[0.72rem] text-text-primary transition-[border-color] duration-150 outline-none focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)] disabled:cursor-not-allowed disabled:opacity-60"
          value={value.lane}
          placeholder="lane-name"
          aria-label="Lane name"
          disabled={readOnly}
          onChange={(event) => onChange({ ...value, lane: event.target.value })}
        />
      </FieldRow>
      <FieldRow label="Grade" hint={MODE_HINT[value.mode]}>
        <SegmentedControl
          aria-label="Write grade"
          value={value.mode}
          disabled={readOnly}
          onValueChange={(next) => {
            if (readOnly) return;
            if (next === "full" || next === "owned" || next === "readOnly") {
              onChange(withMode(value, next));
            }
          }}
        >
          <SegmentedControlItem value="full">Full access</SegmentedControlItem>
          <SegmentedControlItem value="owned">Owning</SegmentedControlItem>
          <SegmentedControlItem value="readOnly">
            Read-only
          </SegmentedControlItem>
        </SegmentedControl>
      </FieldRow>
      {value.mode === "owned" ? (
        <FieldRow label="Owned paths">
          <OwnedPathListEditor
            value={value.ownedPaths}
            disabled={readOnly}
            onChange={(ownedPaths) =>
              onChange({ lane: value.lane, mode: "owned", ownedPaths })
            }
          />
        </FieldRow>
      ) : null}
      {issue ? (
        <div
          className="font-mono text-[0.7rem] leading-[1.5] text-red"
          data-testid="placement-issue"
        >
          {issue}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The ordered owned-path set, edited as removable chips plus one add field.
 *
 * Entries are LITERAL repo-relative paths, never globs — a metacharacter is an
 * ordinary filename character here, and the backend adapter is what refuses one,
 * because it is the layer that knows what the sandbox can enforce. The editor
 * therefore does not lint path shape beyond emptiness; the accept-time gate
 * reports the normalization refusals with a locator.
 */
function OwnedPathListEditor({
  value,
  onChange,
  disabled,
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const entry = text.trim();
  const canAdd = !disabled && entry.length > 0 && !value.includes(entry);

  const add = () => {
    if (!canAdd) return;
    onChange([...value, entry]);
    setText("");
  };

  return (
    <div className="flex min-w-0 flex-col gap-xs">
      {value.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap gap-xs p-0">
          {value.map((path) => (
            <li
              key={path}
              className="inline-flex items-center gap-[5px] rounded-full border border-solid border-border-subtle bg-bg-raised py-[2px] pr-[4px] pl-[9px] font-mono text-[0.72rem] text-text-primary"
            >
              {path}
              <button
                type="button"
                aria-label={`Remove ${path}`}
                className="inline-flex size-[16px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 font-mono text-[0.72rem] leading-none text-text-tertiary transition-colors duration-150 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 enabled:hover:bg-bg-hover enabled:hover:text-red disabled:cursor-not-allowed disabled:opacity-40"
                disabled={disabled}
                onClick={() => onChange(value.filter((each) => each !== path))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className={HINT_CLASS}>No owned paths yet.</div>
      )}
      <div className="flex items-center gap-xs">
        <input
          type="text"
          className="w-[170px] rounded-sm border border-solid border-border-default bg-bg-surface px-[10px] py-[5px] font-mono text-[0.72rem] text-text-primary transition-[border-color] duration-150 outline-none focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)] disabled:cursor-not-allowed disabled:opacity-60"
          value={text}
          placeholder="src/feature"
          aria-label="Add owned path"
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button variant="ghost" size="sm" disabled={!canAdd} onClick={add}>
          Add
        </Button>
      </div>
    </div>
  );
}
