import { z } from "zod";

export const commandTypeSchema = z.enum(["command", "skill"]);

export const commandItemSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().optional(),
  type: commandTypeSchema,
  source: z.string(),
});
export type CommandItem = z.infer<typeof commandItemSchema>;

export const commandsResponseSchema = z.object({
  items: z.array(commandItemSchema),
});
export type CommandsResponse = z.infer<typeof commandsResponseSchema>;
