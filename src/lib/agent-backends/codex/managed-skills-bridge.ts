/**
 * Codex delivery of the Command Center managed skill bundle (v1 bridge).
 *
 * Codex 0.144.x has no exec-transport mechanism to add a skill root
 * (`skills.config[].path` only toggles already-discovered skills; the
 * app-server `skills/extraRoots/set` RPC is unreachable from `codex exec`),
 * so the adapter materializes ONE namespaced symlink in the launch checkout:
 *
 *   <checkout>/.agents/skills/command-center -> <published-bundle>/skills
 *
 * Codex discovers the skills through its project-layer `.agents/skills`
 * walk and renders them as `command-center:*` — the same names the Claude
 * local-plugin attachment produces. The link is reconciled before every
 * normal launch (covers resumed sessions, lane worktrees, task cwds, and
 * project-scoped conversations in the main checkout — mutation Alex has
 * explicitly authorized) and hidden behind an exact-path `info/exclude`
 * entry so it can never reach `git status` or an auto-commit. Exclusion is
 * a hard precondition: if it cannot be established, no link is created.
 * New session checkouts are reconciled during provisioning; launch-time
 * reconciliation remains the self-healing path for every other checkout.
 *
 * Delete this module when the Codex backend gains native runtime skill-root
 * injection; see the managed-skills design in memory-bank/collaboration.
 */

import { lstat, mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";

import { ensureExcludePattern } from "@/lib/git/worktree";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { getPublishedManagedSkillBundle } from "@/lib/managed-skills/service";
import type { ManagedSkillBundle } from "@/lib/managed-skills/schemas";

const logger = createLogger("codex:managed-skills-bridge");

/**
 * Reserved checkout-relative path — the bridge's single collision point.
 *
 * Must stay a plain literal. Turbopack statically evaluates an all-literal
 * `path.join(...)` into a DirAssetReference and then walks that directory at
 * build time — which for this path means walking the symlink below, out of the
 * project root, which Turbopack rejects with a fatal panic. Because this module
 * is reachable from the instrumentation entrypoint, that panic breaks
 * `bun run build` in every checkout the bridge has ever linked.
 */
export const MANAGED_SKILLS_LINK_RELATIVE = ".agents/skills/command-center";

/** Anchored exact-path exclude rule (never a broad glob). */
export const MANAGED_SKILLS_EXCLUDE_PATTERN = "/.agents/skills/command-center";

export type CodexManagedSkillsBridgeResult =
  | { status: "linked"; linkPath: string }
  | { status: "already_linked"; linkPath: string }
  /** Project-owned content occupies the reserved path — a user-visible
   * degraded-capability condition, never an overwrite. */
  | { status: "conflict"; linkPath: string; detail: string }
  | {
      status: "skipped";
      reason: "no_bundle" | "exclude_unavailable";
      detail?: string;
    };

export interface EnsureCodexManagedSkillsBridgeInput {
  checkoutPath: string;
  /** The startup-published bundle; callers pass the process singleton. */
  bundle: ManagedSkillBundle | null;
}

export async function ensureCodexManagedSkillsBridge(
  input: EnsureCodexManagedSkillsBridgeInput,
): Promise<CodexManagedSkillsBridgeResult> {
  const { checkoutPath, bundle } = input;
  if (!bundle) {
    return { status: "skipped", reason: "no_bundle" };
  }

  // Exclusion FIRST: a link that could show up in `git status` (or get swept
  // by an auto-commit `git add -A`) must never exist, so a checkout where the
  // rule cannot be established gets no link at all.
  try {
    await ensureExcludePattern(checkoutPath, MANAGED_SKILLS_EXCLUDE_PATTERN);
  } catch (err) {
    const detail = getErrorMessage(err);
    logger.warn("codex_managed_skills.exclude_unavailable", {
      checkoutPath,
      detail,
    });
    return { status: "skipped", reason: "exclude_unavailable", detail };
  }

  const linkPath = path.join(
    /* turbopackIgnore: true */ checkoutPath,
    MANAGED_SKILLS_LINK_RELATIVE,
  );
  // CC-owned targets all live under the bundles area for this plugin; a link
  // pointing anywhere else was not created by a CC server and is never touched.
  const ccOwnedTargetPrefix = path.dirname(bundle.root) + path.sep;

  let existing: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    existing = await lstat(/* turbopackIgnore: true */ linkPath);
  } catch {
    existing = null;
  }

  if (existing) {
    if (!existing.isSymbolicLink()) {
      const detail =
        "project-owned content occupies the reserved managed-skills path";
      logger.warn("codex_managed_skills.conflict", {
        checkoutPath,
        linkPath,
        detail,
      });
      return { status: "conflict", linkPath, detail };
    }
    const currentTarget = await readlink(/* turbopackIgnore: true */ linkPath);
    if (currentTarget === bundle.skillsRoot) {
      return { status: "already_linked", linkPath };
    }
    if (!isCcOwnedTarget(currentTarget, ccOwnedTargetPrefix)) {
      const detail = `foreign symlink at the reserved managed-skills path (target: ${currentTarget})`;
      logger.warn("codex_managed_skills.conflict", {
        checkoutPath,
        linkPath,
        detail,
      });
      return { status: "conflict", linkPath, detail };
    }
    // Stale CC-owned link (older digest / older server): fall through and
    // atomically re-point it.
  }

  await mkdir(/* turbopackIgnore: true */ path.dirname(linkPath), {
    recursive: true,
  });
  const tempLink = path.join(
    /* turbopackIgnore: true */ path.dirname(linkPath),
    `.command-center.tmp-${process.pid}`,
  );
  try {
    await rm(/* turbopackIgnore: true */ tempLink, { force: true });
    await symlink(
      /* turbopackIgnore: true */ bundle.skillsRoot,
      /* turbopackIgnore: true */ tempLink,
    );
    // rename() atomically replaces an existing symlink, so a concurrently
    // launching agent always resolves either the old or the new bundle —
    // both immutable — never a missing path.
    await rename(
      /* turbopackIgnore: true */ tempLink,
      /* turbopackIgnore: true */ linkPath,
    );
  } catch (err) {
    await rm(/* turbopackIgnore: true */ tempLink, { force: true });
    throw err;
  }

  logger.info("codex_managed_skills.linked", {
    checkoutPath,
    linkPath,
    digest: bundle.digest,
    skillCount: bundle.skillNames.length,
  });
  return { status: "linked", linkPath };
}

function isCcOwnedTarget(target: string, ccOwnedPrefix: string): boolean {
  return target.startsWith(ccOwnedPrefix);
}

/**
 * Launch-path entrypoint for the Codex conversation runtime and task runner:
 * reconcile against the startup-published bundle and never throw — a bridge
 * failure degrades the launch to skill-less, it does not block the turn.
 */
export async function ensureCodexManagedSkillsBridgeForLaunch(
  checkoutPath: string,
): Promise<CodexManagedSkillsBridgeResult> {
  try {
    return await ensureCodexManagedSkillsBridge({
      checkoutPath,
      bundle: getPublishedManagedSkillBundle(),
    });
  } catch (err) {
    const detail = getErrorMessage(err);
    logger.error("codex_managed_skills.bridge_failed", {
      checkoutPath,
      detail,
    });
    return { status: "skipped", reason: "exclude_unavailable", detail };
  }
}

/** Checkout-provisioning adapter for the backend registry's neutral hook. */
export async function prepareCodexManagedSkillsCheckout(
  checkoutPath: string,
): Promise<void> {
  await ensureCodexManagedSkillsBridgeForLaunch(checkoutPath);
}
