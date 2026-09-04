import { createLogger, type Logger } from "@/lib/logging";
import type {
  MemoryNoteListQuery,
  MemoryRepo,
} from "@/lib/state-store/memory-repo";

import type {
  MemoryFreshnessAssessment,
  MemoryFreshnessEngine,
} from "./freshness";
import { renderMemoryStatusLine } from "./age";
import { renderMemoryArtifactHandle } from "./artifact-handles";
import {
  createLexicalMemoryProvider,
  reciprocalRankScore,
  type MemoryRankedProvider,
} from "./recall-providers";
import {
  MEMORY_RECALL_FULL_BODY_MAX,
  MEMORY_RECALL_MIN_BUDGET_CHARS,
  MEMORY_RECALL_QUERY_ECHO_CHARS,
  memoryActorSchema,
  memoryRecallRequestSchema,
  type MemoryActor,
  type MemoryArtifactRef,
  type MemoryLink,
  type MemoryNote,
  type MemoryRecallMode,
  type MemoryRecallRequest,
  type MemoryScope,
} from "./schemas";
import type { MemoryResult } from "./service";

const logger = createLogger("memory.recall");

export type {
  MemoryRankedCandidate,
  MemoryRankedProvider,
  MemoryRankedRequest,
} from "./recall-providers";

/**
 * How a record is carried: `full` primes with the whole body, `hook` is the
 * one-line fact plus the exact command that reads the rest. The pack spends
 * its budget on the best few full bodies and discloses the rest as hooks (D5).
 */
export type MemoryContextPackTier = "full" | "hook";

export interface MemoryContextPackEntry {
  readonly note: MemoryNote;
  readonly tier: MemoryContextPackTier;
  /** The delivered status line, or null when absent or withheld as stale. */
  readonly statusLine: string | null;
  /** The exact command that reads this record in full. */
  readonly readCommand: string;
}

/**
 * One recall's answer: the bounded pack itself, what it left out, and the
 * rendered block a caller prints verbatim. `text` is the budgeted artifact —
 * the structured entries carry the same records for `--json` consumers, which
 * is the only place a memory id may appear (inv-slug-only-text-output).
 */
export interface MemoryContextPack {
  readonly mode: MemoryRecallMode;
  readonly entries: readonly MemoryContextPackEntry[];
  readonly showing: number;
  readonly total: number;
  /** Null when nothing was omitted; otherwise the exact command that narrows. */
  readonly narrowCommand: string | null;
  readonly text: string;
}

export interface MemoryRecallDeps {
  repo: MemoryRepo;
  /**
   * The one owner of staleness. Recall selects candidates first and asks the
   * engine about those only; it never compares a lease or a token itself.
   */
  freshness: MemoryFreshnessEngine;
  /** Consulted in order for a query; defaults to the lexical provider (D5). */
  providers?: readonly MemoryRankedProvider[];
  now(): string;
  /** Defaults to the module logger; injected in tests to read the event. */
  logger?: Logger;
}

/**
 * The one bounded retrieval verb (R7). Three modes, one contract: no query is
 * ambient (the visible union plus active-artifact bindings), a query is the
 * ranked lexical search, and a related artifact resolves its `about` links.
 */
export interface MemoryRecallService {
  recall(
    request: MemoryRecallRequest,
    actor: MemoryActor,
  ): Promise<MemoryResult<MemoryContextPack>>;
}

// ============================================================
// Ranking (D5): about-link, then scope, then index mode, then relevance
// ============================================================

/** More specific scope wins: what a session learned beats the project's rule. */
function scopeRank(scope: MemoryScope): number {
  switch (scope) {
    case "session":
      return 3;
    case "project":
      return 2;
    case "global":
      return 1;
  }
}

/**
 * An explicit index mode is an author's statement about how much the record
 * matters: `always` says it always does. `search-only` is the opposite
 * statement, and both rank around the `auto` default.
 */
function indexModeRank(note: MemoryNote): number {
  switch (note.indexMode) {
    case "always":
      return 2;
    case "auto":
      return 1;
    case "search-only":
      return 0;
  }
}

interface RankedNote {
  readonly note: MemoryNote;
  readonly aboutLinked: boolean;
  readonly relevance: number;
}

/**
 * The ranking order the spec names, applied strictly. The final tiebreak is
 * the slug — a stable, agent-visible value. Retrieval frequency appears
 * NOWHERE in this comparison and there is no counter for it to read
 * (inv-no-popularity-or-telemetry-rank): a record retrieved a hundred times
 * sorts exactly where an untouched equal does.
 */
