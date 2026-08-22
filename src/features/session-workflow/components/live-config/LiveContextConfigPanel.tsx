"use client";

import { useMemo, useState } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  MultilinePrimaryActionScope,
  useMultilinePrimaryActionRegistry,
} from "@/components/MultilineInput";
import type { ConfigCascadeEditor } from "@/components/workflow-config-panel/cascade-editor";
import { cascadeScreens } from "@/components/workflow-config-panel/cascade-screens";
import {
  applyConfigEditToContext,
  type ConfigEditIntent,
} from "@/components/workflow-config-panel/config-cascade";
import { ConfigPanel } from "@/components/workflow-config-panel/ConfigPanel";
import { classifyConfigAffordance } from "@/components/workflow-config-panel/execution-affordance";
import { buildContextRootCards } from "@/components/workflow-config-panel/root-cards";
import { outputSchemaSaveBlockReason } from "@/components/workflow-config-panel/schema-lint";
import { createConfigScreenRegistry } from "@/components/workflow-config-panel/screen-registry";
import { contextStructuralScreens } from "@/components/workflow-config-panel/structural-screens";
import type {
  ContextRuntimeFacts,
  ContextStructuralEditor,
} from "@/components/workflow-config-panel/structural-editor";
import { LaneRotationNotice } from "@/components/workflow-config/LaneRotationNotice";
import { deepEqualJson } from "@/lib/shared/deep-equal";
import type { ValidationCommandSummary } from "@/lib/validation/schemas";
import { resolveUpstreamInputs } from "@/lib/workflow-graph/context-outputs";
import { deriveExecutionLaneActivities } from "@/lib/workflow-graph/lane-activity";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import { createLiveConfigCascade } from "./live-config-cascade";
import { livePlacementIssue } from "./live-placement-gate";
import { liveSaveState } from "./live-save-state";
import {
  diffLiveContextOp,
  liveConfigProvenance,
  rebaseLiveDraft,
  serializeOutputSchemaText,
  toLiveDraft,
  type LiveContextDraft,
} from "./live-context-draft";

/**
 * The config panel mounted over one context of a LIVE execution (README §8).
 *
 * The panel itself is host-agnostic: it renders screens, states an affordance
 * and offers a save bar. What this module owns is everything that makes those
 * true of a running execution — the affordance verdict, the draft over the
 * snapshotted working configuration, the cascade adapter that states proven
 * provenance without offering a reset the live vocabulary cannot spell, and the
 * mapping from a panel edit to the one `update-context` op the runtime-edit
 * endpoint accepts.
 *
 * Task editing is deliberately absent here: §11 lands tasks and task history on
 * the Tasks tab, which already composes the add / update / remove / reorder live
 * ops. A second editor for the same list on the Config tab would be a second
 * owner of the same edit.
 */

/**
 * An in-flight `outputSchema` submission, held until the server is observed to
 * agree with it. `text` is the raw editor text that produced the op; `canonical`
 * is how the stored document will serialize back through `toLiveDraft`;
 * `atRevision` is the `liveRevision` it was authored against.
 *
 * The revision matters because "the server holds my document" is TRUE from the
 * outset for a formatting-only edit — the document never changed, only its text.
 * Without a marker that the stored state actually moved, such a submission would
 * settle the instant it was dispatched.
 */
interface SubmittedSchema {
  text: string;
  canonical: string;
  atRevision: number;
}

export interface LiveContextConfigPanelProps {
  execution: GraphWorkflowExecution;
  contextId: string;
  /** Compose an `update-context` op batch through the runtime-edits endpoint. */
  onSaveContextConfig?: (operations: WorkflowLiveEditOperation[]) => void;
  /** Pause the running execution so a `started` context becomes editable. */
  onPauseExecution?: () => void;
  /** Resume the execution once edits are saved (offered after a save). */
  onResumeExecution?: () => void;
  isSaving?: boolean;
  isPausing?: boolean;
  isResuming?: boolean;
  /** The last save hit a `revision_conflict` — surface the retry notice. */
  editConflict?: boolean;
  /** A non-conflict save refusal or request failure to show at the edit site. */
  editError?: string | null;
  /** The last save succeeded — offer Resume for the pause-to-edit flow. */
  saveSucceeded?: boolean;
  /** Project-scoped registry summaries; undefined = registry unavailable. */
  commandOptions?: readonly ValidationCommandSummary[];
  /** Scopes the agent-profile listing the assignment pickers offer. */
  libraryProjectName?: string | null;
  /** Retire ONE cohort member's lane (README §11). */
  onResetAssignment?: (contextId: string, assignmentId: string) => void;
  /**
   * Destructively reset the WHOLE context — §11 lands this in the Config tab's
   * danger footer, behind a confirmation.
   */
  onResetContext?: (contextId: string) => void;
  /** Any execution-level mutation is in flight, so the reset must not fire. */
  isMutating?: boolean;
  /** The assignment whose reset is in flight, if any. */
  resettingAssignmentId?: string | null;
  /**
   * A screen inside the panel a deep link is aimed at, in the panel's own
   * navigation vocabulary — `["brief", "schema"]` is the output-schema halt's
   * repair path. A fresh array per request, so asking twice navigates again.
   */
  focusScreen?: readonly string[];
}

