import { z } from "zod";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";

/**
 * The D4 persisted-field inventory (approved decision D12), expressed as key
 * paths into {@link graphWorkflowExecutionSchema}.
 *
 * D12 makes persistence a single authoritative declaration "mirrored by the
 * contract tests". This module IS that mirror, and it is deliberately a list of
 * paths rather than prose: the executions and archived-executions round-trip
 * contracts prove every path below survives real SQLite on BOTH tiers, the
 * blob-bounds gate proves every collection-shaped one is accounted for, and
 * {@link stripD4PersistedFields} derives the pre-D4 floor fixture by removing
 * exactly this list. A D4 field added without an entry here is invisible to all
 * three at once — which is the failure mode the inventory exists to prevent.
 *
 * The path grammar matches the blob-bounds gate: `.` descends an object key,
 * `[]` an array element, `.*` a record value.
 *
 * MUST NOT be imported by production code; it lives under
 * `src/lib/shared/testing/`.
 */

export type D4PersistedTier = "definition" | "runtime";

export interface D4PersistedField {
  readonly path: string;
  readonly tier: D4PersistedTier;
  /**
   * True when the node at `path` is itself a collection the blob-bounds gate
   * has to account for — either statically capped in the schema or discharged
   * in the registry. False for scalars and fixed-key objects.
   */
  readonly collection: boolean;
  readonly note: string;
}

