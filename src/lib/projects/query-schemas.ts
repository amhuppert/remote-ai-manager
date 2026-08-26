import { z } from "zod";

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
