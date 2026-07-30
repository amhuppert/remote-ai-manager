import { z } from "zod";

/**
 * The Command Center managed skill bundle: the CC-owned plugin (skills +
 * plugin manifest) published as an immutable, content-addressed asset under
 * `<config-dir>/agent-bundles/command-center/<digest>/`. Backend adapters
 * attach the published copy to every normal launch — Claude as an SDK local
 * plugin, Codex through the worktree skills bridge — so the paths here must
 * always point INTO a published bundle, never at the server checkout.
 */
export const managedSkillBundleSchema = z.object({
  id: z.literal("command-center"),
  /** Human-facing plugin version from `.claude-plugin/plugin.json`. */
  version: z.string().min(1),
  /**
   * Content digest (16 hex chars) over every file in the source plugin.
   * Digest — not version — keys the published directory: a dev instance can
   * edit a skill without bumping the manifest while another instance runs
   * the same nominal version.
   */
  digest: z.string().regex(/^[0-9a-f]{16}$/),
  /** Published plugin root (contains `.claude-plugin/` and `skills/`). */
  root: z.string().min(1),
  /** `<root>/skills` — the directory the Codex bridge links to. */
  skillsRoot: z.string().min(1),
  skillNames: z.array(z.string().min(1)).readonly(),
});

export type ManagedSkillBundle = z.infer<typeof managedSkillBundleSchema>;
