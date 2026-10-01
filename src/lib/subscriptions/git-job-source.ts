import type { JobRecord } from "@/lib/jobs/schemas";
import type { SourceFact, SubscriptionRecipient } from "./schemas";

/** Both passive follows and finite waits describe the same durable job evidence. */
export function gitJobSourceFact(
  job: JobRecord,
  recipient: SubscriptionRecipient,
  occurrenceId: string,
): SourceFact {
  // SQLite datetime('now') is UTC even though it omits a zone marker.
  const timestamp = job.completedAt ?? job.startedAt;
  const occurredAt = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)
    ? `${timestamp.replace(" ", "T")}Z`
    : timestamp;
  const conversation = `'${recipient.conversationId.replaceAll("'", "'\\''")}'`;
  return {
    occurrenceId,
    eventKind: "git-job-outcome",
    category: "outcome",
    sourceTitle: `${job.jobType} ${job.sessionName}`,
    summary: `${job.jobType} ${job.status}${job.errorMessage ? `: ${job.errorMessage.slice(0, 700)}` : "."}`,
    occurredAt,
    revision: job.commitHash ?? job.mergeHash ?? job.preparedSha ?? null,
    outcome: job.status,
    // Jobs have no public cctl detail command. Save the result in the inbox;
    // briefing/wake rendering supplies its exact inbox-get handle once stored.
    retrievalHandle: `cctl inbox list --all --conversation=${conversation}`,
    sourceText: JSON.stringify(job),
    actorConversationId: null,
  };
}
