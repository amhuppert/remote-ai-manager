import { z } from "zod";
import { registerTrustedSchema } from "@/lib/shared/parse-trusted";

export const mergeIntentSourceSchema = z.enum(["session-merge", "graph-join"]);
export type MergeIntentSource = z.infer<typeof mergeIntentSourceSchema>;

/**
 * An intent brief attached to a landed merge commit. Recorded when a smart
 * merge publishes, looked up later to explain the incoming side of a
 * conflicting merge to the resolver.
 */
export const mergeIntentSchema = registerTrustedSchema(
  z.object({
    projectPath: z.string(),
    commitSha: z.string(),
    intent: z.string(),
    source: mergeIntentSourceSchema,
    createdAt: z.string(),
  }),
  "mergeIntentSchema",
);
export type MergeIntent = z.infer<typeof mergeIntentSchema>;
