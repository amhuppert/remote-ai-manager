import { createLogger } from "@/lib/logging";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  AgentTaskRequest,
  AgentTaskResult,
  AgentTaskRunner,
} from "./task";
import {
  BackendAdmissionError,
  backendExecutionRefusal,
  executionRequirementsSchema,
  type ExecutionCatalogEntry,
  type ExecutionRequirements,
} from "./execution-admission";

const logger = createLogger("agent-backends.execution");

export async function assertBackendExecution(
  backend: AgentBackendId,
  requirements: ExecutionRequirements,
  entry?: ExecutionCatalogEntry,
): Promise<void> {
  const parsed = executionRequirementsSchema.parse(requirements);
  const target = entry ?? (await resolveExecutionEntry(backend));
  if (target.id !== backend)
    throw new Error("Execution admission backend mismatch");
  const refusal = backendExecutionRefusal(target, parsed);
  if (refusal === null) {
    if (
      parsed.requiresFsWriteRestriction &&
      parsed.executionClass === "nongoverned-task"
    ) {
      logger.error("backend.execution_intent_invalid", { backend, ...parsed });
      throw new Error("Ownership policies require governed-execution");
    }
    return;
  }
  logger.warn("backend.execution_admission_rejected", {
    ...refusal,
    ...parsed,
  });
  throw new BackendAdmissionError(refusal);
}

export async function resolveExecutionEntry(
  backend: AgentBackendId,
): Promise<ExecutionCatalogEntry> {
  const { getBackendDescriptor } = await import("./registry");
  const descriptor = getBackendDescriptor(backend);
  return {
    id: descriptor.id,
    label: descriptor.metadata.label,
    facets: {
      conversation: descriptor.conversation !== undefined,
      tasks: descriptor.tasks !== undefined,
    },
    execution: {
      conversation: descriptor.conversation
        ? {
            ...descriptor.conversation.execution,
            fsWriteRestriction: descriptor.conversation.fsWriteRestriction,
          }
        : null,
      tasks: descriptor.tasks
        ? {
            ...descriptor.tasks.execution,
            fsWriteRestriction: descriptor.tasks.fsWriteRestriction,
          }
        : null,
    },
  };
}

export interface TaskExecutionDeps {
  runner?: AgentTaskRunner;
  entry?: ExecutionCatalogEntry;
  getRunner?(backend: AgentBackendId): AgentTaskRunner;
}

export async function runAdmittedTask(
  backend: AgentBackendId,
  request: AgentTaskRequest,
  deps: TaskExecutionDeps = {},
): Promise<AgentTaskResult> {
  await assertBackendExecution(
    backend,
    {
      facet: "tasks",
      operation: "task-run",
      executionClass: request.executionClass,
      executionProfile: request.executionProfile ?? "standard",
      requiresPrivilegedInstructions: request.requiresPrivilegedInstructions,
      requiresFsWriteRestriction: request.fsWritePolicy !== undefined,
    },
    deps.entry,
  );
  const runner =
    deps.runner ??
    (deps.getRunner
      ? deps.getRunner(backend)
      : (await import("./registry")).getTaskRunner(backend));
  if (runner.backend !== backend)
    throw new Error("Task execution backend mismatch");
  return runner.run(request);
}
