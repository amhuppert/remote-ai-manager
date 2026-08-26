import { z } from "zod";
import { backendModelSelectionSchema } from "@/lib/agent-backends/schemas";
import { imagePayloadSchema } from "@/lib/images/schemas";
import { agentBackendSchema } from "@/lib/shared/schemas";

/**
 * Agent selection for a proposed session: any registered backend, or `dual` —
 * the Claude+Codex race (seeded as a first-turn concern by the dispatcher, not
 * at creation time). Derived from the canonical backend enum rather than
 * restated, so registering a backend cannot leave a spawn surface silently
 * unable to name it.
 */
export const spawnAgentSchema = z.enum([
  ...agentBackendSchema.options,
  "dual",
] as const);
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
export const proposedSessionSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    target: z.string().trim().min(1).max(200).default("main"),
    agent: spawnAgentSchema,
    mode: spawnModeSchema,
    initialPrompt: z.string().trim().min(1).optional(),
    images: z.array(imagePayloadSchema).max(5).optional(),
    // User-set in the spawn card (never agent-proposed). Apply to a single-backend
    // agent only; the `dual` race runs each participant at its backend default.
    modelSelection: backendModelSelectionSchema.optional(),
    model: z
      .never({ error: "Use the complete modelSelection instead of model." })
      .optional(),
    reasoningEffort: z
      .never({
        error: "Put reasoning effort in modelSelection.parameters.",
      })
      .optional(),
  })
  .strict();
export type ProposedSession = z.infer<typeof proposedSessionSchema>;

/**
 * The machine-validated wire shape an agent turn emits and Command Center
 * validates before offering Create. At least one proposed session; capped at 20
 * so a malformed/runaway proposal cannot request an unbounded batch.
 */
export const spawnProposalSchema = z
  .object({
    sessions: z.array(proposedSessionSchema).min(1).max(20),
  })
  .strict();
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
