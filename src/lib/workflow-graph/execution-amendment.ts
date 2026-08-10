/**
 * The dedicated audited amendment of a launched delivery-plan execution
 * (design §11). `exact-approval` says the definition a launch persisted is the
 * candidate a human approved and stays that way; this operation is the single
 * exception, and it is bounded so the exception cannot swallow the rule:
 *
 * - it is ADDITIVE ONLY — the operand carries `add-context`, `add-task`, and
 *   `add-edge` entries with caller-chosen stable ids, and nothing else. Any
 *   other entry refuses the whole batch, so a "mutation smuggled as an
 *   amendment" is a parse failure rather than a judgment call downstream;
 * - it applies only to a RUNNING execution compiled from a delivery plan.
 *   Legacy compiled runs keep the generic live-edit path (their unlocked
 *   regions are their only escape); a settled run has no working definition to
 *   amend;
 * - it never touches the stored approved candidate — the additions land on the
 *   execution's working definition, and the amendment event records the old and
 *   new working-definition hashes so the drift from the approved bytes is
 *   readable rather than inferred.
 *
 * The CLI (`cctl workflow live amend`) and the Studio control post this exact
 * schema to the same route, which is why the schema is exported rather than
 * inlined at either caller.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { stableStringify } from "@/lib/state-store/serialization";
import type {
  GraphWorkflowResolvedContext,
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "./definition-schemas";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import type { GraphWorkflowExecution } from "./schemas";
import type { ResolvedContextConfig } from "./runtime-edits";

/** Delivery-plan compiled definitions carry this origin scheme (§5). */
const DELIVERY_PLAN_ORIGIN_SCHEME = "spec-plan://";

/**
 * The amendment's actor, derived server-side from the transport. Structurally
 * the same question `ActorProvenance` answers for spec acts, restated here
 * because specs depends on workflow-graph and not the other way round —
 * importing it would invert that edge.
 */
export const workflowAmendmentActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human") }).strict(),
  z
    .object({
      kind: z.literal("agent"),
      conversationId: z.string().min(1),
      backend: z.string().min(1).optional(),
    })
    .strict(),
]);
export type WorkflowAmendmentActor = z.infer<
  typeof workflowAmendmentActorSchema
>;

/**
 * Where an added task lands among the context's existing tasks. Relative to a
 * named sibling or to the context's ends — never an absolute index, which a
 * concurrent addition would silently reinterpret.
 */
const amendmentTaskPositionSchema = z.union([
  z.object({ at: z.enum(["start", "end"]) }).strict(),
  z.object({ after: z.string().trim().min(1) }).strict(),
  z.object({ before: z.string().trim().min(1) }).strict(),
]);

export const workflowAmendmentOperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("add-context"),
      id: z.string().trim().min(1),
      title: z.string().trim().min(1),
      acceptanceCriteria: z.string().trim().min(1),
      description: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("add-task"),
      id: z.string().trim().min(1),
      contextId: z.string().trim().min(1),
      title: z.string().trim().min(1),
      instructions: z.string().trim().min(1),
      position: amendmentTaskPositionSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("add-edge"),
      id: z.string().trim().min(1),
      sourceContextId: z.string().trim().min(1),
      targetContextId: z.string().trim().min(1),
    })
    .strict(),
]);
export type WorkflowAmendmentOperation = z.infer<
  typeof workflowAmendmentOperationSchema
>;

export const WORKFLOW_AMENDMENT_OPERATION_TYPES = [
  "add-context",
  "add-task",
  "add-edge",
] as const;

export const workflowExecutionAmendmentRequestSchema = z
  .object({
    /**
     * Why the running plan is being changed. Required: the rationale is what
     * the durable amendment event is FOR — a hash pair with no reason records
     * that the definition moved without recording why anyone moved it.
     */
    reason: z.string().trim().min(1),
    operations: z.array(workflowAmendmentOperationSchema).min(1),
  })
  .strict();
export type WorkflowExecutionAmendmentRequest = z.infer<
  typeof workflowExecutionAmendmentRequestSchema
>;

export const workflowExecutionAmendmentResponseSchema = z
  .object({
    amended: z.number().int().nonnegative(),
    liveRevision: z.number().int().nonnegative(),
    policyBasis: z.enum(["human_operator", "pinned_allow_agent_task_add"]),
    addedContextIds: z.array(z.string().min(1)),
    addedTaskIds: z.array(z.string().min(1)),
    addedEdgeIds: z.array(z.string().min(1)),
    previousWorkingDefinitionHash: z.string().min(1),
    workingDefinitionHash: z.string().min(1).nullable(),
  })
  .strict();
