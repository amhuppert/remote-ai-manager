import type { SourceRef } from "@/lib/conversations/schemas";
import type { CompactionEnvelope } from "./schemas";

/**
 * Prose rendering of a compaction envelope for `cctl conversation compaction
 * get --format markdown`. Pure — the CLI (and any future consumer) feeds it a
 * parsed envelope plus the artifact row's freshness fields. Source refs keep
 * their seq coordinates so readers can jump straight to `--seq-range` windows;
 * ref quotes stay in the JSON envelope, which remains the lossless view.
 */

export interface CompactionRenderMeta {
  stale: boolean;
  staleBehindMessages: number;
  outdated: boolean;
  updatedAt?: string;
}

function refLabel(ref: SourceRef): string {
  const span =
    ref.seqStart === ref.seqEnd
      ? `s${ref.seqStart}`
      : `s${ref.seqStart}–${ref.seqEnd}`;
  return `#${ref.messageIndex} ${span}`;
}

function refsSuffix(refs: SourceRef[]): string {
  if (refs.length === 0) return "";
  return ` [refs: ${refs.map(refLabel).join(", ")}]`;
}

function freshnessLabel(meta: CompactionRenderMeta): string {
  if (meta.outdated) return "outdated";
  if (meta.stale) return `stale (behind ${meta.staleBehindMessages} messages)`;
  return "fresh";
}

function bulletSection(title: string, items: readonly string[]): string | null {
  if (items.length === 0) return null;
  return [`## ${title}`, ...items.map((item) => `- ${item}`)].join("\n");
}

export function compactionEnvelopeToMarkdown(
  envelope: CompactionEnvelope,
  meta: CompactionRenderMeta,
): string {
  const { source, currentState } = envelope;

  const identity = [
    source.projectName,
    ...(source.sessionName === null ? [] : [source.sessionName]),
    source.conversationId,
  ].join(" / ");
  const headerFacts = [
    freshnessLabel(meta),
    `covered seq ${source.coveredStartSeq}..${source.coveredEndSeq}`,
    `${source.messageCount} messages`,
    ...(meta.updatedAt === undefined ? [] : [`updated ${meta.updatedAt}`]),
  ].join(" · ");

  const stateLines = [
    `## Current state — ${currentState.status}`,
    `Goal: ${currentState.latestUserGoal}`,
  ];
  if (currentState.nextBestActions.length > 0) {
    stateLines.push(
      "",
      "Next best actions:",
      ...currentState.nextBestActions.map(
        (action, index) => `${index + 1}. ${action}`,
      ),
    );
  }

  const sections = [
    `# Compaction — ${identity}\n${headerFacts}`,
    `## Agent brief\n${envelope.agentBrief}`,
    stateLines.join("\n"),
    bulletSection(
      "Decisions",
      envelope.decisions.map((decision) => {
        const status =
          decision.status === "accepted" ? "" : ` (${decision.status})`;
        const rationale =
          decision.rationale === undefined ? "" : ` — ${decision.rationale}`;
        return `${decision.statement}${status}${rationale}${refsSuffix(decision.sourceRefs)}`;
      }),
    ),
    bulletSection(
      "Files",
      envelope.files.map((file) => {
        const details = file.details === undefined ? "" : ` — ${file.details}`;
        return `${file.role} \`${file.path}\`${details}${refsSuffix(file.sourceRefs)}`;
      }),
    ),
    bulletSection(
      "Commands",
      envelope.commands.map((command) => {
        const summary =
          command.summary === undefined ? "" : `: ${command.summary}`;
        return `\`${command.command}\` — ${command.outcome}${summary}${refsSuffix(command.sourceRefs)}`;
      }),
    ),
    bulletSection(
      "Open questions",
      envelope.openQuestions.map(
        (note) => `${note.text}${refsSuffix(note.sourceRefs)}`,
      ),
    ),
    bulletSection(
      "Blockers",
      envelope.blockers.map(
        (note) => `${note.text}${refsSuffix(note.sourceRefs)}`,
      ),
    ),
    `## Omissions\nreasoning omitted: ${envelope.omissions.reasoningOmitted ? "yes" : "no"} · large tool outputs elided: ${envelope.omissions.largeToolOutputsElided}`,
    Object.keys(envelope.extras).length === 0
      ? null
      : `## Extras\n\`\`\`json\n${JSON.stringify(envelope.extras, null, 2)}\n\`\`\``,
  ];

  return `${sections.filter((section) => section !== null).join("\n\n")}\n`;
}
