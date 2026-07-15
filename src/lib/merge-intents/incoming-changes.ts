/**
 * Describes the incoming side of a merge to the conflict resolver: the commits
 * reachable from the target branch but not from the conflicted worktree's
 * HEAD, each annotated with its recorded merge intent when one exists.
 *
 * Best-effort by design — a failure here degrades the resolver's context, it
 * must never fail the merge, so every error path returns null.
 */

import { createLogger } from "@/lib/logging";
import { truncate } from "@/lib/shared/truncate";
import { defaultGitClient, type GitClient } from "@/lib/git/client";
import { createMergeIntentsRepo } from "./repo";
import { getStateDb } from "../state-store/store";
import type { MergeIntent } from "./schemas";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("merge-intents.incoming-changes");

/** Bound on the commit walk; older incoming commits rarely explain a conflict. */
const MAX_INCOMING_COMMITS = 30;
/** Per-commit intent cap; briefs beyond this are cut. */
const MAX_INTENT_CHARS = 1_200;
/** Whole-section cap; keeps the resolver prompt bounded. */
const MAX_SECTION_CHARS = 6_000;
/** Appended when an intent or the whole section is cut. */
const INCOMING_CHANGES_TRUNCATION_MARKER = "\n…[truncated]";

/** `git log` field separator: the ASCII unit separator cannot appear in a
 *  commit subject line, unlike any printable delimiter. */
const FIELD_SEPARATOR = "\x1f";

export interface IncomingChangesParams {
  projectPath: string;
  worktreePath: string;
  targetBranch: string;
}

export interface IncomingChangesDeps {
  gitClient?: GitClient;
  getMergeIntents?(projectPath: string, commitShas: string[]): MergeIntent[];
}

export async function buildIncomingChangesSection(
  params: IncomingChangesParams,
  deps: IncomingChangesDeps = {},
): Promise<string | null> {
  const gitClient = deps.gitClient ?? defaultGitClient;
  const getMergeIntents =
    deps.getMergeIntents ??
    ((projectPath: string, commitShas: string[]) =>
      createMergeIntentsRepo(getStateDb()).getMergeIntents(
        projectPath,
        commitShas,
      ));
  const { projectPath, worktreePath, targetBranch } = params;

  try {
    const { stdout } = await gitClient.git(
      [
        "log",
        `--format=%H${FIELD_SEPARATOR}%s`,
        "-n",
        String(MAX_INCOMING_COMMITS),
        `HEAD..${targetBranch}`,
      ],
      worktreePath,
    );

    const commits = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const separatorIndex = line.indexOf(FIELD_SEPARATOR);
        if (separatorIndex === -1) return [];
        return [
          {
            sha: line.slice(0, separatorIndex),
            subject: line.slice(separatorIndex + 1),
          },
        ];
      });

    if (commits.length === 0) return null;

    const intentsBySha = new Map(
      getMergeIntents(
        projectPath,
        commits.map((c) => c.sha),
      ).map((intent) => [intent.commitSha, intent.intent]),
    );

    const lines: string[] = [
      `Incoming commits from \`${targetBranch}\` (the other side of the conflicts). Recorded intent notes are included where available:`,
    ];
    for (const commit of commits) {
      lines.push(`- ${commit.sha.slice(0, 7)} ${commit.subject}`);
      const intent = intentsBySha.get(commit.sha);
      if (intent) {
        lines.push(
          `  Intent: ${truncate(intent, MAX_INTENT_CHARS, {
            ellipsis: INCOMING_CHANGES_TRUNCATION_MARKER,
          })}`,
        );
      }
    }

    const section = truncate(lines.join("\n"), MAX_SECTION_CHARS, {
      ellipsis: INCOMING_CHANGES_TRUNCATION_MARKER,
    });
    logger.info("incoming-changes.built", {
      worktreePath,
      targetBranch,
      commitCount: commits.length,
      intentCount: intentsBySha.size,
      sectionLength: section.length,
    });
    return section;
  } catch (err) {
    logger.warn("incoming-changes.failed", {
      worktreePath,
      targetBranch,
      error: getErrorMessage(err),
    });
    return null;
  }
}
