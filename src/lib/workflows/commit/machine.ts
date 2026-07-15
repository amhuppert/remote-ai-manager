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
import type { CommitContext, CommitInput, CommitOutput } from "./types";
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
import { errorAssign, createTerminalStates } from "../utils";

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
    input: {} as CommitInput,
    output: {} as CommitOutput,
  },
  actors: {
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
    fixAttempt: 0,
    maxFixAttempts: input.maxFixAttempts ?? 2,
    finalStatus: null,
  }),
  initial: "committing",
  states: {
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

    // Standard terminal states (completed, failed)
    ...terminals,
  },
  output: ({ context }) => ({
    status: context.finalStatus ?? ("completed" as const),
    commitHash: context.commitHash,
    error: context.error,
  }),
});
