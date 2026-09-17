import { z } from "zod";

const copyContextConversationSchema = z.object({
  id: z.string(),
  agentBackend: z.string(),
  backendRef: z.unknown().nullable(),
  status: z.enum(["new", "awaiting", "running", "waiting_for_input"]),
  promptCount: z.number(),
  lastActivityAt: z.string(),
  transcriptPath: z.string().nullable(),
  totalCostUsd: z.number().nullable(),
  totalDurationMs: z.number().nullable(),
  totalTurns: z.number().nullable(),
  source: z.string(),
  role: z.string().nullable().optional(),
  contextTokens: z.number().nullable().optional(),
  contextWindowMax: z.number().nullable().optional(),
});

export const copyContextSessionSchema = z.object({
  branchName: z.string(),
  worktreePath: z.string(),
  createdAt: z.string(),
  finished: z.boolean(),
  conversations: z.array(copyContextConversationSchema),
  source: z.enum(["cc", "imported"]),
  creationMode: z.enum(["normal", "optimistic"]),
  workflowEnvelopes: z.record(z.string(), z.unknown()).optional(),
});
export type CopyContextSession = z.infer<typeof copyContextSessionSchema>;

const copyContextDefinitionSchema = z.object({
  executionContexts: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
    }),
  ),
  tasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
    }),
  ),
});

export const copyContextGraphWorkflowExecutionSchema = z.object({
  id: z.string(),
  status: z.string(),
  seedDefinitionId: z.string().nullable(),
  seedDefinitionRevision: z.number().nullable(),
  activeContextIds: z.array(z.string()),
  contextStates: z.record(
    z.string(),
    z.object({
      status: z.string(),
      iterationCount: z.number(),
      completedTaskCount: z.number(),
      totalTaskCount: z.number(),
    }),
  ),
  taskStates: z.record(
    z.string(),
    z.object({
      taskId: z.string(),
      lastConversationId: z.string().nullable(),
    }),
  ),
  workingDefinition: copyContextDefinitionSchema,
  haltReason: z.object({ type: z.string() }).passthrough().nullable(),
});
export type CopyContextGraphWorkflowExecution = z.infer<
  typeof copyContextGraphWorkflowExecutionSchema
>;

export const copyContextGraphWorkflowExecutionResponseSchema = z.object({
  execution: copyContextGraphWorkflowExecutionSchema.nullable(),
});
