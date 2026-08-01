import path from "node:path";

import { getConfigDirPath } from "@/lib/config/loader";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { getGlobalValue, setGlobalValue } from "@/lib/shared/global-singleton";

import { publishManagedSkillBundle } from "./publisher";
import type { ManagedSkillBundle } from "./schemas";

const logger = createLogger("managed-skills");
const PUBLISHED_BUNDLE_KEY = "__cc_published_managed_skill_bundle";

/**
 * Process-local record of the bundle this server published at startup.
 * Delivery paths (Claude plugin attachment, Codex skills bridge) read it
 * synchronously; `null` means "no managed skills this process" and every
 * consumer degrades to attaching nothing. Next.js evaluates instrumentation
 * and route handlers in separate module graphs, so the record lives on
 * globalThis rather than in module-local state.
 */
export function getPublishedManagedSkillBundle(): ManagedSkillBundle | null {
  return (
    getGlobalValue<ManagedSkillBundle | null>(PUBLISHED_BUNDLE_KEY) ?? null
  );
}

export function setPublishedManagedSkillBundle(
  bundle: ManagedSkillBundle | null,
): void {
  setGlobalValue(PUBLISHED_BUNDLE_KEY, bundle);
}

/**
 * Startup step: publish this server's own plugin source (same
 * server-owns-the-asset invariant as the cctl install) and record the result
 * for delivery paths. Non-fatal by design — a failed publish leaves sessions
 * without managed skills, never without a server.
 */
export async function publishManagedSkillBundleAtStartup(): Promise<ManagedSkillBundle | null> {
  try {
    const result = await publishManagedSkillBundle({
      sourceDir: path.join(
        process.cwd(),
        "plugins",
        "command-center",
        "command-center",
      ),
      configDir: getConfigDirPath(),
    });
    if (!result.published) {
      setPublishedManagedSkillBundle(null);
      return null;
    }
    setPublishedManagedSkillBundle(result.bundle);
    return result.bundle;
  } catch (err) {
    logger.error("managed_skills.startup_publish_failed", {
      error: getErrorMessage(err),
    });
    setPublishedManagedSkillBundle(null);
    return null;
  }
}
