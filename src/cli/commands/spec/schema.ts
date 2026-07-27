/**
 * `cctl spec schema` — the agent surface describing its own input documents
 * (R24.4). Off this repository the element write document, the execution scope
 * document, and the discovered-task document are otherwise knowable only by
 * reading `src/lib/specs/**`, so every shape here is DERIVED from the schemas
 * the server parses with: the JSON Schema, the enumerated values, and the
 * admitting authoring stage all come from those sources, and the worked
 * examples are pinned to them by `schema.test.ts`. A second hand-written copy
 * of any shape would drift on the first change and is the one thing this
 * command must not contain.
 *
 * The command is entirely local: it never reaches the server, because the
 * caller who needs it most is authoring from a repository where no CC server
 * runs.
 */

import { z } from "zod";

import {
  createSpecInitialElementSchema,
  draftElementBatchItemSchema,
  type CreateSpecInitialElement,
  type DraftElementBatchItem,
} from "@/lib/specs/authoring-service";
import {
  MACHINE_VALIDATION_EVIDENCE_KINDS,
  sectionRoleSchema,
  specElementPayloadSchema,
  taskElementPayloadSchema,
  validationStrategyKindsSchema,
  type SectionRole,
  type SpecAuthoringStage,
  type SpecElementKind,
  type TaskElementPayload,
} from "@/lib/specs/schemas";
import {
  executionScopeSchema,
  type ExecutionScope,
} from "@/lib/specs/scope-validation";
import {
  admitDraftWrite,
  authoringStages,
  resolveAuthoringDials,
} from "@/lib/specs/transitions";
import { flagNamesFor } from "../../help-registry";
import {
  EXIT_OK,
  checkFlags,
  render,
  usageFailure,
  type CliResult,
  type GlobalFlags,
} from "../../shared";

/** One enumerated field, addressed by its path inside the document. */
interface EnumFact {
  readonly path: string;
  readonly values: readonly string[];
}

interface SchemaDocument {
  readonly id: string;
  readonly title: string;
  /** Invocation shapes that accept this document, most common first. */
  readonly usedBy: readonly string[];
  readonly jsonSchema: Record<string, unknown>;
  readonly enums: readonly EnumFact[];
  readonly example: unknown;
  readonly notes: readonly string[];
  /** Earliest authoring stage whose draft admits this element kind. */
  readonly admittedFromStage?: SpecAuthoringStage;
  /** A section's admitting stage depends on its role, so state every role. */
  readonly roleStages?: Readonly<Record<string, SpecAuthoringStage>>;
}

const DRAFT_USAGE =
  "cctl spec draft <slug> --file <element.json> --base-version <number|new>";
const BATCH_USAGE = "cctl spec draft <slug> --file <elements.json>";
const CREATE_USAGE =
  "cctl spec create --slug <slug> --name <name> --preset <preset> --file <element.json>";

/**
 * `admitDraftWrite` reads the resolved dials only to word its refusal, never to
 * decide admission, so any policy answers the "which stage admits this kind?"
 * question the same way.
 */
const PROBE_DIALS = resolveAuthoringDials({ preset: "contract-bearing" });

/**
 * `plan` admits every element kind, so the search always finds a stage; the
 * fallback keeps a future kind from reporting an unstated one.
 */
function earliestAdmittingStage(
  kind: SpecElementKind,
  role: SectionRole | undefined,
): SpecAuthoringStage {
  return (
    authoringStages.find(
      (stage) => admitDraftWrite(stage, kind, role, PROBE_DIALS).ok,
    ) ?? "plan"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string")
  );
}

/**
 * Walk a generated JSON Schema and report every enumerated field by its path in
 * the document (`payload.role`, `exclusionDispositions[].disposition`). Reading
 * the enums out of the generated schema rather than listing them keeps this
 * complete for fields nobody remembered to mention.
 */
