/**
 * Smart Commit XState v5 Machine.
 *
 * Models the commit pipeline with validation and auto-fix:
 *
 *   committing → validating → completed
 *       ↓ (error)       ↓ (fail)
 *     failed      fixingValidation → checkingFixChanges → committingFix → revalidating → completed
 *                                                       ↘ (no changes) → revalidating
 *                                                                             ↓ (fail + retries remain)
 *                                                                       fixingValidation (loop)
 *                                                                             ↓ (fail + no retries)
 *                                                                           failed
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
} from "../merge/actors";
import {
  checkUncommitted,
  commitChangesActor,
  runValidation,
  fixValidation,
} from "../merge/actors";
import {
  extractErrorMessage,
  errorAssign,
  createTerminalStates,
} from "../utils";

const SCHEMA_VERSION = 1;

/** Standard terminal states for the commit machine. */
const terminals = createTerminalStates(["completed", "failed"] as const);

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
  guards: {
    fixSucceeded: ({ event }) => {
      const e = event as unknown as { output: FixValidationOutput };
      return e.output.status === "fixed";
    },
    hasFixRetriesRemaining: ({ context }) =>
      context.fixAttempt < context.maxFixAttempts,
    hasUncommittedChanges: ({ event }) => {
      const e = event as unknown as { output: CheckUncommittedOutput };
      return e.output.hasChanges;
    },
  },
  actions: {
    onTerminal: () => {
      // Override via .provide() for notifications, SSE broadcast, etc.
    },
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

    validating: {
      entry: assign({ phase: "validating" as const }),
      invoke: {
        src: "runValidation",
        input: ({ context }) => ({
          projectPath: context.projectPath,
          worktreePath: context.worktreePath,
          sessionName: context.sessionName,
          branchName: context.branchName,
          timeoutMs: context.validationTimeoutMs,
        }),
        onDone: {
          target: "completed",
          actions: assign({
            completedAt: () => new Date().toISOString(),
            phase: null,
          }),
        },
        onError: {
          actions: assign({
            error: ({ event }) => extractErrorMessage(event.error),
          }),
          target: "fixingValidation",
        },
      },
    },

    fixingValidation: {
      entry: [
        assign({ phase: "fixing-validation" as const }),
        assign({ fixAttempt: ({ context }) => context.fixAttempt + 1 }),
      ],
      invoke: {
        src: "fixValidation",
        input: ({ context }) => ({
          worktreePath: context.worktreePath,
          validationOutput: context.error ?? "",
          projectPath: context.projectPath,
          sessionName: context.sessionName,
          branchName: context.branchName,
          isRetry: context.fixAttempt > 1,
        }),
        onDone: [
          {
            guard: "fixSucceeded",
            target: "checkingFixChanges",
          },
          {
            // Fix failed — go to failed with original error
            target: "failed",
            actions: assign({
              completedAt: () => new Date().toISOString(),
              phase: null,
            }),
          },
        ],
        onError: {
          target: "failed",
          actions: [errorAssign(), assign({ phase: null })],
        },
      },
    },

    /**
     * Check whether the fix agent actually made changes before committing.
     * If it didn't, skip straight to revalidating so the machine can decide
     * whether to retry or fail based on actual validation results.
     */
    checkingFixChanges: {
      invoke: {
        src: "checkUncommitted",
        input: ({ context }) => ({ worktreePath: context.worktreePath }),
        onDone: [
          {
            guard: "hasUncommittedChanges",
            target: "committingFix",
          },
          { target: "revalidating" },
        ],
        onError: {
          // Best-effort: if we can't check, try to commit anyway
          target: "committingFix",
        },
      },
    },

    committingFix: {
      invoke: {
        src: "commitChanges",
        input: ({ context }) => ({
          worktreePath: context.worktreePath,
          message: "auto-fix: validation errors",
          skipHooks: true,
        }),
        onDone: "revalidating",
        onError: {
          target: "failed",
          actions: [errorAssign(), assign({ phase: null })],
        },
      },
    },

    revalidating: {
      entry: assign({ phase: "re-validating" as const }),
      invoke: {
        src: "runValidation",
        input: ({ context }) => ({
          projectPath: context.projectPath,
          worktreePath: context.worktreePath,
          sessionName: context.sessionName,
          branchName: context.branchName,
          timeoutMs: context.validationTimeoutMs,
        }),
        onDone: {
          target: "completed",
          actions: assign({
            error: null,
            completedAt: () => new Date().toISOString(),
            phase: null,
          }),
        },
        onError: [
          {
            guard: "hasFixRetriesRemaining",
            actions: assign({
              error: ({ event }) => extractErrorMessage(event.error),
            }),
            target: "fixingValidation",
          },
          {
            target: "failed",
            actions: [errorAssign(), assign({ phase: null })],
          },
        ],
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
