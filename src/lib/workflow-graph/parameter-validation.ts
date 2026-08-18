import { z } from "zod";

import type {
  ParameterDeclaration,
  WorkflowGraphValidationError,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";

function checkDuplicateNames(
  parameters: ParameterDeclaration[],
): WorkflowGraphValidationError[] {
  const errors: WorkflowGraphValidationError[] = [];
  const seen = new Set<string>();

  for (const parameter of parameters) {
    if (seen.has(parameter.name)) {
      errors.push({
        code: "duplicate-parameter-name",
        message: `Parameter name "${parameter.name}" is declared more than once`,
        parameterName: parameter.name,
      });
      continue;
    }
    seen.add(parameter.name);
  }

  return errors;
}

function checkEnumDeclaration(
  parameter: Extract<ParameterDeclaration, { type: "enum" }>,
): WorkflowGraphValidationError[] {
  if (parameter.options.length === 0) {
    return [
      {
        code: "empty-enum-options",
        message: `Enum parameter "${parameter.name}" must declare at least one option`,
        parameterName: parameter.name,
      },
    ];
  }

  if (
    parameter.default !== undefined &&
    !parameter.options.includes(parameter.default)
  ) {
    return [
      {
        code: "default-not-in-enum-options",
        message: `Enum parameter "${parameter.name}" default "${parameter.default}" is not one of its options`,
        parameterName: parameter.name,
      },
    ];
  }

  return [];
}

function checkLengthDeclaration(
  parameter: Extract<ParameterDeclaration, { type: "string" | "text" }>,
): WorkflowGraphValidationError[] {
  if (parameter.default === undefined) return [];

  const length = parameter.default.length;

  if (parameter.minLength !== undefined && length < parameter.minLength) {
    return [
      {
        code: "default-length-out-of-bounds",
        message: `Parameter "${parameter.name}" default is shorter than its minimum length of ${parameter.minLength}`,
        parameterName: parameter.name,
      },
    ];
  }

  if (parameter.maxLength !== undefined && length > parameter.maxLength) {
    return [
      {
        code: "default-length-out-of-bounds",
        message: `Parameter "${parameter.name}" default is longer than its maximum length of ${parameter.maxLength}`,
        parameterName: parameter.name,
      },
    ];
  }

  return [];
}

function checkDeclarationShape(
  parameter: ParameterDeclaration,
): WorkflowGraphValidationError[] {
  if (parameter.type === "enum") return checkEnumDeclaration(parameter);
  return checkLengthDeclaration(parameter);
}

/**
 * Accept-time shape validation for declared launch parameters. Collects every
 * violation (does not short-circuit) in declaration order, returning
 * graph-validation-shaped errors so it composes with `validateWorkflowDefinition`.
 * Each error carries a `parameterName` locator identifying the offending
 * parameter.
 */
export function validateParameterDeclarations(
  parameters: ParameterDeclaration[],
): WorkflowGraphValidationError[] {
  const errors: WorkflowGraphValidationError[] = [
    ...checkDuplicateNames(parameters),
  ];

  for (const parameter of parameters) {
    errors.push(...checkDeclarationShape(parameter));
  }

  return errors;
}

// ============================================================
// Scanned-field surface (shared anti-drift definition)
// ============================================================
//
// The single source of truth for which fields participate in placeholder
// substitution. Both `lintParameterReferences` (here, authoring-time) and
// `substituteContent` (task 2.4, seed-time) MUST derive their field surface
// from this one constant via `forEachScannedField` — neither may enumerate
// fields independently. This is the load-bearing anti-drift mechanism: if the
// lint scan and the substitution pass ever diverged, either a `{{...}}` token
// would escape to an agent as literal text (linted-but-not-substituted) or a
// rendered field would be substituted without ever being linted. The
// `charterFields` list below is asserted against `charter/render.ts` by a
// drift-guard test so a newly rendered charter text field cannot be added to
// prompts/docs without being registered as substitutable here.

// A stable, human-readable identifier for a charter text field, used both to
// build error locators (e.g. `charter.mission`) and to anchor the drift guard.
type CharterFieldKey =
  | "mission"
  | "conventions"
  | "nonGoals"
  | "vocabulary"
  | "testStrategy"
  | "knownAmbiguities"
  | "invariant.statement"
  | "source.label"
  | "source.locator"
  | "source.description"
  | "source.appliesTo";

const CHARTER_FIELD_KEYS: readonly CharterFieldKey[] = [
  "mission",
  "conventions",
  "nonGoals",
  "vocabulary",
  "testStrategy",
  "knownAmbiguities",
  "invariant.statement",
  "source.label",
  "source.locator",
  "source.description",
  "source.appliesTo",
];

export const SUBSTITUTION_FIELD_SET = {
  // Content fields scanned per R2.1: each task's instructions (NOT title),
  // each context's title, description (when present), and acceptanceCriteria.
  contentFields: [
    "tasks[].instructions",
    "executionContexts[].title",
    "executionContexts[].description",
    "executionContexts[].acceptanceCriteria",
  ] as const,
  // Charter text fields rendered by charter/render.ts (drift-guard anchored).
  charterFields: CHARTER_FIELD_KEYS,
} as const;

// Visitor invoked once per present scanned field with a stable locator and the
// field's value. `forEachScannedField` is the single read traversal of the
// scanned-field surface; the write-capable `mapScannedFields` counterpart mirrors
// the same field list (both are built from `scannedFieldAccessors` below) so the
// read and write surfaces cannot diverge.
type ScannedFieldVisitor = (locator: string, value: string) => void;

// A field transform for `mapScannedFields`: given the current value and its
// stable locator, return the replacement value.
type ScannedFieldTransform = (value: string, locator: string) => string;

// One accessor describes how to READ every present occurrence of a single
// scanned field and how to WRITE a replacement for it on a target definition.
// `read` yields `[locator, value]` for each present occurrence (an absent
// optional yields nothing; an array yields one entry per element); `write`
// applies the transform to that same set of occurrences on `target` in place.
// Building both traversals from this one list is the load-bearing anti-drift
// mechanism: the read surface (lint) and the write surface (substitution) are
// literally the same field list, so neither can scan or substitute a field the
// other misses.
interface ScannedFieldAccessor {
  read(definition: WorkflowSemanticDefinition): Array<[string, string]>;
  write(
    target: WorkflowSemanticDefinition,
    transform: ScannedFieldTransform,
  ): void;
}

// Accessor for a single optional/required string field reachable by getter/setter.
function stringFieldAccessor<Owner>(
  locator: string,
  owner: (definition: WorkflowSemanticDefinition) => Owner | undefined,
  get: (owner: Owner) => string | undefined,
  set: (owner: Owner, value: string) => void,
): ScannedFieldAccessor {
  return {
    read(definition) {
      const target = owner(definition);
      if (target === undefined) return [];
      const value = get(target);
      if (value === undefined) return [];
      return [[locator, value]];
    },
    write(definition, transform) {
      const target = owner(definition);
      if (target === undefined) return;
      const value = get(target);
      if (value === undefined) return;
      set(target, transform(value, locator));
    },
  };
}

// Accessor for a single optional `string[]` field; each element is an
// independently located, independently transformed occurrence.
function stringArrayFieldAccessor<Owner>(
  prefix: string,
  owner: (definition: WorkflowSemanticDefinition) => Owner | undefined,
  get: (owner: Owner) => string[] | undefined,
): ScannedFieldAccessor {
  return {
    read(definition) {
      const target = owner(definition);
      if (target === undefined) return [];
      const values = get(target);
      if (values === undefined) return [];
      return values.map((value, index) => [`${prefix}[${index}]`, value]);
    },
    write(definition, transform) {
      const target = owner(definition);
      if (target === undefined) return;
      const values = get(target);
      if (values === undefined) return;
      values.forEach((value, index) => {
        values[index] = transform(value, `${prefix}[${index}]`);
      });
    },
  };
}

// The single ordered list of scanned-field accessors. Charter fields first, then
// content fields, matching the deterministic traversal order. Index-dependent
// accessors (sources, contexts, tasks) are generated from the supplied
// definition's array lengths so a freshly cloned target has the same indices.
function buildScannedFieldAccessors(
  definition: WorkflowSemanticDefinition,
): ScannedFieldAccessor[] {
  const accessors: ScannedFieldAccessor[] = [
    stringFieldAccessor(
      "charter.mission",
      (def) => def.charter,
      (charter) => charter.mission,
      (charter, value) => {
        charter.mission = value;
      },
    ),
    stringArrayFieldAccessor(
      "charter.conventions",
      (def) => def.charter,
      (charter) => charter.conventions,
    ),
    stringArrayFieldAccessor(
      "charter.nonGoals",
      (def) => def.charter,
      (charter) => charter.nonGoals,
    ),
    stringArrayFieldAccessor(
      "charter.vocabulary",
      (def) => def.charter,
      (charter) => charter.vocabulary,
    ),
    stringFieldAccessor(
      "charter.testStrategy",
      (def) => def.charter,
      (charter) => charter.testStrategy,
      (charter, value) => {
        charter.testStrategy = value;
      },
    ),
    stringArrayFieldAccessor(
      "charter.knownAmbiguities",
      (def) => def.charter,
      (charter) => charter.knownAmbiguities,
    ),
  ];

  // Invariant `id` is structural (validators cite it in issues) and therefore
  // NOT substitutable — only the statement text participates.
  (definition.charter.invariants ?? []).forEach((_invariant, index) => {
    accessors.push(
      stringFieldAccessor(
        `charter.invariants[${index}].statement`,
        (def) => def.charter.invariants?.[index],
        (invariant) => invariant.statement,
        (invariant, value) => {
          invariant.statement = value;
        },
      ),
    );
  });

  definition.charter.sourcesOfTruth.forEach((_source, index) => {
    const prefix = `charter.sourcesOfTruth[${index}]`;
    const owner = (def: WorkflowSemanticDefinition) =>
      def.charter.sourcesOfTruth[index];
    accessors.push(
      stringFieldAccessor(
        `${prefix}.label`,
        owner,
        (source) => source.label,
        (source, value) => {
          source.label = value;
        },
      ),
      stringFieldAccessor(
        `${prefix}.locator`,
        owner,
        (source) => source.locator,
        (source, value) => {
          source.locator = value;
        },
      ),
      stringFieldAccessor(
        `${prefix}.description`,
        owner,
        (source) => source.description,
        (source, value) => {
          source.description = value;
        },
      ),
      stringFieldAccessor(
        `${prefix}.appliesTo`,
        owner,
        // Only the legacy prose form is a substitutable string; a structured
        // scope holds context ids, which are graph structure, not template
        // prose.
        (source) =>
          typeof source.appliesTo === "string" ? source.appliesTo : undefined,
        (source, value) => {
          source.appliesTo = value;
        },
      ),
    );
  });

  definition.executionContexts.forEach((_context, index) => {
    const prefix = `executionContexts[${index}]`;
    const owner = (def: WorkflowSemanticDefinition) =>
      def.executionContexts[index];
    accessors.push(
      stringFieldAccessor(
        `${prefix}.title`,
        owner,
        (context) => context.title,
        (context, value) => {
          context.title = value;
        },
      ),
      stringFieldAccessor(
        `${prefix}.description`,
        owner,
        (context) => context.description,
        (context, value) => {
          context.description = value;
        },
      ),
      stringFieldAccessor(
        `${prefix}.acceptanceCriteria`,
        owner,
        (context) => context.acceptanceCriteria,
        (context, value) => {
          context.acceptanceCriteria = value;
        },
      ),
    );
  });

  definition.tasks.forEach((_task, index) => {
    const owner = (def: WorkflowSemanticDefinition) => def.tasks[index];
    accessors.push(
      stringFieldAccessor(
        `tasks[${index}].instructions`,
        owner,
        (task) => task.instructions,
        (task, value) => {
          task.instructions = value;
        },
      ),
    );
  });

  return accessors;
}

// Single shared READ traversal over the scanned-field surface. Charter fields are
// visited first, then content fields, in a deterministic order. Absent optional
// fields are skipped. Only the registered text fields are touched — never ids,
// task.order, edges, or command/config fields.
export function forEachScannedField(
  definition: WorkflowSemanticDefinition,
  visit: ScannedFieldVisitor,
): void {
  for (const accessor of buildScannedFieldAccessors(definition)) {
    for (const [locator, value] of accessor.read(definition)) {
      visit(locator, value);
    }
  }
}

// Single shared WRITE traversal over the same scanned-field surface as
// `forEachScannedField`. Returns a NEW definition (the input is never mutated)
// with ONLY the scanned text fields transformed; ids, task.order, edges, charter
// structural fields, and every command/config field are deep-copied through
// untouched. Both traversals derive from `buildScannedFieldAccessors`, so the
// read surface (lint) and the write surface (substitution) cannot drift.
export function mapScannedFields(
  definition: WorkflowSemanticDefinition,
  transform: ScannedFieldTransform,
): WorkflowSemanticDefinition {
  const next = structuredClone(definition);
  for (const accessor of buildScannedFieldAccessors(next)) {
    accessor.write(next, transform);
  }
  return next;
}

// ============================================================
// Placeholder-grammar + reference lint (authoring-time, R2.2–R2.8)
// ============================================================

// Locates every `{{` opener in a scanned field. The lint must flag every `{{`
// occurrence (there is no escape mechanism in v1), so the scan keys on the
// opener rather than only on well-formed tokens.
const OPENER = "{{";

/**
 * Whether a string contains a placeholder opener (`{{`). This is the single
 * shared `{{...}}` detection primitive: the authoring-time placeholder lint here
 * keys on this opener (any `{{` occurrence is a token, valid or not, since v1 has
 * no escape mechanism), and the prerequisite validator reuses it so the two
 * accept-time lints can never diverge on what counts as a placeholder.
 */
export function containsPlaceholderOpener(value: string): boolean {
  return value.includes(OPENER);
}

// The ONLY valid token: `{{inputs.<name>}}` with no internal whitespace. The
// name class is a sane identifier set (kebab/identifier characters), matching
// the parameter-name shape.
const VALID_TOKEN_RE = /^\{\{inputs\.([A-Za-z0-9_-]+)\}\}/;

function hasEffectiveValue(parameter: ParameterDeclaration): boolean {
  return parameter.required || parameter.default !== undefined;
}

// Scan a single field value, emitting a lint error for every grammar violation
// and every reference resolution problem, in left-to-right order.
function lintField(
  field: string,
  value: string,
  parametersByName: Map<string, ParameterDeclaration>,
): WorkflowGraphValidationError[] {
  const errors: WorkflowGraphValidationError[] = [];

  let cursor = 0;
  while (cursor < value.length) {
    const openerIndex = value.indexOf(OPENER, cursor);
    if (openerIndex === -1) break;

    const match = VALID_TOKEN_RE.exec(value.slice(openerIndex));
    if (!match) {
      const snippet = value.slice(openerIndex, openerIndex + 32);
      errors.push({
        code: "invalid-placeholder-token",
        message: `Field "${field}" contains an invalid placeholder token near "${snippet}"; the only valid token is {{inputs.<name>}} with no internal whitespace`,
        field,
      });
      // Advance past this opener so overlapping `{{` are each reported.
      cursor = openerIndex + OPENER.length;
      continue;
    }

    const name = match[1];
    if (name === undefined) {
      cursor = openerIndex + match[0].length;
      continue;
    }

    const parameter = parametersByName.get(name);
    if (parameter === undefined) {
      errors.push({
        code: "undeclared-parameter-reference",
        message: `Field "${field}" references undeclared parameter "${name}"`,
        field,
        parameterName: name,
      });
    } else if (!hasEffectiveValue(parameter)) {
      errors.push({
        code: "referenced-parameter-without-value",
        message: `Field "${field}" references parameter "${name}", which is neither required nor defaulted, so substitution would have no effective value`,
        field,
        parameterName: name,
      });
    }

    cursor = openerIndex + match[0].length;
  }

  return errors;
}

/**
 * Accept-time placeholder-grammar + reference lint over the closed scanned-field
 * set (content fields + every agent-rendered charter text field, defined once in
 * `SUBSTITUTION_FIELD_SET` and traversed by `forEachScannedField`). Collects ALL
 * violations in deterministic traversal order; pure, no logging.
 *
 * This is the authoring-time grammar lint (R2). It MUST stay distinct from the
 * structural `validateWorkflowDefinition` and MUST NOT be re-applied to
 * substituted launcher data (R5.1, R5.5) — a bound value may legitimately
 * contain a literal `{{...}}`.
 */
export function lintParameterReferences(
  definition: WorkflowSemanticDefinition,
): WorkflowGraphValidationError[] {
  const parametersByName = new Map<string, ParameterDeclaration>();
  for (const parameter of definition.parameters) {
    if (!parametersByName.has(parameter.name)) {
      parametersByName.set(parameter.name, parameter);
    }
  }

  const errors: WorkflowGraphValidationError[] = [];
  forEachScannedField(definition, (field, value) => {
    errors.push(...lintField(field, value, parametersByName));
  });

  return errors;
}

// ============================================================
// Start-time launch-input schema derivation (R3.1, R3.3–R3.5, R3.7)
// ============================================================

// Build the base value schema for one parameter from its declared type and
// validation options — BEFORE required/default is applied. Length bounds apply
// to string/text; the option set constrains enum.
function buildFieldBaseSchema(
  parameter: ParameterDeclaration,
): z.ZodType<string> {
  if (parameter.type === "enum") {
    // Empty options is an accept-time error (validateParameterDeclarations
    // flags it); this pure derivation must not throw, so fall back to a schema
    // that accepts no value.
    if (parameter.options.length === 0) {
      return z.string().refine(() => false, {
        message: "Enum parameter declares no options",
      });
    }
    return z.enum(parameter.options as [string, ...string[]]);
  }

  let schema = z.string();
  if (parameter.minLength !== undefined) {
    schema = schema.min(parameter.minLength);
  }
  if (parameter.maxLength !== undefined) {
    schema = schema.max(parameter.maxLength);
  }
  return schema;
}

// Apply required/default semantics to the base field schema. A declared default
// wins (an omitted value yields it); otherwise a required parameter stays
// required and an optional one becomes optional.
function applyPresence(
  parameter: ParameterDeclaration,
  base: z.ZodType<string>,
): z.ZodTypeAny {
  if (parameter.default !== undefined) {
    return base.default(parameter.default);
  }
  if (parameter.required) {
    return base;
  }
  return base.optional();
}

/**
 * Start-time: derive a per-launch `.strict()` Zod object schema keyed by each
 * parameter's `name`. Each field's value is constrained by the declared type and
 * validation options (string/text length, enum option set), with required/default
 * applied so an omitted value either yields the default, fails (required), or is
 * absent (optional). `.strict()` rejects any unknown KEY — a supplied name that is
 * not a declared parameter — but applies NO secret-content constraint or redaction
 * (R3.7): accepted values pass through unconstrained except for type/length/enum.
 *
 * A zero-parameter definition derives `z.object({}).strict()`: an empty payload
 * parses to `{}` and any key is rejected.
 */
export function buildLaunchInputSchema(
  parameters: ParameterDeclaration[],
): z.ZodType<Record<string, string>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const parameter of parameters) {
    shape[parameter.name] = applyPresence(
      parameter,
      buildFieldBaseSchema(parameter),
    );
  }

  return z.object(shape).strict() as z.ZodType<Record<string, string>>;
}
