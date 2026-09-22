import { z } from "zod";

/** Session-level derived status (waiting_for_input > running > awaiting > new > idle) */
export const derivedSessionStatusSchema = z.enum([
  "waiting_for_input",
  "running",
  "awaiting",
  "new",
  "idle",
]);
export type DerivedSessionStatus = z.infer<typeof derivedSessionStatusSchema>;

export const sessionSourceSchema = z.enum(["cc", "imported"]);

export const sessionCreationModeSchema = z.enum(["normal", "optimistic"]);
export type SessionCreationMode = z.infer<typeof sessionCreationModeSchema>;

/**
 * Origin tag identifying a session created from a project conversation's spawn
 * card, with a back-reference to the spawning conversation.
 */
export const spawnedFromSchema = z.object({
  source: z.literal("chat"),
  projectName: z.string(),
  conversationId: z.string(),
});
export type SpawnedFrom = z.infer<typeof spawnedFromSchema>;

// Slim per-row shape for the sessions-list accessor. Defined explicitly so
// heavy fields added to session state cannot silently leak into this payload.
export const sessionListItemSchema = z.object({
  sessionName: z.string(),
  worktreePath: z.string(),
  branchName: z.string(),
  targetBranch: z.string(),
  parentSessionName: z.string().nullable(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  archived: z.boolean(),
  finished: z.boolean(),
  source: sessionSourceSchema,
  creationMode: sessionCreationModeSchema,
  tddEnabled: z.boolean(),
  derivedStatus: derivedSessionStatusSchema,
  promptCount: z.number().int().nonnegative(),
  derivedLastActivityAt: z.string(),
  collabContribution: z.enum(["running", "paused"]).nullable(),
  hasActiveGraphWorkflow: z.boolean(),
  spawnedFrom: spawnedFromSchema.nullable().optional(),
});
export type SessionListItem = z.infer<typeof sessionListItemSchema>;

export const sessionsResponseSchema = z.object({
  sessions: z.array(sessionListItemSchema),
});

/** The git branch prefix Command Center applies when creating a session. */
export const branchPrefixResponseSchema = z.object({
  branchPrefix: z.string(),
});
