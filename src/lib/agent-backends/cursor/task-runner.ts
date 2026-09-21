import { randomUUID } from "node:crypto";
import path from "node:path";
import { createLogger } from "@/lib/logging";
import {
  conversationTargetSchema,
  targetFromStoreSessionName,
} from "@/lib/conversations/conversation-target";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import {
  ccTaskSessionScopeSchema,
  type AgentTaskRequest,
  type AgentTaskResult,
  type AgentTaskRunner,
} from "../task";
import type { AgentTranscriptEntry } from "../transcript";
import {
  CursorConversationRuntime,
  type CursorConversationRuntimeDeps,
} from "./conversation-runtime";
import {
  createCursorFailureClassifier,
  CursorLocalFailure,
} from "./failure-classifier";
import type { CursorCapabilityDelivery } from "./capability-delivery";
import {
  cursorTaskRefSchema,
  decodeCursorTaskRef,
  encodeCursorTaskRef,
} from "./task-ref";
import {
  BackendAdmissionError,
  backendExecutionRefusal,
} from "../execution-admission";
import {
  cursorTaskExecution,
  cursorTaskFsWriteRestriction,
} from "./descriptor";
import { cursorTaskPolicyInstructions } from "./runtime-policy";
import { loadCursorTaskImages } from "./task-images";
import {
  CURSOR_TASK_BILLING_SETTLE_DELAYS_MS,
  CURSOR_TASK_BILLING_SETTLE_TIMEOUT_MS,
} from "./worker/bounds";

const logger = createLogger("cursor:task-runner");
const classifier = createCursorFailureClassifier();

export interface CursorTaskRunnerDeps extends Omit<
  CursorConversationRuntimeDeps,
  "resolveModel" | "capabilityDelivery"
> {
  removeStore?(conversationId: string): Promise<void>;
  resolveModel(
    selection: AgentTaskRequest["modelSelection"],
    workingDirectory: string,
  ): ReturnType<CursorConversationRuntimeDeps["resolveModel"]>;
  prepareCapabilities?(
    input: AgentTaskRequest,
    storePath: string,
  ): Promise<CursorCapabilityDelivery>;
  /** Task-path settlement window; defaults are the adapter bounds. */
  billingSettleTimeoutMs?: number;
  billingSettleDelaysMs?: readonly number[];
}

