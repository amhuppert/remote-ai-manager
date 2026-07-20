import { z } from "zod";
import { registerTrustedSchema } from "@/lib/shared/parse-trusted";
import { mcpOverridesSchema } from "@/lib/mcp/schemas";
import { agentCapabilityOverridesSchema } from "@/lib/agent-capabilities/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";

/** Discovered project info returned by the discovery API */
export interface DiscoveredProject {
  /** Repository name (directory name) */
  name: string;
  /** Absolute path to the repository root */
  path: string;
  /** Number of active (non-archived) sessions */
  activeSessions: number;
  /** Whether any session is currently running */
  hasRunningSession: boolean;
  /** True when the project exists in state but the directory is no longer present on disk */
  missing?: boolean;
}

export const discoveredProjectSchema = z.object({
  name: z.string(),
  path: z.string(),
  activeSessions: z.number(),
  hasRunningSession: z.boolean(),
});

export const commandCenterProjectResponseSchema = z.object({
  projectName: z.string().min(1).nullable(),
});
export type CommandCenterProjectResponse = z.infer<
  typeof commandCenterProjectResponseSchema
>;

export const projectPreferencesResponseSchema = z.object({
  archived: z.array(z.string()),
  pinned: z.array(z.string()),
});

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