function collectEnums(
  node: unknown,
  path: string,
  found: EnumFact[] = [],
): EnumFact[] {
  if (!isRecord(node)) return found;
  const values = node["enum"];
  if (isStringArray(values) && path.length > 0) {
    const duplicate = found.some(
      (fact) =>
        fact.path === path &&
        fact.values.join("\u0000") === values.join("\u0000"),
    );
    if (!duplicate) found.push({ path, values });
  }
  const properties = node["properties"];
  if (isRecord(properties)) {
    for (const [key, child] of Object.entries(properties)) {
      collectEnums(child, path.length === 0 ? key : `${path}.${key}`, found);
    }
  }
  collectEnums(node["items"], `${path}[]`, found);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) collectEnums(branch, path, found);
  }
  return found;
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  // `io: "input"` is what an author writes: optional fields stay optional and
  // defaults are not pre-applied.
  const generated: unknown = z.toJSONSchema(schema, {
    io: "input",
    // The server refuses a validation strategy without a machine-provable
    // kind via a `.refine()` that `z.toJSONSchema` cannot express. Publish
    // the equivalent JSON Schema constraint on that exact node, derived from
    // the same constant the refusal reads, so the published shape and the
    // accepting schema cannot drift apart.
    override(ctx) {
      if (ctx.zodSchema === validationStrategyKindsSchema) {
        ctx.jsonSchema.contains = {
          enum: [...MACHINE_VALIDATION_EVIDENCE_KINDS],
        };
        ctx.jsonSchema.minContains = 1;
      }
    },
  });
  return isRecord(generated) ? generated : {};
}

/**
 * The ordering and identity contract every element write document carries.
 * Only the compare-and-swap phrasing differs by form — a single write names
 * the flag, a batch element names its own field — so a caller is never pointed
 * at a flag the form it is authoring does not accept.
 */
function positionNotes(baseVersionPhrase: string): string[] {
  return [
    "position: one global order per revision, sorted by position then elementId. Omit position on create to append after the current last element; omit it on update to keep the element's current slot.",
    "Nesting comes from parentElementId alone and never from position; duplicate positions are accepted and resolved by the elementId tiebreak.",
    `elementId is caller-assigned and stable — reuse it to update the element, paired with ${baseVersionPhrase}.`,
    "The top-level kind selects stage admissibility and must equal payload.kind.",
  ];
}

/**
 * Facts about a kind that its schema cannot state: what its parent link means,
 * and which of its id arrays address other elements rather than handles.
 */
const KIND_NOTES: Record<SpecElementKind, readonly string[]> = {
  section: [
    "A section's role decides which authoring stage admits it — design_narrative is design-stage, every other role is requirements-stage.",
    "Sections carry no handle: they are addressed by elementId only.",
  ],
  requirement: [
    "Requirements are top-level: parentElementId is null. The server assigns the R<n> handle from the revision's requirement order.",
  ],
  criterion: [
    "parentElementId must be the owning requirement's elementId — the R<n>.<m> handle is composed from that requirement's number.",
    `validationStrategy.kinds must include at least one machine-provable kind (${MACHINE_VALIDATION_EVIDENCE_KINDS.join(" or ")}); the delivery gate cannot prove a criterion from commits alone, so an empty or commit-only list is refused.`,
  ],
  decision: [
    "tracedRequirementElementIds holds requirement elementIds, not R<n> handles.",
  ],
  task: [
    "All four id arrays hold elementIds, not handles; dependsOnTaskElementIds is the execution ordering the compiler reads.",
    "Size each task for one agent lane, and declare touchedPaths where they communicate a parallelism claim.",
  ],
};

const ELEMENT_EXAMPLES: Record<SpecElementKind, CreateSpecInitialElement> = {
  section: {
    elementId: "sec-intent-problem",
    kind: "section",
    parentElementId: null,
    payload: {
      kind: "section",
      role: "intent_problem",
      title: "Problem",
      body: "Authoring a spec from another repository is guesswork: the write document's shape is knowable only from Command Center's source.",
    },
  },
  requirement: {
    elementId: "req-self-describing-surface",
    kind: "requirement",
    parentElementId: null,
    payload: {
      kind: "requirement",
      statement:
        "The agent surface shall publish every schema-backed input document it accepts.",
      priority: "must",
      risk: "high",
    },
  },
  criterion: {
    elementId: "crit-schema-per-kind",
    kind: "criterion",
    parentElementId: "req-self-describing-surface",
    payload: {
      kind: "criterion",
      text: "cctl spec schema <kind> prints the write document's JSON Schema, its enums, and a worked example.",
      validationStrategy: {
        kinds: ["test_run"],
        note: "CLI contract test over the published documents",
      },
    },
  },
  decision: {
    elementId: "dec-generate-from-zod",
    kind: "decision",
    parentElementId: null,
    payload: {
      kind: "decision",
      title: "Generate the published input schema from the Zod sources",
      chosenApproach:
        "Derive the JSON Schema at call time from the same schemas the server parses input with.",
      rejectedAlternatives: [
        {
          label: "Hand-written help text describing the shape",
          reason:
            "It drifts from the accepting schema on the first change, and a confidently wrong shape is worse than none.",
        },
      ],
      reason:
        "A published shape that can disagree with the accepting schema teaches an author to fail.",
      tracedRequirementElementIds: ["req-self-describing-surface"],
    },
  },
  task: {
    elementId: "task-publish-input-schemas",
    kind: "task",
    parentElementId: null,
    payload: {
      kind: "task",
      title: "Publish the input documents from the CLI",
      instructions:
        "Add the schema verb, derive each document from its Zod source, and pin the worked examples with a test that parses them through the server's own input schema.",
      tracedRequirementElementIds: ["req-self-describing-surface"],
      tracedDecisionElementIds: ["dec-generate-from-zod"],
      coveredCriterionElementIds: ["crit-schema-per-kind"],
      dependsOnTaskElementIds: [],
      laneGroup: "cli",
      touchedPaths: ["src/cli/commands/spec"],
    },
  },
};

