import { z } from "zod";
import {
  cascadeWorkflowSemanticDefinitionSchema,
  workflowDefinitionRecordSchema,
} from "@/lib/workflow-graph/definition-schemas";
import {
  nativeSddWorkflowManagementCompactSchema,
  nativeSddWorkflowManagementDetailSchema,
} from "@/lib/workflow-graph/managed-definition";

const workflowDefinitionSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  management: nativeSddWorkflowManagementCompactSchema.optional(),
});

const managedWorkflowDefinitionRecordSchema =
  workflowDefinitionRecordSchema.and(
    z.object({
      management: nativeSddWorkflowManagementDetailSchema.optional(),
    }),
  );

export const workflowDefinitionsResponseSchema = z.object({
  items: z.array(workflowDefinitionSummarySchema),
});

export const workflowDefinitionMutationResponseSchema = z.object({
  item: managedWorkflowDefinitionRecordSchema,
});

export const workflowDefinitionGetResponseSchema = z.object({
  item: managedWorkflowDefinitionRecordSchema,
  resolved: cascadeWorkflowSemanticDefinitionSchema,
});

export type WorkflowDefinitionGetResponse = z.infer<
  typeof workflowDefinitionGetResponseSchema
>;
