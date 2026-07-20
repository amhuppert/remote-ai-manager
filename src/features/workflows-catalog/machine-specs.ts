/**
 * Reference data for the 3 XState machines orchestrating Command Center.
 *
 * Structural fields (states, transitions, invokes, action/guard/actor names)
 * are auto-derived by introspecting the actual machine definitions. Hand-typed
 * metadata layered on top adds human descriptions, status hints used by the
 * canvas, and friendly labels for composite guards.
 *
 * **Server-only by convention.** The live machines transitively import
 * Node-only logging via the SSE publication module, so any client bundle
 * that pulled this in would fail Next.js's `node:fs` check. Server pages
 * compute the spec once and pass the JSON-serializable result down to
 * client components, which import types from `machine-spec-types.ts`.
 */

import type {
  ActionInfo,
  ActorInfo,
  EventInfo,
  GuardInfo,
  MachineId,
  MachineSpec,
  StateInfo,
  StateStatus,
} from "./machine-spec-types";
import {
  introspectMachine,
  type IntrospectedMachine,
  type IntrospectedState,
} from "./machine-introspection";

import { conversationMachine } from "@/lib/workflows/conversation/machine";
import { mergeMachine } from "@/lib/workflows/merge/machine";
import { commitMachine } from "@/lib/workflows/commit/machine";

// ============================================================
// Metadata shape (hand-typed overlay)
// ============================================================

interface EventMetadata {
  event: string;
  /** If multiple transitions share the same `event`, target distinguishes them. */
  target?: string;
  /** If multiple transitions share the same `event` + `target`, guard distinguishes them. */
  guard?: string;
  description: string;
  /** Friendlier label to display instead of the introspected guard expression. */
  guardLabel?: string;
}

interface StateMetadata {
  description?: string;
  status?: StateStatus;
  events?: EventMetadata[];
}

interface MachineMetadata {
  id: MachineId;
  name: string;
  machineId: string;
  character: string;
  tagline: string;
  description: string;
  filePath: string;
  states: Record<string, StateMetadata>;
  actors: Record<string, string>;
  guards: Record<string, string>;
  actions: Record<string, string>;
}

// ============================================================
// Metadata: 1. Conversation
// ============================================================