export type WorkflowExecutionAmendmentResponse = z.infer<
  typeof workflowExecutionAmendmentResponseSchema
>;

/**
 * The identity an amendment moves. Hashing the whole working definition (not a
 * per-field digest) is what lets the audit row answer "is this still the
 * approved bytes?" against the stored candidate hash with one comparison.
 */
export function workingDefinitionHash(
  definition: WorkflowSemanticDefinition | ResolvedWorkflowSemanticDefinition,
): string {
  return `sha256:${createHash("sha256").update(stableStringify(definition)).digest("hex")}`;
}

/**
 * Whether the definition came from a delivery-plan attempt. The origin URI is
 * the same discriminator the materializer stamps and the locked regions cite,
 * so "amendable" and "locked" are decided from one fact rather than two.
 */
export function isDeliveryPlanDefinition(
  definition: WorkflowSemanticDefinition | ResolvedWorkflowSemanticDefinition,
): boolean {
  return (
    definition.origin?.sourceUri.startsWith(DELIVERY_PLAN_ORIGIN_SCHEME) ===
    true
  );
}

/**
 * The non-additive entries a caller tried to smuggle through. Reported before
 * anything is applied so the refusal can name every offending entry at once
 * rather than one per round-trip.
 */
export function nonAdditiveOperationTypes(
  operations: readonly unknown[],
): string[] {
  const offenders: string[] = [];
  for (const operation of operations) {
    if (typeof operation !== "object" || operation === null) continue;
    const type = (operation as { type?: unknown }).type;
    if (typeof type !== "string") continue;
    if (
      !(WORKFLOW_AMENDMENT_OPERATION_TYPES as readonly string[]).includes(type)
    ) {
      offenders.push(type);
    }
  }
  return [...new Set(offenders)];
}

/**
 * Translate the bounded operand into the live-edit operations the one shared
 * mutation core understands. There is deliberately no second reducer: the
 * amendment is a policy and audit wrapper around the same core, so the frontier
 * invariant, frozen-context rules, and locked-region check all still run.
 */
export function toLiveEditOperations(
  operations: readonly WorkflowAmendmentOperation[],
): WorkflowLiveEditOperation[] {
  return operations.map((operation) => {
    switch (operation.type) {
      case "add-context":
        return {
          type: "add-context",
          id: operation.id,
          title: operation.title,
          acceptanceCriteria: operation.acceptanceCriteria,
          ...(operation.description === undefined
            ? {}
            : { description: operation.description }),
        };
      case "add-task":
        return {
          type: "add-task",
          id: operation.id,
          contextId: operation.contextId,
          title: operation.title,
          instructions: operation.instructions,
          ...(operation.position === undefined
            ? {}
            : { position: operation.position }),
        };
      case "add-edge":
        return {
          type: "add-edge",
          id: operation.id,
          sourceContextId: operation.sourceContextId,
          targetContextId: operation.targetContextId,
        };
    }
  });
}

/** The ids an accepted amendment introduced, grouped for the audit row. */
export interface WorkflowAmendmentAdditions {
  readonly contextIds: string[];
  readonly taskIds: string[];
  readonly edgeIds: string[];
}

export function amendmentAdditions(
  operations: readonly WorkflowAmendmentOperation[],
): WorkflowAmendmentAdditions {
  return {
    contextIds: operations
      .filter((operation) => operation.type === "add-context")
      .map((operation) => operation.id),
    taskIds: operations
      .filter((operation) => operation.type === "add-task")
      .map((operation) => operation.id),
    edgeIds: operations
      .filter((operation) => operation.type === "add-edge")
      .map((operation) => operation.id),
  };
}

/** The launch-pinned authority that admitted the amendment. */
export type WorkflowAmendmentPolicyBasis =
  | "human_operator"
  | "pinned_allow_agent_task_add";

export type WorkflowAmendmentPolicyAdmission =
  | {
      readonly ok: true;
      readonly policyBasis: WorkflowAmendmentPolicyBasis;
      readonly addContextSeed?: ResolvedContextConfig;
    }
  | {
      readonly ok: false;
      readonly code: "mutability_policy_blocked" | "pinned_policy_unavailable";
      readonly error: string;
      readonly instruction: string;
    };

