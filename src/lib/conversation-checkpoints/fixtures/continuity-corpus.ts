/**
 * The continuity corpus: original conversation fixtures plus the facts a
 * reader must still be able to state after the conversation has been
 * checkpointed.
 *
 * The expectations here are authored FROM the dialogue, never from a
 * checkpoint, an envelope or a working state. That direction is the whole
 * point of the corpus — a probe that graded a checkpoint against a summary
 * derived from the same checkpoint would prove only that the generator agrees
 * with itself. `continuity-corpus.test.ts` mechanically enforces the
 * direction: every literal an answer must contain, and every superseded
 * literal it must not, has to appear verbatim in the fixture dialogue.
 */

import type { MessageContentBlock } from "@/lib/conversations/schemas";
import type { TranscriptEntry } from "@/lib/prompt/transcript";

export type ContinuityExpectationKind =
  | "constraint"
  | "identifier"
  | "rejected_approach"
  | "superseded_decision"
  | "blocker"
  | "next_action";

/** The traits a case contributes to the assembled dialogue. */
export type ContinuityCaseTrait =
  | "tool_heavy"
  | "oversized"
  | "image_dependent";

export interface ContinuityExpectation {
  id: string;
  kind: ContinuityExpectationKind;
  /** Asked as an ordinary turn of the continued conversation. */
  question: string;
  /** Literals a correct answer contains (matched case-insensitively). */
  mustInclude: readonly string[];
  /**
   * Literals that mark a wrong answer — the superseded value, the rejected
   * destination, the number that was corrected. Each one is also present in
   * the dialogue, so a model that reaches for it is recalling the source
   * incorrectly rather than being caught by an invented distractor.
   */
  mustNotInclude: readonly string[];
  /** Case-relative entry indexes that establish the fact. */
  sourceEntryIndexes: readonly number[];
  /**
   * Where the fact is written down.
   *
   * `dialogue` is the default: the answer appears verbatim in the recorded
   * text. `image` marks a fact that is printed ONLY in an attached image's
   * pixels — the dialogue deliberately refers to it without stating it, so the
   * expectation cannot be satisfied from any text the checkpoint carries and
   * is graded only when the original bytes are recovered.
   */
  evidence?: "dialogue" | "image";
  /**
   * The checkpoint cycle after which this is asked. A `3` marks a fact that
   * has to survive three separate compactions of the same conversation.
   */
  askAfterCycle: 1 | 2 | 3;
}

export interface ContinuityCase {
  id: string;
  title: string;
  traits: readonly ContinuityCaseTrait[];
  entries: readonly TranscriptEntry[];
  expectations: readonly ContinuityExpectation[];
}

export interface AssembledExpectation extends ContinuityExpectation {
  caseId: string;
  /** Absolute raw sequence numbers in the assembled transcript. */
  sourceSeqs: readonly number[];
}

export interface AssembledContinuityTranscript {
  /** JSONL lines in order; the array index is the entry's raw sequence. */
  lines: readonly TranscriptEntry[];
  expectations: readonly AssembledExpectation[];
}

export interface ContinuityGrade {
  satisfied: boolean;
  missing: readonly string[];
  forbidden: readonly string[];
}

/**
 * A real 1×1 PNG. Small on purpose: the probe hashes these bytes out of the
 * archive before and after each checkpoint, and a hash is as good a witness at
 * 68 bytes as at 68 kilobytes.
 */
