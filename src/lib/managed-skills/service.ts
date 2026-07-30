import path from "node:path";

import { getConfigDirPath } from "@/lib/config/loader";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";

import { publishManagedSkillBundle } from "./publisher";
import type { ManagedSkillBundle } from "./schemas";

const logger = createLogger("managed-skills");

/**
 * Process-local record of the bundle this server published at startup.
 * Launch paths (Claude plugin attachment, Codex skills bridge) read it
 * synchronously; `null` means "no managed skills this process" and every
 * consumer degrades to attaching nothing. Mirrors the server-url pattern:
 * startup writes once, launches read.
 */
let publishedBundle: ManagedSkillBundle | null = null;

export function getPublishedManagedSkillBundle(): ManagedSkillBundle | null {
  return publishedBundle;
}

export function setPublishedManagedSkillBundle(
  bundle: ManagedSkillBundle | null,
): void {
  publishedBundle = bundle;
}

/**
 * Startup step: publish this server's own plugin source (same
 * server-owns-the-asset invariant as the cctl install) and record the result
 * for launch paths. Non-fatal by design — a failed publish leaves sessions
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
      publishedBundle = null;
      return null;
    }
    publishedBundle = result.bundle;
    return result.bundle;
  } catch (err) {
    logger.error("managed_skills.startup_publish_failed", {
      error: getErrorMessage(err),
    });
    publishedBundle = null;
    return null;
  }
}
