"use client";

import AgentProfilePicker from "@/components/agent-profiles/AgentProfilePicker";
import { modelSelectionParametersLabel } from "@/components/model-selection-presentation";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { laneStateKey } from "@/lib/workflow-graph/lane-identity";
import { ASSIGNMENT_INSTRUCTIONS_PRESENTATION } from "@/components/workflow-config/assignment-focus";
import {
  VALIDATOR_AUTHORITY_OPTIONS,
  VALIDATOR_STRATEGY_OPTIONS,
} from "@/components/workflow-config/AssignmentEditor";
import {
  AUTHORITY_PRESENTATION,
  freshAssignmentId,
  seededAssignment,
  toggleCohortEnabled,
} from "@/components/workflow-config/CohortEditor";
import { formatAgentProfileRef } from "@/lib/agent-profiles/schemas";
import type {
  ValidatorAssignment,
  ValidatorAuthority,
  ValidatorCohort,
} from "@/lib/workflow-graph/config-schemas";
import { ConfigAgentRuntimeRows } from "./AgentRuntimeRows";
import { isConfigLocked } from "./affordance";
import type { ConfigCascadeEditor } from "./cascade-editor";
import type { ConfigPath } from "./config-cascade";
import { agentModelChip, blockSummaryParts } from "./config-summaries";
import {
  ConfigDangerButton,
  ConfigItemList,
  ConfigTextArea,
} from "./ConfigControls";
import { ConfigControlRow, ConfigDrillRow, ConfigRowGroup } from "./ConfigRow";
import { seatScreenId } from "./navigation-ids";
import { moveItem, removeItem } from "./ordered-edits";
import { chipPart } from "./value-parts";

/**
 * What reviews a context before it can advance: the validator cohort, the two
 * command gates, and the two human gates (Config Panel `gatesRows()`,
 * `validatorRows()`, `seatRows()`).
 *
 * The cohort is ONE cascade block, so every edit these screens make — the
 * switch, a reorder, a seat's reasoning effort — promotes the whole cohort to
 * the tier being edited and carries the seats it did not touch through
 * verbatim. That is why the roster and the seat screens share the block's
 * provenance rather than each carrying their own: there is one override here,
 * however deep the reader has drilled.
 */

export const VALIDATOR_SCREEN_ID = "validator";
export const SCRIPT_SCREEN_ID = "script";
export const AGENT_VALIDATION_SCREEN_ID = "agentval";
export const LANE_MERGE_SCREEN_ID = "lanemerge";

export const AGENT_VALIDATION_PATHS: readonly ConfigPath[] = [
  "agentValidation.implementer",
  "agentValidation.contextValidator",
];

export const LANE_MERGE_PATHS: readonly ConfigPath[] = [
  "laneMergeValidation.strategy",
  "laneMergeValidation.commands",
];

const COHORT_SWITCH_HINT =
  "Reviews each context's diff against its acceptance criteria after every iteration.";

const COHORT_DORMANT_HINT =
  "The roster below is kept dormant and restored when the cohort is switched back on.";

const COHORT_ENABLED_HINT =
  "All blocking seats must pass for the context to advance.";

const COHORT_DISABLED_HINT =
  "Switched off here — the seats below are kept dormant and restored on re-enable.";

const ROSTER_HINT =
  "Ordered. A frozen roster is dispatched per round; the round in flight keeps the roster it started with.";

const ROSTER_DORMANT_HINT =
  "Dormant — configuration to restore, not work to dispatch.";

const APPROVAL_HINT =
  "After all validators pass, the context parks for review. Approval lets orchestration continue; it does not itself land or publish the lane.";

const QUESTIONS_HINT =
  "Agents may ask questions at consequential decision points. The context parks until answered.";

/** What a verdict from this seat can actually do to the context. */
const AUTHORITY_HINT: Record<ValidatorAuthority, string> = {
  blocking: "A blocking verdict reopens tasks and can fail the context.",
  advisory: "Advisory findings reach the implementer as suggestions only.",
};

/** How the seat's lane is dispatched across rounds. */
const STRATEGY_HINT: Record<ValidatorAssignment["strategy"], string> = {
  conversation: "One durable conversation per validator.",
  task: "A fresh task dispatch per round.",
};

function isAuthority(value: string): value is ValidatorAuthority {
  return (VALIDATOR_AUTHORITY_OPTIONS as readonly string[]).includes(value);
}

function isStrategy(value: string): value is ValidatorAssignment["strategy"] {
  return (VALIDATOR_STRATEGY_OPTIONS as readonly string[]).includes(value);
}

