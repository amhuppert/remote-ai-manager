/**
 * The delimited answer block delivered as the next user message after a
 * `cctl ask` (docs/design/cc-cli/03 §3). Self-contained by design: the queue
 * drain coalesces consecutive text rows into one turn input, so the block must
 * survive being embedded anywhere inside a larger text — never assume it is
 * the whole message.
 */

import { z } from "zod";
import { askQuestionAnswerSchema, type AskQuestionAnswer } from "./schemas";

export const QUESTION_ANSWERS_TAG = "cc-question-answers";

const answersRecordSchema = z.record(z.string(), askQuestionAnswerSchema);

export interface QuestionAnswersBlock {
  questionBatchId: string;
  answers: Record<string, AskQuestionAnswer>;
}

/** Render the id-keyed answers as the delimited block. */
export function formatQuestionAnswersBlock(
  questionBatchId: string,
  answers: Record<string, AskQuestionAnswer>,
): string {
  return [
    `<${QUESTION_ANSWERS_TAG} batch="${questionBatchId}">`,
    JSON.stringify(answers),
    `</${QUESTION_ANSWERS_TAG}>`,
  ].join("\n");
}

const BLOCK_PATTERN = new RegExp(
  `<${QUESTION_ANSWERS_TAG} batch="([^"]+)">\\s*([\\s\\S]*?)\\s*</${QUESTION_ANSWERS_TAG}>`,
);

export interface SplitQuestionAnswersBlock {
  /** Prose preceding the block (trimmed), "" when the block leads. */
  before: string;
  block: QuestionAnswersBlock;
  /** Prose following the block (trimmed), "" when the block ends the text. */
  after: string;
}

/**
 * Locate the first answer block embedded in `text` and separate it from any
 * surrounding prose, or null when none is present or its payload does not
 * validate. Tolerant of surrounding prose — coalesced turns carry the block
 * alongside other queued messages. The display layer renders `before`/`after`
 * as ordinary message text and the block as an answer card.
 */
export function splitQuestionAnswersBlock(
  text: string,
): SplitQuestionAnswersBlock | null {
  const match = BLOCK_PATTERN.exec(text);
  if (!match) return null;
  const [full, questionBatchId, payload] = match;
  if (!questionBatchId || payload === undefined) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = answersRecordSchema.safeParse(raw);
  if (!parsed.success) return null;

  const start = match.index;
  return {
    before: text.slice(0, start).trim(),
    block: { questionBatchId, answers: parsed.data },
    after: text.slice(start + full.length).trim(),
  };
}

/**
 * Extract the first answer block embedded in `text`, or null when none is
 * present or its payload does not validate.
 */
export function parseQuestionAnswersBlock(
  text: string,
): QuestionAnswersBlock | null {
  return splitQuestionAnswersBlock(text)?.block ?? null;
}
