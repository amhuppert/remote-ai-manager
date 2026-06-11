import { z } from "zod";

export const parsedConversationCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("commit"), hint: z.string() }),
  z.object({ command: z.literal("merge"), hint: z.string() }),
]);

export type ParsedConversationCommand = z.infer<
  typeof parsedConversationCommandSchema
>;

export const commitMessageOutputSchema = z.object({
  message: z.string(),
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