const conversationMetadata: MachineMetadata = {
  id: "conversation",
  name: "Conversation",
  machineId: "conversation",
  character: "hierarchical",
  tagline:
    "The full life of a conversation turn — prompt → SDK → ask question → finalize.",
  description:
    "Manages the full conversation lifecycle: prompt submission, resource acquisition, SDK execution, AskUserQuestion handling, and metadata accumulation. Debug mode is an attached workflow (src/lib/workflows/debug/): the flat debug state parks the conversation between debug turns while the phase lives in context.debugMode, and DEBUG_COMMAND events are applied by the debug workflow's pure reducer.",
  filePath: "src/lib/workflows/conversation/machine.ts",
  states: {
    idle: {
      status: "initial",
      description:
        "Waiting for the next prompt, an external auto-continuation, or debug-mode entry.",
      events: [
        {
          event: "SUBMIT_PROMPT",
          description: "User-initiated prompt arrives.",
        },
        {
          event: "SUBMIT_TASK_RUN",
          description:
            "Workflow task claims the conversation for a single-shot task run.",
        },
        {
          event: "DEBUG_COMMAND",
          description:
            "Operator activates the debug workflow (only the `enter` command is legal while debug mode is inactive); the always-transition then parks the conversation in the debug state.",
        },
        {
          event: "always",
          target: "debug",
          description:
            "An active debugMode (restored from input, or just entered) routes into the debug state.",
          guardLabel: "debugMode.active",
        },
        {
          event: "EXTERNAL_TURN_STARTED",
          description:
            "Claude Code self-continues (e.g. responds to a background task notification).",
        },
      ],
    },
    externalExecuting: {
      status: "warning",
      description:
        "An auto-continuation turn the SDK started without a caller-initiated prompt.",
      events: [
        {
          event: "EXTERNAL_TURN_COMPLETED",
          description: "External turn finished; record result and finalize.",
        },
      ],
    },
    acquiringResources: {
      description:
        "Acquires the session lock, query semaphore slot, and ensures the transcript file exists before invoking the SDK.",
      events: [
        { event: "onDone", description: "Lock + transcript ready." },
        {
          event: "onError",
          description: "Failed to acquire resources — abort the turn.",
        },
      ],
    },
    executing: {
      description:
        "Compound state: branches on activeTurn.kind. Streaming conversation_turn invokes executePrompt; ASK_QUESTION records a pending question without pausing the stream. Single-shot task_run invokes runTaskRun once and returns one final TranscriptMessage.",
      events: [
        {
          event: "PROMPT_COMPLETED",
          description: "SDK signaled clean completion.",
        },
        { event: "PROMPT_FAILED", description: "SDK reported an error." },
        {
          event: "ABORT_TURN",
          description: "User, timeout, or shutdown aborted the turn.",
        },
        {
          event: "BACKEND_INIT",
          description: "Internal: store backend session ref.",
        },
        {
          event: "CLEAR_PENDING_QUESTION",
          description:
            "Answer consumed the pending question mid-turn; the turn keeps running and finalizes to idle.",
        },
      ],
    },
    "executing.dispatching": {
      status: "initial",
      description:
        "Transient routing state: always-guard picks between the streaming conversationTurn branch and the single-shot taskRun branch based on activeTurn.kind.",
    },
    "executing.conversationTurn": {
      description:
        "Streaming conversation branch: invokes executePrompt. ASK_QUESTION is an internal transition — it records the pending question (persist + SSE + push) while the stream keeps running; the agent then ends its turn and finalizingTurn routes to waitingForInput.",
      events: [
        {
          event: "ASK_QUESTION",
          description:
            "Agent registered a question batch; the turn keeps running until the agent ends it.",
        },
      ],
    },
    "executing.taskRun": {
      description:
        "Single-shot task branch: invokes runTaskRun once via the shared AgentCall task-runner path, awaits the full AgentCallResult, persists exactly one final TranscriptMessage, and transitions to finalizingTurn. No streaming, no AskUserQuestion.",
    },
    finalizingTurn: {
      description:
        "Always-state with guarded transitions. Routes back to idle, into the debug state, or to waitingForInput based on context flags. Releases resources and persists the snapshot.",
      events: [
        {
          event: "always",
          target: "debug",
          description:
            "Debug mode active: the attached debug workflow interprets the turn outcome (advance / follow-up / verify-cleanup / failed) via resolveDebugFinalization, then the conversation parks back in the debug state.",
          guardLabel: "debugMode.active",
        },
        {
          event: "always",
          target: "waitingForInput",
          description:
            "A registered question survived the turn — settle turn metadata and wait for the user's answer.",
          guardLabel: "pendingQuestion != null",
        },
        {
          event: "always",
          target: "idle",
          description:
            "Default: not in debug mode, no pending question → return to idle.",
        },
      ],
    },
    waitingForInput: {
      status: "warning",
      description:
        "No turn is running; a question pends. Drains the message queue on entry so an answer (or a redirecting user message) starts the next turn; claiming any turn clears the pending question.",
      events: [
        {
          event: "SUBMIT_PROMPT",
          description:
            "Answer or superseding user message arrives — claim a turn, clear the question.",
        },
        {
          event: "SUBMIT_TASK_RUN",
          description:
            "Workflow task claims the conversation — clears the question.",
        },
        {
          event: "ABORT_TURN",
          description:
            "Explicit stop: nothing to abort, clears the pending question.",
        },
      ],
    },
    debug: {
      status: "warning",
      description:
        "The attached debug workflow's parking state. The 6-phase debugging progression lives in context.debugMode (phase legality is the debug reducer's legality table, not machine topology). Each SUBMIT_PROMPT bounces through acquiringResources → executing → finalizingTurn, whose debug branch settles back here. No queue drain on entry: debug settle points must not auto-claim queued messages as debug turns.",
      events: [
        {
          event: "SUBMIT_PROMPT",
          description:
            "Operator submits the next debug turn (phase-advancing prompt or follow-up); replaces a preserved failed turn.",
        },
        {
          event: "DEBUG_COMMAND",
          target: "acquiringResources",
          description:
            "retry_turn: re-runs the preserved failed turn against the same phase + structured-output schema.",
          guardLabel: "retry_turn && lastTurnFailed && activeTurn",
        },
        {
          event: "DEBUG_COMMAND",
          description:
            "Reducer-handled lifecycle command (exit, set_recording, phase marks, Strategy B reverts, async cleanup-verification outcomes). Illegal commands are refused by the legality guard, which keeps the adapter's 409 contract truthful.",
        },
        {
          event: "always",
          target: "idle",
          description:
            "Leaving debug mode (exit command, passed cleanup verification) clears debugMode; the conversation settles back to idle.",
          guardLabel: "!debugMode.active",
        },
      ],
    },
  },
  actors: {
    prepareTurn:
      "Acquires the session lock and a query-semaphore slot, ensures the transcript file exists, and returns the resolved transcript path.",
    executePrompt:
      "Streams a turn through the agent backend (Claude Agent SDK or Codex). ASK_QUESTION does not interrupt it — the invoke lives until the turn ends.",
    runTaskRun:
      "Executes a single-shot task_run turn via the shared AgentCall task-runner path. Non-streaming counterpart to executePrompt: awaits the full AgentCallResult, persists exactly one final assistant TranscriptMessage, broadcasts message-appended once, and surfaces a parsed structuredOutput when outputSchema is present.",
  },
  guards: {
    isActiveTurnTaskRun:
      'True when activeTurn.kind === "task_run". Routes the executing compound state into the single-shot taskRun branch; otherwise the streaming conversationTurn branch is selected.',
  },
  actions: {
    persistSnapshot: "Writes the conversation snapshot to disk (atomic).",
    syncDerivedFields:
      "Updates derived state fields (status, lastActivityAt) used by the UI.",
    broadcastConversationStatus:
      "Emits an SSE status event for connected clients.",
    broadcastAskQuestion:
      "Emits an SSE event with the pending question payload.",
    broadcastDebugModeStatus:
      "Emits an SSE event when debug mode toggles or shifts phase.",
    releaseResources:
      "Releases the session lock and query semaphore slot acquired in prepareTurn.",
    dispatchPushNotification:
      "Sends a push notification when input is needed or a turn completes.",
    markUnreadOnFinish:
      "Sets unread=true and broadcasts a conversation-unread SSE event when a turn finishes (running → awaiting). Skipped for workflow-managed roles.",
    markReadOnUserTurnStart:
      "Clears unread=false and broadcasts a conversation-unread SSE event at the start of a user-initiated turn (prompt submit or question answer). Skipped for workflow-managed roles.",
    drainPendingQueue:
      "On entry to the settled idle state, claims any durably-queued follow-up messages and dispatches them as the next coalesced turn. No-op for workflow roles and empty queues; provided by the conversation manager.",
    cancelDebugCleanupVerification:
      "Aborts cleanup verification for the current debug generation and clears its runtime handle when that generation exits.",
    persistRestoredDebugGeneration:
      "Persists the required generation assigned to an active legacy debug state during rehydration before cleanup verification can run.",
    claimConversationTurn:
      "Single owner of the SUBMIT_PROMPT turn claim (idle, waitingForInput, debug): stores the ActiveTurn, clears the pending question, the previous turn's result/error, and the debug failed-turn flag.",
    claimTaskRun:
      "SUBMIT_TASK_RUN counterpart of claimConversationTurn: stores the task_run ActiveTurn and clears the pending question and previous result/error.",
    applyDebugCommandEffect:
      "Applies a reducer-handled debug command (applyDebugCommand from the debug workflow module) and fires the side effects it selects (sync, status/debug-status broadcasts, persist).",
    finalizeDebugTurn:
      "Settles a turn that finalized while debug mode was active: applies turn accounting, adopts the debug workflow's finalization decision (advance / follow-up / verify-cleanup / failed), notifies the user only on a phase advance, and starts async cleanup verification when the cleanup turn produced a structured report.",
    startDebugCleanupVerification:
      "Fire-and-forget cleanup verification through the debug workflow module; the outcome re-enters the machine as a DEBUG_COMMAND (cleanup_verified / cleanup_verification_failed).",
  },
};