function runtimeFactsFor(
  execution: GraphWorkflowExecution,
  contextId: string,
  lane: string | undefined,
): ContextRuntimeFacts | undefined {
  const state = execution.contextStates[contextId];
  if (state === undefined) return undefined;
  const laneActivity = deriveExecutionLaneActivities(execution).find(
    (entry) => entry.laneId === lane,
  );
  return {
    lane: state.laneId ?? "",
    branch: state.branchName ?? "",
    worktree: state.worktreePath ?? "",
    isolation: state.isolation ?? "",
    // The whole lane's picture, not this context's alone: an owning member's
    // activity only means something beside the siblings sharing its worktree.
    activity:
      laneActivity === undefined
        ? ""
        : laneActivity.members
            .map(
              (member) =>
                `${member.contextId}: ${member.activity} (${member.status})`,
            )
            .join(", "),
    merge: state.mergeStatus ?? "",
    cleanup: state.cleanupStatus ?? "",
    join: state.joinId ?? "",
    batch: state.batchId ?? "",
    mergeError: state.lastMergeError ?? "",
  };
}

export default function LiveContextConfigPanel({
  execution,
  contextId,
  onSaveContextConfig,
  onPauseExecution,
  onResumeExecution,
  isSaving = false,
  isPausing = false,
  isResuming = false,
  editConflict = false,
  editError = null,
  saveSucceeded = false,
  commandOptions,
  libraryProjectName,
  onResetAssignment,
  resettingAssignmentId,
  onResetContext,
  isMutating = false,
  focusScreen,
}: LiveContextConfigPanelProps): React.JSX.Element | null {
  const multilineActions = useMultilinePrimaryActionRegistry();
  const context = execution.workingDefinition.executionContexts.find(
    (candidate) => candidate.id === contextId,
  );

  const freshBase = useMemo(
    () => (context ? toLiveDraft(context) : null),
    [context],
  );

  const [draft, setDraft] = useState<LiveContextDraft | null>(freshBase);
  // The baseline the draft's edits are measured against. Diffs (and the dirty
  // flag) compare the draft to THIS, never to the live `freshBase`, so a
  // concurrent edit that moves an untouched field can never enter the retry
  // payload — the core lost-update guard.
  const [seedBase, setSeedBase] = useState<LiveContextDraft | null>(freshBase);
  // Which SELECTION the draft belongs to. The execution is half of that
  // identity, not decoration: context ids repeat across runs of the same plan
  // and the inspector keeps its selection when the execution rail moves, so a
  // contextId-only check would rebase one run's unsaved edits onto another
  // run's snapshot — and report that run's save outcome over them.
  const [seededFor, setSeededFor] = useState({
    executionId: execution.id,
    contextId,
  });
  const [submittedSchema, setSubmittedSchema] =
    useState<SubmittedSchema | null>(null);
  // Whether THIS context has submitted a save whose outcome is still being
  // reported. The runtime-edit mutation is owned once for the whole execution,
  // so its pending / error / conflict / success flags stay set while a
  // different context is selected — a context that submitted nothing would
  // otherwise announce someone else's Saving…, refusal, or Resume offer.
  const [submitted, setSubmitted] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  // A deep link is honoured by remounting the PANEL, which holds only the
  // navigation stack — the draft lives here, so an unsaved edit survives the
  // jump. Keyed on a counter because the same path may be requested twice.
  const [honouredFocus, setHonouredFocus] = useState<readonly string[] | null>(
    null,
  );
  const [focusSeq, setFocusSeq] = useState(0);
  if (focusScreen !== undefined && focusScreen !== honouredFocus) {
    setHonouredFocus(focusScreen);
    setFocusSeq((seq) => seq + 1);
  }

  if (
    seededFor.executionId !== execution.id ||
    seededFor.contextId !== contextId
  ) {
    // Selection changed — reseed wholesale, outcome flags included: nothing
    // this panel is holding was authored against the selection now on screen.
    setSeededFor({ executionId: execution.id, contextId });
    setDraft(freshBase);
    setSeedBase(freshBase);
    setSubmittedSchema(null);
    setSubmitted(false);
  } else if (draft && seedBase && freshBase) {
    // A schema submission is acknowledged only once the stored state has moved
    // AND the server's own copy serializes to what we sent — never at dispatch,
    // when the outcome is still unknown. Normalizing early would make a
    // formatting-only edit string-equal to `seedBase`, and a rejected save would
    // then rebase as "untouched": the concurrent schema wins and the submitted
    // document is lost silently.
    //
    // Each conjunct rules out a distinct false settle: `saveSucceeded` is our
    // own mutation reporting success, so a submission can never settle while its
    // outcome is unknown — a revision that moved only proves SOME write landed,
    // and an unrelated concurrent edit supplies that on its own; `editConflict`
    // is the rejection itself; the revision proves the write is observable in
    // what we are reading (a formatting-only edit matches the stored document
    // from the outset, so the document check alone would fire immediately); the
    // document check proves the write that landed agrees with ours; and the text
    // check lets a later keystroke revoke it, so text the user has moved on from
    // never settles.
    const acknowledged =
      submittedSchema !== null &&
      saveSucceeded &&
      !editConflict &&
      execution.liveRevision !== submittedSchema.atRevision &&
      freshBase.outputSchemaText === submittedSchema.canonical &&
      draft.outputSchemaText === submittedSchema.text;
    // Adopting the canonical serialization is what settles the draft clean:
    // `toLiveDraft` re-serializes the stored document, so raw text that differs
    // only in formatting would otherwise stay dirty against itself forever.
    const reconciled = acknowledged
      ? { ...draft, outputSchemaText: submittedSchema.canonical }
      : draft;
    if (acknowledged) setSubmittedSchema(null);

    if (!deepEqualJson(freshBase, seedBase)) {
      // The execution moved underneath us (a revision-conflict refetch, or a
      // concurrent edit arriving over SSE). Three-way rebase onto the fresh
      // baseline: keep the fields the user actually edited, adopt the fresh
      // value everywhere else, and advance the baseline so only the user's own
      // edits stay dirty.
      setDraft(rebaseLiveDraft(reconciled, seedBase, freshBase));
      setSeedBase(freshBase);
    } else if (reconciled !== draft) {
      // The document was already what we sent, so no rebase runs — but the raw
      // text still has to adopt the stored form to settle clean.
      setDraft(reconciled);
    }
  }

  const verdict = classifyConfigAffordance(execution, contextId);
  const upstreamInputs = useMemo(
    () => resolveUpstreamInputs(execution, contextId),
    [execution, contextId],
  );

  if (!context || !draft || !seedBase) return null;

  const editable = verdict.affordance === "editable";
  const pendingOp = diffLiveContextOp({
    contextId,
    draft,
    base: seedBase,
    stored: context,
  });
  // Dirtiness cannot be `pendingOp !== null` alone: text that does not parse
  // produces no op, yet the author has unmistakably changed something. Splitting
  // the two lets the save bar say "you have changes AND they are not saveable"
  // instead of silently pretending the edit never happened.
  const schemaTextDirty = draft.outputSchemaText !== seedBase.outputSchemaText;
  const dirty = pendingOp !== null || schemaTextDirty;
  // Every pre-submission refusal reports its own sentence rather than a flag,
  // so the save bar can send the author to the screen that is actually wrong
  // (§8.2). The two that judge the draft come first: an unacceptable schema
  // text, and a placement the frontier would refuse — an illegal declaration,
  // or a move the whole definition cannot accommodate — which blocks here
  // rather than bouncing the whole batch.
  //
  // The third refusal is not about the draft at all. The runtime-edit mutation
  // is owned once for the whole execution, so a sibling context's submission
  // occupies it: `handleSave` would return without submitting anything, and an
  // enabled button that does nothing is the one outcome §8.2 rules out. It
  // ranks last because the two draft refusals name something the author has to
  // fix, while this one clears itself.
  const siblingSaveInFlight = isSaving && !submitted;
  const saveBlockedReason =
    outputSchemaSaveBlockReason(draft.outputSchemaText) ??
    livePlacementIssue({
      execution,
      contextId,
      placement: draft.context.placement,
    }) ??
    (siblingSaveInFlight
      ? "Another edit on this execution is still saving. Wait for it to land, then save again."
      : null);

  // Only a stopped run has anything to resume. An unstarted context is editable
  // while its execution is still going, so a landed save there must not offer
  // to resume a run that never paused.
  const resumable =
    execution.status === "paused" || execution.status === "halted";

  // Every mutation-reported signal is gated on this context having submitted.
  const reportedError = submitted ? editError : null;
  const saveState = liveSaveState({
    dirty,
    saving: submitted && isSaving,
    conflict: submitted && editConflict,
    error: reportedError,
    succeeded: submitted && saveSucceeded,
  });

  function editContext(next: LiveContextDraft["context"]): void {
    setDraft((current) => (current ? { ...current, context: next } : current));
  }

  function applyCascadeEdit(intent: ConfigEditIntent): void {
    // A live execution has no tier to fall back into, so the cascade adapter
    // never offers a reset and only writes reach here. Ignoring the other kinds
    // is what keeps a stray intent from deleting a block the engine still reads.
    if (intent.kind !== "set-path") return;
    setDraft((current) =>
      current
        ? {
            ...current,
            context: applyConfigEditToContext(intent, current.context),
          }
        : current,
    );
  }

  /**
   * `nextContext` is the value a prose editor is submitting from its own
   * shortcut: it has just been written to the draft, but that write is not
   * visible in this closure, so the diff has to be told about it explicitly.
   */
  function handleSave(nextContext?: LiveContextDraft["context"]): void {
    if (
      !onSaveContextConfig ||
      !draft ||
      !seedBase ||
      !context ||
      isSaving ||
      !editable ||
      saveBlockedReason !== null
    ) {
      return;
    }
    const submittedDraft =
      nextContext === undefined ? draft : { ...draft, context: nextContext };
    const submittedOp = diffLiveContextOp({
      contextId,
      draft: submittedDraft,
      base: seedBase,
      stored: context,
    });
    if (!submittedOp) return;
    onSaveContextConfig([submittedOp]);
    setSubmitted(true);
    // Record what was sent and the form the server will echo back, but leave the
    // draft alone: the outcome is not known yet, and the reconciliation above
    // adopts the canonical text only once the stored document matches. Holding
    // the submitted TEXT too is what lets a later keystroke revoke the
    // acknowledgement — text the user has moved on from must never settle.
    if (submittedOp.outputSchema !== undefined) {
      setSubmittedSchema({
        text: submittedDraft.outputSchemaText,
        canonical: serializeOutputSchemaText(submittedOp.outputSchema),
        atRevision: execution.liveRevision,
      });
    }
  }

  const runtime = runtimeFactsFor(execution, contextId, context.placement.lane);

  // Saving goes through the multiline registry so a dictation still settling
  // into a textarea lands in the draft before the diff is taken.
  const onSaveThroughMultiline = () =>
    multilineActions.primaryAction(handleSave);
  const onResumeOnce = () => {
    if (isResuming || !resumable) return;
    onResumeExecution?.();
  };

  const structuralEditor: ContextStructuralEditor = {
    host: "execution",
    affordance: verdict.affordance,
    context: draft.context,
    onContextChange: editContext,
    outputSchemaText: draft.outputSchemaText,
    schemaFrozen: verdict.schemaFrozen,
    onOutputSchemaTextChange: (outputSchemaText) =>
      setDraft((current) =>
        current ? { ...current, outputSchemaText } : current,
      ),
    upstreamInputs,
    onRequestSave: (nextContext) => handleSave(nextContext),
    // Read-only here: §11 puts task editing on the Tasks tab, which owns the
    // add / update / remove / reorder ops.
    tasks: [],
    workflowTaskIds: [],
    onTasksChange: () => {},
    ...(runtime === undefined ? {} : { runtime }),
  };

  // The reducer refuses a per-assignment reset unless the run is paused or
  // halted (`workflow-graph/reset-assignment.ts`); offering the control while it
  // is running would promise an action the endpoint would reject.
  // Same admission rule the retired header button used: the reducer rebuilds
  // context state, which only a stopped run can survive, and a completed
  // context has nothing left to redo.
  const canResetContext =
    onResetContext !== undefined &&
    verdict.affordance !== "read-only" &&
    resumable &&
    execution.contextStates[contextId]?.status !== "completed";

  const resetEligible =
    execution.status === "paused" || execution.status === "halted";

  const cascadeEditor: ConfigCascadeEditor = {
    host: "execution",
    affordance: verdict.affordance,
    cascade: createLiveConfigCascade({
      context: draft.context,
      provenance: liveConfigProvenance(context),
    }),
    onEdit: applyCascadeEdit,
    validationCommands: commandOptions,
    libraryProjectName,
    ...(onResetAssignment && resetEligible
      ? {
          onResetSeat: (seatId: string) => onResetAssignment(contextId, seatId),
        }
      : {}),
    resettingSeatId: resettingAssignmentId,
  };

  const screens = createConfigScreenRegistry([
    ...contextStructuralScreens(structuralEditor).filter(
      (screen) => !screen.id.startsWith("task"),
    ),
    ...cascadeScreens(cascadeEditor),
  ]);

  const rootCards = buildContextRootCards({
    cascade: cascadeEditor.cascade,
    context: draft.context,
    outputSchemaText: draft.outputSchemaText,
    upstreamInputCount: upstreamInputs.length,
    taskCount: 0,
    nextTaskTitle: null,
  }).filter((card) => card.screenId !== "tasks");

  return (
    <MultilinePrimaryActionScope registry={multilineActions}>
      <div
        className="flex h-full min-h-0 flex-col"
        data-testid="context-config-tab"
        data-scope="config"
        data-affordance={verdict.affordance}
      >
        {/* A live seat already holds a lane, so the rotation an authority or
            instructions edit forces has to be visible while the edit can still
            be reconsidered — not discovered afterwards in the event log (R12.4).
            It sits above the panel because it is a consequence of the pending
            DRAFT, which only this host holds both sides of. */}
        {draft.context.contextValidator && seedBase.context.contextValidator ? (
          <div className="flex-shrink-0 px-lg pt-md">
            <LaneRotationNotice
              base={seedBase.context.contextValidator}
              draft={draft.context.contextValidator}
            />
          </div>
        ) : null}
        <ConfigPanel
          key={focusSeq}
          host="execution"
          scope="context"
          entityTitle={draft.context.title}
          entityMeta={`${context.id} · configuration snapshotted at launch`}
          rootCards={rootCards}
          screens={screens}
          affordance={verdict.affordance}
          {...(verdict.readOnlyReason === null
            ? {}
            : { readOnlyReason: verdict.readOnlyReason })}
          onPauseToEdit={onPauseExecution}
          pausing={isPausing}
          saveState={saveState}
          saveBlockedReason={saveBlockedReason}
          voiceBusy={multilineActions.voiceBusy}
          {...(reportedError === null
            ? {}
            : { saveErrorMessage: reportedError })}
          onSave={onSaveThroughMultiline}
          onResume={onResumeOnce}
          resumable={resumable}
          resuming={isResuming}
          {...(canResetContext
            ? {
                dangerAction: {
                  label: "Reset context",
                  onAction: () => setResetConfirmOpen(true),
                  disabled: isMutating,
                },
              }
            : {})}
          {...(honouredFocus === null
            ? {}
            : { initialScreenPath: honouredFocus })}
        />
        {/* Authority can be withdrawn while the confirmation is on screen — an
            SSE refresh can strip the selection's lease mid-dialog — so the open
            state is gated on the derived admission rather than the click. */}
        <ConfirmDialog
          open={resetConfirmOpen && canResetContext}
          title="Reset context?"
          message="Clear implementer and validator conversations, unmark completed tasks, and reset runtime state for this context. The workflow will remain paused until you resume it."
          confirmLabel="Reset"
          cancelLabel="Cancel"
          danger
          onConfirm={() => {
            setResetConfirmOpen(false);
            onResetContext?.(contextId);
          }}
          onCancel={() => setResetConfirmOpen(false)}
        />
      </div>
    </MultilinePrimaryActionScope>
  );
}
