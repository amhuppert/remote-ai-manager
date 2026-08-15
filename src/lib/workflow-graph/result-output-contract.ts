import { z } from "zod";

/**
 * Exact UTF-8 ceiling for one value in a boundary result. Values at the ceiling
 * stay inline; only values above it become durable-output references.
 */
export const GRAPH_WORKFLOW_RESULT_OUTPUT_MAX_BYTES = 64 * 1024;

export const graphWorkflowResultOutputReferenceSchema = z
  .object({
    kind: z.literal("output_reference"),
    executionId: z.string().trim().min(1),
    contextId: z.string().trim().min(1),
    outputName: z.string().trim().min(1),
    deepLink: z.string().trim().min(1),
    command: z.string().trim().min(1),
  })
  .strict();
export type GraphWorkflowResultOutputReference = z.infer<
  typeof graphWorkflowResultOutputReferenceSchema
>;

export const graphWorkflowResultOutputProjectionSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("declared_outputs"),
        byContext: z.record(z.string(), z.record(z.string(), z.unknown())),
      })
      .strict(),
    z.object({ kind: z.literal("no_declared_structured_result") }).strict(),
  ],
);
export type GraphWorkflowResultOutputProjection = z.infer<
  typeof graphWorkflowResultOutputProjectionSchema
>;
