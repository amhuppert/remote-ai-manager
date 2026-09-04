import type {
  MemoryNoteListQuery,
  MemoryRepo,
} from "@/lib/state-store/memory-repo";

import type { MemoryNote } from "./schemas";

/**
 * One candidate a ranked provider offers. `relevance` is higher-is-better and
 * comparable only among candidates from the SAME provider — bm25 and a cosine
 * similarity are not on one scale. The recall path therefore never compares
 * these numbers across providers; it reads each provider's ORDER and fuses by
 * rank (see `reciprocalRankScore`), which is scale-free.
 */
export interface MemoryRankedCandidate {
  readonly note: MemoryNote;
  readonly relevance: number;
}

export interface MemoryRankedRequest {
  readonly query: string;
  /** The caller's visible scope union: a provider never widens it. */
  readonly listQuery: MemoryNoteListQuery;
}

/**
 * The retrieval seam (D5). A semantic ranker joins by implementing this
 * interface and being registered beside the lexical provider — no schema
 * change, no second recall contract, and the ranking, freshness gate, and
 * bounded pack above it stay exactly as they are.
 *
 * `rank` returns every record it considers a match, best-first, and does not
 * bound the list: bounding is the pack's job, and a provider that silently
 * dropped its tail would make the pack's showing-N-of-M report an M smaller
 * than the number of records that actually matched.
 */
export interface MemoryRankedProvider {
  readonly id: string;
  rank(request: MemoryRankedRequest): Promise<MemoryRankedCandidate[]>;
}

/**
 * A candidate's contribution to the fused score, from its POSITION in one
 * provider's ordering rather than that provider's raw relevance. Reciprocal
 * rank is bounded in (0, 1] whatever the underlying scale, so registering a
 * second provider cannot let one scoring scheme swamp the other, and summing
 * across providers rewards a record several providers agree on.
 */
export function reciprocalRankScore(position: number): number {
  return 1 / (1 + position);
}

// ============================================================
// Exact-match boosts (R7)
// ============================================================

/**
 * The whole query IS a handle. A search for a slug or an alias is a request
 * for that record by name, so it outranks every prose match, however good.
 */
const BOOST_HANDLE_EXACT = 1000;

/** One token of the query is a handle: the same intent, stated among others. */
const BOOST_HANDLE_TOKEN = 400;

/**
 * A distinguishing literal — a path, a symbol, a native artifact handle —
 * occurs verbatim in the record. Stemmed lexical matching cannot tell
 * `onTaskUpdate` from a note that merely discusses updating tasks; a
 * case-sensitive occurrence can.
 */
const BOOST_LITERAL = 60;

/** `src/lib/memory/recall.ts` — at least one separator between path-ish parts. */
const PATH_LIKE = /^[\w@.-]+(?:\/[\w@.-]+)+$/u;

/** `command-center#74`, `#74` — a native artifact handle as agents write it. */
const ARTIFACT_HANDLE = /^[a-z0-9][a-z0-9-]*#\d+$/iu;

/** `repo.search`, `Database.prepare` — a dotted member path. */
const DOTTED_SYMBOL = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]+)+$/u;

/** A bare identifier; only distinguishing SHAPES count (see `isSymbolLike`). */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

/** Punctuation an agent's prose wraps a literal in, stripped before matching. */
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}_$#/@.-]+|[^\p{L}\p{N}_$#/@-]+$/gu;

function queryTokens(query: string): string[] {
  return query
    .split(/\s+/u)
    .map((token) => token.replace(EDGE_PUNCTUATION, ""))
    .filter((token) => token !== "");
}

/**
 * Whether a bare identifier is distinctive enough to be a literal rather than
 * an ordinary word: camelCase, an ALL-CAPS symbol, or a snake_case name. Plain
 * lowercase words are left to the stemmed index, which is what they are for.
 */
function isSymbolLike(token: string): boolean {
  if (!IDENTIFIER.test(token)) return false;
  if (token.includes("_")) return true;
  if (
    token.length >= 3 &&
    token === token.toUpperCase() &&
    /[A-Z]/u.test(token)
  )
    return true;
  return /^[a-z$_][\w$]*[A-Z]/u.test(token);
}

/**
 * The distinguishing literals in a query: paths, symbols, and native artifact
 * handles. A handle here is matched as TEXT against the record — resolving it
 * to an artifact and following its links is `--related`'s job, and doing it
 * implicitly would make a prose mention create retrieval semantics (D6).
 */
export function memoryQueryLiterals(query: string): string[] {
  const literals = new Set<string>();
  for (const token of queryTokens(query)) {
    if (
      PATH_LIKE.test(token) ||
      ARTIFACT_HANDLE.test(token) ||
      DOTTED_SYMBOL.test(token) ||
      isSymbolLike(token)
    ) {
      literals.add(token);
    }
  }
  return [...literals];
}

/**
 * The exact-match boost this record earns for this query (R7). Zero is the
 * ordinary case: most queries are prose, and prose is the stemmed index's job.
 */
export function memoryExactMatchBoost(query: string, note: MemoryNote): number {
  const handles = new Set([
    note.slug.toLowerCase(),
    ...note.aliases.map((alias) => alias.toLowerCase()),
  ]);
  const normalized = query.trim().toLowerCase();
  let boost = handles.has(normalized) ? BOOST_HANDLE_EXACT : 0;

  const tokens = queryTokens(query);
  if (boost === 0 && tokens.some((token) => handles.has(token.toLowerCase()))) {
    boost = BOOST_HANDLE_TOKEN;
  }

  // Case-sensitive on purpose: the whole value of a literal boost is telling
  // `ENAMETOOLONG` apart from the same letters in running prose.
  for (const literal of memoryQueryLiterals(query)) {
    if (note.hook.includes(literal) || note.body.includes(literal)) {
      boost += BOOST_LITERAL;
    }
  }
  return boost;
}

/**
 * The V1 provider: normalized, stemmed FTS5 over slug, hook, aliases, and body
 * with the exact-match boosts above. bm25 is negative and orders ascending, so
 * it is negated into a higher-is-better relevance the boosts can add to.
 */
export function createLexicalMemoryProvider(
  repo: MemoryRepo,
): MemoryRankedProvider {
  return {
    id: "lexical-fts5",
    async rank(request) {
      const hits = await repo.search(request.query, request.listQuery);
      // Every hit, not a top slice: the FTS query has already materialized
      // them, and dropping the tail here would cost the pack the honest count
      // of what matched without saving the work that produced it.
      return hits
        .map((hit) => ({
          note: hit.note,
          relevance:
            -hit.score + memoryExactMatchBoost(request.query, hit.note),
        }))
        .sort(
          (left, right) =>
            right.relevance - left.relevance ||
            left.note.slug.localeCompare(right.note.slug),
        );
    },
  };
}