function compareRanked(left: RankedNote, right: RankedNote): number {
  return (
    Number(right.aboutLinked) - Number(left.aboutLinked) ||
    scopeRank(right.note.scope) - scopeRank(left.note.scope) ||
    indexModeRank(right.note) - indexModeRank(left.note) ||
    right.relevance - left.relevance ||
    left.note.slug.localeCompare(right.note.slug)
  );
}

// ============================================================
// Rendering
// ============================================================

/**
 * Single quotes, not double: a double-quoted argument carrying a backtick is
 * command-substituted by the shell before the CLI ever sees it, which blanks
 * the text of any query written about shell syntax.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command that reads one record in full. The scope is not decoration: a
 * slug is unique only WITHIN a scope, so a caller who can see a global and a
 * project note sharing one slug gets an ambiguous-handle refusal from the bare
 * handle. Naming the scope makes every rendered command resolve to the record
 * the pack actually showed.
 */
function readCommandFor(note: MemoryNote): string {
  return `cctl memory get ${note.slug} --scope ${note.scope}`;
}

function renderEntry(entry: MemoryContextPackEntry): string {
  const lines = [
    `## ${entry.note.slug} [${entry.note.scope}]`,
    entry.note.hook,
  ];
  if (entry.statusLine !== null) lines.push(entry.statusLine);
  if (entry.tier === "full") {
    if (entry.note.body.trim() !== "") lines.push("", entry.note.body);
  } else {
    lines.push(`read: ${entry.readCommand}`);
  }
  return lines.join("\n");
}

function renderHeader(
  mode: MemoryRecallMode,
  query: string | null,
  related: MemoryArtifactRef | null,
): string {
  const parts = [`Memory recall — ${mode}`];
  if (related !== null) parts.push(renderMemoryArtifactHandle(related));
  // The header is a title, not a command, so a long query may be elided here.
  // The closing line's narrowing command may not: it has to be runnable.
  if (query !== null) {
    parts.push(
      shellQuote(
        query.length > MEMORY_RECALL_QUERY_ECHO_CHARS
          ? `${query.slice(0, MEMORY_RECALL_QUERY_ECHO_CHARS)}…`
          : query,
      ),
    );
  }
  return parts.join(" ");
}

function renderClosing(
  showing: number,
  total: number,
  narrowCommand: string | null,
): string {
  const counts = `Showing ${showing} of ${total} memory records`;
  return narrowCommand === null
    ? `${counts}.`
    : `${counts} — narrow with: ${narrowCommand}`;
}

// ============================================================
// Service
// ============================================================

function aboutLinkedIds(links: readonly MemoryLink[]): Set<string> {
  const ids = new Set<string>();
  for (const link of links) {
    // Only `about` is a relevance cue: a `source` link to the very same
    // artifact grants nothing (inv-about-links-only-cues).
    if (link.kind === "about") ids.add(link.memoryId);
  }
  return ids;
}

function mostSpecificScope(notes: readonly MemoryNote[]): MemoryScope {
  return notes.reduce<MemoryScope>(
    (best, note) =>
      scopeRank(note.scope) > scopeRank(best) ? note.scope : best,
    "global",
  );
}

