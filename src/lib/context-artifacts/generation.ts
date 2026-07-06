/**
 * Compaction prompt builder (docs/design/conversation-compaction/README.md
 * §7.3), mirroring `conversation-commands/generation.ts`: pure, no I/O. The
 * prompt is laid out for provider prompt caching — stable instructions and
 * the JSON schema first, dynamic per-run material (source metadata, previous
 * envelope, rendered transcript) last.
 */

import { z } from "zod";
import {
  renderedTranscriptToMarkdown,
  type RenderedTranscript,
} from "@/lib/conversations/transcript-render";
import {
  compactionEnvelopeSchema,
  type ArtifactKind,
  type CompactionEnvelope,
} from "./schemas";

/**
 * Stamped into `context_artifacts.prompt_version`; consumers compare it to
 * detect artifacts produced by an older prompt contract. Bump on any change
 * to the instruction text or prompt layout.
 */
export const PROMPT_VERSION = "1";

/**
 * `outputFormat.schema` payload for the structured-output task run, derived
 * from {@link compactionEnvelopeSchema} so the two can never drift. Output-io
 * derivation makes defaulted fields required, so the model always emits the
 * full envelope shape.
 */
export const COMPACTION_JSON_SCHEMA: Record<string, unknown> = z.toJSONSchema(
  compactionEnvelopeSchema,
);

/** Values the model must copy verbatim into the envelope's `source` block. */
export interface CompactionSourceMeta {
  projectName: string;
  sessionName: string | null;
  conversationId: string;
  coveredStartSeq: number;
  coveredEndSeq: number;
  messageCount: number;
  sourceHash: string;
}

interface CompactionPromptBase {
  kind: ArtifactKind;
  sourceMeta: CompactionSourceMeta;
}

export type BuildCompactionPromptInput =
  | (CompactionPromptBase & {
      mode: "full";
      renderedTranscript: RenderedTranscript;
    })
  | (CompactionPromptBase & {
      mode: "delta";
      previousEnvelope: CompactionEnvelope;
      deltaRenderedTranscript: RenderedTranscript;
    });

const STABLE_INSTRUCTIONS = [
  "You are producing a structured compaction of a coding-agent conversation transcript for Command Center.",
  "Respond with a single JSON object conforming to the compaction envelope schema below.",
  "",
  "Rules:",
  "- Extract only what the rendered transcript supports. Never invent file paths, command outcomes, decisions, or state; if something is unknown, omit it.",
  "- Every item in decisions, files, commands, openQuestions, and blockers MUST cite sourceRefs. Copy messageIndex and seq coordinates from the rendered unit headers (`#<messageIndex> [seq A–B] <role>`) and the per-line `[s<seq>]` prefixes. Use the narrowest span that supports the item; when filling `quote`, quote the transcript verbatim.",
  "- agentBrief is a dense handoff for another coding agent picking up this work: terse and complete, not a polished article.",
  "- currentState reflects where the work stands right now: status, the latest user goal, and the next best actions.",
  "- Copy the `kind` and `source` values verbatim from the source metadata section; set schemaVersion to 1.",
];

const DELTA_INSTRUCTIONS = [
  "",
  "Delta update rules — you are updating an existing envelope with transcript lines that arrived after its covered range:",
  '- Merge, do not rebuild: append new items and update existing ones; never silently drop a previous decision — if the new lines reverse one, keep it with status "superseded".',
  "- Refresh agentBrief and currentState so they describe the whole conversation including the new lines.",
  "- Extend coverage: the source metadata below already carries the new covered range; copy it verbatim.",
];

export function buildCompactionPrompt(
  input: BuildCompactionPromptInput,
): string {
  const lines = [...STABLE_INSTRUCTIONS];
  if (input.mode === "delta") {
    lines.push(...DELTA_INSTRUCTIONS);
  }

  lines.push(
    "",
    "## Output JSON schema",
    "```json",
    JSON.stringify(COMPACTION_JSON_SCHEMA),
    "```",
    "",
    "## Source metadata (copy `kind` and `source` verbatim)",
    "```json",
    JSON.stringify({ kind: input.kind, source: input.sourceMeta }),
    "```",
  );

  if (input.mode === "full") {
    lines.push(
      "",
      "## Rendered transcript",
      renderedTranscriptToMarkdown(input.renderedTranscript),
    );
    return lines.join("\n");
  }

  lines.push(
    "",
    "## Previous compaction envelope",
    "```json",
    JSON.stringify(input.previousEnvelope),
    "```",
    "",
    `## New transcript lines (after seq ${input.previousEnvelope.source.coveredEndSeq})`,
    renderedTranscriptToMarkdown(input.deltaRenderedTranscript),
  );
  return lines.join("\n");
}
