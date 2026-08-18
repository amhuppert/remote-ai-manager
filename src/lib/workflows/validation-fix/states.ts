/**
 * Reusable validate → fix → check → commit-fix → revalidate state fragment
 * for XState workflow machines (sibling of `createTerminalStates`).
 *
 * Owns the full validation-fix loop shared by Smart Merge and Smart Commit,
 * including the timeout short-circuit: a validation-script timeout is an
 * environment/scope limit no fix agent can resolve, so it must fail the
 * workflow immediately instead of burning LLM fix turns.
 *
 * Host machine contract:
 * - Actors registered under the names `runValidation`, `fixValidation`,
 *   `checkUncommitted`, and `commitChanges` (see `./actors`).
 * - A `failed` state (fix/commit errors and exhausted retries target it).
 * - Context satisfying {@link ValidationFixHostContext}.
 * - States named by {@link ValidationFixStateName} must not already exist.
 */

import { assign } from "xstate";
import { createLogger } from "@/lib/logging";
import {
  errorAssign,
  extractErrorMessage,
  isTimeoutError,
  timeoutHaltMessage,
} from "../utils";
import type {
  CheckUncommittedOutput,
  FixValidationOutput,
  RunValidationInput,
} from "./actors";
import { isRemediableValidationFailure } from "./actors";
import type { AgentTurnDispatch } from "@/lib/workflows/conversation/execute-fresh-task-run";

const logger = createLogger("validation-fix-states");

/** Context fields the fragment reads or assigns on the host machine. */
export interface ValidationFixHostContext {
  projectPath: string;
  worktreePath: string;
  sessionName: string;
  branchName: string;
  /** Conversation the fix turn binds to; hosts without one (Smart Commit)
   *  omit it and the fix actor falls back to the session's
   *  most-recently-active conversation. */
  conversationId?: string | null;
  /** How the fix turn executes; absent/null means `conversation`. */
  agentTurnDispatch?: AgentTurnDispatch | null;
  resolutionContext?: string | null;
  error: string | null;
  completedAt: string | null;
  phase: string | null;
  fixAttempt: number;
  maxFixAttempts: number;
}

export interface ValidationFixStatesConfig<
  TContext extends ValidationFixHostContext,
> {
  /** Build the `runValidation` actor input (used by validate and revalidate). */
  validateInput(context: TContext): RunValidationInput;
  /**
   * Transition taken when validation passes (initially or after a fix round).
   * The fragment clears `error` before running the supplied actions.
   */
  onValidated: { target: string; actions?: readonly unknown[] };
  /**
   * Transition target when the validation script is killed by its timeout.
   * The fragment assigns the actionable halt message and skips the fix loop.
   */
  onTimeout: { target: string };
  /**
   * Whether a first validation failure may dispatch the fix agent (merge
   * gates this on `autoResolve`). Defaults to always. Revalidation retries
   * are governed solely by `fixAttempt < maxFixAttempts`.
   */
  shouldAttemptFix?(context: TContext): boolean;
  /** Commit message for the fix commit. */
  commitFixMessage?: string;
}

export type ValidationFixStateName =
  | "validating"
  | "fixingValidation"
  | "checkingFixChanges"
  | "committingFix"
  | "revalidating";

/**
 * Build the five validation-fix states for spreading into a host machine's
 * `states` block.
 *
 * The return type uses a broad cast for the same reason as
 * `createTerminalStates()`: XState's strict type system requires exact
 * context/event type matches, but this fragment works across any workflow
 * machine satisfying the host contract. Runtime behavior is pinned by both
 * host machines' test suites.
 */
export function createValidationFixStates<
  TContext extends ValidationFixHostContext,
