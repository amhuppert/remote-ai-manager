import { z } from "zod";
import { registerTrustedSchema } from "@/lib/shared/parse-trusted";
import { mcpOverridesSchema } from "@/lib/mcp/schemas";
import { agentCapabilityOverridesSchema } from "@/lib/agent-capabilities/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";
export {
  commandCenterProjectResponseSchema,
  discoveredProjectSchema,
  projectPreferencesResponseSchema,
  type CommandCenterProjectResponse,
  type DiscoveredProject,
} from "./query-schemas";

export const projectStateSchema = z.object({
  rootPath: z.string(),
  sessions: z.record(z.string(), sessionStateSchema),
  mcpOverrides: mcpOverridesSchema.optional(),
  agentCapabilityOverrides: agentCapabilityOverridesSchema.optional(),
});
export type ProjectState = z.infer<typeof projectStateSchema>;

export const projectRowSchema = registerTrustedSchema(
  z.object({
    rootPath: z.string(),
    archived: z.boolean(),
    pinned: z.boolean(),
    pinOrder: z.number().int().nullable(),
    mcpOverrides: mcpOverridesSchema.optional(),
    agentCapabilityOverrides: agentCapabilityOverridesSchema.optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  "projectRowSchema",
);
export type ProjectRow = z.infer<typeof projectRowSchema>;

export const managerStateSchema = z.object({
  projects: z.record(z.string(), projectStateSchema),
  archivedProjects: z.array(z.string()).default([]),
  pinnedProjects: z.array(z.string()).default([]),
});
export type ManagerState = z.infer<typeof managerStateSchema>;
