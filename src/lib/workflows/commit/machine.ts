/**
 * Smart Commit XState v5 Machine.
 *
 * Models the commit pipeline with validation and auto-fix (the fix loop is
 * the shared `createValidationFixStates` fragment):
 *
 *   committing → validating → completed
 *       ↓ (error)       ↓ (fail)
 *     failed      fixingValidation → checkingFixChanges → committingFix → revalidating → completed
 *                                                       ↘ (no changes) → revalidating
 *                                                                             ↓ (fail + retries remain)
 *                                                                       fixingValidation (loop)
 *                                                                             ↓ (fail + no retries)
 *                                                                           failed
 *
 * A validation-script timeout in validating/revalidating short-circuits to
 * failed — an environment/scope limit the fix agent can never resolve.
 */

import { setup, assign, fromPromise } from "xstate";
import type {
  CommitContext,
  CommitEvent,
  CommitInput,
  CommitOutput,
} from "./types";
import type {
  ClassifyWorktreeInput,
  ClassifyWorktreeOutput,
} from "../merge/actors";
import { classifyWorktreeActor } from "../merge/actors";
import type {
  CheckUncommittedInput,
  CheckUncommittedOutput,
  CommitChangesInput,
  CommitChangesOutput,
  RunValidationInput,
  RunValidationOutput,
  FixValidationInput,
  FixValidationOutput,
} from "../validation-fix/actors";
import {
  checkUncommitted,
  commitChangesActor,
  runValidation,
  fixValidation,
} from "../validation-fix/actors";
import { createValidationFixStates } from "../validation-fix/states";
import {
  errorAssign,
  createTerminalStates,
  OPERATOR_ABORT_ERROR,
} from "../utils";

const SCHEMA_VERSION = 1;

/** Standard terminal states for the commit machine. */
const terminals = createTerminalStates(["completed", "failed"] as const);

/**
 * Shared validate → fix → check → commit-fix → revalidate fragment.
 * Success routes straight to `completed` (terminals don't clear
 * phase/completedAt, so the transition assigns them); a validation-script
 * timeout short-circuits to `failed` without burning fix turns.
 */
const validationFixStates = createValidationFixStates<CommitContext>({
  validateInput: (context) => ({
    source: context.validationMode.source,
    selection: context.validationMode.selection,
    projectPath: context.projectPath,
    worktreePath: context.worktreePath,
    sessionName: context.sessionName,
    branchName: context.branchName,
    targetBranch: context.targetBranch,
    timeoutMs: context.validationTimeoutMs,
  }),
  onValidated: {
    target: "completed",
    actions: [
      assign({
        completedAt: () => new Date().toISOString(),
        phase: null,
      }),
    ],
  },
  onTimeout: { target: "failed" },
});

/** Exported type alias so consumers can accept the machine or `.provide()` variants. */
export type CommitMachineType = typeof commitMachine;

