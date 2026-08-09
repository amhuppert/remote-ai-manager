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
  draftElementDocumentSchema,
  type CreateSpecInitialElement,
  type DraftElementInput,
} from "@/lib/specs/authoring-service";
import {
  MACHINE_VALIDATION_EVIDENCE_KINDS,
  executionLaneSchema,
  sectionRoleSchema,
  specElementPayloadSchema,
  taskElementPayloadSchema,
  touchedPathSchema,
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

const DRAFT_USAGE = "cctl spec draft <slug> --file <element.json>";
const BATCH_USAGE = "cctl spec draft <slug> --file <elements.json>";
const CREATE_USAGE =
  "cctl spec create --slug <slug> --name <name> --preset <preset> --file <element.json>";

const TOUCHED_PATH_DESCRIPTION =
  "normalized repo-relative POSIX paths; directories without a trailing slash";

const EXECUTION_LANE_DESCRIPTION =
  "the lane this task's execution context runs on; tasks sharing one share a worktree and a join. /^[A-Za-z0-9_.-]+$/, not starting with '.' or '-', not containing '..', not ending with '.', '-', or '.lock'";

const CREATE_DOCUMENT_ID = "create-element";

/**
 * What the compare-and-swap version is, and the trap in reading one: element
 * versions are revision-local. An amendment copies the approved content in at
 * version 1, so a version read before the amendment names nothing in the new
 * revision.
 */
const BASE_VERSION_NOTES = [
  "baseElementVersion is the version you last read for this element, or null to create it. The compare-and-swap boundary is the element, so two authors writing disjoint elements never conflict.",
  "Element versions are per revision and restart at 1: `cctl spec amend` copies the approved content into the new revision as version 1, so re-read the element after an amendment instead of reusing a version from the revision before it.",
];

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
      // A touched path's normalization is a `.superRefine()`, which generates
      // to a bare string. JSON Schema cannot express the rule, so the node
      // carries it in prose rather than publishing a shape that accepts
      // `src/cli/` and absolute paths the server refuses.
      if (ctx.zodSchema === touchedPathSchema) {
        ctx.jsonSchema.description = TOUCHED_PATH_DESCRIPTION;
      }
      // Same reason as the touched path above: the lane grammar is a
      // `.superRefine()` that generates to a bare string, and a published shape
      // accepting `src/lib` would teach an author to fail at compile time.
      if (ctx.zodSchema === executionLaneSchema) {
        ctx.jsonSchema.description = EXECUTION_LANE_DESCRIPTION;
      }
    },
  });
  return isRecord(generated) ? generated : {};
}

/**
 * The ordering and identity contract every element write document carries.
 * Only the compare-and-swap phrasing differs by document — a draft element
 * states its own version, a create document has no revision to compare
 * against — so a caller is never pointed at a field the document it is
 * authoring does not accept.
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
 * The reintroduction marker. It is only ever reached from the refusal that
 * asks for it, so the note is written as the answer to that refusal — and the
 * compare-and-swap half differs by document, because a document that states no
 * base version has none to pair the marker with.
 */
function reintroductionNote(baseVersionPairing: string): string {
  return `reintroduceHistorical: true brings an element id this spec already owns, but this revision does not carry, back into the revision — set it only after a write refused with historical_element_id${baseVersionPairing}. A reintroduced element keeps its number and handle (R3 returns as R3) and cannot change kind or parent; anything else needs a new element id.`;
}

const DRAFT_REINTRODUCTION_NOTE = reintroductionNote(
  ", and pair it with a null base version",
);

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
    "laneGroup and executionLane are different claims: laneGroup contracts its tasks into ONE execution context, executionLane puts contexts on ONE lane — one worktree, one join — where touchedPaths become the ownership envelope that keeps them apart. Every context on an executionLane needs a non-empty envelope, so a task on one must declare touchedPaths unless it is contracted into a laneGroup where another member does. Every member of one laneGroup must agree on the executionLane or all omit it.",
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
 * The same element as a draft write: identical to the create document plus the
 * version it replaces. A create example carrying one, or a draft example
 * missing one, would be a document the verb it names refuses.
 */
function draftExample(kind: SpecElementKind): DraftElementInput {
  return { ...ELEMENT_EXAMPLES[kind], baseElementVersion: null };
}

