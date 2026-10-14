import { gitJobSourceFact } from "./git-job-source";
import { isTerminalValidationRunStatus } from "@/lib/validation/schemas";
import { projectNameFromPath } from "@/lib/state-store/tickets-repo";
import type { SubscriptionSourceDeps } from "./source-adapters";
import type { SubscriptionRecipient } from "./schemas";
import type {
  ActiveWaitSource,
  TerminalSourceRead,
} from "./active-wait-schemas";

type TerminalSourceDeps = Pick<
  SubscriptionSourceDeps,
  "validations" | "jobs" | "queries"
> & {
  now?(): string;
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** Explicit waits inspect the durable verdict, independently of passive event cursors. */
export function createTerminalSourceReader(deps: TerminalSourceDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  return async function readTerminalSource(
    recipient: SubscriptionRecipient,
    source: ActiveWaitSource,
  ): Promise<TerminalSourceRead> {
    const occurrenceId = `one-time-terminal:${source.kind}:${source.id}`;
    if (source.kind === "validation") {
      const run = deps.validations.findById(source.id);
      if (!run || run.projectPath !== recipient.projectPath)
        return { kind: "missing" };
      if (!isTerminalValidationRunStatus(run.status))
        return { kind: "pending", status: run.status };
      return {
        kind: "terminal",
        fact: {
          occurrenceId,
          eventKind: "validation-completed",
          category: "outcome",
          sourceTitle: `${run.commandName} validation`,
          summary: `${run.commandName} ${run.status}${run.exitCode === null ? "" : ` (exit ${run.exitCode})`}.`,
          occurredAt: run.finishedAt ?? now(),
          revision: null,
          outcome: run.status,
          retrievalHandle: `cctl validate status -- ${quote(run.runId)}`,
          actorConversationId: run.conversationId,
        },
      };
    }
    if (source.kind === "git_job") {
      const job = deps.jobs.getJobRecord(source.id);
      if (
        !job ||
        job.projectName !== projectNameFromPath(recipient.projectPath)
      )
        return { kind: "missing" };
      if (job.status === "running")
        return { kind: "pending", status: job.status };
      return {
        kind: "terminal",
        fact: gitJobSourceFact(job, recipient, occurrenceId),
      };
    }
    return { kind: "missing" };
  };
}
