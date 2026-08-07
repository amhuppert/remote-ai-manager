/**
 * The exact ceilings a runtime graph expansion is bounded by (D4 R8).
 *
 * A leaf module with no imports, on purpose. The numbers are needed in two
 * places that cannot import each other: `schemas.ts` bounds the persisted
 * receipt ledgers with them (`.max()`, which is what the persisted-blob-bounds
 * gate reads), and `expansion-receipts.ts` enforces them. Declaring them here
 * makes "the schema bound and the enforced cap are the same number" a property
 * of the code rather than a comment, without the schema module picking up a
 * `node:crypto` dependency it would then leak into every client bundle that
 * imports an execution type.
 *
 * The caps are EXACT: a request AT a ceiling is admitted, one past it is
 * refused.
 */
export const EXPANSION_CAPS = {
  /** New contexts one request may create. */
  contextsPerRequest: 5,
  /** Tasks one request may seed across all the contexts it creates. */
  tasksPerRequest: 25,
  /** Edges one request may add. */
  edgesPerRequest: 40,
  /** Canonical-JSON payload size, in UTF-8 bytes. */
  canonicalPayloadBytes: 64 * 1024,
  /**
   * Contexts a SINGLE invoking context may create across all of its accepted
   * expansions. Counted from the permanent acceptance receipts, so it is
   * monotone: removing a generated context never returns budget.
   */
  contextsPerAddingContext: 10,
  /**
   * Expansion-created contexts per execution, cumulative. Seed contexts and
   * loop-pass clones are excluded by construction — neither rides the expansion
   * service, so neither leaves an acceptance receipt to count.
   */
  contextsPerExecution: 25,
  /** How many of the most recent refusals per execution stay durable. */
  refusalRingSize: 20,
} as const;
