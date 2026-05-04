/**
 * Reference data for the 5 XState machines orchestrating Command Center.
 *
 * Structural fields (states, transitions, invokes, action/guard/actor names)
 * are auto-derived by introspecting the actual machine definitions. Hand-typed
 * metadata layered on top adds human descriptions, status hints used by the
 * canvas, and friendly labels for composite guards.
 *
 * **Server-only by convention.** The live machines transitively import
 * Node-only logging via `default-session-status-bus`, so any client bundle
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
import { optimisticMachine } from "@/lib/workflows/optimistic/machine";
import { createRetryMachine } from "@/lib/workflows/retry-machine";

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
    "Manages the full conversation lifecycle: prompt submission, resource acquisition, SDK execution, AskUserQuestion handling, and metadata accumulation. The debug compound state layers a 6-phase debugging workflow on top of the same core loop.",
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
          event: "ENTER_DEBUG_MODE",
          description: "Operator activates the debug workflow.",
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
        "Compound state: the executePrompt invoke stays alive across running ↔ waitingForInput transitions, so the SDK can pause for AskUserQuestion answers without restarting the stream.",
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
      ],
    },
    "executing.running": {
      status: "initial",
      description: "SDK is producing output.",
      events: [
        {
          event: "ASK_QUESTION",
          description: "SDK called the AskUserQuestion tool.",
        },
      ],
    },
    "executing.waitingForInput": {
      status: "warning",
      description:
        "Holding the SDK in a paused state until the user answers the pending question.",
      events: [
        {
          event: "ANSWER",
          description: "User submitted an answer; resume.",
        },
      ],
    },
    finalizingTurn: {
      description:
        "Always-state with 8 guarded transitions. Routes back to idle, to a specific debug phase, or loops the debug workflow based on context flags. Releases resources and persists the snapshot.",
      events: [
        {
          event: "always",
          target: "debug.awaitingReproduction",
          guard: "isDebugHypothesizing",
          description: "Debug: just delivered hypotheses → wait for repro.",
        },
        {
          event: "always",
          target: "debug.hypothesizing",
          guard: "isDebugAnalyzing && shouldLoopBackToHypothesizing",
          description:
            "Evidence analysis recommended more instrumentation — loop.",
        },
        {
          event: "always",
          target: "debug.fixing",
          guard: "isDebugAnalyzing",
          description: "Evidence analyzed → proceed to fix.",
        },
        {
          event: "always",
          target: "debug.awaitingVerification",
          guard: "isDebugFixing",
          description: "Fix delivered → wait for verification.",
        },
        {
          event: "always",
          target: "debug.awaitingReproduction",
          guard: "isDebugAwaitingReproduction",
          description: "Follow-up prompt while awaiting repro.",
        },
        {
          event: "always",
          target: "debug.awaitingVerification",
          guard: "isDebugAwaitingVerification",
          description: "Follow-up prompt while awaiting verification.",
        },
        {
          event: "always",
          target: "idle",
          guard: "isDebugCleanup",
          description: "Debug cleanup completed → exit debug mode.",
        },
        {
          event: "always",
          target: "idle",
          description: "Default: not in debug mode → return to idle.",
        },
      ],
    },
    debug: {
      status: "warning",
      description:
        "A 6-phase debugging workflow layered on top of the conversation loop. Each SUBMIT_PROMPT bounces through acquiringResources → executing → finalizingTurn, then finalizingTurn's guards route back to the right phase here.",
      events: [
        {
          event: "EXIT_DEBUG_MODE",
          description: "Operator leaves debug mode.",
        },
        {
          event: "SET_DEBUG_RECORDING",
          description: "Toggle recording on the active debug log.",
        },
        {
          event: "CLEAR_DEBUG_LOGS",
          description: "Side-effect-only event handled by the API route.",
        },
      ],
    },
    "debug.hypothesizing": {
      status: "initial",
      description: "Generating hypotheses and instrumentation instructions.",
      events: [
        {
          event: "SUBMIT_PROMPT",
          description: "Operator submits hypothesis-generating prompt.",
        },
      ],
    },
    "debug.awaitingReproduction": {
      status: "warning",
      description:
        "Instructions delivered; waiting for the operator to reproduce the bug and signal MARK_REPRODUCED.",
      events: [
        {
          event: "MARK_REPRODUCED",
          description: "Operator confirmed the bug was reproduced.",
        },
        {
          event: "SUBMIT_PROMPT",
          description: "Follow-up prompt while waiting.",
        },
      ],
    },
    "debug.analyzingEvidence": {
      description:
        "Analyzing collected logs/evidence. Output drives whether to fix or loop back for more instrumentation.",
      events: [
        { event: "SUBMIT_PROMPT", description: "Trigger the analysis turn." },
      ],
    },
    "debug.fixing": {
      description: "Producing the fix and verification plan.",
      events: [
        { event: "SUBMIT_PROMPT", description: "Trigger the fix turn." },
      ],
    },
    "debug.awaitingVerification": {
      status: "warning",
      description:
        "Fix delivered; waiting for the operator to verify the fix and signal MARK_FIX_VERIFIED.",
      events: [
        {
          event: "MARK_FIX_VERIFIED",
          description: "Operator confirmed the fix works.",
        },
        {
          event: "SUBMIT_PROMPT",
          description: "Follow-up prompt while waiting.",
        },
      ],
    },
    "debug.cleanupInstrumentation": {
      status: "success",
      description:
        "Removing temporary instrumentation. The next finalizingTurn pass will exit debug mode entirely.",
      events: [
        { event: "SUBMIT_PROMPT", description: "Trigger the cleanup turn." },
      ],
    },
  },
  actors: {
    prepareTurn:
      "Acquires the session lock and a query-semaphore slot, ensures the transcript file exists, and returns the resolved transcript path.",
    executePrompt:
      "Streams a turn through the agent backend (Claude Agent SDK or Codex). Stays alive across ASK_QUESTION/ANSWER pauses by virtue of being invoked on the executing compound state.",
  },
  guards: {
    isDebugModeActive: "True if debugMode is non-null and active.",
    isDebugHypothesizing: 'True when debugMode.phase === "hypothesizing".',
    isDebugAnalyzing: 'True when debugMode.phase === "analyzing_evidence".',
    isDebugFixing: 'True when debugMode.phase === "fixing".',
    isDebugAwaitingReproduction:
      'True when debugMode.phase === "awaiting_reproduction".',
    isDebugAwaitingVerification:
      'True when debugMode.phase === "awaiting_verification".',
    isDebugCleanup: 'True when debugMode.phase === "cleanup_instrumentation".',
    shouldLoopBackToHypothesizing:
      "True if the analyzer's structured output recommends gathering more instrumentation.",
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
    routing: {
      status: "initial",
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
    squashMerging: {
      description: "Performs the squash merge into the target worktree.",
    },
    completed: {
      status: "success",
      description: "Merge landed. mergeHash recorded.",
    },
    failed: {
      status: "failure",
      description: "Pipeline failed. Error message captured in context.error.",
    },
    conflicts: {
      status: "warning",
      description:
        "Manual resolution required. conflictAnalysis (if produced) is in context for the UI.",
    },
  },
  actors: {
    checkUncommitted: "git status — returns whether the worktree has changes.",
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
    squashMerge:
      "Squashes the feature branch into the target worktree and pushes the merge commit.",
  },
  guards: {
    isResolveConflictsJob:
      "Job was dispatched as a bare resolve-conflicts job.",
    hasUncommittedChanges: "checkUncommitted returned hasChanges: true.",
    mergeHadConflicts: "git merge produced conflicts.",
    shouldAutoResolve: "context.autoResolve is true (set by the caller).",
    resolutionSucceeded: 'resolveConflicts returned status: "resolved".',
    analysisSucceeded: 'analyzeConflicts returned status: "analyzed".',
    fixSucceeded: 'fixValidation returned status: "fixed".',
    hasFixRetriesRemaining: "fixAttempt < maxFixAttempts (default 2).",
  },
  actions: {
    onTerminal:
      "Override via .provide() — fires push notifications, SSE broadcast, job-history write.",
  },
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
  actions: {
    onTerminal: "Override via .provide() for SSE broadcast and job history.",
  },
};

// ============================================================
// Metadata: 4. Optimistic
// ============================================================

const optimisticMetadata: MachineMetadata = {
  id: "optimistic",
  name: "Optimistic",
  machineId: "optimistic",
  character: "linear",
  tagline:
    "Execute a prompt autonomously, then dispatch a merge — the simplest workflow.",
  description:
    "The reference implementation of the standard workflow shape: invoke an agent prompt, then dispatch a merge job, with a single shared failure terminal. Used to validate the composable-primitives pattern before applying it to more complex flows.",
  filePath: "src/lib/workflows/optimistic/machine.ts",
  states: {
    executingPrompt: {
      status: "initial",
      description:
        "Runs the user's instructions through the agent autonomously and captures the resulting conversationId.",
    },
    dispatchingMerge: {
      description:
        "Enqueues a Smart Merge job for the resulting branch and stores its jobId.",
    },
    completed: {
      status: "success",
      description: "Prompt finished and the merge job is queued.",
    },
    failed: {
      status: "failure",
      description:
        "Either the prompt or the merge dispatch failed; notifyFailure was fired.",
    },
  },
  actors: {
    executePrompt:
      "Runs the prompt against the agent backend autonomously and returns the conversationId.",
    dispatchMerge: "Posts a Smart Merge job and returns its jobId.",
  },
  guards: {},
  actions: {
    notifyFailure:
      "Stub action overridden via .provide() to send a push notification when the workflow fails.",
  },
};

// ============================================================
// Metadata: 5. Retry (factory)
// ============================================================

const retryMetadata: MachineMetadata = {
  id: "retry",
  name: "Retry",
  machineId: "retry",
  character: "factory · cycle",
  tagline:
    "Generic attempt → fix → reattempt cycle. A reusable child machine for any workflow.",
  description:
    "A generic factory: createRetryMachine<TWorkInput, TWorkOutput>() returns a 4-state machine that other workflows invoke. The work and fix actors are stubbed and provided via .provide(). The fix actor is optional — when not supplied, the machine retries directly.",
  filePath: "src/lib/workflows/retry-machine.ts",
  states: {
    attempting: {
      status: "initial",
      description:
        "Invokes the work actor and increments the attempts counter. Success → succeeded, failure with retries left → fixing, failure without retries → exhausted.",
    },
    fixing: {
      status: "warning",
      description:
        "Optional corrective step between retries. Increments retriesUsed. Success loops back to attempting; failure exhausts.",
    },
    succeeded: { status: "success", description: "Work returned a result." },
    exhausted: {
      status: "failure",
      description: "Retries exhausted or fix failed.",
    },
  },
  actors: {
    work: "The operation to attempt. Provided via .provide(). Throws on failure.",
    fix: "Optional corrective step run between retries. Defaults to a no-op so retries proceed directly.",
  },
  guards: {
    hasRetriesLeft: "retriesUsed < maxRetries.",
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
const optimisticSpec = buildSpec(
  optimisticMetadata,
  introspectMachine(optimisticMachine),
);
// Retry is a factory; instantiate once with throwaway type params.
const retrySpec = buildSpec(
  retryMetadata,
  introspectMachine(createRetryMachine<unknown, unknown>()),
);

// ============================================================
// Registry
// ============================================================

export const machineSpecs: ReadonlyArray<MachineSpec> = [
  conversationSpec,
  smartMergeSpec,
  smartCommitSpec,
  optimisticSpec,
  retrySpec,
];

const specById: Record<MachineId, MachineSpec> = {
  conversation: conversationSpec,
  "smart-merge": smartMergeSpec,
  "smart-commit": smartCommitSpec,
  optimistic: optimisticSpec,
  retry: retrySpec,
};

export function getMachineSpec(id: MachineId): MachineSpec {
  return specById[id];
}

// Re-export universal helpers for convenience at the import site.
export {
  isMachineId,
  getMachineStats,
  type MachineId,
  type MachineSpec,
  type StateInfo,
  type EventInfo,
  type ActorInfo,
  type GuardInfo,
  type ActionInfo,
  type StateNodeKind,
  type StateStatus,
  type MachineStats,
} from "./machine-spec-types";
