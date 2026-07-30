import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";

import type { ManagedSkillBundle } from "./schemas";

const logger = createLogger("managed-skills");

export interface PublishManagedSkillBundleInput {
  /** Plugin source root: contains `.claude-plugin/plugin.json` and `skills/`. */
  sourceDir: string;
  configDir: string;
}

export type PublishManagedSkillBundleResult =
  | { published: true; bundle: ManagedSkillBundle; alreadyPublished: boolean }
  | { published: false; reason: "source_missing" | "invalid_bundle" };

const BUNDLE_ID = "command-center";
const DIGEST_LENGTH = 16;

/**
 * Validate the plugin source and publish it as an immutable content-addressed
 * copy under `<configDir>/agent-bundles/command-center/<digest>/`.
 *
 * Atomic (temp copy + rename) so a concurrently launching agent never sees a
 * torn bundle, and idempotent: identical content re-resolves the existing
 * directory, edited content publishes a NEW digest and leaves prior digests
 * untouched — worktree links created by older server instances keep resolving.
 */
export async function publishManagedSkillBundle(
  input: PublishManagedSkillBundleInput,
): Promise<PublishManagedSkillBundleResult> {
  const { sourceDir, configDir } = input;

  if (!existsSync(sourceDir)) {
    logger.error("managed_skills.publish_skipped", {
      sourceDir,
      reason: "source_missing",
    });
    return { published: false, reason: "source_missing" };
  }

  let version: string;
  let skillNames: string[];
  try {
    version = await readPluginVersion(sourceDir);
    skillNames = await readSkillInventory(sourceDir);
  } catch (err) {
    logger.error("managed_skills.publish_skipped", {
      sourceDir,
      reason: "invalid_bundle",
      error: getErrorMessage(err),
    });
    return { published: false, reason: "invalid_bundle" };
  }

  const digest = (await digestDirectory(sourceDir)).slice(0, DIGEST_LENGTH);
  const bundlesDir = path.join(configDir, "agent-bundles", BUNDLE_ID);
  const root = path.join(bundlesDir, digest);

  const bundle: ManagedSkillBundle = {
    id: BUNDLE_ID,
    version,
    digest,
    root,
    skillsRoot: path.join(root, "skills"),
    skillNames,
  };

  if (existsSync(root)) {
    return { published: true, bundle, alreadyPublished: true };
  }

  const tempRoot = path.join(bundlesDir, `.tmp-${process.pid}-${digest}`);
  await mkdir(bundlesDir, { recursive: true });
  try {
    await rm(tempRoot, { recursive: true, force: true });
    await cp(sourceDir, tempRoot, { recursive: true });
    await rename(tempRoot, root);
  } catch (err) {
    await rm(tempRoot, { recursive: true, force: true });
    // A concurrent publisher of the same digest may win the rename; the
    // content is identical by construction, so that still counts as published.
    if (existsSync(root)) {
      return { published: true, bundle, alreadyPublished: true };
    }
    throw err;
  }

  logger.info("managed_skills.published", {
    digest,
    version,
    root,
    skillCount: skillNames.length,
  });
  return { published: true, bundle, alreadyPublished: false };
}

async function readPluginVersion(sourceDir: string): Promise<string> {
  const manifestPath = path.join(sourceDir, ".claude-plugin", "plugin.json");
  const raw = await readFile(manifestPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`plugin.json is not an object: ${manifestPath}`);
  }
  const record = parsed as Record<string, unknown>;
  if (record["name"] !== BUNDLE_ID) {
    throw new Error(`plugin.json name is not "${BUNDLE_ID}": ${manifestPath}`);
  }
  const version = record["version"];
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`plugin.json has no version: ${manifestPath}`);
  }
  return version;
}

async function readSkillInventory(sourceDir: string): Promise<string[]> {
  const skillsDir = path.join(sourceDir, "skills");
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    throw new Error(`skills directory missing: ${skillsDir}`);
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) {
      throw new Error(`skill directory without SKILL.md: ${entry.name}`);
    }
    names.push(entry.name);
  }
  if (names.length === 0) {
    throw new Error(`no skills found under: ${skillsDir}`);
  }
  return names.sort();
}

/** sha256 over every file's repo-relative path and bytes, in sorted order. */
async function digestDirectory(sourceDir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  };
  await walk(sourceDir);
  files.sort();

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(sourceDir, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}
