"use client";

import AgentProfilePicker from "@/components/agent-profiles/AgentProfilePicker";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { laneStateKey } from "@/lib/workflow-graph/lane-identity";
import { NumericInput } from "@/components/workflow-config/FieldPrimitives";
import { formatAgentProfileRef } from "@/lib/agent-profiles/schemas";
import type { CollaborationAutonomousResolutionThreshold } from "@/lib/workflow-graph/collaboration-schemas";
import type { AgentAssignment } from "@/lib/workflow-graph/config-schemas";
import { ConfigAgentRuntimeRows } from "./AgentRuntimeRows";
import { isConfigLocked } from "./affordance";
import type { ConfigCascadeEditor } from "./cascade-editor";
import type { ConfigPath } from "./config-cascade";
import { blockSummaryParts } from "./config-summaries";
import { ConfigTextArea } from "./ConfigControls";
import { ConfigControlRow, ConfigDrillRow, ConfigRowGroup } from "./ConfigRow";

/**
 * Who does the work: the implementer block, and the second agent that
 * negotiates with it (Config Panel `agentsRows()`, `implementerRows()`,
 * `collabRows()`).
 *
 * The two cascade at different granularities and the screens are shaped by
 * that. The implementer is one block — an edit to its profile, its steer or its
 * runtime promotes all of it — so its rows share one provenance and one reset.
 * Collaboration is four independent fields, so each row carries its own tier
 * chip and its own reset, and the group screen says so where the switch is:
 * turning collaboration on is one field's worth of override, not the block's.
 */

export const COLLABORATION_SCREEN_ID = "collab";
export const IMPLEMENTER_SCREEN_ID = "implementer";

const COLLABORATION_PATHS: readonly ConfigPath[] = [
  "collaboration.enabled",
  "collaboration.secondAgent",
  "collaboration.negotiationRounds",
  "collaboration.autonomousResolutionThreshold",
];

const COLLABORATION_SWITCH_HINT =
  "A second agent negotiates the diff with the implementer before it is offered for validation. This field inherits on its own — the rest of the block is unaffected.";

const COLLABORATION_OFF_HINT =
  "Off — the fields below stay authored and inherit independently.";

const IMPLEMENTER_INSTRUCTIONS_HINT =
  "Use-site steer, not a durable prompt — clearing it removes the key.";

const NEGOTIATION_ROUNDS_HINT =
  "Per-field cascade: this field is set here; the others above still resolve from their own tier.";

/** What each threshold actually decides, in the author's terms. */
const THRESHOLD_HINT: Record<
  CollaborationAutonomousResolutionThreshold,
  string
> = {
  none: "Always pause when there are conflicts",
  minor: "Auto-resolve only minor conflicts",
  major: "Auto-resolve up to major conflicts",
  blocking: "Auto-resolve everything, including blocking conflicts",
};

const THRESHOLDS: readonly CollaborationAutonomousResolutionThreshold[] = [
  "none",
  "minor",
  "major",
  "blocking",
];

function isThreshold(
  value: string,
): value is CollaborationAutonomousResolutionThreshold {
  return (THRESHOLDS as readonly string[]).includes(value);
}

export function AgentsGroupScreen({
  editor,
  onOpen,
}: {
  editor: ConfigCascadeEditor;
  onOpen: (screenId: string) => void;
}): React.JSX.Element {
  const { cascade } = editor;
  const locked = isConfigLocked(editor.affordance);
  const enabled = cascade.resolve("collaboration.enabled").value;

  return (
    <>
      <ConfigRowGroup label="Implementer">
        <ConfigDrillRow
          screenId={IMPLEMENTER_SCREEN_ID}
          label="Implementer"
          parts={blockSummaryParts(cascade, "implementer")}
          provenance={cascade.groupProvenance(["implementer"])}
          onOpen={() => onOpen(IMPLEMENTER_SCREEN_ID)}
        />
      </ConfigRowGroup>

      <ConfigRowGroup label="Collaboration">
        <ConfigControlRow
          rowId="collaboration-enabled"
          label="Collaboration"
          hint={COLLABORATION_SWITCH_HINT}
          provenance={cascade.provenance("collaboration.enabled")}
          disabled={locked}
          onReset={() => editor.onEdit(cascade.reset("collaboration.enabled"))}
          control={
            <Switch
              checked={enabled}
              disabled={locked}
              aria-label="Collaboration"
              onCheckedChange={(next) =>
                editor.onEdit(cascade.set("collaboration.enabled", next))
              }
            />
          }
        />
        <ConfigDrillRow
          screenId={COLLABORATION_SCREEN_ID}
          label="Collaboration setup"
          parts={blockSummaryParts(cascade, "collaboration")}
          provenance={cascade.groupProvenance(COLLABORATION_PATHS)}
          onOpen={() => onOpen(COLLABORATION_SCREEN_ID)}
        />
      </ConfigRowGroup>
    </>
  );
}

