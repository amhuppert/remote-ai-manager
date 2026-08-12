import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defaultGitClient, type GitClient } from "@/lib/git/client";
import type { IgnoredWorktreeContents } from "@/lib/git/worktree";
import { createLogger, type Logger } from "@/lib/logging";
import { atomicWriteJson } from "@/lib/shared/atomic-write-json";
import { getErrorMessage } from "@/lib/shared/errors";

const MANIFEST_FILE_NAME = "command-center-ignored-baseline.json";

const laneIgnoredBaselineManifestSchema = z.object({
  version: z.literal(1),
  roots: z.array(z.string().min(1)),
  entries: z.array(
    z.object({
      path: z.string().min(1),
      fingerprint: z.string().min(1),
    }),
  ),
});

export interface LaneIgnoredBaselineStore {
  write(worktreePath: string, contents: IgnoredWorktreeContents): Promise<void>;
  read(worktreePath: string): Promise<IgnoredWorktreeContents | null>;
}

export interface LaneIgnoredBaselineStoreDeps {
  gitClient?: GitClient;
  readFile?(target: string): Promise<string>;
  writeJson?(target: string, value: unknown): Promise<void>;
  logger?: Logger;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function createLaneIgnoredBaselineStore(
  deps: LaneIgnoredBaselineStoreDeps = {},
): LaneIgnoredBaselineStore {
  const gitClient = deps.gitClient ?? defaultGitClient;
  const readManifestFile =
    deps.readFile ?? ((target: string) => readFile(target, "utf-8"));
  const writeJson = deps.writeJson ?? atomicWriteJson;
  const logger =
    deps.logger ?? createLogger("graph-workflow-lane-ignored-baseline");

  async function manifestPath(worktreePath: string): Promise<string> {
    const { stdout } = await gitClient.git(
      ["rev-parse", "--absolute-git-dir"],
      worktreePath,
    );
    const gitDir = stdout.trim();
    if (!path.isAbsolute(gitDir)) {
      throw new Error("Git did not return an absolute worktree metadata path");
    }
    return path.join(gitDir, MANIFEST_FILE_NAME);
  }

  return {
    async write(worktreePath, contents) {
      const target = await manifestPath(worktreePath);
      await writeJson(target, {
        version: 1,
        roots: [...contents.roots],
        entries: contents.entries.map((entry) => ({ ...entry })),
      });
      logger.info("ignored_baseline.write", {
        worktreePath,
        rootCount: contents.roots.length,
        entryCount: contents.entries.length,
      });
    },

    async read(worktreePath) {
      let target: string;
      try {
        target = await manifestPath(worktreePath);
      } catch (error) {
        logger.warn("ignored_baseline.path_unavailable", {
          worktreePath,
          error: getErrorMessage(error),
        });
        return null;
      }

      try {
        const parsed = laneIgnoredBaselineManifestSchema.safeParse(
          JSON.parse(await readManifestFile(target)),
        );
        if (!parsed.success) {
          logger.warn("ignored_baseline.invalid", {
            worktreePath,
            manifestPath: target,
            issueCount: parsed.error.issues.length,
          });
          return null;
        }
        logger.debug("ignored_baseline.read", {
          worktreePath,
          rootCount: parsed.data.roots.length,
          entryCount: parsed.data.entries.length,
        });
        return {
          roots: parsed.data.roots,
          entries: parsed.data.entries,
        };
      } catch (error) {
        logger.warn(
          isMissingFile(error)
            ? "ignored_baseline.missing"
            : "ignored_baseline.read_failed",
          {
            worktreePath,
            manifestPath: target,
            error: getErrorMessage(error),
          },
        );
        return null;
      }
    },
  };
}
