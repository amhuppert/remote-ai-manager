import path from "node:path";
import {
  criterionRecordsOf,
  type AcceptanceCriteria,
} from "@/lib/workflow-graph/criteria/criterion-records";

// ============================================================
// Semantic authoring lints (#69 change 6)
//
// The structural validator answers "is this graph well-formed?"; these answer
// "is this plan writable by the agents it staffs?" — a question no structural
// check reaches. Each lint pins a specific incident from a real execution and
// earns its place from that incident alone; a lint that turns out noisy is
// removed rather than tuned, per the repo's earned-guidance rule.
//
// WARNINGS ONLY. Nothing here may reach the issues channel or change a plan's
// verdict: the whole point of the change set these belong to is to reduce the
// number of ways an execution can fail, and a semantic heuristic that can
// refuse a plan would add one. A false positive costs the author a sentence
// they can answer and move past.
// ============================================================

/** Located exactly like a plan issue, so warnings render through the same printer. */
export interface PlanLintWarning {
  path: string;
  message: string;
}

/**
 * The canonical draft definition, narrowed to the fields the lints read. A
 * structural type rather than the full semantic definition so the lints stay
 * callable from the accept path without importing the graph schema surface.
 */
export interface PlanLintDefinition {
  charter: { sourcesOfTruth: readonly { id: string; locator: string }[] };
  executionContexts: readonly {
    id: string;
    description?: string;
    acceptanceCriteria: AcceptanceCriteria;
  }[];
  tasks: readonly { id: string; instructions: string }[];
}

// Thresholds are named because they are judgment calls, not facts: each one is
// the point past which a real execution's plan stopped being reviewable.
/** Past this, one validator round cannot judge the context in a single pass. */
const MAX_CRITERIA_PER_CONTEXT = 12;
/** Past this, a "criterion" is a prose blob wearing one record's id. */
const MAX_CRITERION_STATEMENT_CHARS = 600;
/** Past this, task instructions are carrying reference material a shared document should own. */
const MAX_TASK_INSTRUCTIONS_CHARS = 8000;
/** Past this, a context description is a design document rather than an orientation. */
const MAX_CONTEXT_DESCRIPTION_CHARS = 2000;

/**
 * Quantifiers that promise a sweep the plan never inventories. D7's
 * one-site-per-round invariant sweeps are the anchor: "every call site" reads
 * as a contract but leaves the validator to discover the site list itself, so
 * each round found one more and the context never converged.
 */
const OPEN_QUANTIFIERS = ["every", "all", "complete", "maximal"] as const;
const OPEN_QUANTIFIER_PATTERN = new RegExp(
  `\\b(?:${OPEN_QUANTIFIERS.join("|")})\\b`,
  "gi",
);

/** `scheme://…` — anything the filesystem cannot be asked about. */
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * The opening of every semantic-lint message, exported because it is a
 * CONTRACT rather than a formatting detail: it is how a consumer tells this
 * module's advisory prose from a structural warning it must not ignore. Any
 * consumer keying on it imports this instead of spelling the literal, so the
 * two cannot drift apart, and nothing outside this module may adopt it.
 */
export const LINT_MESSAGE_PREFIX = "lint/";

type PlanLintId =
  | "criteria-density"
  | "open-quantifier"
  | "source-locator-unresolvable"
  | "oversized-prose";

/** `lint/<id>: <detail>` — the one place a lint message is spelled. */
function lintMessage(id: PlanLintId, detail: string): string {
  return `${LINT_MESSAGE_PREFIX}${id}: ${detail}`;
}

function contextPath(index: number, field: string): string {
  return `definition.executionContexts.${index}.${field}`;
}

/**
 * A context with more acceptance criteria than one validator round can hold, or
 * a single criterion carrying a paragraph's worth of obligation.
 *
 * Anchor: the 30-obligation context, where the validator's judgment degraded
 * into sampling because no round could weigh the whole contract at once.
 */
function lintCriteriaDensity(
  definition: PlanLintDefinition,
): PlanLintWarning[] {
  const warnings: PlanLintWarning[] = [];
  definition.executionContexts.forEach((context, index) => {
    const records = criterionRecordsOf(context.acceptanceCriteria);
    if (records.length > MAX_CRITERIA_PER_CONTEXT) {
      warnings.push({
        path: contextPath(index, "acceptanceCriteria"),
        message: lintMessage(
          "criteria-density",
          `context "${context.id}" declares ${records.length} acceptance criteria (more than ${MAX_CRITERIA_PER_CONTEXT}); split the context or merge related obligations so one validator round can weigh the whole contract`,
        ),
      });
    }
    records.forEach((record, recordIndex) => {
      if (record.statement.length <= MAX_CRITERION_STATEMENT_CHARS) return;
      warnings.push({
        path: contextPath(index, `acceptanceCriteria.${recordIndex}.statement`),
        message: lintMessage(
          "criteria-density",
          `criterion "${record.id}" in context "${context.id}" is ${record.statement.length} characters (more than ${MAX_CRITERION_STATEMENT_CHARS}) — a prose blob wrapped as one record; split it into criteria a validator can judge independently`,
        ),
      });
    });
  });
  return warnings;
}

interface LiteralRange {
  start: number;
  end: number;
}

const LITERAL_CLOSERS = new Map<string, string>([
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["‘", "’"],
]);
const WORD_CHARACTER_PATTERN = /[\p{L}\p{N}_]/u;

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && WORD_CHARACTER_PATTERN.test(character);
}

