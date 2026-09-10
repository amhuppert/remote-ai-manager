import { z } from "zod";

const targetFields = { projectName: z.string().min(1), id: z.string().min(1) };
export const liveReferenceTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ticket"), ...targetFields }),
  z.object({ kind: z.literal("conversation"), ...targetFields }),
  z.object({
    kind: z.literal("execution"),
    ...targetFields,
    sessionName: z.string().min(1),
  }),
]);
export type LiveReferenceTarget = z.infer<typeof liveReferenceTargetSchema>;

export const liveReferenceSummarySchema = z.object({
  title: z.string(),
  identity: z.string(),
  status: z.string(),
  tone: z.enum(["neutral", "cyan", "amber", "green", "red"]),
  href: z.string(),
  readCommand: z.string(),
  details: z.array(z.object({ label: z.string(), value: z.string() })),
  attentionCount: z.number().int().nonnegative(),
});
export type LiveReferenceSummary = z.infer<typeof liveReferenceSummarySchema>;

export const liveReferenceResultSchema = z.object({
  target: liveReferenceTargetSchema,
  checkedAt: z.string(),
  summary: liveReferenceSummarySchema.nullable(),
  unavailableReason: z.enum(["missing", "error", "timeout"]).nullable(),
});
export type LiveReferenceResult = z.infer<typeof liveReferenceResultSchema>;
export const liveReferenceResponseSchema = z.object({
  results: z.array(liveReferenceResultSchema),
});
export const liveReferenceRequestSchema = z.object({
  targets: z.array(liveReferenceTargetSchema).min(1).max(100),
});

export function liveReferenceKey(target: LiveReferenceTarget): string {
  return JSON.stringify([
    target.kind,
    target.projectName,
    target.id,
    target.kind === "execution" ? target.sessionName : null,
  ]);
}
