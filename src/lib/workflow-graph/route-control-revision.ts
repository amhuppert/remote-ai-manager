/**
 * The per-source monotonic route-control revision (D4 decision D2).
 *
 * Route settlement is deduplicated on `(sourceContextId, captureIteration,
 * routeControlRevision)`. The revision exists because a content hash of the
 * guard set is not collision-proof under editing: changing a source's guards
 * from A to B and back to A reproduces A's hash, which would suppress a
 * legitimate re-settlement. A monotonic counter cannot.
 *
 * The trigger set is CLOSED, and it is closed by construction rather than by
 * bookkeeping: a source bumps exactly when its ROUTE CONTROL SURFACE — its
 * outgoing conditional edges (guards and else edges alike) and its
 * `routing.cardinality` — differs before and after a mutation. Every listed
 * trigger changes that surface, and nothing else in the definition touches it.
 * That is why one derivation covers live edits, runtime expansion, and loop
 * unrolling without each of them re-declaring when to bump: they all mutate the
 * definition through the same seam, and the diff sees the result.
 */

/**
 * The closed list of changes that bump a source's revision, in the wording of
 * decision D2. Nothing else bumps it — a test at the mutation seam walks the
 * whole edit vocabulary and pins that.
 */
export const ROUTE_CONTROL_REVISION_BUMP_TRIGGERS = [
  "outgoing-conditional-edge-added",
  "outgoing-conditional-edge-updated",
  "outgoing-conditional-edge-removed",
  "routing-cardinality-changed",
] as const;

/**
 * Read structurally: the authored and resolved definitions both satisfy this,
 * so the projection serves the saved tier's shape and the live tier's alike.
 */
export interface RouteControlSurfaceDefinition {
  readonly executionContexts: readonly {
    readonly id: string;
    readonly routing?: { readonly cardinality?: string } | undefined;
  }[];
  readonly edges: readonly {
    readonly id: string;
    readonly sourceContextId: string;
    readonly targetContextId: string;
    readonly when?: unknown;
  }[];
}

/**
 * Bump every source whose route-control surface changed, leaving every other
 * entry exactly as it was. Entries for contexts that no longer exist are
 * dropped, which is what keeps the persisted map bounded by the live context
 * set rather than by edit history.
 */
export function bumpRouteControlRevisions(
  previous: Readonly<Record<string, number>>,
  before: RouteControlSurfaceDefinition,
  after: RouteControlSurfaceDefinition,
): Record<string, number> {
  const beforeSurface = projectRouteControlSurface(before);
  const afterSurface = projectRouteControlSurface(after);

  const next: Record<string, number> = {};
  for (const [contextId, signature] of afterSurface) {
    const current = previous[contextId] ?? 0;
    // A context that did not exist before starts at the implicit floor of 0
    // however it was born (live add, expansion, loop-pass clone): there is no
    // earlier settlement of ITS routes for a bump to invalidate, and treating
    // its first appearance as a change would hand every new context a revision
    // it never earned.
    const existedBefore = beforeSurface.has(contextId);
    if (existedBefore && beforeSurface.get(contextId) !== signature) {
      next[contextId] = current + 1;
    } else if (contextId in previous) {
      next[contextId] = current;
    }
  }
  return next;
}

/**
 * One canonical signature per context covering everything that can change how
 * its outgoing routes are decided. Contexts with no conditional edges and no
 * routing policy still get an entry (the empty surface), so a guard's ARRIVAL is
 * a difference rather than a first sighting.
 */
function projectRouteControlSurface(
  definition: RouteControlSurfaceDefinition,
): Map<string, string> {
  const conditionalBySource = new Map<string, [string, unknown][]>();
  for (const edge of definition.edges) {
    if (edge.when === undefined) continue;
    const entries = conditionalBySource.get(edge.sourceContextId) ?? [];
    entries.push([edge.id, edge.when]);
    conditionalBySource.set(edge.sourceContextId, entries);
  }

  const surface = new Map<string, string>();
  for (const context of definition.executionContexts) {
    // Sorted by edge id so array order — which carries no routing meaning under
    // the order-free activation rule — cannot fake a change.
    const conditional = (conditionalBySource.get(context.id) ?? []).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    );
    surface.set(
      context.id,
      canonicalize({
        cardinality: context.routing?.cardinality ?? null,
        conditional,
      }),
    );
  }
  return surface;
}

/**
 * Key-sorted JSON. A guard document that only round-tripped through a different
 * key order is the same guard, and a spurious bump would force a pointless
 * re-settlement of every route from that source.
 */
function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    .join(",")}}`;
}
