/**
 * The dormant floor D4 must parse to when its fields are absent (R14), and the
 * field inventory that floor is measured against.
 *
 * The inventory mirrors the approved persisted-field decision: definition tier
 * `edges[].when`, `contexts[].routing`, `loopGroups[]`; runtime tier
 * `contextStates[].skipReason` / `landingIntent` and the execution-level
 * `routeSettlements` / `routeControlRevisions` / `loopStates` /
 * `expansionReceipts` / `loopControlAmendments`. A D4 field that is not listed
 * here is invisible to the floor probes, so adding a persisted field means
 * adding it here in the same change.
 *
 * Expansion authority is probed differently, and on purpose: it is a cascaded
 * MUTABILITY flag, so the floor is "no mutability entry beyond
 * {@link PRE_D4_MUTABILITY_FIELDS} is turned on" rather than one guessed key
 * name. That survives whatever the flag ends up being called, while staying
 * value-sensitive — see {@link grantsExpansionAuthority}.
 *
 * Test-support only; not imported by production code.
 */
export const D4_ADDITIVE_FIELDS = {
  definition: ["loopGroups"],
  edge: ["when"],
  context: ["routing"],
  execution: [
    "routeSettlements",
    "routeControlRevisions",
    "loopStates",
    "expansionReceipts",
    "loopControlAmendments",
  ],
  contextState: ["skipReason", "landingIntent"],
} as const satisfies Record<string, readonly string[]>;

export const PRE_D4_MUTABILITY_FIELDS: readonly string[] = [
  "allowAgentTaskAdd",
];

/**
 * A mutability entry beyond {@link PRE_D4_MUTABILITY_FIELDS} grants expansion
 * authority only when it is actually TURNED ON. R14's floor is semantic — "and
 * expansion disabled" — so a materialized `allowAgentGraphExpansion: false` (or
 * a nested block whose leaves are all false) is a valid additive parse AT the
 * floor, not a breach of it.
 *
 * `true` enables; every other primitive is read as disabled. That keeps the
 * probe from misreading a name it does not understand as authority — the same
 * discipline `D4_ADDITIVE_FIELDS` states for persisted fields applies here: a
 * D4 slice that represents expansion authority as anything other than a boolean
 * (an enum, a bounded policy object with a non-boolean "on" leaf) must teach
 * this predicate that shape in the same change, or the floor probe silently
 * reads it as dormant.
 */
function grantsExpansionAuthority(value: unknown): boolean {
  if (value === true) return true;
  if (Array.isArray(value)) return value.some(grantsExpansionAuthority);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(grantsExpansionAuthority);
  }
  return false;
}

/**
 * The probes are STRUCTURAL: they read the sites D4 extends, not a nominal
 * definition type. Both authored and resolved definitions satisfy this shape,
 * and so does the post-D4 shape a later slice will produce — which is what lets
 * a test feed the probe a guard-bearing definition and prove it can see one.
 */
export interface FloorProbeDefinition {
  edges: readonly object[];
  executionContexts: readonly object[];
  /** Declared optional here because D4 has not added it yet; read structurally. */
  loopGroups?: unknown;
}

export interface FloorProbeExecution {
  workingDefinition: FloorProbeDefinition;
  contextStates: Readonly<Record<string, object>>;
  routeSettlements?: unknown;
  routeControlRevisions?: unknown;
  loopStates?: unknown;
  expansionReceipts?: unknown;
}

export interface DefinitionFloor {
  edgeActivation: "all-unconditional" | "guard-declared";
  loops: "none-declared" | "declared";
  expansionAuthority: "disabled-on-every-context" | "enabled-somewhere";
}

export interface ExecutionFloor extends DefinitionFloor {
  routing: "no-recorded-decisions" | "decisions-recorded";
  skips: "none" | "present";
}

/**
 * Read an own property without asserting a shape onto the value. The D4 fields
 * do not exist on the current types by construction — that absence IS the
 * property under test — so the probe reaches them as `unknown` and decides on
 * runtime evidence alone.
 */
function readOwnField(value: object, field: string): unknown {
  if (!Object.hasOwn(value, field)) return undefined;
  return Object.entries(value).find(([key]) => key === field)?.[1];
}

/**
 * Does this value carry CONTENT? Emptiness is recursive, because a D4 field
 * whose dormant shape is a record of empty collections (`expansionReceipts`
 * parses to `{accepted: [], refusals: []}` on a pre-D4 row) is materially just
 * as dormant as one that parses to `[]` — and reading its two always-present
 * keys as evidence would report every post-D4 execution as having recorded
 * decisions, which is precisely the false positive the floor exists to rule
 * out. This can only ever turn "declared" into "not declared" for a value that
 * holds nothing, so it narrows the probe to content without weakening it: any
 * primitive leaf anywhere inside still counts.
 */
function carriesContent(held: unknown): boolean {
  if (held === undefined || held === null) return false;
  if (Array.isArray(held)) return held.some(carriesContent);
  if (typeof held === "object") return Object.values(held).some(carriesContent);
  return true;
}

/** A field counts as declared only when it carries content; `[]`/`{}`/null do not. */
function isDeclared(value: object, field: string): boolean {
  return carriesContent(readOwnField(value, field));
}

function anyDeclared(value: object, fields: readonly string[]): boolean {
  return fields.some((field) => isDeclared(value, field));
}

function hasExpansionAuthority(context: object): boolean {
  const mutability = readOwnField(context, "mutability");
  if (typeof mutability !== "object" || mutability === null) return false;
  return Object.entries(mutability).some(
    ([key, value]) =>
      !PRE_D4_MUTABILITY_FIELDS.includes(key) &&
      grantsExpansionAuthority(value),
  );
}

export function projectDefinitionFloor(
  definition: FloorProbeDefinition,
): DefinitionFloor {
  return {
    edgeActivation: definition.edges.some((edge) =>
      anyDeclared(edge, D4_ADDITIVE_FIELDS.edge),
    )
      ? "guard-declared"
      : "all-unconditional",
    loops: anyDeclared(definition, D4_ADDITIVE_FIELDS.definition)
      ? "declared"
      : "none-declared",
    expansionAuthority: definition.executionContexts.some(
      (context) =>
        hasExpansionAuthority(context) ||
        anyDeclared(context, D4_ADDITIVE_FIELDS.context),
    )
      ? "enabled-somewhere"
      : "disabled-on-every-context",
  };
}

export function projectExecutionTierFloor(
  execution: FloorProbeExecution,
): ExecutionFloor {
  return {
    ...projectDefinitionFloor(execution.workingDefinition),
    routing: anyDeclared(execution, D4_ADDITIVE_FIELDS.execution)
      ? "decisions-recorded"
      : "no-recorded-decisions",
    skips: Object.values(execution.contextStates).some((contextState) =>
      anyDeclared(contextState, D4_ADDITIVE_FIELDS.contextState),
    )
      ? "present"
      : "none",
  };
}
