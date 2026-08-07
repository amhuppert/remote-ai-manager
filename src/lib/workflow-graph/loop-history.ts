/**
 * Loop History: the bounded, ENTRY-ONLY prompt projection of a loop's prior
 * passes (D4 R16.1, decision D9).
 *
 * A pass entry starts a fresh conversation on a fresh clone, so without this it
 * would know only what its incoming edge carries — the prior exit's payload —
 * and nothing about what the passes before that already tried. The section
 * answers that and nothing more: prior passes' per-body-context captures, and
 * how each pass was decided.
 *
 * Three properties define it and none of them is negotiable:
 *
 *  - **Entry-only.** Only the pass ENTRY instance receives it. Same-pass body
 *    contexts already read their predecessors through ordinary upstream
 *    injection, and giving them the history too would duplicate the pass they
 *    are standing in.
 *  - **Bounded.** Most-recent {@link LOOP_HISTORY_MAX_PASSES} passes,
 *    {@link LOOP_HISTORY_MAX_CONTEXT_BYTES} per captured payload,
 *    {@link LOOP_HISTORY_MAX_SECTION_BYTES} for the rendered section. Prompts
 *    need RECENT history, not complete history — the complete decision ledger is
 *    read through the cursor-paginated event reader instead.
 *  - **Derived, never stored.** Everything here comes from the blob's loop
 *    markers (`loopStates.decisions`) and the pass instances' banked captures.
 *    The ledger introduces no mutable state and no second communication channel;
 *    free-form inter-pass narrative rides a body context's own `outputSchema`
 *    through the documented handoff-field convention.
 */

import { findLoopBodyMembership, loopInstanceId } from "./loop-resolver";
import type { GraphWorkflowResolvedLoopGroup } from "./definition-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowLoopDecisionRecord,
} from "./schemas";

/** Most recent passes carried into a pass entry's prompt. */
export const LOOP_HISTORY_MAX_PASSES = 3;
/** Per captured payload, after JSON rendering. */
export const LOOP_HISTORY_MAX_CONTEXT_BYTES = 2 * 1024;
/**
 * Floor for the shrunken per-payload budget. Below this a payload is no longer
 * worth its fences, so the ladder drops payloads instead of shaving further.
 */
export const LOOP_HISTORY_MIN_CONTEXT_BYTES = 256;
/** The whole rendered section, header included. */
export const LOOP_HISTORY_MAX_SECTION_BYTES = 16 * 1024;

const TRUNCATION_MARKER = "\n… (truncated)";
const BLOCK_SEPARATOR = "\n\n";

export interface LoopHistoryContextEntry {
  /** The pass instance's minted id. */
  readonly contextId: string;
  /** The body-template id it was cloned from — stable across passes. */
  readonly templateContextId: string;
  readonly title: string;
  /** The banked capture, JSON-rendered and size-bounded; null if none. */
  readonly output: string | null;
  readonly truncated: boolean;
  /**
   * A capture exists but the section bound left no room for any of it. Distinct
   * from `truncated` (some of it survived) and from a null output with this
   * false (the context banked nothing at all).
   */
  readonly outputOmitted: boolean;
  readonly skipped: boolean;
}

export interface LoopHistoryPassEntry {
  readonly pass: number;
  readonly contexts: readonly LoopHistoryContextEntry[];
  /**
   * Body contexts dropped whole because the section bound could not fit even
   * their headers. The decision still reports.
   */
  readonly omittedContextCount: number;
  /**
   * The pass's authoritative decision, or null when the ledger holds none — a
   * pass whose settlement halted records nothing, deliberately.
   */
  readonly decision: GraphWorkflowLoopDecisionRecord | null;
}