export function ImplementerScreen({
  editor,
  open,
}: {
  editor: ConfigCascadeEditor;
  /** Test/story affordance: Radix cannot open a listbox in jsdom on its own. */
  open?: boolean;
}): React.JSX.Element {
  const { cascade } = editor;
  const implementer = cascade.resolve("implementer").value;
  const started =
    editor.startedLaneKeys?.has(laneStateKey("implementer")) ?? false;
  const locked = isConfigLocked(editor.affordance) || started;
  const provenance = cascade.provenance("implementer");

  // One writer for the whole block: promoting the implementer to this tier
  // carries its id, its profile, its steer and its runtime together, because
  // that is the unit the cascade stores and inherits (README §7).
  const edit = (next: AgentAssignment) =>
    editor.onEdit(cascade.set("implementer", next));

  const editInstructions = (text: string) => {
    if (text.trim() === "") {
      // Absence, not an empty string, is what "no use-site steer" is in the
      // schema — and clearing it must be the same document a fresh block has.
      const cleared = { ...implementer };
      delete cleared.focus;
      edit(cleared);
      return;
    }
    edit({ ...implementer, focus: text });
  };

  const reset = () => editor.onEdit(cascade.reset("implementer"));

  return (
    <>
      {started && (
        <p className="m-0 px-lg py-sm font-mono text-[0.7rem] text-text-tertiary">
          This assignment is fixed because its conversation has started.
        </p>
      )}
      <ConfigRowGroup label="Identity">
        <ConfigControlRow
          rowId="implementer-profile"
          label="Profile"
          provenance={provenance}
          disabled={locked}
          onReset={reset}
          control={
            <AgentProfilePicker
              projectName={editor.libraryProjectName ?? null}
              value={formatAgentProfileRef(implementer.profile)}
              audience="workflow_implementer"
              disabled={locked}
              onChange={(selection) =>
                edit({ ...implementer, profile: selection.ref })
              }
              {...(open === undefined ? {} : { open })}
            />
          }
        />
        <ConfigControlRow
          rowId="implementer-instructions"
          label="Instructions"
          hint={IMPLEMENTER_INSTRUCTIONS_HINT}
          provenance={provenance}
          disabled={locked}
        >
          <ConfigTextArea
            value={implementer.focus ?? ""}
            onChange={editInstructions}
            ariaLabel="Implementer instructions"
            placeholder="Steer this implementer at this use site only"
            disabled={locked}
          />
        </ConfigControlRow>
      </ConfigRowGroup>

      <ConfigRowGroup label="Runtime">
        <ConfigAgentRuntimeRows
          rowPrefix="implementer"
          value={implementer.agent}
          onChange={(agent) => edit({ ...implementer, agent })}
          provenance={provenance}
          disabled={locked}
        />
      </ConfigRowGroup>
    </>
  );
}

export function CollaborationScreen({
  editor,
}: {
  editor: ConfigCascadeEditor;
}): React.JSX.Element {
  const { cascade } = editor;
  const locked = isConfigLocked(editor.affordance);
  const enabled = cascade.resolve("collaboration.enabled").value;
  const secondAgent = cascade.resolve("collaboration.secondAgent").value;
  const rounds = cascade.resolve("collaboration.negotiationRounds").value;
  const threshold = cascade.resolve(
    "collaboration.autonomousResolutionThreshold",
  ).value;

  const resetOf = (path: ConfigPath) => () =>
    editor.onEdit(cascade.reset(path));

  return (
    <>
      <ConfigRowGroup label="Status">
        <ConfigControlRow
          rowId="collab-enabled"
          label="Enabled"
          hint={enabled ? undefined : COLLABORATION_OFF_HINT}
          provenance={cascade.provenance("collaboration.enabled")}
          disabled={locked}
          onReset={resetOf("collaboration.enabled")}
          control={
            <Switch
              checked={enabled}
              disabled={locked}
              aria-label="Collaboration enabled"
              onCheckedChange={(next) =>
                editor.onEdit(cascade.set("collaboration.enabled", next))
              }
            />
          }
        />
      </ConfigRowGroup>

      <ConfigRowGroup label="Second agent">
        <ConfigAgentRuntimeRows
          rowPrefix="collab-second-agent"
          value={secondAgent}
          onChange={(agent) =>
            editor.onEdit(cascade.set("collaboration.secondAgent", agent))
          }
          provenance={cascade.provenance("collaboration.secondAgent")}
          onReset={resetOf("collaboration.secondAgent")}
          disabled={locked}
        />
      </ConfigRowGroup>

      <ConfigRowGroup label="Negotiation">
        <ConfigControlRow
          rowId="collab-rounds"
          label="Negotiation rounds"
          hint={NEGOTIATION_ROUNDS_HINT}
          provenance={cascade.provenance("collaboration.negotiationRounds")}
          disabled={locked}
          onReset={resetOf("collaboration.negotiationRounds")}
          control={
            <NumericInput
              value={rounds}
              min={1}
              ariaLabel="Negotiation rounds"
              disabled={locked}
              onChange={(next) => {
                // A half-typed or cleared field is not a round count; the row
                // keeps showing the resolved value until one arrives.
                if (next === undefined || !Number.isInteger(next) || next < 1) {
                  return;
                }
                editor.onEdit(
                  cascade.set("collaboration.negotiationRounds", next),
                );
              }}
            />
          }
        />
        <ConfigControlRow
          rowId="collab-threshold"
          label="Auto-resolve threshold"
          hint={THRESHOLD_HINT[threshold]}
          provenance={cascade.provenance(
            "collaboration.autonomousResolutionThreshold",
          )}
          disabled={locked}
          onReset={resetOf("collaboration.autonomousResolutionThreshold")}
        >
          <SegmentedControl
            aria-label="Auto-resolve threshold"
            value={threshold}
            disabled={locked}
            layoutClassName="w-full"
            onValueChange={(next) => {
              if (!isThreshold(next)) return;
              editor.onEdit(
                cascade.set(
                  "collaboration.autonomousResolutionThreshold",
                  next,
                ),
              );
            }}
          >
            {THRESHOLDS.map((option) => (
              <SegmentedControlItem
                key={option}
                value={option}
                layoutClassName="flex-1"
              >
                {option}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </ConfigControlRow>
      </ConfigRowGroup>
    </>
  );
}
