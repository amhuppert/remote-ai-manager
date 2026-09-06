import { z } from "zod";
import { backendAdmissionRefusalSchema } from "@/lib/agent-backends/execution-admission";

export const builtInCommandNameSchema = z.enum([
  "/spec",
  "/align",
  "/ticket",
  "/collab",
  "/commit",
  "/merge",
  "/rebase",
]);
export type BuiltInCommandName = z.infer<typeof builtInCommandNameSchema>;
export const commandAvailabilitySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available") }),
  z.object({
    status: z.literal("unavailable"),
    refusal: backendAdmissionRefusalSchema,
  }),
  z.object({
    status: z.literal("degraded"),
    stages: z
      .array(
        z.object({
          stage: z.enum([
            "message-generation",
            "validation-repair",
            "conflict-assistance",
          ]),
          refusal: backendAdmissionRefusalSchema,
        }),
      )
      .max(3),
  }),
]);
export type CommandAvailability = z.infer<typeof commandAvailabilitySchema>;

export const commandTypeSchema = z.enum(["command", "skill"]);

export const commandItemSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().optional(),
  type: commandTypeSchema,
  source: z.string(),
  availability: commandAvailabilitySchema.optional(),
});
export type CommandItem = z.infer<typeof commandItemSchema>;

export const commandsResponseSchema = z.object({
  items: z.array(commandItemSchema),
});
export type CommandsResponse = z.infer<typeof commandsResponseSchema>;
