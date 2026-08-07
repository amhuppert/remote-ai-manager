import { z } from "zod";
import {
  cascadeWorkflowSemanticDefinitionSchema,
  workflowDefinitionRecordSchema,
} from "@/lib/workflow-graph/definition-schemas";

const workflowDefinitionSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const workflowDefinitionsResponseSchema = z.object({
  items: z.array(workflowDefinitionSummarySchema),
});

export const workflowDefinitionMutationResponseSchema = z.object({
  item: workflowDefinitionRecordSchema,
});

export const workflowDefinitionGetResponseSchema = z.object({
  item: workflowDefinitionRecordSchema,
  resolved: cascadeWorkflowSemanticDefinitionSchema,
});