// ============================================================
// Metadata: 2. Smart Merge
// ============================================================

const smartMergeMetadata: MachineMetadata = {
  id: "smart-merge",
  name: "Smart Merge",
  machineId: "smartMerge",
  character: "pipeline · loop",
  tagline:
    "Auto-resolves conflicts, validates, fixes failures, then squashes — or surfaces conflicts.",
  description:
    "The merge pipeline. Commits any in-flight changes, merges the target branch, optionally auto-resolves conflicts, runs pre-merge validation, and either fixes-and-retries failures or fails out. The same machine handles plain merge jobs and bare resolve-conflicts jobs (routing state).",
  filePath: "src/lib/workflows/merge/machine.ts",
  states: {
    entryRouting: {
      status: "initial",
      description:
        "Transient initial state that routes by entryMode (merge → verifyingBranch, land → publishing, discard → discarding).",
    },
    verifyingBranch: {
      description:
        "Reads the worktree's HEAD branch and fails fast if it does not match the expected feature branch (or is detached). Guards against operating on the wrong branch.",
    },
    routing: {
      description:
        "Resolve-conflicts jobs jump straight to resolvingConflicts; merge jobs fall through to checkingUncommitted.",
    },
    checkingUncommitted: {
      description:
        "git status check — uncommitted changes get a WIP commit before the merge.",
    },
    committingUncommitted: {
      description:
        'Stages and commits in-flight changes ("WIP: uncommitted changes").',
    },
    mergingMain: {
      description:
        'Merges the target branch (default "main") into the worktree.',
    },
    conflictsDetected: {
      status: "warning",
      description:
        "Always-state. autoResolve === true → try the auto-resolver; otherwise produce an analysis for manual resolution.",
    },
    analyzingConflicts: {
      description:
        "Builds a structured conflict analysis without resolving. Always lands in the conflicts terminal state.",
    },
    resolvingConflicts: {
      description:
        "Agent-driven conflict resolution. Success → committingResolution. Partial/failed → conflicts (with partial analysis).",
    },
    committingResolution: {
      description: 'Commits the resolved tree ("resolve merge conflicts").',
    },
    validating: {
      description:
        "Runs the project's preMergeCommand. Failures with autoResolve get a fix attempt; otherwise fail.",
    },
    fixingValidation: {
      status: "warning",
      description:
        "Agent-driven validation fix. Increments fixAttempt. Reuses the same agent session across retries.",
    },
    checkingFixChanges: {
      description:
        "Did the fix agent actually make changes? If not, skip the commit and re-validate directly.",
    },
    committingFix: {
      description: 'Commits the fix ("auto-fix: validation errors").',
    },
    revalidating: {
      description:
        "Re-runs the validation command. Failure with retries left loops back; otherwise fails.",
    },
    preparing: {
      description:
        "Builds the prepared squash commit off the target worktree via git plumbing (merge-tree + commit-tree) or a detached-worktree fallback; parks the result at refs/cc-merges/<jobId>.",
    },
    publishing: {
      description:
        "Runs the delivery gate against the prepared candidate. Pass → publishingCandidate. Refusal → deliveryGateFailed with the parked candidate ref preserved.",
    },
    publishingCandidate: {
      description:
        "Discovers the target worktree (no lock), then acquires the project lock and atomically advances the target ref via update-ref CAS. Dirty target → readyToLand; CAS lost + retries → preparing; CAS lost + exhausted → failed.",
    },
    discarding: {
      description: "Deletes the parked ref via git update-ref -d.",
    },
    completed: {
      status: "success",
      description: "Merge landed. mergeHash recorded.",
    },
    failed: {
      status: "failure",
      description: "Pipeline failed. Error message captured in context.error.",
    },
    deliveryGateFailed: {
      status: "failure",
      description:
        "Terminal refusal from the delivery gate. haltReason captures the unmet delivery criteria and instruction.",
    },
    conflicts: {
      status: "warning",
      description:
        "Manual resolution required. conflictAnalysis (if produced) is in context for the UI.",
    },
    readyToLand: {
      status: "warning",
      description:
        "Terminal state — prepared commit parked, awaiting user Land or Discard. phase remains 'awaiting-land'.",
    },
    discarded: {
      status: "warning",
      description: "Terminal state — parked ref deleted, no merge landed.",
    },
  },
  actors: {
    checkUncommitted: "git status — returns whether the worktree has changes.",
    getCurrentBranch:
      "git symbolic-ref --short HEAD — returns the worktree's branch name, or null when HEAD is detached.",
    commitChanges: "git add + git commit with a fixed message; skips hooks.",
    mergeMain:
      "git merge of the target branch into the session worktree. Returns conflict file list on failure.",
    resolveConflicts:
      "Agent-driven conflict resolution. Reads conflict markers, applies decisions, returns resolved/partial state.",
    analyzeConflicts:
      "Agent-driven structured analysis of unresolved conflicts. Used when autoResolve is off.",
    runValidation:
      "Runs the project's preMergeCommand with timeout. Resolves on exit 0, rejects on non-zero or timeout.",
    fixValidation:
      "Agent-driven validation fix. Reuses the previous fix session (continuity across retries).",
    prepare:
      "Reads featureSha and targetSha, then invokes prepareSquashMerge (plumbing or fallback). Returns { prepared, expectedTargetSha, parkedRef } or { conflicts }.",
    deliveryGate:
      "Evaluates the prepared candidate against the delivery gate using the workflow execution id, prepared SHA, expected target SHA, project path, and any persisted candidate validation fact. Returns pass-through or a machine-readable refusal.",
    publish:
      "Discovers the target worktree (no lock). On dirty, returns ready-to-land. Otherwise acquires the project lock, performs CAS via publishPreparedMerge, optionally refreshes a clean target worktree, deletes the parked ref, and (when finalizeSession) runs setSessionFinished / retargetOrphanedChildren / stopAllForSession.",
    discardParkedRef:
      "git update-ref -d refs/cc-merges/<jobId> <preparedSha> — drops the parked commit without advancing the target ref.",
  },
  guards: {
    isResolveConflictsJob:
      "Job was dispatched as a bare resolve-conflicts job.",
    branchMatchesExpected:
      "Worktree's current branch matches context.branchName (not detached, not a different branch).",
    hasUncommittedChanges: "checkUncommitted returned hasChanges: true.",
    mergeHadConflicts: "git merge produced conflicts.",
    shouldAutoResolve: "context.autoResolve is true (set by the caller).",
    resolutionSucceeded: 'resolveConflicts returned status: "resolved".',
    analysisSucceeded: 'analyzeConflicts returned status: "analyzed".',
    fixSucceeded: 'fixValidation returned status: "fixed".',
    hasFixRetriesRemaining: "fixAttempt < maxFixAttempts (default 2).",
    validationTimedOut:
      "The validation error carries timedOut: true — pre-merge validation was killed by its timeout, not a fixable check failure, so the fix loop is skipped and the merge fails fast.",
    isMergeEntry: "entryMode === 'merge' (default).",
    isLandEntry: "entryMode === 'land' (re-entry on a parked prepared commit).",
    isDiscardEntry:
      "entryMode === 'discard' (drops the parked ref without advancing the target).",
    prepareProducedConflicts:
      'prepare actor returned status: "conflicts" — the merge-tree plumbing found conflicts that block a clean squash.',
    deliveryGatePassed:
      'deliveryGate actor returned status: "allowed" — the prepared candidate satisfied the delivery criteria and may proceed to publish.',
    publishCompleted:
      'publish actor returned status: "completed" — CAS landed the prepared commit on the target ref.',
    publishReadyToLand:
      'publish actor returned status: "ready-to-land" — target worktree is dirty; parked ref retained for manual Land.',
    publishCasLost:
      'publish actor returned status: "cas-lost" — target ref advanced between prepare and publish; need to re-prepare.',
    publishFailed:
      'publish actor returned status: "failed" — non-CAS failure (e.g. update-ref error, worktree refresh blocker).',
    casRetriesRemaining:
      "casAttempt < maxCasAttempts (default 3) AND entryMode === 'merge'. Land mode never re-prepares.",
  },
  actions: {},
};