export function createMemoryRecallService(
  deps: MemoryRecallDeps,
): MemoryRecallService {
  const providers =
    deps.providers ?? ([createLexicalMemoryProvider(deps.repo)] as const);
  const log = deps.logger ?? logger;

  async function cueIds(
    artifacts: readonly MemoryArtifactRef[],
  ): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const artifact of artifacts) {
      for (const id of aboutLinkedIds(
        await deps.repo.listLinksForArtifact(artifact),
      )) {
        ids.add(id);
      }
    }
    return ids;
  }

  return {
    async recall(request, actor) {
      const parsedActor = memoryActorSchema.safeParse(actor);
      if (!parsedActor.success) {
        return {
          ok: false,
          error: {
            code: "validation_failed",
            message: "The recall actor is not valid.",
            rationale:
              "Recall reads the caller's own visible scope union, so it cannot run without a well-formed actor.",
            instruction: "Supply an actor with a valid visibility.",
            issues: parsedActor.error.issues.map((issue) => ({
              path: issue.path.map(String).join("."),
              message: issue.message,
            })),
          },
        };
      }
      const parsed = memoryRecallRequestSchema.safeParse(request);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "validation_failed",
            message: "The recall request is not valid.",
            rationale:
              "A malformed retrieval request would silently return the wrong slice of the library.",
            instruction: "Correct the named fields and retry.",
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.map(String).join("."),
              message: issue.message,
            })),
          },
        };
      }

      const { query, related, activeArtifacts, scope, budgetChars } =
        parsed.data;
      const mode: MemoryRecallMode =
        related !== null ? "related" : query !== null ? "query" : "ambient";
      const listQuery: MemoryNoteListQuery = {
        visibility: parsedActor.data.visibility,
        ...(scope === undefined ? {} : { scope }),
        includeArchived: false,
      };

      // `related` resolves its own about links AND cues ranking; the
      // conversation's active artifacts cue ranking only.
      const relatedIds =
        related === null ? new Set<string>() : await cueIds([related]);
      const cued = new Set(relatedIds);
      for (const id of await cueIds(activeArtifacts)) cued.add(id);

      const candidates = new Map<string, RankedNote>();
      /**
       * Fuse by rank, not by raw score: `relevance` accumulates each
       * provider's reciprocal-rank contribution. Adding rather than taking a
       * maximum means a record two providers both rank highly outranks one
       * only a single provider likes, and no provider's scale can dominate.
       */
      const remember = (note: MemoryNote, contribution: number): void => {
        const existing = candidates.get(note.id);
        candidates.set(note.id, {
          note,
          aboutLinked: cued.has(note.id),
          relevance: (existing?.relevance ?? 0) + contribution,
        });
      };

      if (query !== null) {
        for (const provider of providers) {
          const ranked = await provider.rank({ query, listQuery });
          for (const [position, candidate] of ranked.entries()) {
            remember(candidate.note, reciprocalRankScore(position));
          }
        }
      }

      if (mode === "ambient" || relatedIds.size > 0) {
        for (const note of await deps.repo.list(listQuery)) {
          if (mode === "ambient") {
            // Ambient delivery is where an unapproved global proposal would
            // prime a conversation that never asked for it (R9), and where a
            // `search-only` record has said it does not belong.
            if (note.lifecycle !== "active") continue;
            if (note.indexMode === "search-only") continue;
            remember(note, 0);
          } else if (relatedIds.has(note.id)) {
            remember(note, 0);
          }
        }
      }

      const ranked = [...candidates.values()].sort(compareRanked);
      const assessments = await deps.freshness.check(
        ranked.map((candidate) => candidate.note),
      );
      const now = deps.now();

      const eligible =
        mode === "ambient"
          ? ranked.filter(
              (candidate) =>
                assessments.get(candidate.note.id)?.ambient !== "withhold",
            )
          : ranked;

      const pack = buildContextPack({
        mode,
        query,
        related,
        ranked: eligible,
        assessments,
        budgetChars,
        now,
      });
      // The frame is mandatory: the header states what was asked and the
      // closing states what was left out. A budget too small to hold both
      // could only be honoured by dropping the disclosure, so the request is
      // refused with the size it would actually need rather than overrun.
      if (pack.text.length > budgetChars) {
        // Only a zero-entry pack can overrun: with entries the builder
        // reserves the closing line exactly, so this length IS the frame.
        const required = pack.text.length;
        return {
          ok: false,
          error: {
            code: "validation_failed",
            message: `A budget of ${budgetChars} characters cannot carry this recall's header and closing line.`,
            rationale:
              "Recall states what it omitted; a budget below the frame could only be met by omitting that statement silently.",
            instruction: `Retry with budgetChars of at least ${required}.`,
            issues: [
              {
                path: "budgetChars",
                message: `this request needs at least ${required} characters (the floor is ${MEMORY_RECALL_MIN_BUDGET_CHARS})`,
              },
            ],
          },
        };
      }
      // R15.2's recall-miss log: one line per answered call, so a query that
      // found nothing is identifiable from the log alone. Identities, counts,
      // sizes, and the (length-capped) query only — never a hook, a body, or a
      // status line, which is what makes this record safe to keep.
      log.info("memory.recall.query", {
        query,
        mode,
        hits: pack.total,
        showing: pack.showing,
        chars: pack.text.length,
        providers: providers.map((provider) => provider.id),
      });
      return { ok: true, value: pack };
    },
  };
}