export const D4_PERSISTED_FIELDS: readonly D4PersistedField[] = [
  // --- definition tier ---
  {
    path: "workingDefinition.edges[].id",
    tier: "definition",
    collection: false,
    note: "required unique per edge; a legacy definition's absent/duplicate ids are minted deterministically at the inflate boundary",
  },
  {
    path: "workingDefinition.edges[].when",
    tier: "definition",
    collection: false,
    note: "the activation guard document, or the `else` marker; absent means unconditional",
  },
  {
    path: "workingDefinition.executionContexts[].routing",
    tier: "definition",
    collection: false,
    note: "the source-local cardinality policy the route projection evaluates",
  },
  {
    path: "workingDefinition.executionContexts[].mutability.allowAgentContextAdd",
    tier: "definition",
    collection: false,
    note: "runtime graph-expansion authority (R7). D12 enumerates the new structural tiers and leaves this one to the cascaded config, but R14 makes EVERY new persisted field owe a round-trip, a floor, and a bounds answer — and it is the field the compat floor reads expansion dormancy from",
  },
  {
    path: "workingDefinition.loopGroups",
    tier: "definition",
    collection: true,
    note: "resolved loop groups; absent on every pre-D4 definition",
  },
  {
    path: "workingDefinition.loopGroups[].entryContextId",
    tier: "definition",
    collection: false,
    note: "the authored (logical) single entry of the body",
  },
  {
    path: "workingDefinition.loopGroups[].exitContextId",
    tier: "definition",
    collection: false,
    note: "the authored (logical) single exit an external edge addresses",
  },
  {
    path: "workingDefinition.loopGroups[].until",
    tier: "definition",
    collection: false,
    note: "the exit predicate evaluated against the exit's captured output",
  },
  {
    path: "workingDefinition.loopGroups[].maxPasses",
    tier: "definition",
    collection: false,
    note: "the mandatory per-loop pass cap (there is no completion-on-exhaustion mode)",
  },
  {
    path: "workingDefinition.loopGroups[].template",
    tier: "definition",
    collection: false,
    note: "the frozen body snapshot (contexts, tasks, internal edges) each pass clones from",
  },
  {
    path: "workingDefinition.loopGroups[].templateVersion",
    tier: "definition",
    collection: false,
    note: "bumped by every accepted template content edit; part of a decision's dedup key",
  },
  {
    path: "workingDefinition.loopGroups[].planRepair",
    tier: "definition",
    collection: false,
    note: "resolved at seed, because the resolved definition drops workflow-tier config",
  },
  // --- runtime tier ---
  {
    path: "contextStates.*.skipReason",
    tier: "runtime",
    collection: false,
    note: "set only on a skipped context; carries the COMPLETE incoming-edge verdict set",
  },
  {
    path: "contextStates.*.skipReason.edgeEvaluations",
    tier: "runtime",
    collection: true,
    note: "one verdict per incoming edge, written once when the skip settles",
  },
  {
    path: "contextStates.*.landingIntent",
    tier: "runtime",
    collection: false,
    note: "recorded at DISPATCH with the mode-specific landing evidence, so no evidence lives only in memory",
  },
  {
    path: "routeSettlements",
    tier: "runtime",
    collection: true,
    note: "at most one CURRENT settlement marker per source context",
  },
  {
    path: "routeControlRevisions",
    tier: "runtime",
    collection: true,
    note: "monotonic per source context owning conditional out-edges",
  },
  {
    path: "loopStates",
    tier: "runtime",
    collection: true,
    note: "one bounded ledger per SEED-DECLARED loop group",
  },
  {
    path: "loopStates.*.activation",
    tier: "runtime",
    collection: false,
    note: "unstarted | running | concluded | skipped",
  },
  {
    path: "loopStates.*.passCount",
    tier: "runtime",
    collection: false,
    note: "the ledger's own count, not a graph scan",
  },
  {
    path: "loopStates.*.loopControlRevision",
    tier: "runtime",
    collection: false,
    note: "bumped by an audited amendment; part of a decision's dedup key",
  },
  {
    path: "loopStates.*.slotLedger",
    tier: "runtime",
    collection: true,
    note: "one grant per pass, reserved -> counted | released",
  },
  {
    path: "loopStates.*.boundaryInputs",
    tier: "runtime",
    collection: true,
    note: "the loop's external inputs pinned once at activation and never re-taken",
  },
  {
    path: "loopStates.*.decisions",
    tier: "runtime",
    collection: true,
    note: "the LATEST decision per pass, keyed by pass number; the full history lives in the events table",
  },
  {
    path: "loopControlAmendments",
    tier: "runtime",
    collection: true,
    note: "the audit log of accepted loop-control edits (R11.2/R12); the amended predicate, cap and template live on the working definition, which keeps no history, so a predicate amendment's rationale survives only here",
  },
  {
    path: "expansionReceipts",
    tier: "runtime",
    collection: false,
    note: "the two expansion audit ledgers",
  },
  {
    path: "expansionReceipts.accepted",
    tier: "runtime",
    collection: true,
    note: "permanent within the cumulative cap, which is what makes the budget monotone under removal",
  },
  {
    path: "expansionReceipts.refusals",
    tier: "runtime",
    collection: true,
    note: "a bounded ring; an aged-out attempt is honestly re-validated",
  },
];

/**
 * Where the SHIPPED schema diverges from decision D12's literal text.
 *
 * D12 is a rank-1 source and this list does not license its divergences — it
 * makes them auditable. Each entry names the field as D12 writes it, where the
 * equivalent state actually lives, and why the shapes differ; the accompanying
 * test asserts every `productionPath` still resolves, so the record cannot rot
 * into a stale excuse, and so conforming a field to D12 later FAILS here until
 * its entry is removed.
 *
 * Every divergence was introduced by the task that owns that schema (route
 * settlement and landing intent in the scheduler slice, loop state in the loop
 * settlement slice), not by the persistence sweep. Recorded here because the
 * sweep is where the inventory is reconciled against D12, and a divergence
 * nobody wrote down is one nobody can decide about.
 */
export type D4DivergenceKind =
  /** Same data, different field name. */
  | "renamed"
  /** Same information, different encoding. */
  | "re-encoded"
  /** Not stored; reconstructible from what is. */
  | "derived";

export interface D4D12Divergence {
  /** The field as decision D12 writes it. */
  readonly d12Field: string;
  /** Where the equivalent state lives, or null when nothing is stored. */
  readonly productionPath: string | null;
  readonly kind: D4DivergenceKind;
  readonly note: string;
}