/**
 * A worked batch: one element updated at the version its author last read, and
 * one created under it, in a single transaction.
 */
const BATCH_EXAMPLE: DraftElementBatchItem[] = [
  { ...ELEMENT_EXAMPLES.requirement, baseElementVersion: 3 },
  { ...ELEMENT_EXAMPLES.criterion, baseElementVersion: null },
];

const SCOPE_EXAMPLE: ExecutionScope = {
  selectedTaskIds: ["task-publish-input-schemas"],
  selectedCriterionIds: ["crit-schema-per-kind"],
  exclusionDispositions: [
    { criterionId: "crit-cross-spec-search", disposition: "deferred" },
  ],
};

const DISCOVERED_TASK_EXAMPLE: Omit<TaskElementPayload, "kind"> = {
  title: "Publish the execution scope document too",
  instructions:
    "The scope document was undocumented as well; capture it as plan work on the amended revision.",
  tracedRequirementElementIds: ["req-self-describing-surface"],
  tracedDecisionElementIds: [],
  coveredCriterionElementIds: [],
  dependsOnTaskElementIds: ["task-publish-input-schemas"],
  laneGroup: "cli",
};

/**
 * The element write document narrowed to one kind. Both the discriminator and
 * the payload variant come from `specElementPayloadSchema`'s own options, so a
 * new element kind publishes itself.
 */
function elementDocuments(): SchemaDocument[] {
  return specElementPayloadSchema.options.map((payload) => {
    const kind: SpecElementKind = payload.shape.kind.value;
    const jsonSchema = jsonSchemaOf(
      createSpecInitialElementSchema.extend({
        kind: z.literal(kind),
        payload,
      }),
    );
    return {
      id: kind,
      title: `element write document (kind: ${kind})`,
      usedBy: [DRAFT_USAGE, CREATE_USAGE],
      jsonSchema,
      enums: collectEnums(jsonSchema, ""),
      example: ELEMENT_EXAMPLES[kind],
      notes: [
        ...KIND_NOTES[kind],
        ...positionNotes("--base-version <the version you last read>"),
      ],
      // Role-less probe: the earliest stage this kind can be admitted at
      // under any role. `roleStages` carries the per-role answer where it
      // differs, so this line never overstates.
      admittedFromStage: earliestAdmittingStage(kind, undefined),
      ...(kind === "section"
        ? {
            roleStages: Object.fromEntries(
              sectionRoleSchema.options.map((role) => [
                role,
                earliestAdmittingStage("section", role),
              ]),
            ),
          }
        : {}),
    };
  });
}

/**
 * The batch write document: the same element writes, each stating the version
 * it is replacing. Published as its own document because the array form is
 * otherwise invisible — an author reading the per-kind document has no way to
 * learn that many elements can travel in one transaction, or that the
 * compare-and-swap stays per element when they do.
 */
