/**
 * `cctl spec schema` — the agent surface describing its input documents and
 * read-envelope reference (R24.4). Off this repository the element write,
 * delivery-plan edit, and discovered-task documents are otherwise knowable
 * only by reading `src/lib/specs/**`, so every input shape here is DERIVED from
 * the schemas the server parses with: the JSON Schema, enumerated values, and
 * admitting authoring stage all come from those sources. Read-envelope field
 * lists are likewise derived from the runtime schemas that validate CLI
 * output, and the worked examples are pinned by `schema.test.ts`. A second
 * hand-written copy of a production shape would drift on the first change and
 * is the one thing this command must not contain.
 *
 * The command is entirely local: it never reaches the server, because the
 * caller who needs it most is authoring from a repository where no CC server
 * runs.
 */

import { z } from "zod";

import {
  createSpecInitialElementSchema,
  draftElementBatchDocumentSchema,
  draftElementDocumentSchema,
  type CreateSpecInitialElement,
  type DraftElementInput,
} from "@/lib/specs/authoring-service";
import {
  IMPORTED_VALIDATION_STRATEGY_NOTE,
  MACHINE_VALIDATION_EVIDENCE_KINDS,
  executionLaneSchema,
  importBundleSchema,
  sectionRoleSchema,
  specElementPayloadSchema,
  taskElementPayloadSchema,
  touchedPathSchema,
  validationStrategyKindsSchema,
  type ImportBundle,
  type SectionRole,
  type SpecAuthoringStage,
  type SpecElementKind,
  type TaskElementPayload,
} from "@/lib/specs/schemas";
import {
  admitDraftWrite,
  authoringStages,
  resolveAuthoringDials,
} from "@/lib/specs/transitions";
import type { DeliveryPlanDocument } from "@/lib/specs/delivery-plan";
import { deliveryPlanEditRequestSchema } from "@/lib/specs/delivery-plan-views";
import { graphWorkflowLaunchExample } from "@/lib/workflow-graph/launch-presentation";
import {
  NATIVE_SDD_GUIDANCE,
  nativeSddGuidanceSchema,
} from "@/lib/specs/native-sdd-guidance";
import { flagNamesFor } from "../../help-registry";
import {
  EXIT_OK,
  checkFlags,
  render,
  usageFailure,
  type CliResult,
  type GlobalFlags,
} from "../../shared";
import { SPEC_READ_ENVELOPE_FIELDS } from "./read-envelopes";

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
const REMOVAL_BATCH_USAGE = "cctl spec draft <slug> --file <batch.json>";
const REMOVE_USAGE = "cctl spec remove <slug> <handle...>";
const CREATE_USAGE =
  "cctl spec create --slug <slug> --name <name> --preset <preset> --file <element.json>";
const IMPORT_USAGE = "cctl spec import --file <bundle.json>";
const IMPORT_DRY_RUN_USAGE = "cctl spec import --file <bundle.json> --dry-run";

const TOUCHED_PATH_DESCRIPTION =
  "normalized repo-relative POSIX paths; directories without a trailing slash";

const EXECUTION_LANE_DESCRIPTION =
  "the lane this task's execution context runs on; tasks sharing one share a worktree and a join. /^[A-Za-z0-9_.-]+$/, not starting with '.' or '-', not containing '..', not ending with '.', '-', or '.lock'";