export const CORPUS_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAASwAAACMCAIAAABJdAN4AAAC+UlEQVR42u3c0W3CMBCAYTZgjQ7BJEzCdB2Chdo3ZCG1SuxzfEe+XzylJJyCv4pAy+VH0tIuToEEoQShJAgr9rzdtt8CH6jEzIIQQgghnNz178L3glAQQgghhBBCKAjfFO26T99esRh27RtoY9W+ghBCCCGEEEIlR3jdEIR1Ef7zbA5evY9cxkMIIYQQQlgEYZKXhRCeBWHffQYN9z21EI48v31bXBNCCCGEEEIIIYSprgmjeLsmzIlwy/KA8NQId72HmfPP1g57IAgXI1z79heEEEIY9pFA1JEnzQPhPIThKwdCCCGEEEIIIYQw9lQu+X/Cz3t3dN6RBz+icE0IIYQQQghhNYRvh3qd2L4tEB6BsGIQRl0h+5YNCCGEEEIIc1CZd3IghBBCCCGEEEIIIYQQQgghhBBCCA80Oe/bmUaOfBgGCCGEEEIIIYQQQgghhBBCCCGEEEJV+JUEIYSCEEJBCCGEghBCQQghhDX7un9PukEIoSCEEEIIIYRQEEIIIYQQQigIIYQQQgghFIQQDiN8NLU/tX18eytnxvaOOV9m2u2tpZHtGc4/hLZDCKGXo16OejkKoSCEEEIIIYRQEEIIIYQQQgghhBBCCCGEEEIIIYSnQJhzuUMIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEJYEaHlDiGEEJoKQggtdwghhNBUEEJouUMIIYSmghBCyx1CCCE0FYQQWu4QQgihqSCE0HKHEEIITQUhhJY7hBBCaCoIIbTcIYQQQlNBCKHlDiGEEJoKQggtdwghhNBUEEJouUMIIYSmghBCCCGEEEJTQQghhBBCCKGpIIQQQgghhNBUEEIIIYQQQmgqCDMjlD4mCCUIIRSEhRBKglCCUBKEEoSSIJQglAShBKEkCCUIJUEoQSgJQglCSRBKEEqCUIJQEoQShJIglCCUIJQEoQShJAils/YLHsFFmpfz3J0AAAAASUVORK5CYII=";

/** Replaced with the caller's on-disk path when the transcript is assembled. */
const IMAGE_REF_PLACEHOLDER = "{{CORPUS_IMAGE_REF_PATH}}";

/** Fixed so an assembled transcript hashes the same on every run. */
const BASE_TIME = Date.UTC(2026, 2, 4, 9, 0, 0);

function at(index: number): string {
  return new Date(BASE_TIME + index * 60_000).toISOString();
}

function user(...content: MessageContentBlock[]): TranscriptEntry {
  return { timestamp: "", type: "user", role: "user", content };
}

function assistant(...content: MessageContentBlock[]): TranscriptEntry {
  return { timestamp: "", type: "assistant", role: "assistant", content };
}

function text(body: string): MessageContentBlock {
  return { type: "text", text: body };
}

function toolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): MessageContentBlock {
  return { type: "tool_use", id, name, input };
}

function toolResult(id: string, body: string): MessageContentBlock {
  return { type: "tool_result", tool_use_id: id, content: body };
}

/**
 * A deterministic reconcile log large enough that the newest exchange cannot
 * be quoted whole inside the recent-dialogue budget, with the one line that
 * matters buried in the middle rather than at either edge a truncation would
 * naturally keep.
 */
function reconcileLog(): string {
  const lines: string[] = ["$ ledgerctl reconcile --run 2026-03-03 --verbose"];
  for (let shard = 0; shard < 48; shard += 1) {
    const label = `shard-${String(shard).padStart(2, "0")}`;
    lines.push(
      `[2026-03-03T22:${String(10 + (shard % 40)).padStart(2, "0")}:0${shard % 10}Z] INFO  ${label} lease acquired generation=${1000 + shard}`,
      `[2026-03-03T22:${String(11 + (shard % 40)).padStart(2, "0")}:0${shard % 10}Z] INFO  ${label} scanned 148213 rows in 2.${shard}s`,
      `[2026-03-03T22:${String(12 + (shard % 40)).padStart(2, "0")}:0${shard % 10}Z] INFO  ${label} checksum 0x${(0x5a1d0000 + shard * 7919).toString(16)}`,
      `[2026-03-03T22:${String(13 + (shard % 40)).padStart(2, "0")}:0${shard % 10}Z] DEBUG ${label} flushed 12 batches, 0 retries, queue depth 0`,
      shard === 7
        ? `[2026-03-03T22:14:07Z] FATAL shard-07 lease expired mid-scan; reconcile aborted for this shard only`
        : `[2026-03-03T22:${String(14 + (shard % 40)).padStart(2, "0")}:0${shard % 10}Z] INFO  ${label} lease released cleanly`,
    );
  }
  lines.push(
    "[2026-03-03T22:59:59Z] INFO  run complete: 47 shards reconciled, 1 aborted",
  );
  return lines.join("\n");
}

