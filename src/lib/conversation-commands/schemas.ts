import { z } from "zod";

export const parsedConversationCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("commit"), hint: z.string() }),
  z.object({
    command: z.literal("merge"),
    hint: z.string(),
    skipMarkMerged: z.boolean().optional(),
  }),
  z.object({ command: z.literal("rebase"), hint: z.string() }),
  z.object({ command: z.literal("align"), hint: z.string() }),
  z.object({ command: z.literal("ticket"), hint: z.string() }),
]);

export type ParsedConversationCommand = z.infer<
  typeof parsedConversationCommandSchema
>;

export const commitMessageOutputSchema = z.object({
  message: z.string(),
  /** Merge only: intent notes handed to a later conflict-resolution agent. */
  resolutionContext: z.string().optional(),
});

export type CommitMessageOutput = z.infer<typeof commitMessageOutputSchema>;

/** `outputFormat.schema` payload mirroring {@link commitMessageOutputSchema}. */
export const COMMIT_MESSAGE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    message: { type: "string" },
  },
  required: ["message"],
  additionalProperties: false,
};

/** Merge message schema includes conflict-resolution intent for later jobs. */
export const MERGE_MESSAGE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    message: { type: "string" },
    resolutionContext: { type: "string" },
  },
  required: ["message", "resolutionContext"],
  additionalProperties: false,
};