function resolvedContextConfig(
  context: GraphWorkflowResolvedContext,
): ResolvedContextConfig | null {
  if (
    context.collaboration === undefined ||
    context.agentValidation === undefined
  ) {
    return null;
  }
  return {
    implementer: context.implementer,
    contextValidator: context.contextValidator,
    scriptValidator: context.scriptValidator,
    scriptValidatorSource: context.scriptValidatorSource ?? "global",
    humanApprovalGate: context.humanApprovalGate,
    askUserQuestions: context.askUserQuestions,
    mutability: context.mutability,
    circuitBreaker: context.circuitBreaker,
    iterationPolicy: context.iterationPolicy,
    planRepair: context.planRepair,
    collaboration: context.collaboration,
    agentValidation: context.agentValidation,
  };
}

function pinnedContextSeed(
  execution: GraphWorkflowExecution,
): ResolvedContextConfig | null {
  const sourceUri = execution.workingDefinition.origin?.sourceUri;
  if (sourceUri === undefined) return null;

  const planContexts = execution.workingDefinition.executionContexts.filter(
    (context) => context.origin?.sourceUri === `${sourceUri}#${context.id}`,
  );
  const first = planContexts[0];
  if (first === undefined) return null;
  const seed = resolvedContextConfig(first);
  if (seed === null) return null;

  const serializedSeed = stableStringify(seed);
  const hasDivergentConfig = planContexts.slice(1).some((context) => {
    const config = resolvedContextConfig(context);
    return config === null || stableStringify(config) !== serializedSeed;
  });
  return hasDivergentConfig ? null : seed;
}

function blockedAgentAmendment(
  executionId: string,
  contextId?: string,
): WorkflowAmendmentPolicyAdmission {
  const target =
    contextId === undefined
      ? "the execution's pinned policy"
      : `context "${contextId}"`;
  return {
    ok: false,
    code: "mutability_policy_blocked",
    error: `${target} does not allow an agent to add this work. Nothing was applied.`,
    instruction: `Ask a human operator to amend execution "${executionId}" through Studio, or abandon execution "${executionId}" and seed a replacement delivery-plan attempt.`,
  };
}

/**
 * Admit the bounded amendment against the configuration snapshotted into this
 * execution at launch. The check runs inside the serialized live-edit mutation,
 * so neither a global-config change nor a concurrent edit can alter the policy
 * used for this decision.
 */
export function admitWorkflowExecutionAmendment(
  execution: GraphWorkflowExecution,
  operations: readonly WorkflowAmendmentOperation[],
  actor: WorkflowAmendmentActor,
): WorkflowAmendmentPolicyAdmission {
  const needsPinnedSeed =
    actor.kind === "agent" ||
    operations.some((operation) => operation.type === "add-context");
  const seed = needsPinnedSeed ? pinnedContextSeed(execution) : null;
  if (needsPinnedSeed && seed === null) {
    return {
      ok: false,
      code: "pinned_policy_unavailable",
      error: `Execution "${execution.id}" has no consistent pinned delivery-plan policy to admit this amendment. Nothing was applied.`,
      instruction: `Abandon execution "${execution.id}" and seed a replacement delivery-plan attempt before adding this work.`,
    };
  }

  if (actor.kind === "human") {
    return {
      ok: true,
      policyBasis: "human_operator",
      ...(seed === null ? {} : { addContextSeed: structuredClone(seed) }),
    };
  }

  if (seed?.mutability.allowAgentTaskAdd !== true) {
    return blockedAgentAmendment(execution.id);
  }

  const addedContextIds = new Set(
    operations
      .filter((operation) => operation.type === "add-context")
      .map((operation) => operation.id),
  );
  for (const operation of operations) {
    if (
      operation.type !== "add-task" ||
      addedContextIds.has(operation.contextId)
    ) {
      continue;
    }
    const target = execution.workingDefinition.executionContexts.find(
      (context) => context.id === operation.contextId,
    );
    if (target !== undefined && !target.mutability.allowAgentTaskAdd) {
      return blockedAgentAmendment(execution.id, operation.contextId);
    }
  }

  return {
    ok: true,
    policyBasis: "pinned_allow_agent_task_add",
    addContextSeed: structuredClone(seed),
  };
}