export const commitMachine = setup({
  types: {
    context: {} as CommitContext,
    events: {} as CommitEvent,
    input: {} as CommitInput,
    output: {} as CommitOutput,
  },
  actors: {
    classifyWorktree: classifyWorktreeActor as ReturnType<
      typeof fromPromise<ClassifyWorktreeOutput, ClassifyWorktreeInput>
    >,
    checkUncommitted: checkUncommitted as ReturnType<
      typeof fromPromise<CheckUncommittedOutput, CheckUncommittedInput>
    >,
    commitChanges: commitChangesActor as ReturnType<
      typeof fromPromise<CommitChangesOutput, CommitChangesInput>
    >,
    runValidation: runValidation as ReturnType<
      typeof fromPromise<RunValidationOutput, RunValidationInput>
    >,
    fixValidation: fixValidation as ReturnType<
      typeof fromPromise<FixValidationOutput, FixValidationInput>
    >,
  },
}).createMachine({
  id: "smartCommit",
  context: ({ input }) => ({
    _schemaVersion: SCHEMA_VERSION,
    jobId: input.jobId,
    projectPath: input.projectPath,
    projectName: input.projectName,
    sessionName: input.sessionName,
    startedAt: new Date().toISOString(),
    completedAt: null,
    message: input.message,
    branchName: input.branchName,
    targetBranch: input.targetBranch ?? "main",
    worktreePath: input.worktreePath,
    phase: null,
    error: null,
    commitHash: null,
    validationTimeoutMs: input.validationTimeoutMs ?? 300_000,
    validationMode: input.validationMode,
    fixAttempt: 0,
    maxFixAttempts: input.maxFixAttempts ?? 2,
    finalStatus: null,
  }),
  initial: "classifyingWorktree",
  // An operator can stop the run from any phase; the state exit stops the
  // in-flight actor, whose AbortSignal cancels the validation run it started.
  on: { ABORT: ".aborting" },
  states: {
    /**
     * Smart Commit has no merge to continue, so every merge-bearing worktree
     * is somebody else's unfinished work: it refuses under both readings
     * rather than sweeping a half-merged tree into a commit.
     */
    classifyingWorktree: {
      invoke: {
        src: "classifyWorktree",
        input: ({ context }) => ({ worktreePath: context.worktreePath }),
        onDone: [
          {
            guard: ({ event }) =>
              event.output.kind === "clean" || event.output.kind === "dirty",
            target: "committing",
          },
          {
            target: "failed",
            actions: [
              assign({
                error: ({ context, event }) => {
                  if (event.output.kind === "mid-merge") {
                    return event.output.unresolved
                      ? `Worktree ${context.worktreePath} is mid-merge with unresolved conflicts. Resolve and commit the merge, or abort it (git merge --abort), before committing.`
                      : `Worktree ${context.worktreePath} holds a merge whose conflicts are resolved but not committed. Conclude that merge (git commit) instead of starting a new commit.`;
                  }
                  if (event.output.kind !== "poisoned") {
                    return `Worktree ${context.worktreePath} could not be classified before committing`;
                  }
                  const files = [
                    ...new Set([
                      ...event.output.artifacts.unmergedFiles,
                      ...event.output.artifacts.markerFiles,
                    ]),
                  ];
                  return `Worktree ${context.worktreePath} carries conflict artifacts with no merge in progress — ${files.length} file(s): ${files.join(", ")}. Restore or resolve them by hand; nothing may commit this state.`;
                },
              }),
              assign({ phase: null }),
            ],
          },
        ],
        onError: {
          target: "failed",
          actions: [errorAssign(), assign({ phase: null })],
        },
      },
    },

    committing: {
      entry: assign({ phase: "committing" as const }),
      invoke: {
        src: "commitChanges",
        input: ({ context }) => ({
          worktreePath: context.worktreePath,
          message: context.message,
          skipHooks: true,
        }),
        onDone: {
          target: "validating",
          actions: assign({
            commitHash: ({ event }) => event.output.hash,
          }),
        },
        onError: {
          target: "failed",
          actions: [errorAssign(), assign({ phase: null })],
        },
      },
    },

    // Shared validate → fix → check → commit-fix → revalidate fragment
    ...validationFixStates,

    /**
     * Where an operator's stop lands. Smart Commit opens no merge of its own —
     * a merge-bearing worktree is refused at classification — so there is
     * nothing here to clean up, and a `git merge --abort` would discard a merge
     * this run never started.
     */
    aborting: {
      always: {
        target: "failed",
        actions: assign({
          error: OPERATOR_ABORT_ERROR,
          phase: null,
          completedAt: () => new Date().toISOString(),
        }),
      },
    },

    // Standard terminal states (completed, failed)
    ...terminals,
  },
  output: ({ context }) => ({
    status: context.finalStatus ?? ("completed" as const),
    commitHash: context.commitHash,
    error: context.error,
  }),
});