const CREATE_DOCUMENT_ID = "create-element";
const REMOVAL_BATCH_DOCUMENT_ID = "element-batch-removals";
const IMPORT_BUNDLE_DOCUMENT_ID = "import-bundle";

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
    // Learned by refusal in the field (#60): an ABANDONED spec still owns its
    // ids, so the convention has to be stated before the first write, not
    // only inside the element_id_taken refusal.
    'elementId is globally unique across every spec in the project, including abandoned ones — prefix ids with the spec slug (for example, "<spec-slug>-req-audit") so no other spec can own yours first.',
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
    `validationStrategy.kinds must include at least one machine-provable kind (${MACHINE_VALIDATION_EVIDENCE_KINDS.join(" or ")}); a criterion whose only proposed proof is that someone committed something states no checkable claim, so an empty or commit-only list is refused. The kinds are the author's stated proof intent — delivery is decided by the claiming context's graph-configured gates, not by matching evidence against this list.`,
  ],
  decision: [
    "tracedRequirementElementIds holds requirement elementIds, not R<n> handles.",
  ],
  task: [
    "A task element states intended work on the spec's Plan revision. It is not a delivery plan: the graph that runs is authored directly with `cctl spec schema plan-edit` and `cctl spec plan edit <slug> --file <plan.json>`, and no task element compiles into it.",
    "All four id arrays hold elementIds, not handles.",
    "dependsOnTaskElementIds, laneGroup, executionLane and touchedPaths record the author's intended ordering, grouping, lane and surfaces. Nothing derives execution from them — the delivery-plan author reads them while placing contexts, tasks, edges and ownedPaths in the authored launch, where those decisions are actually made.",
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

/**
 * A worked removal batch: an unrelated requirement is updated while the task
 * and the criterion it covered leave together. Removing either of those two
 * alone would leave the other pointing at content the revision no longer
 * carries, which is the whole reason one document holds both.
 */
const REMOVAL_BATCH_EXAMPLE = {
  elements: [{ ...ELEMENT_EXAMPLES.requirement, baseElementVersion: 3 }],
  removals: [
    { elementId: "task-publish-input-schemas", baseElementVersion: 2 },
    { elementId: "crit-schema-per-kind", baseElementVersion: 4 },
  ],
};

/**
 * A one-context plan: the smallest document that is legal under the whole
 * disposition and ownership law, so an author can copy it and grow it rather
 * than assemble the shape from the JSON Schema.
 */
const planEditExampleLaunch = graphWorkflowLaunchExample();
const PLAN_EDIT_EXAMPLE: DeliveryPlanDocument = {
  schemaVersion: 2,
  launch: planEditExampleLaunch,
  binding: {
    dispositions: [
      {
        criterionElementId: "crit-schema-per-kind",
        disposition: "in_scope",
        deliveredByExecutionId: null,
      },
    ],
    claims: [
      {
        contextId: "context-implement",
        criterionElementIds: ["crit-schema-per-kind"],
      },
    ],
  },
};

const DISCOVERED_TASK_EXAMPLE: Omit<TaskElementPayload, "kind"> = {
  title: "Publish the delivery-plan migration guidance too",
  instructions:
    "The retired scope-file path needs an exact migration act; capture that documentation as plan work on the next delivery attempt.",
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
      title:
        kind === "task"
          ? "legacy draft element write document (kind: task)"
          : `draft element write document (kind: ${kind})`,
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
 * The keyed batch document: the array form plus the removals that can only
 * travel with it. Published separately from `element-batch` because the two
 * are different shapes, and an author reading an array schema has no way to
 * learn that a removal is expressible at all — the exact invisibility that
 * left the server's removal path unreachable.
 */
function removalBatchDocument(): SchemaDocument {
  const jsonSchema = jsonSchemaOf(draftElementBatchDocumentSchema);
  return {
    id: REMOVAL_BATCH_DOCUMENT_ID,
    title: "batch document with removals",
    usedBy: [REMOVAL_BATCH_USAGE, REMOVE_USAGE],
    jsonSchema,
    enums: collectEnums(jsonSchema, ""),
    example: REMOVAL_BATCH_EXAMPLE,
    notes: [
      "Writes and removals land in ONE transaction. That is why they share a document: a reference and the element it points at can only leave together, so removing them in two files has no legal order.",
      "A removal states the element id and the version it takes out — there is no handle form here, because the server parses ids. `cctl spec remove <slug> <handle...>` is the same document with the handles already resolved.",
      "Either array may be empty, but not both. Writing and removing the same element id in one document is refused as the contradiction it is.",
      "A removal that would leave a surviving element pointing at content the revision no longer carries is refused whole, naming both ends of the dangling reference; rewrite or remove the referring element in the same document.",
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
      "This document needs no baseElementVersion: the spec's first revision has no version to compare against. An explicit null is tolerated — it states the same thing — but a number is refused rather than ignored: a real base version belongs to the draft document.",
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

/**
 * Every artifact a bundle can carry, in one document an agent can copy and
 * edit. The two easiest omissions are deliberate here: the second criterion
 * states no `validationStrategy`, so the imported default is visible beside an
 * explicit one, and the decision's `traces` names the requirement's
 * bundle-local `ref` rather than an element id that does not exist yet.
 */
const IMPORT_BUNDLE_EXAMPLE: ImportBundle = {
  slug: "audit-log-retention",
  name: "Audit log retention",
  gatePolicy: { preset: "contract-bearing" },
  source: { label: "kiro:.kiro/specs/audit-log-retention" },
  sections: [
    {
      role: "intent_problem",
      title: "Problem",
      body: "Audit records were pruned on no stated schedule, so an incident review could not say whether a missing entry was never written or already deleted.",
    },
    {
      role: "design_narrative",
      title: "Approach",
      body: "Retention is a per-project policy evaluated by one scheduled sweep; the sweep writes its own audit entry so a deletion is itself accountable.",
    },
  ],
  requirements: [
    {
      ref: "retention-policy",
      statement:
        "A project states how long audit records are kept, and the sweep deletes nothing outside that window.",
      priority: "must",
      risk: "high",
      criteria: [
        {
          text: "A record older than the project's window is deleted by the sweep, and one inside it is not.",
          validationStrategy: {
            kinds: ["test_run"],
            note: "Covered by the retention sweep's boundary test.",
          },
        },
        {
          text: "Each sweep writes an audit entry naming what it deleted and under which policy.",
        },
      ],
    },
  ],
  decisions: [
    {
      title: "One scheduled sweep, not deletion at write time",
      chosenApproach:
        "A single scheduled sweep evaluates the policy for every project.",
      rejectedAlternatives: [
        {
          label: "Delete on write",
          reason:
            "Puts an unbounded scan on the latency path of every audit write.",
        },
      ],
      reason:
        "Retention is a property of the record set over time, so it is answered once per sweep rather than once per write.",
      traces: ["retention-policy"],
    },
  ],
  questions: [
    {
      text: "Does the window differ for security-relevant records?",
      answer:
        "No — the external design states one window per project, and a per-kind window was left to a later spec.",
    },
  ],
  assumptions: [
    {
      text: "Projects have at most one retention policy in force at a time.",
      disposition: "confirmed",
    },
  ],
  delivered: true,
  dryRun: false,
};

/**
 * The one document an import reads. Published here because the agent that
 * authors it is translating an external source from a repository that is not
 * Command Center, so this text and its example are the whole mapping contract.
 */
function importBundleDocument(): SchemaDocument {
  const jsonSchema = jsonSchemaOf(importBundleSchema);
  return {
    id: IMPORT_BUNDLE_DOCUMENT_ID,
    title: "spec import bundle document",
    usedBy: [IMPORT_USAGE, IMPORT_DRY_RUN_USAGE],
    jsonSchema,
    enums: collectEnums(jsonSchema, ""),
    example: IMPORT_BUNDLE_EXAMPLE,
    notes: [
      "Import creates new specs only. A slug or alias this project already uses — including one an abandoned spec holds — refuses with slug_taken, and there is no revival or amendment path through this verb; change an existing spec with `cctl spec amend <slug>`.",
      "The imported spec is born approved at the design stage on IMPORT PROVENANCE. No approval of any kind is written, so every human gate on it stays exactly as strong as on a spec authored here.",
      'delivered defaults to TRUE: a spec worth importing has usually already shipped, and the record it writes is external-delivery provenance rather than machine proof — the delivery gate never reads it. A source with no acceptance criterion to record delivery against is refused; give the bundle a criterion, or set `"delivered": false` to import it as approved without claiming delivery.',
      "requirements[].ref is a BUNDLE-LOCAL label, not an element id: it exists only so decisions[].traces can point at a requirement before any element id exists. Every ref a trace names must be declared by exactly one requirement in the same bundle — a duplicate or an unresolved ref refuses before anything is written.",
      `A criterion that states no validationStrategy is born with a machine-provable default whose note reads "${IMPORTED_VALIDATION_STRATEGY_NOTE}" — state one explicitly whenever the external source names the obligation, because an authoring agent that read the source knows it better than the default does.`,
      "Handles are allocated in bundle order: requirements R1…Rn, criteria numbered within each requirement (R1.1, R1.2), decisions D1…Dn, questions Q1…Qn, assumptions A1…An. Run the import with --dry-run to see the exact numbering before writing cross-references against it.",
      "dryRun: true rehearses the whole import — every validation, the findings, and the handles it would allocate — and writes nothing. `--dry-run` sets it; either asking rehearses, and neither cancels the other.",
    ],
  };
}

function otherDocuments(): SchemaDocument[] {
  const discoveredTaskSchema = jsonSchemaOf(
    taskElementPayloadSchema.omit({ kind: true }),
  );
  return [
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
    planEditDocument(),
    guidanceDocument(),
  ];
}

function planEditDocument(): SchemaDocument {
  const schema = jsonSchemaOf(deliveryPlanEditRequestSchema);
  return {
    id: "plan-edit",
    title: "delivery plan edit document",
    usedBy: ["cctl spec plan edit <slug> --file <plan.json>"],
    jsonSchema: schema,
    enums: collectEnums(schema, ""),
    example: {
      expectedDraftRevision: 1,
      document: PLAN_EDIT_EXAMPLE,
    },
    notes: [
      "`expectedDraftRevision` is the plan's compare-and-swap token, the way `baseElementVersion` is an element's: read it from `cctl spec plan get <slug> --json` and send back the revision you edited.",
      "Every criterion of the pinned revision carries exactly one disposition. Each selected criterion needs at least one claim naming a stable authored graph source; dynamic contexts and execution outcomes stay graph-owned.",
      "`launch` is the complete ordinary graph launch and is accepted without a native-SDD field allowlist. Graph admission owns topology, loops, guards, expansion, output schemas, invariants, runtime configuration, and layout.",
      "Proposal adds the pinned-spec and claims sources as server-owned finalization data. Keep externally hosted sources `external-readonly`; the charter requires explicit human permission before they are read.",
    ],
  };
}

function guidanceDocument(): SchemaDocument {
  const schema = jsonSchemaOf(nativeSddGuidanceSchema);
  return {
    id: "guidance",
    title: "native SDD graph-admission, lint, and evidence reference",
    usedBy: ["cctl spec schema guidance"],
    jsonSchema: schema,
    enums: collectEnums(schema, ""),
    example: NATIVE_SDD_GUIDANCE,
    notes: [
      "The empty delivery-plan lint taxonomy records that graph admission and accountability checks belong to the shared graph launch boundary. Evergreen lint rule ids and severities come from the registries that construct findings.",
      "test_run is minted only when the criterion's own strategy declares it, alongside validator_verdict from the same graph-workflow-validation-result event; no test runner mints independent test_run evidence.",
    ],
  };
}

const readEnvelopeReferenceSchema = z
  .object({
    envelopes: z.array(
      z
        .object({
          command: z.enum([
            "spec show",
            "spec status",
            "spec lint",
            "spec get",
          ]),
          view: z.enum(["summary", "outline", "rendered", "full"]).nullable(),
          payloadFields: z.array(z.string().min(1)).min(1),
          disclosure: z.string().min(1),
        })
        .strict(),
    ),
    revisionRoles: z
      .object({
        baseRevision: z.string().min(1),
        currentRevision: z.string().min(1),
        currentApprovedRevision: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const READ_ENVELOPE_REFERENCE: z.infer<typeof readEnvelopeReferenceSchema> = {
  envelopes: [
    {
      command: "spec show",
      view: "outline",
      payloadFields: [...SPEC_READ_ENVELOPE_FIELDS.show.outline],
      disclosure:
        "storage: inline carries the bounded nested current-revision outline and reports total, returned, truncated, and next; when either serialization would exceed the stdout budget, storage: artifact carries reason: stdout_budget_exceeded and the exact inline envelope moves to artifact.path",
    },
    {
      command: "spec show",
      view: "summary",
      payloadFields: [...SPEC_READ_ENVELOPE_FIELDS.show.summary],
      disclosure:
        "storage: inline carries counts and rollups only; disclosure reports zero returned rows, truncation per counted collection, and the exact default-outline next command; when either serialization would exceed the stdout budget, storage: artifact carries reason: stdout_budget_exceeded and the exact inline envelope moves to artifact.path",
    },
    {
      command: "spec show",
      view: "rendered",
      payloadFields: [...SPEC_READ_ENVELOPE_FIELDS.show.rendered],
      disclosure:
        "artifact is {path, format, bytes, sha256}; canonical Markdown is in the file, not stdout",
    },
    {
      command: "spec show",
      view: "full",
      payloadFields: [...SPEC_READ_ENVELOPE_FIELDS.show.full],
      disclosure:
        "artifact is {path, format, bytes, sha256}; raw SpecDetailView is in the file, not stdout",
    },
    {
      command: "spec status",
      view: null,
      payloadFields: [...SPEC_READ_ENVELOPE_FIELDS.status],
      disclosure:
        "status is the complete lifecycle projection; executions is its active execution subset",
    },
    {
      command: "spec lint",
      view: null,
      payloadFields: [...SPEC_READ_ENVELOPE_FIELDS.lint],
      disclosure:
        "lint is {revisionId, total, blocking, counts, groups}; findings live under lint.groups[].findings",
    },
    {
      command: "spec get",
      view: null,
      payloadFields: [...SPEC_READ_ENVELOPE_FIELDS.get],
      disclosure:
        "element is the complete addressed view; content-element identity is also hoisted beside it",
    },
  ],
  revisionRoles: {
    baseRevision:
      "the immediate parent named by currentRevision.revision.basedOnRevisionId",
    currentRevision:
      "the latest revision and lineage head regardless of draft, proposed, approved, or withdrawn state",
    currentApprovedRevision:
      "the latest approved revision; it need not be an ancestor of the current lineage head",
  },
};

function readEnvelopeDocument(): SchemaDocument {
  const schema = jsonSchemaOf(readEnvelopeReferenceSchema);
  return {
    id: "read-envelopes",
    title: "Native SDD read envelope and revision-role reference",
    usedBy: [
      "cctl spec show <slug>",
      "cctl spec status <slug>",
      "cctl spec lint <slug>",
      "cctl spec get <slug>/<handle>",
    ],
    jsonSchema: schema,
    enums: collectEnums(schema, ""),
    example: READ_ENVELOPE_REFERENCE,
    notes: [
      "Every success envelope carries ok: true. Show is flattened: command, view, storage, spec identity, revision, and the selected view fields are siblings rather than a named show payload. Status, lint, and get keep their named payloads under status, lint, and element.",
      "Summary and outline normally use storage: inline. If either text or JSON serialization would exceed the stdout budget, storage: artifact and reason: stdout_budget_exceeded point to the exact inline envelope in artifact.path. Rendered and full always use storage: artifact.",
      "baseRevision is the currentRevision lineage head's immediate basedOnRevisionId parent; it is the review comparison base, not a synonym for an approved revision.",
      "currentRevision is the latest revision and lineage head regardless of state.",
      "currentApprovedRevision is the latest approved revision and is not assumed to be an ancestor of currentRevision.",
      "Lint counts are lint.total and lint.blocking; grouped findings are lint.groups[].findings.",
      "--json changes serialization only and does not widen the selected disclosure level. Full and rendered show bodies remain file-backed artifacts.",
    ],
  };
}

function allDocuments(): SchemaDocument[] {
  return [
    ...elementDocuments(),
    batchDocument(),
    removalBatchDocument(),
    createDocument(),
    importBundleDocument(),
    ...otherDocuments(),
    readEnvelopeDocument(),
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
    "offline spec documents:",
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
    const index = documents.map(({ id, title, usedBy }) => ({
      id,
      title,
      usedBy,
    }));
    return {
      exitCode: EXIT_OK,
      stdout: render(json, `${indexText(documents)}\n`, {
        ok: true,
        documents: index,
        hint: "run `cctl spec schema <document>` for its generated schema or mechanical reference",
      }),
      stderr: "",
    };
  }
  const selected = documents.find((document) => document.id === requested);
  if (selected === undefined) {
    const migration =
      requested === "scope"
        ? "; execution-scope documents are retired — inspect the authored graph with `cctl spec schema plan-edit`"
        : "";
    return usageFailure(
      `spec schema: unknown schema document ${JSON.stringify(requested)}${migration}; known documents: ${documents
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
      hint:
        selected.id === "guidance" || selected.id === "read-envelopes"
          ? "consult the relevant `cctl spec <command> --help` leaf for the same generated reference at the point of use"
          : `write this document to a file, then run: ${selected.usedBy[0]}`,
    }),
    stderr: "",
  };
}