>(
  config: ValidationFixStatesConfig<TContext>,
): Record<ValidationFixStateName, never> {
  const commitFixMessage =
    config.commitFixMessage ?? "auto-fix: validation errors";
  const shouldAttemptFix = config.shouldAttemptFix ?? (() => true);

  const validatedTransition = {
    target: config.onValidated.target,
    actions: [assign({ error: null }), ...(config.onValidated.actions ?? [])],
  };

  const timeoutTransition = {
    guard: ({ event }: { event: { error?: unknown } }) =>
      isTimeoutError(event.error),
    target: config.onTimeout.target,
    actions: [
      ({
        context,
        event,
      }: {
        context: TContext;
        event: { error?: unknown };
      }) => {
        logger.warn("validation_fix.timeout_short_circuit", {
          projectPath: context.projectPath,
          sessionName: context.sessionName,
          branchName: context.branchName,
          fixAttempt: context.fixAttempt,
          error: extractErrorMessage(event.error),
        });
      },
      assign({
        error: ({ event }: { event: { error?: unknown } }) =>
          timeoutHaltMessage(event.error),
        completedAt: () => new Date().toISOString(),
        phase: null,
      }),
    ],
  };

  const startFixTransition = {
    target: "fixingValidation",
    actions: assign({
      error: ({ event }: { event: { error: unknown } }) =>
        extractErrorMessage(event.error),
    }),
  };

  const failedTransition = {
    target: "failed",
    actions: [errorAssign(), assign({ phase: null })],
  };

  /**
   * The validation error says what has to be fixed; the fix agent's error says
   * why it could not be. Only both together distinguish "the agent tried and
   * the code still fails" from "the fix turn never ran" (quota, transport,
   * abort) — with the second dropped, the halt reads as the former.
   */
  const composeFixFailureError = (
    validationError: string | null,
    fixError: string | undefined,
  ): string | null => {
    if (fixError === undefined || fixError.length === 0) return validationError;
    if (validationError === null || validationError.length === 0) {
      return `Fix agent failed: ${fixError}`;
    }
    return `${validationError}\n\nFix agent failed: ${fixError}`;
  };

  const states: Record<string, unknown> = {
    validating: {
      entry: assign({ phase: "validating" }),
      invoke: {
        src: "runValidation",
        input: ({ context }: { context: TContext }) =>
          config.validateInput(context),
        onDone: validatedTransition,
        onError: [
          timeoutTransition,
          {
            ...startFixTransition,
            guard: ({
              context,
              event,
            }: {
              context: TContext;
              event: { error?: unknown };
            }) =>
              shouldAttemptFix(context) &&
              isRemediableValidationFailure(event.error),
          },
          failedTransition,
        ],
      },
    },

    fixingValidation: {
      entry: [
        assign({ phase: "fixing-validation" }),
        assign({
          fixAttempt: ({ context }: { context: { fixAttempt: number } }) =>
            context.fixAttempt + 1,
        }),
      ],
      invoke: {
        src: "fixValidation",
        input: ({ context }: { context: TContext }) => ({
          worktreePath: context.worktreePath,
          validationOutput: context.error ?? "",
          projectPath: context.projectPath,
          sessionName: context.sessionName,
          conversationId: context.conversationId ?? undefined,
          agentTurnDispatch: context.agentTurnDispatch ?? undefined,
          resolutionContext: context.resolutionContext ?? undefined,
          branchName: context.branchName,
          isRetry: context.fixAttempt > 1,
        }),
        onDone: [
          {
            guard: ({ event }: { event: { output: FixValidationOutput } }) =>
              event.output.status === "fixed",
            target: "checkingFixChanges",
          },
          {
            target: "failed",
            actions: assign({
              // The host machine's context/event types are generic here, so an
              // assigner may only claim what any event satisfies: the done
              // event's output is read as optional and falls back to the
              // untouched validation error.
              error: ({
                context,
                event,
              }: {
                context: ValidationFixHostContext;
                event: { type: string; output?: FixValidationOutput };
              }) => composeFixFailureError(context.error, event.output?.error),
              completedAt: () => new Date().toISOString(),
              phase: null,
            }),
          },
        ],
        onError: failedTransition,
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
        input: ({ context }: { context: TContext }) => ({
          worktreePath: context.worktreePath,
        }),
        onDone: [
          {
            guard: ({ event }: { event: { output: CheckUncommittedOutput } }) =>
              event.output.hasChanges,
            target: "committingFix",
          },
          { target: "revalidating" },
        ],
        // Best-effort: if we can't check, try to commit anyway
        onError: { target: "committingFix" },
      },
    },

    committingFix: {
      invoke: {
        src: "commitChanges",
        input: ({ context }: { context: TContext }) => ({
          worktreePath: context.worktreePath,
          message: commitFixMessage,
          skipHooks: true,
        }),
        onDone: "revalidating",
        onError: failedTransition,
      },
    },

    revalidating: {
      entry: assign({ phase: "re-validating" }),
      invoke: {
        src: "runValidation",
        input: ({ context }: { context: TContext }) =>
          config.validateInput(context),
        onDone: validatedTransition,
        onError: [
          timeoutTransition,
          {
            ...startFixTransition,
            guard: ({
              context,
              event,
            }: {
              context: TContext;
              event: { error?: unknown };
            }) =>
              context.fixAttempt < context.maxFixAttempts &&
              isRemediableValidationFailure(event.error),
          },
          failedTransition,
        ],
      },
    },
  };

  return states as Record<ValidationFixStateName, never>;
}