export const D4_D12_DIVERGENCES: readonly D4D12Divergence[] = [
  {
    d12Field: "routeSettlements[*].evaluations",
    productionPath: "routeSettlements.*.activatedEdgeIds",
    kind: "re-encoded",
    note: "the per-edge verdict set is stored as the activatedEdgeIds / inactiveEdgeIds / omittedEdgeIds partition — the same information, one entry per outgoing edge, in three id arrays instead of one evaluation array",
  },
  {
    d12Field: "routeSettlements[*].cardinalityOutcome",
    productionPath: null,
    kind: "derived",
    note: "computed by the shared route projection from the settled edge partition and the source's routing policy; the charter invariant makes that projection the single owner of route semantics, so a stored copy would be a second answer that can go stale",
  },
  {
    d12Field: "routeSettlements[*].at",
    productionPath: "routeSettlements.*.settledAt",
    kind: "renamed",
    note: "same timestamp, spelled settledAt",
  },
  {
    d12Field: "landingIntent.receipts",
    productionPath: "contextStates.*.landingIntent.evidence",
    kind: "re-encoded",
    note: "the mode-specific landing evidence is stored FLAT beside the mode (headSha and worktreePath for lane_commit, joinId for fan_in_merge, evidence naming how the landing was established) rather than nested under a `receipts` key; the round-trip covers all three modes",
  },
  {
    d12Field: "landingIntent.state = retry",
    productionPath: "contextStates.*.landingIntent.state",
    kind: "renamed",
    note: "the third state is spelled `failed`; it carries D12's retry semantics — the land gate re-decides it every pass on positive merge evidence, so a successful retry releases the dependents",
  },
  {
    d12Field: "loopStates[*].activation = pending | active | untaken",
    productionPath: "loopStates.*.activation",
    kind: "renamed",
    note: "spelled unstarted | running | skipped, one-for-one with D12's vocabulary (`concluded` matches); `skipped` also matches the context status a not-taken activation path produces",
  },
];

/**
 * Field names the D4 inventory SUPERSEDED. Absence is a persisted-schema
 * property, not a code-search result: a re-added `commitStatus` would quietly
 * become a second, contradictory answer to "did this context's work land",
 * which is the question `landingIntent` now owns.
 */
export const D4_SUPERSEDED_FIELD_NAMES: readonly string[] = ["commitStatus"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Zod v4 types the wrapper inner nodes as the internal `$ZodType` base; at
 * runtime every node is a real `ZodType`, so narrow by `instanceof`.
 */
function asZodType(node: unknown): z.ZodType | null {
  return node instanceof z.ZodType ? node : null;
}

/** Peel `ZodDefault` / `ZodOptional` / `ZodNullable` off a schema node. */
function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  while (
    current instanceof z.ZodDefault ||
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable
  ) {
    const inner = asZodType(current.def.innerType);
    if (inner === null) return current;
    current = inner;
  }
  return current;
}

type PathSegment =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "element" }
  | { readonly kind: "value" };

function parsePath(path: string): PathSegment[] {
  const segments: PathSegment[] = [];
  for (const token of path.split(".")) {
    if (token === "*") {
      segments.push({ kind: "value" });
      continue;
    }
    let key = token;
    let depth = 0;
    while (key.endsWith("[]")) {
      key = key.slice(0, -2);
      depth += 1;
    }
    segments.push({ kind: "key", key });
    for (let i = 0; i < depth; i += 1) segments.push({ kind: "element" });
  }
  return segments;
}

/**
 * The schema node at `path`, or null when the path does not exist. Proves an
 * inventory entry is still a real persisted field — the round-trip harness
 * cannot, because it walks whatever the schema currently declares and would
 * pass just as happily with a field removed.
 */