const LEDGER_EXPORT: ContinuityCase = {
  id: "ledger-export",
  title: "CSV export for the reconciliation ledger",
  traits: ["tool_heavy"],
  entries: [
    user(
      text(
        "We're adding a CSV export to the reconciliation ledger. Hard constraint from legal, already signed off: the export must never contain the payer_tax_id column. That one is not negotiable, whatever the finance team asks for later.",
      ),
    ),
    assistant(
      toolUse("tu-1", "Bash", {
        command: "ledgerctl schema describe reconciliation_ledger",
      }),
      toolResult(
        "tu-1",
        [
          "column                 type        nullable",
          "settlement_id          uuid        no",
          "payer_tax_id           text        no",
          "payer_display_name     text        no",
          "amount_minor           bigint      no",
          "currency               char(3)     no",
          "reconciled_at          timestamptz yes",
        ].join("\n"),
      ),
    ),
    assistant(
      text(
        "The schema does carry payer_tax_id, so the writer has to project columns explicitly rather than select *. The export job is registered as RCN-4417 in the scheduler; I'll hang the CSV writer off that job.",
      ),
    ),
    user(text("Write the output to the ledger-exports-v1 bucket.")),
    assistant(
      toolUse("tu-2", "Bash", {
        command: "aws s3api get-bucket-policy --bucket ledger-exports-v1",
      }),
      toolResult(
        "tu-2",
        'ObjectLockConfiguration: COMPLIANCE, retainUntil 2031-01-01. Writes from role "ledger-exporter" are denied.',
      ),
    ),
    user(
      text(
        "Then switch it. The destination bucket is now ledger-exports-v2; ledger-exports-v1 is retired and retention-locked, so nothing new goes there.",
      ),
    ),
    assistant(
      text(
        "Understood — destination is ledger-exports-v2 from here on, and job RCN-4417 keeps the same schedule.",
      ),
    ),
    assistant(
      text(
        "One approach is out: I tried csv-stringify for the row writer and rejected it, because it buffers the whole result set before flushing and a full-year export blows the 512 MB memory cap. I'm going with manual chunked writes instead.",
      ),
    ),
  ],
  expectations: [
    {
      id: "constraint-excluded-column",
      kind: "constraint",
      question:
        "Which single ledger column is the CSV export forbidden from ever containing? Answer with just the column name and nothing else.",
      mustInclude: ["payer_tax_id"],
      mustNotInclude: [],
      sourceEntryIndexes: [0],
      askAfterCycle: 1,
    },
    {
      id: "identifier-export-job",
      kind: "identifier",
      question:
        "What is the scheduler id of the export job? Answer with just the id and nothing else.",
      mustInclude: ["RCN-4417"],
      mustNotInclude: [],
      sourceEntryIndexes: [2],
      askAfterCycle: 1,
    },
    {
      id: "superseded-destination-bucket",
      kind: "superseded_decision",
      question:
        "Which bucket does the export write to now? Answer with exactly one bucket name and nothing else.",
      mustInclude: ["ledger-exports-v2"],
      mustNotInclude: ["ledger-exports-v1"],
      sourceEntryIndexes: [3, 5],
      askAfterCycle: 2,
    },
    {
      id: "rejected-row-writer",
      kind: "rejected_approach",
      question:
        "Which row-writing library was tried and rejected for this export, and in one short clause, why?",
      mustInclude: ["csv-stringify", "buffer"],
      mustNotInclude: [],
      sourceEntryIndexes: [7],
      askAfterCycle: 2,
    },
  ],
};

const SHARD_TIMEOUT: ContinuityCase = {
  id: "shard-timeout",
  title: "A pasted reconcile log and the ticket that blocks shipping",
  traits: ["oversized"],
  entries: [
    user(
      text(
        `Here is last night's full reconcile run, pasted raw. Read it and tell me which shard failed.\n\n${reconcileLog()}`,
      ),
    ),
    assistant(
      text(
        "Exactly one shard failed: shard-07 lost its lease mid-scan and aborted. The other 47 shards reconciled cleanly.",
      ),
    ),
    user(
      text(
        "Right. And we are blocked on shipping the export at all until finance approves the column mapping — that is ticket FIN-882. Do not ship before FIN-882 lands, even if the code is ready.",
      ),
    ),
  ],
  expectations: [
    {
      id: "identifier-failing-shard",
      kind: "identifier",
      question:
        "In the reconcile log I pasted, which shard failed? Answer with just the shard name and nothing else.",
      mustInclude: ["shard-07"],
      mustNotInclude: [],
      sourceEntryIndexes: [0, 1],
      askAfterCycle: 3,
    },
    {
      id: "blocker-finance-ticket",
      kind: "blocker",
      question:
        "What is currently blocking us from shipping the export, and which ticket tracks it?",
      mustInclude: ["FIN-882"],
      mustNotInclude: [],
      sourceEntryIndexes: [2],
      askAfterCycle: 3,
    },
  ],
};