export interface LoopHistory {
  readonly loopGroupId: string;
  /** The pass whose entry receives this section. */
  readonly pass: number;
  /** The retained passes, oldest first. */
  readonly passes: readonly LoopHistoryPassEntry[];
  /** Prior passes dropped by the recency or size bound. */
  readonly omittedPassCount: number;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Cut `text` to fit `maxBytes` INCLUDING the truncation marker, so a caller's
 * budget is the real cost of what it renders. Decoding the cut buffer can leave
 * a replacement character where a multi-byte codepoint was split; it is dropped
 * rather than shipped into a prompt as mojibake.
 */
function truncateToBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) {
    return { text, truncated: false };
  }
  const budget = Math.max(0, maxBytes - byteLength(TRUNCATION_MARKER));
  const decoded = new TextDecoder("utf-8").decode(encoded.subarray(0, budget));
  const cleaned = decoded.endsWith("�") ? decoded.slice(0, -1) : decoded;
  return { text: `${cleaned}${TRUNCATION_MARKER}`, truncated: true };
}

function resolvedLoopGroups(
  execution: GraphWorkflowExecution,
): readonly GraphWorkflowResolvedLoopGroup[] {
  return execution.workingDefinition.loopGroups ?? [];
}

/** Bytes allowed per rendered payload, or `omit` to carry none of them. */
type PayloadBudget = number | "omit";

function buildPassEntry(
  execution: GraphWorkflowExecution,
  group: GraphWorkflowResolvedLoopGroup,
  pass: number,
  payloadBudget: PayloadBudget,
): LoopHistoryPassEntry {
  const contexts = group.template.contexts.map(
    (templateContext): LoopHistoryContextEntry => {
      const contextId = loopInstanceId(group.id, pass, templateContext.id);
      const captured = execution.contextOutputs[contextId];
      const rendered =
        captured === undefined || payloadBudget === "omit"
          ? null
          : truncateToBytes(
              JSON.stringify(captured.value, null, 2),
              payloadBudget,
            );
      return {
        contextId,
        templateContextId: templateContext.id,
        title: templateContext.title,
        output: rendered?.text ?? null,
        truncated: rendered?.truncated ?? false,
        outputOmitted: captured !== undefined && payloadBudget === "omit",
        skipped: execution.contextStates[contextId]?.status === "skipped",
      };
    },
  );

  return {
    pass,
    contexts,
    omittedContextCount: 0,
    decision: decisionFor(execution, group, pass),
  };
}

function decisionFor(
  execution: GraphWorkflowExecution,
  group: GraphWorkflowResolvedLoopGroup,
  pass: number,
): GraphWorkflowLoopDecisionRecord | null {
  return execution.loopStates[group.id]?.decisions[String(pass)] ?? null;
}

/**
 * The richest rendering of `pass` that fits `availableBytes`, or null when even
 * its decision line does not.
 *
 * Bounded degradation, never all-or-nothing: a body wide enough that ONE pass
 * exceeds the section bound must still hand pass k+1 that pass's verdict,
 * outcome and control revision. Dropping the block whole would leave the next
 * pass with no record of the pass before it, which is the one thing R16.1
 * requires it to have. The ladder shrinks the per-payload budget by halves,
 * then drops payloads, then drops the context blocks — measuring the real
 * rendered bytes at every rung rather than estimating them.
 */
function fitPassEntry(
  execution: GraphWorkflowExecution,
  group: GraphWorkflowResolvedLoopGroup,
  pass: number,
  availableBytes: number,
): LoopHistoryPassEntry | null {
  const fits = (entry: LoopHistoryPassEntry) =>
    byteLength(renderPassBlock(entry)) <= availableBytes;

  for (
    let budget = LOOP_HISTORY_MAX_CONTEXT_BYTES;
    budget >= LOOP_HISTORY_MIN_CONTEXT_BYTES;
    budget = Math.floor(budget / 2)
  ) {
    const entry = buildPassEntry(execution, group, pass, budget);
    if (fits(entry)) return entry;
  }

  const withoutPayloads = buildPassEntry(execution, group, pass, "omit");
  if (fits(withoutPayloads)) return withoutPayloads;

  const decisionOnly: LoopHistoryPassEntry = {
    pass,
    contexts: [],
    omittedContextCount: group.template.contexts.length,
    decision: decisionFor(execution, group, pass),
  };
  return fits(decisionOnly) ? decisionOnly : null;
}