// ============================================================
// Metadata: 3. Smart Commit
// ============================================================

const smartCommitMetadata: MachineMetadata = {
  id: "smart-commit",
  name: "Smart Commit",
  machineId: "smartCommit",
  character: "linear · loop",
  tagline: "Commit, validate, auto-fix on failure, then re-validate.",
  description:
    "A focused commit pipeline: stage and commit the working tree, then run pre-merge validation. If validation fails, an agent attempts a fix; the loop retries up to maxFixAttempts. Reuses the merge machine's actors for commit and validation primitives.",
  filePath: "src/lib/workflows/commit/machine.ts",
  states: {
    committing: {
      status: "initial",
      description:
        "Stages and commits the working tree with the supplied message.",
    },
    validating: {
      description: "Runs the project's preMergeCommand.",
    },
    fixingValidation: {
      status: "warning",
      description:
        "Agent attempts to fix validation errors. fixAttempt is incremented; the same agent session is reused across retries.",
    },
    checkingFixChanges: {
      description:
        "Did the fix agent change anything? If not, skip straight to revalidating.",
    },
    committingFix: {
      description: "Commits the agent's fix.",
    },
    revalidating: {
      description:
        "Re-runs validation. Loops back to fixingValidation while retries remain; otherwise fails.",
    },
    completed: {
      status: "success",
      description: "Commit landed and validation passed.",
    },
    failed: {
      status: "failure",
      description: "Commit pipeline failed; context.error captures the reason.",
    },
  },
  actors: {
    commitChanges:
      "git add + git commit (skips hooks). Returns the commit hash.",
    runValidation: "Runs the project's preMergeCommand with timeout.",
    fixValidation:
      "Agent attempts to fix validation errors using the failure output as context.",
    checkUncommitted:
      "git status — used to verify the fix agent actually changed files.",
  },
  guards: {
    fixSucceeded: 'fixValidation returned status: "fixed".',
    hasFixRetriesRemaining: "fixAttempt < maxFixAttempts (default 2).",
    hasUncommittedChanges: "checkUncommitted returned hasChanges: true.",
  },
  actions: {},
};

