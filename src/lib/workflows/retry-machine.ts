/**
 * Generic retry machine factory for XState v5.
 *
 * Models the attempt → fix → reattempt cycle as a standalone child machine:
 *
 *   attempting → (success) → succeeded
 *   attempting → (error, retries left) → fixing → attempting
 *   attempting → (error, no retries) → exhausted
 *   fixing → (error) → exhausted
 *
 * Parent workflows invoke this machine like any other actor:
 *   invoke: { src: retryMachine, input: { maxRetries, workInput }, onDone: [...] }
 *
 * The `work` and `fix` actors are stubs — replace them via `.provide()`.
 * The fix actor is optional; if not provided, retries happen without a fix step.
 */

import { setup, assign, fromPromise } from "xstate";
import { extractErrorMessage } from "./utils";

// ============================================================
// Types
// ============================================================

/** Input to the retry machine. */
export interface RetryMachineInput<TWorkInput> {
  /** Maximum number of retries (0 = no retries, fail on first error). */
  maxRetries: number;
  /** Input passed to the work actor on each attempt. */
  workInput: TWorkInput;
}

/** Output from the retry machine. */
export interface RetryMachineOutput<TWorkOutput> {
  /** Whether the work ultimately succeeded. */
  success: boolean;
  /** Result from the work actor (present only on success). */
  result?: TWorkOutput;
  /** Error message (present only on failure). */
  error?: string;
  /** Total number of work attempts made. */
  attempts: number;
}

/** Input passed to the fix actor between retries. */
export interface FixInput<TWorkInput> {
  /** Error message from the failed work attempt. */
  error: string;
  /** Original work input for context. */
  workInput: TWorkInput;
}

// ============================================================
// Internal context
// ============================================================

interface RetryContext<TWorkInput, TWorkOutput> {
  maxRetries: number;
  workInput: TWorkInput;
  attempts: number;
  retriesUsed: number;
  result: TWorkOutput | undefined;
  error: string | undefined;
}

// ============================================================
// Factory
// ============================================================

/**
 * Create a generic retry machine.
 *
 * @typeParam TWorkInput - Input type for the work actor
 * @typeParam TWorkOutput - Output type from the work actor
 *
 * Actors to provide via `.provide()`:
 * - `work`: `fromPromise<TWorkOutput, TWorkInput>` — the operation to attempt
 * - `fix` (optional): `fromPromise<void, FixInput<TWorkInput>>` — corrective action between retries
 */
export function createRetryMachine<TWorkInput, TWorkOutput>() {
  return setup({
    types: {
      context: {} as RetryContext<TWorkInput, TWorkOutput>,
      input: {} as RetryMachineInput<TWorkInput>,
      output: {} as RetryMachineOutput<TWorkOutput>,
    },
    actors: {
      work: fromPromise<TWorkOutput, TWorkInput>(async () => {
        throw new Error(
          "retry-machine: 'work' actor must be provided via .provide()",
        );
      }),
      fix: fromPromise<void, FixInput<TWorkInput>>(async () => {
        // Default fix is a no-op — retries proceed directly without a fix step.
      }),
    },
    guards: {
      hasRetriesLeft: ({ context }) => context.retriesUsed < context.maxRetries,
    },
  }).createMachine({
    id: "retry",
    context: ({ input }) => ({
      maxRetries: input.maxRetries,
      workInput: input.workInput,
      attempts: 0,
      retriesUsed: 0,
      result: undefined,
      error: undefined,
    }),
    initial: "attempting",
    states: {
      attempting: {
        entry: assign({
          attempts: ({ context }) => context.attempts + 1,
        }),
        // Cast needed: XState's strict types don't infer correctly through
        // generic type parameters in factory functions. Runtime is correct.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        invoke: {
          src: "work",
          input: ({
            context,
          }: {
            context: RetryContext<TWorkInput, TWorkOutput>;
          }) => context.workInput,
          onDone: {
            target: "succeeded",
            actions: assign({
              result: ({ event }: { event: { output: TWorkOutput } }) =>
                event.output,
            }),
          },
          onError: [
            {
              guard: "hasRetriesLeft",
              target: "fixing",
              actions: assign({
                error: ({ event }: { event: { error: unknown } }) =>
                  extractErrorMessage(event.error),
              }),
            },
            {
              target: "exhausted",
              actions: assign({
                error: ({ event }: { event: { error: unknown } }) =>
                  extractErrorMessage(event.error),
              }),
            },
          ],
        } as never,
      },

      fixing: {
        entry: assign({
          retriesUsed: ({ context }) => context.retriesUsed + 1,
        }),
        invoke: {
          src: "fix",
          input: ({ context }) => ({
            error: context.error ?? "",
            workInput: context.workInput,
          }),
          onDone: "attempting",
          onError: {
            target: "exhausted",
            actions: assign({
              error: ({ event }: { event: { error: unknown } }) =>
                extractErrorMessage(event.error),
            }) as never,
          },
        },
      },

      succeeded: {
        type: "final",
      },

      exhausted: {
        type: "final",
      },
    },

    output: ({ context }) => {
      if (context.result !== undefined) {
        return {
          success: true,
          result: context.result,
          attempts: context.attempts,
        };
      }
      return {
        success: false,
        error: context.error,
        attempts: context.attempts,
      };
    },
  });
}