export function resolveExecutionSchemaAtPath(path: string): z.ZodType | null {
  let current: z.ZodType = graphWorkflowExecutionSchema;
  for (const segment of parsePath(path)) {
    const node = unwrap(current);
    if (segment.kind === "key") {
      if (!(node instanceof z.ZodObject)) return null;
      const child = node.shape[segment.key];
      if (child === undefined) return null;
      current = child;
      continue;
    }
    if (segment.kind === "element") {
      if (!(node instanceof z.ZodArray)) return null;
      const element = asZodType(node.element);
      if (element === null) return null;
      current = element;
      continue;
    }
    if (!(node instanceof z.ZodRecord)) return null;
    const value = asZodType(node.def.valueType);
    if (value === null) return null;
    current = value;
  }
  return current;
}

/**
 * Every value `path` addresses in `root`, expanding `[]` over array elements
 * and `.*` over record values. A path whose parent is absent contributes
 * nothing; a present-but-undefined leaf contributes `undefined`, so a caller
 * can tell "no such container" from "container present, field missing".
 */
export function collectValuesAtPath(root: unknown, path: string): unknown[] {
  let frontier: unknown[] = [root];
  for (const segment of parsePath(path)) {
    const next: unknown[] = [];
    for (const value of frontier) {
      if (segment.kind === "key") {
        if (!isRecord(value)) continue;
        next.push(value[segment.key]);
        continue;
      }
      if (segment.kind === "element") {
        if (!Array.isArray(value)) continue;
        next.push(...value);
        continue;
      }
      if (!isRecord(value)) continue;
      next.push(...Object.values(value));
    }
    frontier = next;
  }
  return frontier;
}

/**
 * Key-sorted JSON, so two structurally equal values stringify identically no
 * matter what order their keys were built in. Only an ordering key — callers
 * still compare the values themselves by deep equality.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The values at `path`, canonically ordered.
 *
 * A `.*` expansion walks record values in key order, and nothing guarantees a
 * reloaded blob rebuilt its records in the order the fixture wrote them — so
 * comparing the raw expansions could read a reordered map as a dropped field.
 * Ordering by content instead makes the comparison about WHICH values survived,
 * which is the durability question; a mutated payload still fails, because the
 * caller compares the ordered lists by deep equality.
 */
export function canonicalValuesAtPath(root: unknown, path: string): unknown[] {
  return [...collectValuesAtPath(root, path)].sort((a, b) =>
    stableStringify(a).localeCompare(stableStringify(b)),
  );
}

/**
 * True when a fixture value proves nothing about its field: absent, null, or an
 * empty container. A maximal fixture has to populate every inventory path with
 * real content, or the round-trip it feeds is vacuous for that field.
 */
export function isEmptyForFixture(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

function deleteAtPath(root: unknown, segments: readonly PathSegment[]): void {
  const [head, ...rest] = segments;
  if (head === undefined) return;

  if (rest.length === 0) {
    if (head.kind !== "key") return;
    if (isRecord(root)) delete root[head.key];
    return;
  }

  if (head.kind === "key") {
    if (!isRecord(root)) return;
    deleteAtPath(root[head.key], rest);
    return;
  }
  if (head.kind === "element") {
    if (!Array.isArray(root)) return;
    for (const element of root) deleteAtPath(element, rest);
    return;
  }
  if (!isRecord(root)) return;
  for (const value of Object.values(root)) deleteAtPath(value, rest);
}

/**
 * A pre-D4 execution blob, derived from a post-D4 one by removing EXACTLY the
 * inventory. Derived rather than hand-written on purpose: a hand-written legacy
 * literal drifts into "some old shape nobody writes any more", whereas this one
 * is by construction the current maximal fixture minus the D4 fields — so it
 * keeps proving the floor as the rest of the execution schema evolves, and a
 * new inventory entry strengthens the floor test for free.
 *
 * Takes and returns a RAW record: the input has already lost fields the current
 * schema requires (`edges[].id`), so it cannot be a parsed execution.
 */
export function stripD4PersistedFields(
  execution: unknown,
): Record<string, unknown> {
  const stripped: unknown = JSON.parse(JSON.stringify(execution));
  if (!isRecord(stripped)) {
    throw new Error("expected an execution-shaped record to strip");
  }
  for (const field of D4_PERSISTED_FIELDS) {
    deleteAtPath(stripped, parsePath(field.path));
  }
  return stripped;
}