// ============================================================
// Merge: introspection + metadata → MachineSpec
// ============================================================

function buildSpec(
  metadata: MachineMetadata,
  introspected: IntrospectedMachine,
): MachineSpec {
  return {
    id: metadata.id,
    name: metadata.name,
    machineId: metadata.machineId,
    character: metadata.character,
    tagline: metadata.tagline,
    description: metadata.description,
    filePath: metadata.filePath,
    initialState: introspected.initialState,
    states: introspected.states.map((s) =>
      mergeState(s, metadata.states[s.id]),
    ),
    actors: introspected.actors.map((name) =>
      mergeActor(name, metadata.actors[name]),
    ),
    guards: introspected.guards.map((name) =>
      mergeGuard(name, metadata.guards[name]),
    ),
    actions: introspected.actions.map((name) =>
      mergeAction(name, metadata.actions[name]),
    ),
  };
}

function mergeState(
  introspected: IntrospectedState,
  metadata: StateMetadata | undefined,
): StateInfo {
  const events = introspected.events.map((evt) => mergeEvent(evt, metadata));
  const state: StateInfo = {
    id: introspected.id,
    label: introspected.label,
    kind: introspected.kind,
  };
  if (introspected.parentId !== undefined)
    state.parentId = introspected.parentId;
  if (metadata?.status !== undefined) state.status = metadata.status;
  if (metadata?.description !== undefined)
    state.description = metadata.description;
  if (introspected.invokes.length > 0) state.invokes = introspected.invokes;
  if (introspected.entryActions.length > 0) {
    state.entryActions = introspected.entryActions;
  }
  if (events.length > 0) state.events = events;
  return state;
}

