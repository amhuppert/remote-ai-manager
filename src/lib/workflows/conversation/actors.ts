/**
 * Conversation machine actor stubs.
 *
 * Each actor is a `fromPromise` stub that lazy-imports the production
 * implementation. Override via `.provide()` in tests.
 */

import { fromPromise } from "xstate";
import type {
  PrepareTurnInput,
  PrepareTurnOutput,
  ExecutePromptInput,
  PromptActorResult,
  VerifyCleanupInput,
  VerifyCleanupOutput,
} from "./types";

/**
 * Acquire session lock, query slot, and initialize transcript path.
 */
export const prepareTurnActor = fromPromise<
  PrepareTurnOutput,
  PrepareTurnInput
>(async ({ input }) => {
  const { prepareTurnForMachine } = await import("./actor-implementations");
  return prepareTurnForMachine(input);
});

/**
 * Execute a prompt via the Claude Agent SDK.
 * Handles QuerySession reuse, system prompt construction, SDK streaming,
 * transcript writes, and structured output for debug phases.
 */
export const executePromptActor = fromPromise<
  PromptActorResult,
  ExecutePromptInput
>(async ({ input }) => {
  const { executePromptForMachine } = await import("./actor-implementations");
  return executePromptForMachine(input);
});

/**
 * Cross-check the agent's debug cleanup result against the persisted
 * instrumentation manifest. On a passing verification the manifest is
 * deleted as a side-effect.
 */
export const verifyCleanupActor = fromPromise<
  VerifyCleanupOutput,
  VerifyCleanupInput
>(async ({ input }) => {
  const { verifyCleanupForMachine } = await import("./actor-implementations");
  return verifyCleanupForMachine(input);
});
