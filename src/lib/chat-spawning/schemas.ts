import { z } from "zod";
import { effortLevelSchema } from "@/lib/agent-backends/schemas";

/**
 * Agent selection for a proposed session. `dual` is the Claude+Codex race
 * (seeded as a first-turn concern by the dispatcher, not at creation time).
 */
export const spawnAgentSchema = z.enum(["claude", "codex", "dual"]);
export type SpawnAgent = z.infer<typeof spawnAgentSchema>;

/**
 * Creation mode for a proposed session. Deliberately duplicates the session
 * domain's `sessionCreationModeSchema` literals as a local enum so the wire
 * shape does not depend on the discriminated `createSessionRequestSchema`. A
 * sync-guard unit test (schemas.test.ts) asserts these members exactly match
 * `sessionCreationModeSchema.options`, failing CI if either enum drifts.
 */
export const spawnModeSchema = z.enum(["normal", "optimistic"]);
export type SpawnMode = z.infer<typeof spawnModeSchema>;

/**
 * One proposed session inside a spawn proposal. The agent proposes only the
 * `name`; Command Center derives the branch from it server-side (same slug +
 * prefix + uniqueness suffix as the New Session dialog), so a proposal never
 * carries a branch. `target` defaults to `"main"` (the merge target) when the
 * agent omits it; `initialPrompt` is the optional first user turn, dropped when
 * empty after trim.
 */
export const proposedSessionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  target: z.string().trim().min(1).max(200).default("main"),
  agent: spawnAgentSchema,
  mode: spawnModeSchema,
  initialPrompt: z.string().trim().min(1).optional(),
  // User-set in the spawn card (never agent-proposed). Apply to a single-backend
  // agent only — the `dual` race omits both and runs each participant at its
  // backend default. They drive the spawned session's first turn.
  model: z.string().trim().min(1).max(100).optional(),
  reasoningEffort: effortLevelSchema.optional(),
});
export type ProposedSession = z.infer<typeof proposedSessionSchema>;

/**
 * The machine-validated wire shape an agent turn emits and Command Center
 * validates before offering Create. At least one proposed session; capped at 20
 * so a malformed/runaway proposal cannot request an unbounded batch.
 */
export const spawnProposalSchema = z.object({
  sessions: z.array(proposedSessionSchema).min(1).max(20),
});
export type SpawnProposal = z.infer<typeof spawnProposalSchema>;

/**
 * The outcome Command Center returns after acting on a (possibly edited)
 * proposal: which proposed sessions were created (with whether their initial
 * prompt was queued for background dispatch — the turn itself runs after the
 * response) and which failed. Produced by Command Center — never authored by
 * the agent.
 */
export const spawnResultSchema = z.object({
  created: z.array(
    z.object({
      name: z.string(),
      sessionName: z.string(),
      branchName: z.string(),
      initialPromptQueued: z.boolean(),
    }),
  ),
  failed: z.array(
    z.object({
      name: z.string(),
      error: z.string(),
    }),
  ),
});
export type SpawnResult = z.infer<typeof spawnResultSchema>;

/**
 * SSE event carrying a batch spawn outcome, scoped to the spawning project
 * conversation so the cockpit can update the card without a refetch. Spawned
 * session *status* updates are NOT this event — they ride the existing
 * session-status / conversation events.
 */
export const spawnResultEventSchema = z.object({
  type: z.literal("spawn-result"),
  scope: z.literal("project"),
  projectName: z.string(),
  conversationId: z.string(),
  result: spawnResultSchema,
});
export type SpawnResultEvent = z.infer<typeof spawnResultEventSchema>;