/** The seat's profile and model parameters at a glance. */
function seatMeta(assignment: ValidatorAssignment): string {
  const parameters = modelSelectionParametersLabel(
    assignment.agent.modelSelection,
  );
  return `${assignment.profile.id} · ${parameters || "default parameters"}`;
}

export function QualityGatesScreen({
  editor,
  onOpen,
}: {
  editor: ConfigCascadeEditor;
  onOpen: (screenId: string) => void;
}): React.JSX.Element {
  const { cascade } = editor;
  const locked = isConfigLocked(editor.affordance);
  const cohort = cascade.resolve("contextValidator").value;
  const approval = cascade.resolve("humanApprovalGate").value;
  const questions = cascade.resolve("askUserQuestions").value;

  const setCohort = (next: ValidatorCohort) =>
    editor.onEdit(cascade.set("contextValidator", next));

  return (
    <>
      <ConfigRowGroup label="Agent review">
        <ConfigControlRow
          rowId="validator-cohort-enabled"
          label="Validator cohort"
          hint={COHORT_SWITCH_HINT}
          provenance={cascade.provenance("contextValidator")}
          disabled={locked}
          onReset={() => editor.onEdit(cascade.reset("contextValidator"))}
          control={
            <Switch
              checked={cohort.enabled}
              disabled={locked}
              aria-label="Validator cohort"
              // The lossless re-enable rule lives in the cohort editor's own
              // toggle, so both surfaces restore the same dormant roster and
              // seed the same reviewer for an emptied cohort.
              onCheckedChange={(next) =>
                setCohort(toggleCohortEnabled(cohort, next))
              }
            />
          }
        />
        <ConfigDrillRow
          screenId={VALIDATOR_SCREEN_ID}
          label="Cohort roster"
          parts={blockSummaryParts(cascade, "contextValidator")}
          provenance={cascade.groupProvenance(["contextValidator"])}
          onOpen={() => onOpen(VALIDATOR_SCREEN_ID)}
        />
      </ConfigRowGroup>

      <ConfigRowGroup label="Command gates">
        <ConfigDrillRow
          screenId={SCRIPT_SCREEN_ID}
          label="Script validator"
          parts={blockSummaryParts(cascade, "scriptValidator")}
          provenance={cascade.groupProvenance(["scriptValidator"])}
          onOpen={() => onOpen(SCRIPT_SCREEN_ID)}
        />
        <ConfigDrillRow
          screenId={AGENT_VALIDATION_SCREEN_ID}
          label="Agent validation"
          parts={blockSummaryParts(cascade, "agentValidation")}
          provenance={cascade.groupProvenance(AGENT_VALIDATION_PATHS)}
          onOpen={() => onOpen(AGENT_VALIDATION_SCREEN_ID)}
        />
        {/* The lane-merge gate guards a shared fan-in target, so it exists at
            the workflow tier only and a context scope must not offer it. */}
        {cascade.scope === "workflow" ? (
          <ConfigDrillRow
            screenId={LANE_MERGE_SCREEN_ID}
            label="Lane-merge validation"
            parts={blockSummaryParts(cascade, "laneMergeValidation")}
            provenance={cascade.groupProvenance(LANE_MERGE_PATHS)}
            onOpen={() => onOpen(LANE_MERGE_SCREEN_ID)}
          />
        ) : null}
      </ConfigRowGroup>

      <ConfigRowGroup label="Human gates">
        <ConfigControlRow
          rowId="human-approval-gate"
          label="Human approval gate"
          hint={APPROVAL_HINT}
          provenance={cascade.provenance("humanApprovalGate")}
          disabled={locked}
          onReset={() => editor.onEdit(cascade.reset("humanApprovalGate"))}
          control={
            <Switch
              checked={approval.enabled}
              // Green rather than the default cyan: this gate hands control
              // back to a person, which is a safe stop, not a consequence.
              tone="green"
              disabled={locked}
              aria-label="Human approval gate"
              onCheckedChange={(enabled) =>
                editor.onEdit(cascade.set("humanApprovalGate", { enabled }))
              }
            />
          }
        />
        <ConfigControlRow
          rowId="ask-user-questions"
          label="Ask user questions"
          hint={QUESTIONS_HINT}
          provenance={cascade.provenance("askUserQuestions")}
          disabled={locked}
          onReset={() => editor.onEdit(cascade.reset("askUserQuestions"))}
          control={
            <Switch
              checked={questions.enabled}
              disabled={locked}
              aria-label="Ask user questions"
              onCheckedChange={(enabled) =>
                editor.onEdit(cascade.set("askUserQuestions", { enabled }))
              }
            />
          }
        />
      </ConfigRowGroup>

      {cohort.enabled ? null : (
        <ConfigRowGroup>
          <ConfigControlRow
            rowId="cohort-dormant"
            label="Cohort is off here"
            hint={<span className="text-red">{COHORT_DORMANT_HINT}</span>}
          />
        </ConfigRowGroup>
      )}
    </>
  );
}

