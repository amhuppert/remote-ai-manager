import { createHash } from "node:crypto";
import { z } from "zod";
import {
  checkpointHandoffCandidateSchema,
  type CheckpointHandoffCandidate,
} from "./schemas";
import { CHECKPOINT_CAPTURE_LIMITS, utf8ByteLength } from "./budget";
import { validateStructuredOutput } from "@/lib/agent-backends/structured-output";
import { appendStructuredOutputInstruction } from "@/lib/agent-backends/structured-output-prompt";
import { redactEnvelopeStrings } from "@/lib/context-artifacts/redaction";
import {
  groupTranscriptEntries,
  isRecordedEvidenceReference,
} from "@/lib/conversations/transcript-render";

const HANDOFF_SCHEMA = z.toJSONSchema(checkpointHandoffCandidateSchema, {
  io: "input",
  reused: "ref",
});
const HANDOFF_INSTRUCTIONS = [
  "Record a concise advisory handoff for continuation of the user's existing task using only context already available.",
  "This request is capture only: no tool calls, investigation, implementation, delegation, user questions or workflow actions.",
  "Record plan, hypotheses, failed approaches, blockers and next step in the supplied schema. Empty arrays explicitly mean not established.",
  "Distinguish beliefs/proposals from reported observations. Observations require original CC source references; cite coordinates only when already known, never invent them or look them up.",
  "Describe the task's next action without executing it. The capture-only restrictions apply to this request; do not copy them into continuing-task constraints or imply that the next step is unauthorized because capture is read-only.",
  "Do not claim current approval, validation or completion. Each claim text is at most 2000 UTF-8 bytes; the complete final answer, including any fences and whitespace, is at most 6144 UTF-8 bytes.",
].join("\n");
import type { TranscriptEntryWithSeq } from "@/lib/prompt/transcript";

export type HandoffPromptResult =
  | {
      ok: true;
      promptText: string;
      outputSchema: Record<string, unknown>;
      inputBytes: number;
    }
  | { ok: false; reason: "input_limit" };
export type HandoffValidationResult =
  | {
      ok: true;
      candidate: CheckpointHandoffCandidate;
      canonicalJson: string;
      contentHash: string;
      outputBytes: number;
    }
  | { ok: false; reason: "invalid_output" | "output_limit" };
/** Final serialized prompt; shared schema appending is idempotent for adapters. */
export function buildHandoffPrompt(captureId: string): HandoffPromptResult {
  const promptText = appendStructuredOutputInstruction(
    `${HANDOFF_INSTRUCTIONS}\nCapture correlation: ${JSON.stringify(captureId)}`,
    HANDOFF_SCHEMA,
  );
  const inputBytes = utf8ByteLength(promptText);
  if (inputBytes > CHECKPOINT_CAPTURE_LIMITS.inputBytes)
    return { ok: false, reason: "input_limit" };
  return { ok: true, promptText, outputSchema: HANDOFF_SCHEMA, inputBytes };
}

/** One final answer, zero repair turns. Provider reasoning is not answer text. */
export function validateHandoffCandidate(input: {
  answerText: string;
  entries: TranscriptEntryWithSeq[];
}): HandoffValidationResult {
  const outputBytes = utf8ByteLength(input.answerText);
  if (outputBytes > CHECKPOINT_CAPTURE_LIMITS.outputBytes)
    return { ok: false, reason: "output_limit" };
  const parsed = validateStructuredOutput(checkpointHandoffCandidateSchema, {
    text: input.answerText,
  });
  if (!parsed.ok) return { ok: false, reason: "invalid_output" };
  const units = groupTranscriptEntries(input.entries);
  for (const claims of Object.values(parsed.value)) {
    for (const claim of claims) {
      if (
        !claim.sourceRefs.every((ref) =>
          isRecordedEvidenceReference(ref, units),
        )
      )
        return { ok: false, reason: "invalid_output" };
    }
  }
  const redacted = checkpointHandoffCandidateSchema.safeParse(
    redactEnvelopeStrings(parsed.value),
  );
  if (!redacted.success) return { ok: false, reason: "invalid_output" };
  // Zod's declared property order and original array order form the canonical JSON.
  const canonicalJson = JSON.stringify(redacted.data);
  return {
    ok: true,
    candidate: redacted.data,
    canonicalJson,
    contentHash: createHash("sha256")
      .update(canonicalJson, "utf8")
      .digest("hex"),
    outputBytes,
  };
}