function mergeEvent(
  introspected: { event: string; target?: string; guard?: string },
  metadata: StateMetadata | undefined,
): EventInfo {
  const meta = findEventMetadata(introspected, metadata?.events);
  const event: EventInfo = { event: introspected.event };
  if (introspected.target !== undefined) event.target = introspected.target;
  const guardLabel = meta?.guardLabel ?? introspected.guard;
  if (guardLabel !== undefined) event.guard = guardLabel;
  if (meta?.description !== undefined) event.description = meta.description;
  return event;
}

function findEventMetadata(
  introspected: { event: string; target?: string; guard?: string },
  candidates: EventMetadata[] | undefined,
): EventMetadata | undefined {
  if (!candidates) return undefined;

  // Most specific match first: event + target + guard
  for (const c of candidates) {
    if (
      c.event === introspected.event &&
      (c.target === undefined || c.target === introspected.target) &&
      (c.guard === undefined || c.guard === introspected.guard)
    ) {
      // Ensure if both target and guard are specified in metadata they both match
      if (c.target !== undefined && c.target !== introspected.target) continue;
      if (c.guard !== undefined && c.guard !== introspected.guard) continue;
      return c;
    }
  }
  return undefined;
}

function mergeActor(name: string, description: string | undefined): ActorInfo {
  return { name, description: description ?? "" };
}

function mergeGuard(name: string, description: string | undefined): GuardInfo {
  return { name, description: description ?? "" };
}

function mergeAction(
  name: string,
  description: string | undefined,
): ActionInfo {
  return { name, description: description ?? "" };
}

// ============================================================
// Live machine instances → introspection → specs
// ============================================================

const conversationSpec = buildSpec(
  conversationMetadata,
  introspectMachine(conversationMachine),
);
const smartMergeSpec = buildSpec(
  smartMergeMetadata,
  introspectMachine(mergeMachine),
);
const smartCommitSpec = buildSpec(
  smartCommitMetadata,
  introspectMachine(commitMachine),
);

// ============================================================
// Registry
// ============================================================

export const machineSpecs: ReadonlyArray<MachineSpec> = [
  conversationSpec,
  smartMergeSpec,
  smartCommitSpec,
];

const specById: Record<MachineId, MachineSpec> = {
  conversation: conversationSpec,
  "smart-merge": smartMergeSpec,
  "smart-commit": smartCommitSpec,
};

export function getMachineSpec(id: MachineId): MachineSpec {
  return specById[id];
}

// Re-export universal helpers for convenience at the import site.
export { type MachineId, type MachineSpec } from "./machine-spec-types";
