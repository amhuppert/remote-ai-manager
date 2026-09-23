import { z } from "zod";
import { jsonValueSchema } from "./shared";
import {
  graphWorkflowExecutionActReceiptSchema,
  graphWorkflowExecutionOriginSchema,
  graphWorkflowLaunchReceiptSchema,
  graphWorkflowUpstreamInputSchema,
} from "@/lib/workflow-graph/schemas";
import { graphWorkflowBoundaryKindSchema } from "@/lib/workflow-graph/event-schemas";
import { graphWorkflowStatusSchema } from "@/lib/workflow-graph/definition-schemas";
import { managedDefinitionPreflightSuccessSchema } from "@/lib/workflow-graph/managed-definition-preflight";
import { planReviewAdvisorySchema } from "@/lib/workflows/plan-review/status-schemas";
const TEMPLATE_TIERS = ["global", "project"] as const;
export const managedReceiptSchema = z.object({ specSlug: z.string() });
export const proposeGateSchema = z.object({
  blockingBefore: z.number().int().nonnegative(),
  blockingAfter: z.number().int().nonnegative(),
});
export const definitionItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  revision: z.number(),
  management: managedReceiptSchema.optional(),
});
export const planWarningSchema = z.object({
  path: z.string(),
  message: z.string(),
  recordId: z.string().optional(),
});
export const cliGraphWorkflowLaunchReceiptSchema =
  graphWorkflowLaunchReceiptSchema.extend({
    warnings: z.array(planWarningSchema).optional(),
  });
export const mutationResponseSchema = z.object({
  item: definitionItemSchema,
  reviewStatus: planReviewAdvisorySchema.optional(),
  warnings: z.array(planWarningSchema).optional(),
  proposeGate: proposeGateSchema.optional(),
});
export const validateResponseSchema = z.object({
  warnings: z.array(planWarningSchema).optional(),
  preflight: managedDefinitionPreflightSuccessSchema
    .omit({ ok: true })
    .optional(),
});
export const editResponseSchema = z.object({
  item: definitionItemSchema,
  applied: z.number(),
  dryRun: z.boolean().optional(),
  proposeGate: proposeGateSchema.optional(),
});
export const definitionSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  revision: z.number(),
});
export const listResponseSchema = z.object({
  items: z.array(definitionSummarySchema),
});
export const templateItemSchema = z.object({
  tier: z.enum(TEMPLATE_TIERS),
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});
export const templatesResponseSchema = z.object({
  items: z.array(templateItemSchema),
});
export const startResponseSchema = z.object({
  execution: z.object({ executionId: z.string(), status: z.string() }),
  receipt: z
    .object({
      status: z.string(),
      warnings: z.array(planWarningSchema).optional(),
    })
    .optional(),
});
export const contextStateSchema = z.object({
  contextId: z.string(),
  status: z.string(),
  totalTaskCount: z.number(),
  completedTaskCount: z.number(),
  batchId: z.string().nullable().optional(),
  laneId: z.string().nullable().optional(),
});
export const executionSchema = z.object({
  id: z.string(),
  status: z.string(),
  activeContextIds: z.array(z.string()).default([]),
  haltReason: jsonValueSchema.nullish(),
  planRepairRounds: z.array(jsonValueSchema).default([]),
  workingDefinition: z.object({
    executionContexts: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        placement: z.object({ lane: z.string() }).optional(),
      }),
    ),
  }),
  contextStates: z.record(z.string(), contextStateSchema),
  executionLanes: z
    .record(
      z.string(),
      z.object({
        laneId: z.string(),
        kind: z.enum(["session", "worktree"]),
        status: z.string(),
        includedContextIds: z.array(z.string()).default([]),
      }),
    )
    .default({}),
});
export const statusResponseSchema = z.object({
  execution: executionSchema.nullable(),
});
export const abandonResponseSchema = z.object({
  execution: graphWorkflowExecutionActReceiptSchema,
  abandoned: z.literal(true),
});
export const workflowBoundaryCursorSchema = z.union([
  z.string().trim().min(1),
  z.number().int().positive(),
]);
export const workflowBoundaryResultSchema = z.object({
  cursor: workflowBoundaryCursorSchema,
  occurredAt: z.string(),
  executionId: z.string().trim().min(1),
  boundaryKind: graphWorkflowBoundaryKindSchema,
  status: graphWorkflowStatusSchema,
  contextId: z.string().nullable(),
  pendingActions: z.array(z.record(z.string(), jsonValueSchema)),
  outputs: jsonValueSchema,
  name: z.string(),
  origin: graphWorkflowExecutionOriginSchema,
  originConversationId: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  haltReason: jsonValueSchema.nullable(),
  abandonment: jsonValueSchema.nullable(),
  documents: z.array(jsonValueSchema),
  deepLink: z.string(),
});
export const workflowBoundaryResponseSchema = z.object({
  result: workflowBoundaryResultSchema.nullable(),
});
export const completeResponseSchema = z.object({
  ok: z.literal(true),
  remainingTaskCount: z.number(),
  reminders: z.array(z.string()).optional(),
});
export const collabResponseSchema = z.object({
  ok: z.literal(true),
  status: z.string(),
  workflowId: z.string().optional(),
});
export const sharedDocFileSchema = z.object({
  description: z.string(),
  readWhen: z.string(),
});
export const amendResponseSchema = z.object({
  amended: z.number(),
  liveRevision: z.number(),
  policyBasis: z.string(),
  addedContextIds: z.array(z.string()).default([]),
  addedTaskIds: z.array(z.string()).default([]),
  addedEdgeIds: z.array(z.string()).default([]),
  previousWorkingDefinitionHash: z.string(),
  workingDefinitionHash: z.string().nullable(),
});
export const liveEditResponseSchema = z.object({
  applied: z.number(),
  liveRevision: z.number(),
  affectedContextIds: z.array(z.string()).default([]),
  dryRun: z.boolean().optional(),
});
export const expandResponseSchema = z.object({
  replayed: z.boolean().default(false),
  liveRevision: z.number(),
  createdContextIds: z.array(z.string()).default([]),
  createdTaskIds: z.array(z.string()).default([]),
  rejoinContextIds: z.array(z.string()).default([]),
});
export const inputsResponseSchema = z.object({
  ok: z.literal(true),
  inputs: z.array(
    graphWorkflowUpstreamInputSchema.extend({
      output: z.record(z.string(), jsonValueSchema).nullable(),
    }),
  ),
});