export function ValidatorCohortScreen({
  editor,
  onOpen,
}: {
  editor: ConfigCascadeEditor;
  onOpen: (screenId: string) => void;
}): React.JSX.Element {
  const { cascade } = editor;
  const locked = isConfigLocked(editor.affordance);
  const cohort = cascade.resolve("contextValidator").value;
  const dormant = !cohort.enabled;
  // A dormant roster is configuration to restore, not work to revise: the one
  // control that would put it back is a row away.
  const rosterLocked = locked || dormant;

  const setCohort = (next: ValidatorCohort) =>
    editor.onEdit(cascade.set("contextValidator", next));

  const commit = (assignments: readonly ValidatorAssignment[]) =>
    setCohort({ ...cohort, assignments: [...assignments] });

  const add = () => {
    const seed = seededAssignment();
    const taken = new Set(cohort.assignments.map((entry) => entry.id));
    commit([
      ...cohort.assignments,
      { ...seed, id: freshAssignmentId(taken, seed.profile.id) },
    ]);
  };

  const items = cohort.assignments.map((assignment, index) => ({
    id: assignment.id,
    title: assignment.id,
    chips: [
      chipPart(
        assignment.authority,
        AUTHORITY_PRESENTATION[assignment.authority].tone,
      ),
      agentModelChip(assignment.agent),
      chipPart(assignment.strategy),
    ],
    meta: seatMeta(assignment),
    screenId: seatScreenId(assignment.id),
    onOpen: () => onOpen(seatScreenId(assignment.id)),
    ...(index === 0
      ? {}
      : {
          onMoveUp: () =>
            commit(moveItem(cohort.assignments, index, index - 1)),
        }),
    ...(index === cohort.assignments.length - 1
      ? {}
      : {
          onMoveDown: () =>
            commit(moveItem(cohort.assignments, index, index + 1)),
        }),
    onRemove: () => commit(removeItem(cohort.assignments, index)),
    // An enabled cohort with no seats would pass vacuously, so its last seat
    // cannot go — the schema refuses that document.
    removeDisabled:
      (editor.startedLaneKeys?.has(
        laneStateKey("context_validator", assignment.id),
      ) ??
        false) ||
      (cohort.enabled && cohort.assignments.length <= 1),
  }));

  return (
    <>
      <ConfigRowGroup label="Status">
        <ConfigControlRow
          rowId="cohort-enabled"
          label="Cohort enabled"
          hint={dormant ? COHORT_DISABLED_HINT : COHORT_ENABLED_HINT}
          provenance={cascade.provenance("contextValidator")}
          disabled={locked}
          onReset={() => editor.onEdit(cascade.reset("contextValidator"))}
          control={
            <Switch
              checked={cohort.enabled}
              disabled={locked}
              aria-label="Cohort enabled"
              onCheckedChange={(next) =>
                setCohort(toggleCohortEnabled(cohort, next))
              }
            />
          }
        />
      </ConfigRowGroup>

      <ConfigRowGroup label="Roster">
        <ConfigControlRow
          rowId="cohort-seats"
          label="Seats"
          hint={
            dormant ? (
              <span className="text-red">{ROSTER_DORMANT_HINT}</span>
            ) : (
              ROSTER_HINT
            )
          }
        >
          <ConfigItemList
            items={items}
            addLabel="Add validator"
            onAdd={add}
            disabled={rosterLocked}
          />
        </ConfigControlRow>
      </ConfigRowGroup>
    </>
  );
}