const CHART_REVIEW: ContinuityCase = {
  id: "chart-review",
  title: "A latency chart review and the agreed alert threshold",
  traits: ["image_dependent"],
  entries: [
    user(
      { type: "image", mediaType: "image/png", base64Data: CORPUS_PNG_BASE64 },
      text(
        "Here is the export latency chart from the staging run. The red bar is our measured p99 and the chart prints that number above it — I am not repeating it here, read it off the image. Note the threshold we agreed on the call: alerts fire above 250 ms. The old 500 ms dashed line on the chart is stale, ignore it.",
      ),
    ),
    assistant(
      text(
        "Understood — the alerting threshold is 250 ms, and the 500 ms line in the image is the stale one.",
      ),
    ),
    user(
      {
        type: "image_ref",
        mediaType: "image/png",
        imagePath: IMAGE_REF_PLACEHOLDER,
      },
      text(
        "Same chart attached again from the artifact store, for the record.",
      ),
    ),
    assistant(
      text(
        "Next action on the CLI: add the --since flag to the export command so operators can re-run a bounded window instead of the whole year.",
      ),
    ),
  ],
  expectations: [
    {
      id: "constraint-alert-threshold",
      kind: "constraint",
      question:
        "At what export latency do alerts fire? Answer with just the number and its unit, nothing else.",
      mustInclude: ["250"],
      mustNotInclude: ["500"],
      sourceEntryIndexes: [0, 1],
      askAfterCycle: 3,
    },
    {
      id: "image-measured-p99",
      kind: "identifier",
      // Printed in the chart's pixels and nowhere in the dialogue, so the only
      // way to answer is to recover the original image after checkpointing.
      question:
        "The chart image prints our measured p99 above the red bar. What is that number? Answer with just the number and nothing else.",
      mustInclude: ["812"],
      mustNotInclude: ["250", "500"],
      sourceEntryIndexes: [0],
      evidence: "image",
      askAfterCycle: 3,
    },
    {
      id: "next-action-cli-flag",
      kind: "next_action",
      question:
        "What is the next action on the export CLI? Name the exact flag it adds.",
      mustInclude: ["--since"],
      mustNotInclude: [],
      sourceEntryIndexes: [3],
      askAfterCycle: 3,
    },
  ],
};

export const CONTINUITY_CORPUS: readonly ContinuityCase[] = [
  LEDGER_EXPORT,
  SHARD_TIMEOUT,
  CHART_REVIEW,
];

function substituteImagePath(
  block: MessageContentBlock,
  imageRefPath: string,
): MessageContentBlock {
  return block.type === "image_ref" && block.imagePath === IMAGE_REF_PLACEHOLDER
    ? { ...block, imagePath: imageRefPath }
    : block;
}

export function assembleContinuityTranscript(options: {
  imageRefPath: string;
  cases?: readonly ContinuityCase[];
}): AssembledContinuityTranscript {
  const cases = options.cases ?? CONTINUITY_CORPUS;
  const lines: TranscriptEntry[] = [];
  const expectations: AssembledExpectation[] = [];
  for (const fixture of cases) {
    const offset = lines.length;
    for (const entry of fixture.entries) {
      lines.push({
        ...entry,
        timestamp: at(lines.length),
        content: (entry.content ?? []).map((block) =>
          substituteImagePath(block, options.imageRefPath),
        ),
      });
    }
    for (const expectation of fixture.expectations) {
      expectations.push({
        ...expectation,
        caseId: fixture.id,
        sourceSeqs: expectation.sourceEntryIndexes.map(
          (index) => index + offset,
        ),
      });
    }
  }
  return { lines, expectations };
}

/** Case- and whitespace-insensitive, so grading turns on content not layout. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function gradeContinuityAnswer(
  answer: string,
  expectation: Pick<ContinuityExpectation, "mustInclude" | "mustNotInclude">,
): ContinuityGrade {
  const normalized = normalize(answer);
  const missing = expectation.mustInclude.filter(
    (literal) => !normalized.includes(normalize(literal)),
  );
  const forbidden = expectation.mustNotInclude.filter((literal) =>
    normalized.includes(normalize(literal)),
  );
  return {
    satisfied: missing.length === 0 && forbidden.length === 0,
    missing,
    forbidden,
  };
}

/** The expectations a probe asks after cycle `cycle`'s checkpoint. */
export function expectationsForCycle(
  assembled: AssembledContinuityTranscript,
  cycle: 1 | 2 | 3,
): readonly AssembledExpectation[] {
  return assembled.expectations.filter(
    (expectation) => expectation.askAfterCycle === cycle,
  );
}