/**
 * A worked batch: one element updated at the version its author last read, and
 * one created under it, in a single transaction.
 */
const BATCH_EXAMPLE: DraftElementInput[] = [
  { ...ELEMENT_EXAMPLES.requirement, baseElementVersion: 3 },
  draftExample("criterion"),
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
 * The draft write document narrowed to one kind. Both the discriminator and
 * the payload variant come from `specElementPayloadSchema`'s own options, so a
 * new element kind publishes itself. The create document is published
 * separately rather than sharing this one: it is a different shape, and one
 * document claiming both verbs is what taught authors to send `spec draft` a
 * file with no version in it.
 */
function elementDocuments(): SchemaDocument[] {
  return specElementPayloadSchema.options.map((payload) => {
    const kind: SpecElementKind = payload.shape.kind.value;
    const jsonSchema = jsonSchemaOf(
      draftElementDocumentSchema.extend({
        kind: z.literal(kind),
        payload,
      }),
    );
    return {
      id: kind,
      title: `draft element write document (kind: ${kind})`,
      usedBy: [DRAFT_USAGE, BATCH_USAGE],
      jsonSchema,
      enums: collectEnums(jsonSchema, ""),
      example: draftExample(kind),
      notes: [
        ...KIND_NOTES[kind],
        ...positionNotes("this element's own baseElementVersion"),
        DRAFT_REINTRODUCTION_NOTE,
        ...BASE_VERSION_NOTES,
        `The first element of a spec that does not exist yet is a different document — run \`cctl spec schema ${CREATE_DOCUMENT_ID}\`.`,
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
  const jsonSchema = jsonSchemaOf(z.array(draftElementDocumentSchema).min(1));
  return {
    id: "element-batch",
    title: "element write batch document",
    usedBy: [BATCH_USAGE],
    jsonSchema,
    enums: collectEnums(jsonSchema, ""),
    example: BATCH_EXAMPLE,
    notes: [
      "An array file is a batch of the same per-kind draft documents; a lone object is one of them, so an element that is legal in one form is legal in the other.",
      "The batch is one transaction. If any element refuses, nothing is written and every refusal is reported against that element's index in this array.",
      // The two forms take different write paths, and only the single write
      // can name one winning element, so promising the batch returns content
      // would send an author looking for a field that is not in the refusal.
      "A stale write refuses with the winning element version in both forms; only the lone-object form also returns the winning content. Re-read the element to see what a batch lost to.",
      "Element kinds may be mixed, but each one must be admitted by the draft's current authoring stage — the same rule a single write obeys.",
      ...positionNotes("this element's own baseElementVersion"),
      DRAFT_REINTRODUCTION_NOTE,
      ...BASE_VERSION_NOTES,
    ],
  };
}

/**
 * The create document: the same element without a compare-and-swap version,
 * because the revision it opens holds nothing to compare against. Published as
 * one kind-correlated document rather than five, since a spec is created once
 * and the author already knows which kind the first element is.
 */
function createDocument(): SchemaDocument {
  const jsonSchema = jsonSchemaOf(
    z.union(
      specElementPayloadSchema.options.map((payload) =>
        createSpecInitialElementSchema.extend({
          kind: z.literal(payload.shape.kind.value),
          payload,
        }),
      ),
    ),
  );
  return {
    id: CREATE_DOCUMENT_ID,
    title: "first element write document (spec creation)",
    usedBy: [CREATE_USAGE],
    jsonSchema,
    enums: collectEnums(jsonSchema, ""),
    example: ELEMENT_EXAMPLES.section,
    notes: [
      "This document states no baseElementVersion: the spec's first revision has no version to compare against, and stating one is refused rather than ignored.",
      "Every later write is the draft document for that kind — run `cctl spec schema <kind>`.",
      ...positionNotes(
        "the baseElementVersion the draft document carries once the spec exists",
      ),
      // The same verb opens an amendment when the slug already exists with no
      // draft open, which is the only position where this document can carry
      // the marker — and it has no base version to pair it with.
      reintroductionNote(
        ", which this document can only meet when the slug already exists and this create opens an amendment; there is no base version here to pair it with",
      ),
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
  return [
    ...elementDocuments(),
    batchDocument(),
    createDocument(),
    ...otherDocuments(),
  ];
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