function batchDocument(): SchemaDocument {
  const jsonSchema = jsonSchemaOf(z.array(draftElementBatchItemSchema).min(1));
  return {
    id: "element-batch",
    title: "element write batch document",
    usedBy: [BATCH_USAGE],
    jsonSchema,
    enums: collectEnums(jsonSchema, ""),
    example: BATCH_EXAMPLE,
    notes: [
      "Every element states its own baseElementVersion: the version you last read to update it, or null to create it. The compare-and-swap boundary stays the element, so two authors writing disjoint elements never conflict.",
      "The batch is one transaction. If any element refuses, nothing is written and every refusal is reported against that element's index in this array.",
      "--base-version is the single-element flag and does not apply here; passing it with an array file is refused locally.",
      "Element kinds may be mixed, but each one must be admitted by the draft's current authoring stage — the same rule a single write obeys.",
      ...positionNotes("this element's own baseElementVersion"),
    ],
  };
}

function otherDocuments(): SchemaDocument[] {
  const scopeSchema = jsonSchemaOf(executionScopeSchema);
  const discoveredTaskSchema = jsonSchemaOf(
    taskElementPayloadSchema.omit({ kind: true }),
  );
  return [
    {
      id: "scope",
      title: "execution scope document",
      usedBy: ["cctl spec start <slug> --file <scope.json>"],
      jsonSchema: scopeSchema,
      enums: collectEnums(scopeSchema, ""),
      example: SCOPE_EXAMPLE,
      notes: [
        "Tasks and criteria are addressed by element id, not by handle — read the ids from `cctl spec show <slug> --json`.",
        "Every criterion of the approved plan that is not selected needs an exclusion disposition; a selected criterion needs a selected task that covers it, and a selected task needs its declared dependencies selected too.",
      ],
    },
    {
      id: "discovered-task",
      title: "discovered-task document",
      usedBy: ["cctl spec capture <slug> --execution <id> --file <task.json>"],
      jsonSchema: discoveredTaskSchema,
      enums: collectEnums(discoveredTaskSchema, ""),
      example: DISCOVERED_TASK_EXAMPLE,
      notes: [
        "This is a task payload without its `kind` discriminator — capture supplies it.",
        "Capture amends the spec from inside a running execution; to continue authoring an approved spec outside one, use `cctl spec amend <slug>` and `cctl spec draft`.",
      ],
    },
  ];
}

function allDocuments(): SchemaDocument[] {
  return [...elementDocuments(), batchDocument(), ...otherDocuments()];
}

function documentText(document: SchemaDocument): string {
  const lines = [
    `document: ${document.id} — ${document.title}`,
    `used by: ${document.usedBy.join("; ")}`,
    ...(document.admittedFromStage === undefined
      ? []
      : [`admitted from authoring stage: ${document.admittedFromStage}`]),
    ...(document.roleStages === undefined
      ? []
      : [
          `stage by section role: ${Object.entries(document.roleStages)
            .map(([role, stage]) => `${role}=${stage}`)
            .join(", ")}`,
        ]),
    "json schema:",
    JSON.stringify(document.jsonSchema, null, 2),
  ];
  if (document.enums.length > 0) {
    lines.push(
      "enums:",
      ...document.enums.map(
        (fact) => `  ${fact.path}: ${fact.values.join(" | ")}`,
      ),
    );
  }
  lines.push("example:", JSON.stringify(document.example, null, 2));
  if (document.notes.length > 0) {
    lines.push("notes:", ...document.notes.map((note) => `  - ${note}`));
  }
  return lines.join("\n");
}

function indexText(documents: readonly SchemaDocument[]): string {
  return [
    "schema-backed input documents:",
    ...documents.map(
      (document) => `  cctl spec schema ${document.id}\t${document.title}`,
    ),
  ].join("\n");
}

export function runSpecSchema(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
): CliResult {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec schema"), json);
  if (denied) return denied;
  if (rest.length > 1) {
    return usageFailure("spec schema takes at most one <document>", json);
  }
  const documents = allDocuments();
  const requested = rest[0];
  if (requested === undefined) {
    return {
      exitCode: EXIT_OK,
      stdout: render(json, `${indexText(documents)}\n`, {
        ok: true,
        documents,
        hint: "run `cctl spec schema <document>` for its JSON Schema, enumerated values, and a worked example",
      }),
      stderr: "",
    };
  }
  const selected = documents.find((document) => document.id === requested);
  if (selected === undefined) {
    return usageFailure(
      `spec schema: unknown document ${JSON.stringify(requested)}; known documents: ${documents
        .map((document) => document.id)
        .join(", ")}`,
      json,
    );
  }
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${documentText(selected)}\n`, {
      ok: true,
      documents: [selected],
      hint: `write this document to a file, then run: ${selected.usedBy[0]}`,
    }),
    stderr: "",
  };
}