function balancedLiteralRangesIn(statement: string): LiteralRange[] {
  const ranges: LiteralRange[] = [];
  let active: { start: number; closer: string } | undefined;

  for (let index = 0; index < statement.length; index += 1) {
    const character = statement[index];
    const straightApostropheFollowsWord =
      character === "'" && isWordCharacter(statement[index - 1]);
    const isInWordApostrophe =
      (character === "'" || character === "’") &&
      isWordCharacter(statement[index - 1]) &&
      isWordCharacter(statement[index + 1]);

    if (active !== undefined) {
      if (isInWordApostrophe) continue;
      if (character === active.closer) {
        ranges.push({ start: active.start, end: index + 1 });
        active = undefined;
      }
      continue;
    }

    if (straightApostropheFollowsWord) continue;

    const closer =
      character === undefined ? undefined : LITERAL_CLOSERS.get(character);
    if (closer !== undefined) active = { start: index, closer };
  }

  return ranges;
}

/** The distinct quantifiers a statement uses, lowercased, in first-seen order. */
function openQuantifiersIn(statement: string): string[] {
  const literalRanges = balancedLiteralRangesIn(statement);
  const found = new Set<string>();
  for (const match of statement.matchAll(OPEN_QUANTIFIER_PATTERN)) {
    const matchIndex = match.index;
    if (
      literalRanges.some(
        (range) => matchIndex >= range.start && matchIndex < range.end,
      )
    ) {
      continue;
    }
    found.add(match[0].toLowerCase());
  }
  return [...found];
}

function lintOpenQuantifiers(
  definition: PlanLintDefinition,
): PlanLintWarning[] {
  const warnings: PlanLintWarning[] = [];
  definition.executionContexts.forEach((context, index) => {
    criterionRecordsOf(context.acceptanceCriteria).forEach(
      (record, recordIndex) => {
        const quantifiers = openQuantifiersIn(record.statement);
        if (quantifiers.length === 0) return;
        warnings.push({
          path: contextPath(
            index,
            `acceptanceCriteria.${recordIndex}.statement`,
          ),
          message: lintMessage(
            "open-quantifier",
            `criterion "${record.id}" in context "${context.id}" uses ${quantifiers
              .map((word) => `"${word}"`)
              .join(
                ", ",
              )}; syntactically quote exact UI or output copy; for a real sweep, name the inventoried surface it ranges over or split it into fixed-scope criteria`,
          ),
        });
      },
    );
  });
  return warnings;
}

/**
 * Whether a locator has the worktree-relative shape an agent can resolve.
 *
 * Worktree-relative is the only resolvable form (planning skill: external
 * material is materialized into the worktree before it may be cited), so a URL
 * scheme and an absolute path are unresolvable BY SHAPE — an absolute path that
 * happens to exist on this machine does not exist in a lane worktree, and
 * checking it would bless a locator that is absent everywhere it is read. A
 * relative locator that lexically escapes the worktree is the same case spelled
 * differently. Availability belongs to a server-pinned committed tree probe.
 */
export function isLexicallyResolvableSourceLocator(locator: string): boolean {
  if (URL_SCHEME_PATTERN.test(locator)) return false;
  if (path.posix.isAbsolute(locator) || path.win32.isAbsolute(locator)) {
    return false;
  }
  const normalized = path.posix.normalize(locator);
  return normalized !== ".." && !normalized.startsWith("../");
}

/**
 * Anchor: D7's rank-2 source, whose locator resolved nowhere and was reported
 * absent in all 19 verdicts — nineteen rounds spent re-discovering that the
 * plan cited a document no agent could read.
 */
function lintSourceLocators(definition: PlanLintDefinition): PlanLintWarning[] {
  const warnings: PlanLintWarning[] = [];
  definition.charter.sourcesOfTruth.forEach((source, index) => {
    if (isLexicallyResolvableSourceLocator(source.locator)) return;
    warnings.push({
      path: `definition.charter.sourcesOfTruth.${index}.locator`,
      message: lintMessage(
        "source-locator-unresolvable",
        `charter source "${source.id}" locator "${source.locator}" is not a worktree-relative path contained by the worktree; materialize external material into the worktree and cite the committed path, or an agent asked to consult this source reports it absent every round`,
      ),
    });
  });
  return warnings;
}

function lintOversizedProse(definition: PlanLintDefinition): PlanLintWarning[] {
  const warnings: PlanLintWarning[] = [];
  definition.tasks.forEach((task, index) => {
    if (task.instructions.length <= MAX_TASK_INSTRUCTIONS_CHARS) return;
    warnings.push({
      path: `definition.tasks.${index}.instructions`,
      message: lintMessage(
        "oversized-prose",
        `task "${task.id}" instructions are ${task.instructions.length} characters (more than ${MAX_TASK_INSTRUCTIONS_CHARS}); move durable reference material into a shared document and leave the task with the work it must do`,
      ),
    });
  });
  definition.executionContexts.forEach((context, index) => {
    const description = context.description;
    if (
      description === undefined ||
      description.length <= MAX_CONTEXT_DESCRIPTION_CHARS
    ) {
      return;
    }
    warnings.push({
      path: contextPath(index, "description"),
      message: lintMessage(
        "oversized-prose",
        `context "${context.id}" description is ${description.length} characters (more than ${MAX_CONTEXT_DESCRIPTION_CHARS}); move durable reference material into a shared document and leave the description as the context's orientation`,
      ),
    });
  });
  return warnings;
}

/**
 * Every semantic lint over one canonical draft definition, in a stable order
 * (density, quantifiers, locators, prose) so repeated validations of the same
 * plan print the same list.
 */
export function lintPlanSemantics(
  definition: PlanLintDefinition,
): PlanLintWarning[] {
  return [
    ...lintCriteriaDensity(definition),
    ...lintOpenQuantifiers(definition),
    ...lintSourceLocators(definition),
    ...lintOversizedProse(definition),
  ];
}
