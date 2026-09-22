import { z } from "zod";

import { sessionDiffSchema } from "@/lib/git/schemas";

/**
 * The change set the human approval surface renders for an ENVELOPED context:
 * exactly the paths that context owns, at the identity its gate froze (R15.2).
 *
 * `treeHash` travels with the patch for the same reason it travels with a
 * validation round's: it is the identity the bytes were read under, so a reader
 * can say what the diff is a diff OF. It is only ever the frozen one — a read
 * that disagrees is reported as drift instead, never rendered.
 */
export const graphWorkflowApprovalSnapshotSchema = z
  .object({
    contextId: z.string().trim().min(1),
    ownedPaths: z.array(z.string().trim().min(1)),
    treeHash: z.string().trim().min(1),
    diff: sessionDiffSchema,
  })
  .strict();

/**
 * What the approval API answers with for one parked context.
 *
 * Both scope grades carry the frozen candidate's baseline-relative patch.
 * `drifted` carries no patch: bytes that no longer match the gate's frozen
 * identity cannot be rendered as that gate's evidence.
 *
 * Lives here rather than beside the server-side resolver because the client
 * parses it, and the resolver reaches git.
 */
export const graphWorkflowApprovalSnapshotResponseSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("scoped"),
      snapshot: graphWorkflowApprovalSnapshotSchema,
    }),
    z.object({
      kind: z.literal("whole_tree"),
      contextId: z.string(),
      snapshot: z
        .object({ treeHash: z.string(), diff: sessionDiffSchema })
        .strict(),
    }),
    z.object({
      kind: z.literal("drifted"),
      contextId: z.string(),
      frozenTreeHash: z.string(),
      observedTreeHash: z.string(),
    }),
    z.object({ kind: z.literal("unavailable"), reason: z.string() }),
  ],
);
export type GraphWorkflowApprovalSnapshotResponse = z.infer<
  typeof graphWorkflowApprovalSnapshotResponseSchema
>;
