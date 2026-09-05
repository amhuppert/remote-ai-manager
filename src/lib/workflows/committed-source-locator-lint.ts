import { isWorkflowDocumentPath } from "@/lib/workflow-graph/seeded-documents";
import { commitContainsPath, getHeadCommit } from "@/lib/git/commits";
import { createLogger } from "@/lib/logging";
import type { SessionState } from "@/lib/sessions/schemas";
import { containsPlaceholderOpener } from "@/lib/workflow-graph/parameter-validation";
import {
  isLexicallyResolvableSourceLocator,
  LINT_MESSAGE_PREFIX,
  type PlanLintDefinition,
  type PlanLintWarning,
} from "./plan-lints";

const logger = createLogger("workflow-source-locator");

export type CommittedSourceResolutionSession = Pick<
  SessionState,
  "sessionName" | "branchName" | "worktreePath"
>;

export interface CommittedSourceLocatorLintDeps {
  getHeadCommit(worktreePath: string): Promise<string | null>;
  commitContainsPath(
    worktreePath: string,
    sha: string,
    repoRelativePath: string,
  ): Promise<boolean>;
}

const defaultDeps: CommittedSourceLocatorLintDeps = {
  getHeadCommit,
  commitContainsPath,
};

export async function lintCommittedSourceLocators(
  definition: Pick<PlanLintDefinition, "charter">,
  session: CommittedSourceResolutionSession,
  deps: CommittedSourceLocatorLintDeps = defaultDeps,
): Promise<PlanLintWarning[]> {
  const concreteSources = definition.charter.sourcesOfTruth.flatMap(
    (source, index) =>
      isWorkflowDocumentPath(source.locator) ||
      containsPlaceholderOpener(source.locator) ||
      !isLexicallyResolvableSourceLocator(source.locator)
        ? []
        : [{ source, index }],
  );
  if (concreteSources.length === 0) return [];

  let sha: string | null;
  try {
    sha = await deps.getHeadCommit(session.worktreePath);
  } catch (error) {
    logger.warn("workflow.source-locator.head-unresolved", {
      sessionName: session.sessionName,
      branch: session.branchName,
      worktreePath: session.worktreePath,
      reason: "git_failure",
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  if (sha === null) {
    logger.warn("workflow.source-locator.head-unresolved", {
      sessionName: session.sessionName,
      branch: session.branchName,
      worktreePath: session.worktreePath,
      reason: "head_absent",
    });
    return [];
  }

  const warnings: PlanLintWarning[] = [];
  for (const { source, index } of concreteSources) {
    let present: boolean;
    try {
      present = await deps.commitContainsPath(
        session.worktreePath,
        sha,
        source.locator,
      );
    } catch (error) {
      logger.warn("workflow.source-locator.commit-probe-failed", {
        sessionName: session.sessionName,
        branch: session.branchName,
        worktreePath: session.worktreePath,
        sha,
        sourceId: source.id,
        locator: source.locator,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (present) continue;
    warnings.push({
      path: `definition.charter.sourcesOfTruth.${index}.locator`,
      message:
        `${LINT_MESSAGE_PREFIX}source-locator-unresolvable: charter source "${source.id}" ` +
        `locator "${source.locator}" is absent from the committed tree checked ` +
        `for session "${session.sessionName}" on branch "${session.branchName}" ` +
        `at commit ${sha}; commit the source path before launch, or an agent ` +
        `asked to consult it reports it absent every round`,
    });
  }
  return warnings;
}