export function createCursorTaskRunner(
  deps: CursorTaskRunnerDeps,
): AgentTaskRunner {
  return {
    backend: "cursor",
    async run(input) {
      const isolated = input.executionProfile === "isolated-one-shot";
      let backendRef: AgentSessionRef | null =
        isolated || input.resumeRef?.backend !== "cursor"
          ? null
          : (input.resumeRef ?? null);
      let runtime: CursorConversationRuntime | undefined;
      let storeId: string | undefined;
      let outcome: AgentTaskResult;
      const transcript: AgentTranscriptEntry[] = [];
      const controller = new AbortController();
      let abortReason: string | null = null;
      const abort = (reason: string) => {
        abortReason ??= reason;
        controller.abort();
      };
      const onAbort = () => abort("Cursor task cancelled");
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
      const timer =
        input.timeoutMs > 0
          ? setTimeout(
              () => abort(`Cursor task timed out after ${input.timeoutMs}ms`),
              input.timeoutMs,
            )
          : null;
      timer?.unref?.();
      try {
        const refusal = backendExecutionRefusal(
          {
            id: "cursor",
            label: "Cursor",
            facets: { conversation: true, tasks: true },
            execution: {
              conversation: null,
              tasks: {
                ...cursorTaskExecution,
                fsWriteRestriction: cursorTaskFsWriteRestriction,
              },
            },
          },
          {
            facet: "tasks",
            operation: "task-run",
            executionClass: input.executionClass,
            executionProfile: input.executionProfile ?? "standard",
            requiresPrivilegedInstructions:
              input.requiresPrivilegedInstructions,
            requiresFsWriteRestriction: input.fsWritePolicy !== undefined,
          },
        );
        if (refusal) throw new BackendAdmissionError(refusal);
        if (
          (!isolated &&
            input.sandboxMode !== undefined &&
            input.sandboxMode !== "danger-full-access") ||
          (!isolated && input.networkAccessEnabled === false) ||
          (!isolated &&
            input.webSearchMode !== undefined &&
            input.webSearchMode !== "live") ||
          (input.approvalPolicy !== undefined &&
            input.approvalPolicy !== "never") ||
          (!isolated && input.additionalDirectories?.length)
        ) {
          logger.warn("cursor.task_policy_instruction_only", {
            sandboxMode: input.sandboxMode ?? null,
            networkAccessEnabled: input.networkAccessEnabled ?? null,
            approvalPolicy: input.approvalPolicy ?? null,
            webSearchMode: input.webSearchMode ?? null,
            additionalDirectoryCount: input.additionalDirectories?.length ?? 0,
          });
        }
        const cwd = path.resolve(input.workingDirectory);
        const scope =
          !isolated && input.ccSessionScope
            ? ccTaskSessionScopeSchema.parse(input.ccSessionScope)
            : null;
        const conversationResume =
          !isolated &&
          input.resumeRef?.backend === "cursor" &&
          !input.resumeRef.ref.startsWith("{");
        const target = scope
          ? targetFromStoreSessionName(
              scope.project,
              scope.session,
              scope.conversationId,
            )
          : null;
        const conversationTarget =
          !isolated && input.conversationTarget
            ? conversationTargetSchema.parse(input.conversationTarget)
            : target;
        if (conversationResume && conversationTarget === null) {
          throw new CursorLocalFailure(
            "invalid_ref",
            "Resuming a Cursor conversation as a task requires its CC conversation target",
          );
        }
        const resumed =
          !isolated && input.resumeRef && !conversationResume
            ? decodeCursorTaskRef(input.resumeRef)
            : null;
        const hostedConversation =
          conversationTarget !== null &&
          (conversationResume ||
            (input.conversationTarget !== undefined && resumed === null));
        if (
          resumed &&
          (resumed.cwd !== cwd ||
            JSON.stringify(resumed.scope) !== JSON.stringify(scope))
        ) {
          throw new CursorLocalFailure(
            "invalid_ref",
            "Cursor task continuation belongs to a different working directory or CC scope",
          );
        }
        const task =
          resumed ??
          cursorTaskRefSchema.parse({
            taskId: randomUUID(),
            agentId: conversationResume ? input.resumeRef?.ref : null,
            cwd,
            scope,
          });
        const conversationId =
          hostedConversation && conversationTarget
            ? conversationTarget.conversationId
            : `task-${task.taskId}`;
        storeId = conversationId;
        if (controller.signal.aborted)
          throw new Error(abortReason ?? "Cursor task cancelled");
        const capabilityDelivery = await deps.prepareCapabilities?.(
          input,
          deps.storePath(conversationId),
        );
        const imageRefs = await loadCursorTaskImages(
          input.imagePaths ?? [],
          controller.signal,
        );
        if (controller.signal.aborted)
          throw new Error(abortReason ?? "Cursor task cancelled");
        runtime = new CursorConversationRuntime(
          {
            executionClass: "ordinary-conversation",
            conversationId,
            projectPath: cwd,
            projectName: conversationTarget?.projectName ?? conversationId,
            conversationTarget: conversationTarget ?? {
              scope: "project",
              projectName: conversationId,
              conversationId,
            },
            worktreePath: cwd,
            persistedRef: task.agentId
              ? { backend: "cursor", ref: task.agentId }
              : null,
            modelSelection: input.modelSelection,
            sessionInstructions: [
              ...(input.systemInstructions ?? []),
              ...cursorTaskPolicyInstructions(input),
            ],
            fsWritePolicy: input.fsWritePolicy,
            tooling: isolated ? {} : (input.tooling ?? {}),
          },
          {
            ...deps,
            capabilityDelivery,
            resolveModel: (selection) => deps.resolveModel(selection, cwd),
            transport: {
              start: (start) =>
                deps.transport.start({
                  ...start,
                  target,
                  executionProfile: input.executionProfile ?? "standard",
                }),
              find: (id) => deps.transport.find(id),
              closeAll: () => deps.transport.closeAll(),
            },
            stallTimeoutMs: input.stallTimeoutMs ?? deps.stallTimeoutMs,
          },
        );
        logger.info("task.started", {
          taskId: task.taskId,
          conversationId,
          continuationKind: hostedConversation ? "conversation" : "task",
          executionProfile: input.executionProfile ?? "standard",
          resumed: resumed !== null || conversationResume,
        });
        const result = await runtime.sendTurn({
          promptText: input.prompt,
          imageRefs,
          sessionInstructions: [],
          modelSelection: input.modelSelection,
          autonomous: input.autonomous,
          ...(input.outputSchema
            ? {
                outputFormat: {
                  type: "json_schema",
                  schema: input.outputSchema,
                },
              }
            : {}),
          signal: controller.signal,
          onEvent(event) {
            if (event.type === "transcript_entry") transcript.push(event.entry);
            if (!isolated && event.type === "backend_init")
              backendRef = hostedConversation
                ? event.backendRef
                : encodeCursorTaskRef({
                    ...task,
                    agentId: event.backendRef.ref,
                  });
          },
        });
        if (!result.backendRef || isolated) backendRef = null;
        // A task closes its runtime next, so a cost the provider has not
        // priced yet is waited for here, within the bound, or stays unknown.
        let costUsd = result.costUsd;
        if (
          costUsd === null &&
          result.failure === null &&
          !controller.signal.aborted
        ) {
          costUsd = (
            await runtime.settleBilling({
              timeoutMs:
                deps.billingSettleTimeoutMs ??
                CURSOR_TASK_BILLING_SETTLE_TIMEOUT_MS,
              delaysMs:
                deps.billingSettleDelaysMs ??
                CURSOR_TASK_BILLING_SETTLE_DELAYS_MS,
            })
          ).costUsd;
        }
        const timedOut =
          controller.signal.aborted ||
          result.aborted ||
          result.failure?.kind === "timeout";
        const error =
          abortReason ??
          result.failure?.message ??
          (result.aborted ? "Cursor task cancelled" : null);
        logger.info("task.settled", {
          taskId: task.taskId,
          timedOut,
          failureKind: result.failure?.kind ?? null,
          transcriptEntries: transcript.length,
        });
        outcome = {
          backendRef,
          text: result.finalText ?? null,
          usage:
            result.tokenUsage || costUsd !== null
              ? {
                  ...(result.tokenUsage
                    ? {
                        inputTokens: result.tokenUsage.inputTokens,
                        outputTokens: result.tokenUsage.outputTokens,
                        cachedInputTokens: result.tokenUsage.cacheReadTokens,
                      }
                    : {}),
                  // Billed by the provider, never derived from token prices.
                  ...(costUsd !== null ? { costUsd } : {}),
                }
              : null,
          error,
          timedOut,
          failure:
            result.failure ??
            (error ? classifier.classify(new Error(error)) : null),
          continuationDisposition: isolated
            ? "clear"
            : result.continuationDisposition,
          transcript,
        } satisfies AgentTaskResult;
      } catch (error) {
        const verdict = classifier.classifyWithContinuation(error);
        logger.warn("task.failed", {
          failureKind: verdict.failure.kind,
          timedOut: controller.signal.aborted,
        });
        outcome = {
          backendRef:
            verdict.continuationDisposition === "clear" ? null : backendRef,
          text: null,
          usage: null,
          error: abortReason ?? verdict.failure.message,
          timedOut: controller.signal.aborted,
          ...verdict,
          ...(isolated
            ? { backendRef: null, continuationDisposition: "clear" as const }
            : {}),
          transcript,
        };
      } finally {
        if (timer) clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        await runtime?.close();
      }
      if (runtime?.cleanupFailure) {
        return {
          ...outcome,
          error: runtime.cleanupFailure,
          failure: classifier.classify(new Error(runtime.cleanupFailure)),
        };
      }
      if (isolated && storeId) {
        try {
          await deps.removeStore?.(storeId);
        } catch (error) {
          const failure = classifier.classify(error);
          logger.error("task.store_cleanup_failed", {
            storeId,
            failureKind: failure.kind,
          });
          return { ...outcome, error: failure.message, failure };
        }
      }
      return outcome;
    },
  };
}
