import type {
  BackendAdmissionRefusal,
  BackendExecution,
  ExecutionRequirements,
} from "./execution-schemas";

export interface ExecutionCatalogEntry {
  id: BackendAdmissionRefusal["backend"];
  label: string;
  facets: { conversation: boolean; tasks: boolean };
  execution: BackendExecution;
}

export function backendExecutionRefusal(
  entry: ExecutionCatalogEntry,
  requirements: ExecutionRequirements,
): BackendAdmissionRefusal | null {
  const refuse = (
    code: BackendAdmissionRefusal["code"],
    message: string,
  ): BackendAdmissionRefusal => ({
    backend: entry.id,
    operation: requirements.operation,
    code,
    message,
  });
  const facet = entry.execution[requirements.facet];
  const noun = requirements.facet === "tasks" ? "task" : "conversation";
  if (!entry.facets[requirements.facet] || facet === null) {
    return refuse(
      "backend-facet-unsupported",
      `${entry.label} does not support ${noun} execution.`,
    );
  }
  if (!facet.classes.includes(requirements.executionClass)) {
    return refuse(
      "backend-role-unsupported",
      `${entry.label} is not eligible for ${requirements.executionClass} on its ${noun} runtime`,
    );
  }
  if (
    requirements.facet === "tasks" &&
    !entry.execution.tasks?.profiles.includes(requirements.executionProfile)
  ) {
    return refuse(
      "backend-task-profile-unsupported",
      `${entry.label} does not support the ${requirements.executionProfile} task profile`,
    );
  }
  if (
    requirements.requiresPrivilegedInstructions &&
    facet.instructionDelivery !== "privileged"
  ) {
    return refuse(
      "backend-instructions-unsupported",
      `${entry.label} cannot deliver privileged instructions on its ${noun} runtime`,
    );
  }
  if (
    requirements.requiresFsWriteRestriction &&
    facet.fsWriteRestriction === "unsupported"
  ) {
    return refuse(
      "backend-fs-policy-unsupported",
      `${entry.label} cannot apply a filesystem write policy on its ${noun} runtime`,
    );
  }
  return null;
}

export function backendExecutionRefusalIn(
  entries: readonly ExecutionCatalogEntry[],
  backend: BackendAdmissionRefusal["backend"],
  requirements: ExecutionRequirements,
): BackendAdmissionRefusal | null {
  const entry = entries.find((candidate) => candidate.id === backend);
  return entry
    ? backendExecutionRefusal(entry, requirements)
    : {
        backend,
        operation: requirements.operation,
        code: "backend-catalog-unavailable",
        message: `Execution availability for ${backend} is unavailable`,
      };
}

export class BackendAdmissionError extends Error {
  readonly code: BackendAdmissionRefusal["code"];

  /** By name: the code that throws it may run another bundle's copy of this class. */
  static is(error: unknown): error is BackendAdmissionError {
    return error instanceof Error && error.name === "BackendAdmissionError";
  }
  constructor(readonly refusal: BackendAdmissionRefusal) {
    super(refusal.message);
    this.name = "BackendAdmissionError";
    this.code = refusal.code;
  }
}
