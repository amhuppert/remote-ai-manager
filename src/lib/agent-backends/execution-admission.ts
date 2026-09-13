import { z } from "zod";
import { agentBackendSchema } from "@/lib/shared/schemas";

export const executionClassSchema = z.enum([
  "ordinary-conversation",
  "nongoverned-task",
  "governed-execution",
]);
export type ExecutionClass = z.infer<typeof executionClassSchema>;

export const taskExecutionProfileSchema = z.enum([
  "standard",
  "isolated-one-shot",
]);
export type TaskExecutionProfile = z.infer<typeof taskExecutionProfileSchema>;

const executionPolicyFields = {
  classes: z.array(executionClassSchema).min(1),
  instructionDelivery: z.enum(["privileged", "user-message"]),
};
export const conversationExecutionPolicySchema = z.object(
  executionPolicyFields,
);
export const taskExecutionPolicySchema = z.object({
  ...executionPolicyFields,
  profiles: z.array(taskExecutionProfileSchema).min(1),
});
export type ConversationExecutionPolicy = z.infer<
  typeof conversationExecutionPolicySchema
>;
export type TaskExecutionPolicy = z.infer<typeof taskExecutionPolicySchema>;

const restrictionSchema = z.enum([
  "enforced",
  "instruction-only",
  "unsupported",
]);
export const backendExecutionSchema = z
  .object({
    conversation: conversationExecutionPolicySchema
      .extend({
        fsWriteRestriction: restrictionSchema,
      })
      .nullable(),
    tasks: taskExecutionPolicySchema
      .extend({
        fsWriteRestriction: restrictionSchema,
      })
      .nullable(),
  })
  .superRefine((execution, ctx) => {
    for (const facet of ["conversation", "tasks"] as const) {
      const policy = execution[facet];
      if (policy === null) continue;
      const invalidClass =
        facet === "tasks" ? "ordinary-conversation" : "nongoverned-task";
      if (
        new Set(policy.classes).size !== policy.classes.length ||
        policy.classes.includes(invalidClass)
      ) {
        ctx.addIssue({
          code: "custom",
          path: [facet, "classes"],
          message: "Execution classes must be unique and match the facet",
        });
      }
    }
    const task = execution.tasks;
    if (task === null) return;
    if (new Set(task.profiles).size !== task.profiles.length) {
      ctx.addIssue({
        code: "custom",
        path: ["tasks", "profiles"],
        message: "Task profiles must be unique",
      });
    }
    if (
      task.classes.includes("governed-execution") &&
      task.fsWriteRestriction === "unsupported"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["tasks", "classes"],
        message: "Governed tasks require supported filesystem restrictions",
      });
    }
  });
export type BackendExecution = z.infer<typeof backendExecutionSchema>;

export const executionIntentSchema = z.object({
  executionClass: executionClassSchema,
  requiresPrivilegedInstructions: z.boolean().optional(),
});
export type ExecutionIntent = z.infer<typeof executionIntentSchema>;

const requirementFields = {
  ...executionIntentSchema.shape,
  operation: z.string().min(1),
  requiresFsWriteRestriction: z.boolean().optional(),
};
export const executionRequirementsSchema = z.discriminatedUnion("facet", [
  z.object({ facet: z.literal("conversation"), ...requirementFields }),
  z.object({
    facet: z.literal("tasks"),
    executionProfile: taskExecutionProfileSchema,
    ...requirementFields,
  }),
]);
export type ExecutionRequirements = z.infer<typeof executionRequirementsSchema>;

export const backendAdmissionRefusalSchema = z.object({
  backend: agentBackendSchema,
  operation: z.string(),
  code: z.enum([
    "backend-facet-unsupported",
    "backend-role-unsupported",
    "backend-task-profile-unsupported",
    "backend-instructions-unsupported",
    "backend-fs-policy-unsupported",
    "backend-fork-unsupported",
    "backend-catalog-unavailable",
  ]),
  message: z.string(),
});
export type BackendAdmissionRefusal = z.infer<
  typeof backendAdmissionRefusalSchema
>;

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
  constructor(readonly refusal: BackendAdmissionRefusal) {
    super(refusal.message);
    this.name = "BackendAdmissionError";
    this.code = refusal.code;
  }
}