interface BuildPackInput {
  readonly mode: MemoryRecallMode;
  readonly query: string | null;
  readonly related: MemoryArtifactRef | null;
  readonly ranked: readonly RankedNote[];
  readonly assessments: ReadonlyMap<string, MemoryFreshnessAssessment>;
  readonly budgetChars: number;
  readonly now: string;
}

/**
 * Fill the budget best-first: full bodies for the best few fresh records, then
 * hooks with exact read commands, then an omission line that states what was
 * left out and the command that narrows. Nothing is ever dropped silently —
 * the closing line is rendered from the same counts the structured pack
 * reports, so the two serializations cannot disagree.
 */
function buildContextPack(input: BuildPackInput): MemoryContextPack {
  const header = renderHeader(input.mode, input.query, input.related);
  const entries: MemoryContextPackEntry[] = [];
  let used = header.length;
  let fullCount = 0;
  /**
   * Set the first time the budget refuses a full body. "The best few" is an
   * order as well as a count: once a record is demoted for want of room, no
   * lower-ranked record may take more of the pack than the one above it.
   */
  let budgetDemoted = false;

  const omittedFrom = (index: number): MemoryNote[] =>
    input.ranked.slice(index).map((candidate) => candidate.note);

  for (const [index, candidate] of input.ranked.entries()) {
    const assessment = input.assessments.get(candidate.note.id);
    const statusNote = assessment?.statusNote ?? null;
    const base = {
      note: candidate.note,
      statusLine:
        statusNote === null
          ? null
          : renderMemoryStatusLine(statusNote, input.now),
      readCommand: readCommandFor(candidate.note),
    };
    // Freshness is a GATE, not a score: a withheld record never primes a
    // conversation with a full body, but it stays reachable as a hook plus the
    // command that reads it (R2 keeps stale records retrievable).
    const fullAllowed =
      !budgetDemoted &&
      fullCount < MEMORY_RECALL_FULL_BODY_MAX &&
      assessment?.ambient !== "withhold";

    // Reserve the closing line before spending on this entry: an omission that
    // could not be stated would be a silent truncation.
    const reserve =
      renderClosing(
        entries.length + 1,
        input.ranked.length,
        narrowingCommand(input, omittedFrom(index + 1)),
      ).length + 2;

    const asHook: MemoryContextPackEntry = { ...base, tier: "hook" };
    const hookCost = renderEntry(asHook).length + 2;
    let chosen: MemoryContextPackEntry | null = null;
    if (fullAllowed) {
      const asFull: MemoryContextPackEntry = { ...base, tier: "full" };
      const fullCost = renderEntry(asFull).length + 2;
      if (used + fullCost + reserve <= input.budgetChars) {
        chosen = asFull;
        used += fullCost;
        fullCount += 1;
      } else {
        budgetDemoted = true;
      }
    }
    if (chosen === null) {
      if (used + hookCost + reserve > input.budgetChars) break;
      chosen = asHook;
      used += hookCost;
    }
    entries.push(chosen);
  }

  const narrowCommand = narrowingCommand(input, omittedFrom(entries.length));
  const closing = renderClosing(
    entries.length,
    input.ranked.length,
    narrowCommand,
  );
  const text = [header, ...entries.map(renderEntry), closing].join("\n\n");
  return {
    mode: input.mode,
    entries,
    showing: entries.length,
    total: input.ranked.length,
    narrowCommand,
    text,
  };
}

/**
 * The exact command that discloses what the budget left out. Scope is recall's
 * one filter, so a scope-narrowed re-run is the narrowing — but only when some
 * candidate actually falls outside that scope. Offering `--scope project` to a
 * caller whose every candidate is project-scoped names a command that returns
 * the identical pack, which is a disclosure that discloses nothing; there the
 * honest exact command is the read of the next omitted record.
 */
function narrowingCommand(
  input: BuildPackInput,
  omitted: readonly MemoryNote[],
): string | null {
  const [next] = omitted;
  if (next === undefined) return null;
  const scope = mostSpecificScope(omitted);
  const shrinks = input.ranked.some(
    (candidate) => candidate.note.scope !== scope,
  );
  if (!shrinks) return readCommandFor(next);
  const parts = ["cctl memory recall"];
  if (input.query !== null) parts.push(shellQuote(input.query));
  if (input.related !== null) {
    parts.push(`--related ${renderMemoryArtifactHandle(input.related)}`);
  }
  parts.push(`--scope ${scope}`);
  return parts.join(" ");
}