export function ValidatorSeatScreen({
  editor,
  seatId,
  open,
}: {
  editor: ConfigCascadeEditor;
  seatId: string;
  /** Test/story affordance: Radix cannot open a listbox in jsdom on its own. */
  open?: boolean;
}): React.JSX.Element {
  const { cascade } = editor;
  const started =
    editor.startedLaneKeys?.has(laneStateKey("context_validator", seatId)) ??
    false;
  const locked = isConfigLocked(editor.affordance) || started;
  const cohort = cascade.resolve("contextValidator").value;
  const provenance = cascade.provenance("contextValidator");
  const seat = cohort.assignments.find((entry) => entry.id === seatId);

  if (seat === undefined) {
    // Reachable only from a stale navigation stack — a removed seat's screen
    // is still on it when the reader steps back into it.
    return (
      <ConfigRowGroup>
        <ConfigControlRow
          rowId="seat-missing"
          label="Seat not found"
          hint={`No validator named ${seatId} is on this roster.`}
        />
      </ConfigRowGroup>
    );
  }

  // One writer for the whole cohort: a seat edit is a block edit, and the
  // seats it did not touch ride along unchanged.
  const editSeat = (next: ValidatorAssignment) =>
    editor.onEdit(
      cascade.set("contextValidator", {
        ...cohort,
        assignments: cohort.assignments.map((entry) =>
          entry.id === seatId ? next : entry,
        ),
      }),
    );

  const instructions = ASSIGNMENT_INSTRUCTIONS_PRESENTATION[seat.authority];

  const editInstructions = (text: string) => {
    if (text.trim() === "") {
      // Absence, not an empty string, is what "no use-site steer" is in the
      // schema.
      const cleared = { ...seat };
      delete cleared.focus;
      editSeat(cleared);
      return;
    }
    editSeat({ ...seat, focus: text });
  };

  return (
    <>
      {started && (
        <p className="m-0 px-lg py-sm font-mono text-[0.7rem] text-text-tertiary">
          This assignment is fixed because its conversation has started.
        </p>
      )}
      <ConfigRowGroup label="Identity">
        <ConfigControlRow
          rowId="seat-profile"
          label="Profile"
          provenance={provenance}
          disabled={locked}
          control={
            <AgentProfilePicker
              projectName={editor.libraryProjectName ?? null}
              value={formatAgentProfileRef(seat.profile)}
              audience="workflow_validator"
              disabled={locked}
              onChange={(selection) =>
                editSeat({ ...seat, profile: selection.ref })
              }
              {...(open === undefined ? {} : { open })}
            />
          }
        />
      </ConfigRowGroup>

      <ConfigRowGroup label="Verdict">
        <ConfigControlRow
          rowId="seat-authority"
          label="Authority"
          hint={AUTHORITY_HINT[seat.authority]}
          provenance={provenance}
          disabled={locked}
          control={
            <SegmentedControl
              aria-label={`Authority for ${seat.id}`}
              value={seat.authority}
              disabled={locked}
              onValueChange={(next) => {
                if (!isAuthority(next)) return;
                editSeat({ ...seat, authority: next });
              }}
            >
              {VALIDATOR_AUTHORITY_OPTIONS.map((option) => (
                <SegmentedControlItem key={option} value={option}>
                  {option}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          }
        />
        <ConfigControlRow
          rowId="seat-instructions"
          // The authority alone decides the force of this one field, so the
          // label is where an author sees which of the two they are writing.
          label={instructions.label}
          hint={instructions.hint}
          provenance={provenance}
          disabled={locked}
        >
          <ConfigTextArea
            value={seat.focus ?? ""}
            onChange={editInstructions}
            ariaLabel={`${instructions.label} for ${seat.id}`}
            placeholder={instructions.placeholder}
            disabled={locked}
          />
        </ConfigControlRow>
        <ConfigControlRow
          rowId="seat-strategy"
          label="Strategy"
          hint={STRATEGY_HINT[seat.strategy]}
          provenance={provenance}
          disabled={locked}
          control={
            <SegmentedControl
              aria-label={`Strategy for ${seat.id}`}
              value={seat.strategy}
              disabled={locked}
              onValueChange={(next) => {
                if (!isStrategy(next)) return;
                editSeat({ ...seat, strategy: next });
              }}
            >
              {VALIDATOR_STRATEGY_OPTIONS.map((option) => (
                <SegmentedControlItem key={option} value={option}>
                  {option}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          }
        />
      </ConfigRowGroup>

      <ConfigRowGroup label="Runtime">
        <ConfigAgentRuntimeRows
          rowPrefix="seat"
          value={seat.agent}
          onChange={(agent) => editSeat({ ...seat, agent })}
          provenance={provenance}
          disabled={locked}
        />
      </ConfigRowGroup>

      {editor.onResetSeat === undefined ? null : (
        <ConfigRowGroup label="Reset">
          <ConfigControlRow
            rowId="seat-reset"
            label="Retry this validator"
            hint="Re-runs this validator in its existing conversation against the current candidate. The other seats keep their verdicts."
          >
            <ConfigDangerButton
              label={
                editor.resettingSeatId === seat.id ? "Resetting…" : "Reset seat"
              }
              disabled={editor.resettingSeatId != null}
              onClick={() => editor.onResetSeat?.(seat.id)}
            />
          </ConfigControlRow>
        </ConfigRowGroup>
      )}
    </>
  );
}