/**
 * The history section `contextId` should receive, or null when it should
 * receive none — which is every context that is not a pass entry, and the first
 * pass's entry, which has no prior pass to report.
 */
export function resolveLoopHistory(
  execution: GraphWorkflowExecution,
  contextId: string,
): LoopHistory | null {
  const groups = resolvedLoopGroups(execution);
  const membership = findLoopBodyMembership(contextId, groups);
  if (membership === null || membership.pass === null) return null;

  const group = groups.find((entry) => entry.id === membership.loopGroupId);
  if (!group) return null;
  const pass = membership.pass;
  if (contextId !== loopInstanceId(group.id, pass, group.entryContextId)) {
    return null;
  }
  if (pass < 2) return null;

  const priorPassCount = pass - 1;

  // Newest-first accumulation: when the section budget runs out it is the
  // OLDEST retained pass that goes, which is the same bias the recency bound
  // already applies. The header is charged against the budget with the widest
  // omission count it can carry, so the estimate is never short of the final
  // render.
  const kept: LoopHistoryPassEntry[] = [];
  let spent = byteLength(renderHeader(group.id, pass, priorPassCount));
  for (
    let candidate = pass - 1;
    candidate >= 1 && kept.length < LOOP_HISTORY_MAX_PASSES;
    candidate -= 1
  ) {
    const available =
      LOOP_HISTORY_MAX_SECTION_BYTES - spent - byteLength(BLOCK_SEPARATOR);
    const entry = fitPassEntry(execution, group, candidate, available);
    if (entry === null) break;
    spent += byteLength(BLOCK_SEPARATOR) + byteLength(renderPassBlock(entry));
    kept.push(entry);
  }
  kept.reverse();

  return {
    loopGroupId: group.id,
    pass,
    passes: kept,
    omittedPassCount: priorPassCount - kept.length,
  };
}

function renderHeader(
  loopGroupId: string,
  pass: number,
  omittedPassCount: number,
): string {
  const lines = [
    "## Loop History",
    `You are running pass ${pass} of loop \`${loopGroupId}\`. Earlier passes of this loop produced the following; use them instead of repeating work that already failed.`,
  ];
  if (omittedPassCount > 0) {
    lines.push(
      `${omittedPassCount} earlier pass(es) are omitted — only the most recent ${LOOP_HISTORY_MAX_PASSES} are carried.`,
    );
  }
  return lines.join("\n");
}

function renderPassBlock(entry: LoopHistoryPassEntry): string {
  const lines = [`### Pass ${entry.pass}`];
  const decision = entry.decision;
  if (decision) {
    lines.push(
      `Exit \`${decision.exitContextId}\` verdict: ${decision.verdict} → ${decision.outcome} (loopControlRevision ${decision.loopControlRevision}, templateVersion ${decision.templateVersion}).`,
    );
  } else {
    lines.push("No settled decision was recorded for this pass.");
  }

  for (const context of entry.contexts) {
    lines.push("", `#### ${context.templateContextId} — ${context.title}`);
    if (context.skipped) {
      lines.push("Skipped — this branch was not taken on that pass.");
      continue;
    }
    if (context.outputOmitted) {
      lines.push("Captured output omitted — the history size bound was spent.");
      continue;
    }
    if (context.output === null) {
      lines.push("No captured output.");
      continue;
    }
    lines.push("```json", context.output, "```");
  }

  if (entry.omittedContextCount > 0) {
    lines.push(
      "",
      `${entry.omittedContextCount} body context(s) omitted — the history size bound was spent.`,
    );
  }

  return lines.join("\n");
}

/**
 * The rendered section, or null when there is nothing to say. Rendering lives
 * beside the projection on purpose: the section cap is measured against exactly
 * these bytes, so a caller cannot render it a different way and blow the budget.
 */
export function renderLoopHistorySection(
  history: LoopHistory | null,
): string | null {
  if (history === null || history.passes.length === 0) return null;
  return [
    renderHeader(history.loopGroupId, history.pass, history.omittedPassCount),
    ...history.passes.map((entry) => renderPassBlock(entry)),
  ].join("\n\n");
}
