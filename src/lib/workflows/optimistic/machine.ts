/**
 * Optimistic Sessions XState v5 Machine.
 *
 * States:
 *   executingPrompt → dispatchingMerge → completed
 *                  ↘ failed ←──────────↙
 *
 * This is the simplest workflow machine — validates the standard pattern
 * before applying it to more complex workflows (Smart Merge, Ralph Loop).
 */

import { setup, assign, fromPromise } from "xstate";
import type {
  OptimisticContext,
  OptimisticInput,
  OptimisticEvent,
  OptimisticOutput,
} from "./types";
import type {
  ExecutePromptInput,
  ExecutePromptOutput,
  DispatchMergeInput,
  DispatchMergeOutput,
} from "./actors";
import { executePrompt, dispatchMerge } from "./actors";
import { extractErrorMessage } from "../utils";

const SCHEMA_VERSION = 1;

export const optimisticMachine = setup({
  types: {
    context: {} as OptimisticContext,
    events: {} as OptimisticEvent,
    input: {} as OptimisticInput,
    output: {} as OptimisticOutput,
  },
  actors: {
    executePrompt: executePrompt as ReturnType<
      typeof fromPromise<ExecutePromptOutput, ExecutePromptInput>
    >,
    dispatchMerge: dispatchMerge as ReturnType<
      typeof fromPromise<DispatchMergeOutput, DispatchMergeInput>
    >,
  },
  actions: {
    notifyFailure: () => {
      // Default implementation — overridden via .provide() in production/tests
    },
  },
}).createMachine({
  id: "optimistic",
  context: ({ input }) => ({
    _schemaVersion: SCHEMA_VERSION,
    projectPath: input.projectPath,
    projectName: input.projectName,
    sessionName: input.sessionName,
    startedAt: new Date().toISOString(),
    completedAt: null,
    instructions: input.instructions,
    images: input.images ?? [],
    session: input.session,
    branchName: input.session.branchName,
    worktreePath: input.session.worktreePath,
    error: null,
    conversationId: null,
    mergeJobId: null,
  }),
  initial: "executingPrompt",
  states: {
    executingPrompt: {
      invoke: {
        src: "executePrompt",
        input: ({ context }) => ({
          projectPath: context.projectPath,
          session: context.session,
          instructions: context.instructions,
          images: context.images,
        }),
        onDone: {
          target: "dispatchingMerge",
          actions: assign({
            conversationId: ({ event }) => event.output.conversationId,
          }),
        },
        onError: {
          target: "failed",
          actions: [
            assign({
              error: ({ event }) => extractErrorMessage(event.error),
              completedAt: () => new Date().toISOString(),
            }),
            {
              type: "notifyFailure" as const,
              params: ({
                context,
                event,
              }: {
                context: OptimisticContext;
                event: { type: string; error: unknown };
              }) => ({
                error: extractErrorMessage(event.error),
                projectName: context.projectName,
                sessionName: context.sessionName,
                branchName: context.branchName,
                instructions: context.instructions,
              }),
            },
          ],
        },
      },
    },
    dispatchingMerge: {
      invoke: {
        src: "dispatchMerge",
        input: ({ context }) => ({
          projectPath: context.projectPath,
          projectName: context.projectName,
          sessionName: context.sessionName,
          worktreePath: context.worktreePath,
          branchName: context.branchName,
          instructions: context.instructions,
        }),
        onDone: {
          target: "completed",
          actions: assign({
            mergeJobId: ({ event }) => event.output.jobId,
            completedAt: () => new Date().toISOString(),
          }),
        },
        onError: {
          target: "failed",
          actions: [
            assign({
              error: ({ event }) => extractErrorMessage(event.error),
              completedAt: () => new Date().toISOString(),
            }),
            {
              type: "notifyFailure" as const,
              params: ({
                context,
                event,
              }: {
                context: OptimisticContext;
                event: { type: string; error: unknown };
              }) => ({
                error: extractErrorMessage(event.error),
                projectName: context.projectName,
                sessionName: context.sessionName,
                branchName: context.branchName,
                instructions: context.instructions,
              }),
            },
          ],
        },
      },
    },
    completed: {
      type: "final",
    },
    failed: {
      type: "final",
    },
  },
  output: ({ context }) => ({
    success: context.error === null,
    conversationId: context.conversationId,
    mergeJobId: context.mergeJobId,
    error: context.error,
  }),
});
