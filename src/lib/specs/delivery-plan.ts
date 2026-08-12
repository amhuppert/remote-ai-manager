import { z } from "zod";
import {
  accessPolicySchema,
  sourceTypeSchema,
} from "@/lib/workflows/charter-schemas";
import { criterionStalenessReasonSchema } from "./delivery-delta";
import {
  actorProvenanceSchema,
  evidenceKindSchema,
  type DeliveryPlanAttemptStatus,
} from "./schemas";

/**
 * The `DeliveryPlanAttempt` content document (design §4): the per-execution,
 * graph-shaped delivery plan that is also the scope. It is authored in the
 * graph vocabulary — explicit contexts, ordered tasks, explicit dependency
 * edges — with criterion ownership bound in, so materialization has nothing
 * left to infer.
 *
 * The document is stored whole in one TEXT column, so every collection here
 * carries a static bound (see the persisted-blob-bounds gate). The bounds are
 * sized for the largest plan native SDD has produced (the D4 run authored 23
 * contexts) with an order of magnitude of headroom, not as a design target.
 */

const MAX_CRITERIA = 500;
const MAX_CONTEXTS = 200;
const MAX_TASKS = 1000;
const MAX_EDGES = 800;
const MAX_WIRING = 300;
const MAX_CONTRACT_LINES = 60;
const MAX_POLICY_OVERRIDES = 60;
const MAX_TOUCHED_SURFACES = 300;
const MAX_INVARIANTS = 60;
const MAX_SOURCES_OF_TRUTH = 30;
const MAX_VALIDATION_COMMANDS = 30;
const MAX_REAFFIRMATION_BASIS = 40;
const MAX_OWNED_PATHS = 64;
const MAX_OWNED_PATH_LENGTH = 500;
const MAX_LANE_LENGTH = 120;

const elementIdSchema = z.string().min(1);
const nodeIdSchema = z.string().min(1).max(120);
const timestampSchema = z.string().min(1);
const criterionListSchema = z.array(elementIdSchema).max(MAX_CRITERIA);

/**
 * The total disposition law: every criterion of the pinned revision carries
 * exactly one of these. `pending_reaffirmation` is the interim state seeding
 * assigns to a soft-stale criterion — legal in a draft, refused at propose —
 * so a seeded plan is never silently incomplete.
 */
export const DELIVERY_PLAN_DISPOSITIONS = [
  "selected",
  "deferred",
  "waived",
  "delivered_elsewhere",
  "reaffirmed",
  "pending_reaffirmation",
] as const;

export const deliveryPlanDispositionSchema = z.enum(DELIVERY_PLAN_DISPOSITIONS);
export type DeliveryPlanDisposition = z.infer<
  typeof deliveryPlanDispositionSchema
>;

/**
 * The audited human act behind a `reaffirmed` disposition. Its production
 * owner is the Studio reaffirm act (context `dpa-studio`); the plan carries
 * the record so lint can refuse a disposition asserted without one.
 */
export const deliveryPlanReaffirmationSchema = z
  .object({
    actor: actorProvenanceSchema,
    at: timestampSchema,
    /** The delivered revision the reaffirmation was judged against. */
    basisRevisionId: elementIdSchema,
    /**
     * The exact governing elements — and both of their payload hashes — the
     * human judged. Recording them is what makes the act falsifiable later: if
     * the same criterion goes soft-stale against a DIFFERENT basis, this
     * reaffirmation demonstrably did not cover it, and the criterion reads as
     * pending again. Comparing hashes rather than a stored verdict is what
     * keeps the judgment a read-time projection (`computed-projections`).
     */
    basis: z
      .array(
        z
          .object({
            elementId: elementIdSchema,
            reason: criterionStalenessReasonSchema,
            baseHash: z.string().min(1).nullable(),
            currentHash: z.string().min(1).nullable(),
          })
          .strict(),
      )
      .max(MAX_REAFFIRMATION_BASIS),
  })
  .strict();
export type DeliveryPlanReaffirmation = z.infer<
  typeof deliveryPlanReaffirmationSchema
>;

export const deliveryPlanCriterionDispositionSchema = z
  .object({
    criterionElementId: elementIdSchema,
    disposition: deliveryPlanDispositionSchema,
    /** The earlier merged execution a `delivered_elsewhere` claim rests on. */
    deliveredByExecutionId: elementIdSchema.nullable(),
    reaffirmation: deliveryPlanReaffirmationSchema.nullable(),
    note: z.string().max(2000).nullable(),
  })
  .strict();
export type DeliveryPlanCriterionDisposition = z.infer<
  typeof deliveryPlanCriterionDispositionSchema
>;

/**
 * A context with no owned criteria is only legal when it is explicitly typed
 * as integration or closeout work carrying its own observable contract — the
 * replacement for the compiler's "no selected criterion is directly mapped to
 * this prerequisite task" apology (design §4).
 */
export const deliveryPlanContextTypeSchema = z.enum([
  "delivery",
  "integration",
  "closeout",
]);
export type DeliveryPlanContextType = z.infer<
  typeof deliveryPlanContextTypeSchema
>;

export const deliveryPlanProofStepSchema = z
  .object({
    criterionElementId: elementIdSchema,
    evidenceKinds: z.array(evidenceKindSchema).max(8),
    note: z.string().max(2000),
  })
  .strict();
export type DeliveryPlanProofStep = z.infer<typeof deliveryPlanProofStepSchema>;

/**
 * One authored ownership entry: a normalized repo-relative POSIX path covering
 * itself and everything beneath it.
 *
 * The grammar — including the unconditional, case-folded `.git` and `.cc`
 * denials — is the graph tier's `ownedPathSchema`, mirrored rather than
 * imported: this module is a client-importable leaf, and importing
 * `@/lib/workflow-graph` would drag the whole definition schema graph into
 * every reader of a plan payload. `delivery-plan.test.ts` pins the mirror
 * against the owning schema so the two cannot drift; a path this schema admits
 * and the graph tier refuses would compile into a definition that is rejected
 * only at launch.
 *
 * The length cap is this tier's alone: the plan document is stored whole in one
 * TEXT column, so every collection and its entries owe the persisted-blob gate
 * a static bound the graph tier has no reason to carry.
 */
const deliveryPlanOwnedPathSchema = z
  .string()
  .min(1)
  .max(MAX_OWNED_PATH_LENGTH)
  .superRefine((value, ctx) => {
    const reject = (message: string): void => {
      ctx.addIssue({ code: "custom", message });
    };
    if (value === "." || value === "./") {
      reject(
        `owned path "${value}" names the repository root; declare the directories the context owns instead`,
      );
      return;
    }
    const segments = value.split("/");
    if (
      value !== value.trim() ||
      value.startsWith("/") ||
      /^[A-Za-z]:/.test(value) ||
      value.includes("\\") ||
      value.endsWith("/") ||
      segments.some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
    ) {
      reject(
        `owned path "${value}" must be a normalized repo-relative POSIX path without parent segments or trailing separators`,
      );
      return;
    }
    if (segments[0]?.toLowerCase() === ".git") {
      reject(
        `owned path "${value}" names repository metadata; .git is denied regardless of authored ownership`,
      );
      return;
    }
    if (segments[0]?.toLowerCase() === ".cc") {
      reject(
        `owned path "${value}" names the engine's .cc namespace; the write envelope injects a per-context payload directory there, so it is reserved from authored ownership`,
      );
    }
  });

const placementLaneShape = {
  /**
   * The authored lane name. Lane-name grammar (charset, reserved session
   * identifiers) is checked by propose-time lint rather than here, so the
   * refusal can name the context that declared it — and so this schema keeps
   * admitting exactly what the graph tier admits.
   */
  lane: z.string().trim().min(1).max(MAX_LANE_LENGTH),
};

/**
 * Where a context runs and what it may write, authored in the graph tier's own
 * vocabulary (design D1) so materialization is a copy rather than a
 * translation — the precedent `deliveryPlanGovernanceSchema` already sets.
 *
 * Discriminated on `mode` so each grade carries exactly its own obligations,
 * and `.strict()` so a stray `ownedPaths` on a full-access or read-only
 * placement is a refusal rather than a silently ignored declaration of intent.
 * An empty `ownedPaths` is invalid by construction: `readOnly` is the explicit
 * grade for a context with no write surface.
 */
export const deliveryPlanContextPlacementSchema = z.discriminatedUnion("mode", [
  z.object({ ...placementLaneShape, mode: z.literal("full") }).strict(),
  z
    .object({
      ...placementLaneShape,
      mode: z.literal("owned"),
      ownedPaths: z
        .array(deliveryPlanOwnedPathSchema)
        .min(1, {
          message:
            'an owning placement must declare at least one owned path; use mode "readOnly" for a context with no write surface',
        })
        .max(MAX_OWNED_PATHS),
    })
    .strict(),
  z.object({ ...placementLaneShape, mode: z.literal("readOnly") }).strict(),
]);
export type DeliveryPlanContextPlacement = z.infer<
  typeof deliveryPlanContextPlacementSchema
>;

export const deliveryPlanContextSchema = z
  .object({
    contextId: nodeIdSchema,
    title: z.string().min(1).max(200),
    contextType: deliveryPlanContextTypeSchema,
    criterionElementIds: criterionListSchema,
    /** The context-local acceptance contract, authored — never unioned. */
    acceptanceContract: z
      .array(z.string().min(1).max(4000))
      .max(MAX_CONTRACT_LINES),
    proofPlan: z.array(deliveryPlanProofStepSchema).max(MAX_CRITERIA),
    /**
     * Optional, unlike the graph tier's required field: there the absence of a
     * placement would silently resurrect seed-time lane assignment, whereas
     * here the materializer is the single deliberate owner of the solo-lane
     * default (design D2). Omitting it is the author's explicit choice to take
     * that default, so every plan written before placement existed keeps its
     * canonical serialization — and its hash — byte for byte.
     */
    placement: deliveryPlanContextPlacementSchema.optional(),
  })
  .strict();
export type DeliveryPlanContext = z.infer<typeof deliveryPlanContextSchema>;

export const deliveryPlanTaskSchema = z
  .object({
    taskId: nodeIdSchema,
    contextId: nodeIdSchema,
    title: z.string().min(1).max(200),
    instructions: z.string().min(1).max(20000),
    /** Position within the owning context; order inside a context is just order. */
    order: z.number().int().nonnegative(),
    /**
     * Provenance only. A task annotation never manufactures a validator
     * contract — the owning context's acceptance contract is the only thing
     * a validator is held to.
     */
    contributesToCriterionElementIds: criterionListSchema,
  })
  .strict();
export type DeliveryPlanTask = z.infer<typeof deliveryPlanTaskSchema>;

export const deliveryPlanEdgeSchema = z
  .object({
    edgeId: nodeIdSchema,
    fromContextId: nodeIdSchema,
    toContextId: nodeIdSchema,
  })
  .strict();
export type DeliveryPlanEdge = z.infer<typeof deliveryPlanEdgeSchema>;

/**
 * Production wiring stated structurally rather than in prose: either some
 * context owns the call site that reaches the capability, or a named
 * downstream context does. Prose could not be resolved to exactly one owner,
 * which is what lint checks.
 */
export const deliveryPlanWiringOwnerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("call_site"),
      contextId: nodeIdSchema,
      locator: z.string().min(1).max(500),
    })
    .strict(),
  z.object({ kind: z.literal("downstream"), contextId: nodeIdSchema }).strict(),
]);
export type DeliveryPlanWiringOwner = z.infer<
  typeof deliveryPlanWiringOwnerSchema
>;

export const deliveryPlanWiringEntrySchema = z
  .object({
    capabilityId: nodeIdSchema,
    criterionElementIds: criterionListSchema,
    owner: deliveryPlanWiringOwnerSchema,
  })
  .strict();
export type DeliveryPlanWiringEntry = z.infer<
  typeof deliveryPlanWiringEntrySchema
>;

export const deliveryPlanPolicyOverrideSchema = z
  .object({
    key: z.string().min(1).max(200),
    value: z.string().min(1).max(2000),
    rationale: z.string().min(1).max(2000),
  })
  .strict();
export type DeliveryPlanPolicyOverride = z.infer<
  typeof deliveryPlanPolicyOverrideSchema
>;

/**
 * A source of truth in the charter's own vocabulary, bounded for the blob
 * column. Every field the workflow charter needs is authored here — including
 * `type` and `accessPolicy`, which govern whether an agent may read the source
 * at all: deriving those at materialization would be exactly the synthesis
 * this document exists to remove.
 */
export const deliveryPlanSourceOfTruthSchema = z
  .object({
    rank: z.number().int().positive(),
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(200),
    type: sourceTypeSchema,
    locator: z.string().min(1).max(500),
    description: z.string().min(1).max(2000),
    /** Applicability scope; null when the source governs every context. */
    appliesTo: z.string().min(1).max(500).nullable(),
    accessPolicy: accessPolicySchema,
  })
  .strict();
export type DeliveryPlanSourceOfTruth = z.infer<
  typeof deliveryPlanSourceOfTruthSchema
>;

/**
 * A charter invariant carries its own stable id because validators cite the id
 * in issues; a materializer-assigned id would renumber under an edit and break
 * every citation that already named one.
 */
export const deliveryPlanCharterInvariantSchema = z
  .object({
    id: z.string().min(1).max(120),
    // Sized with `mission`: both carry authored governance prose, and a real
    // approved `intent_constraints` section (2786 characters on
    // workflow-validator-cohorts revision 11) does not fit in less. The blob
    // bound that matters is the 60-entry cap above; the gate checks collection
    // bounds, not string lengths.
    statement: z.string().min(1).max(8000),
  })
  .strict();
export type DeliveryPlanCharterInvariant = z.infer<
  typeof deliveryPlanCharterInvariantSchema
>;

/**
 * The execution-scoped governance the plan authors once and materialization
 * copies: the mission, charter invariants, ranked sources of truth, and the
 * registered deterministic validation selections (design §4).
 *
 * The shape is the workflow charter's own, field for field, so materialization
 * is a copy rather than a translation. It is bounded here rather than reusing
 * `workflowCharterSchema` directly because this document is stored whole in one
 * TEXT column and every collection in it owes the persisted-blob gate a static
 * cap. An empty mission and an empty source list are the legal draft state —
 * materialization, not the schema, is what refuses to compile them.
 */
export const deliveryPlanGovernanceSchema = z
  .object({
    mission: z.string().max(8000),
    charterInvariants: z
      .array(deliveryPlanCharterInvariantSchema)
      .max(MAX_INVARIANTS),
    sourcesOfTruth: z
      .array(deliveryPlanSourceOfTruthSchema)
      .max(MAX_SOURCES_OF_TRUTH),
    validationCommandNames: z
      .array(z.string().min(1).max(200))
      .max(MAX_VALIDATION_COMMANDS),
  })
  .strict();
export type DeliveryPlanGovernance = z.infer<
  typeof deliveryPlanGovernanceSchema
>;

export const deliveryPlanDocumentSchema = z
  .object({
    dispositions: z
      .array(deliveryPlanCriterionDispositionSchema)
      .max(MAX_CRITERIA),
    contexts: z.array(deliveryPlanContextSchema).max(MAX_CONTEXTS),
    tasks: z.array(deliveryPlanTaskSchema).max(MAX_TASKS),
    edges: z.array(deliveryPlanEdgeSchema).max(MAX_EDGES),
    wiring: z.array(deliveryPlanWiringEntrySchema).max(MAX_WIRING),
    policyOverrides: z
      .array(deliveryPlanPolicyOverrideSchema)
      .max(MAX_POLICY_OVERRIDES),
    touchedSurfaces: z
      .array(z.string().min(1).max(500))
      .max(MAX_TOUCHED_SURFACES),
    governance: deliveryPlanGovernanceSchema,
  })
  .strict();
export type DeliveryPlanDocument = z.infer<typeof deliveryPlanDocumentSchema>;

/** The document `spec plan open` writes before the author has said anything. */
export function emptyDeliveryPlanDocument(): DeliveryPlanDocument {
  return {
    dispositions: [],
    contexts: [],
    tasks: [],
    edges: [],
    wiring: [],
    policyOverrides: [],
    touchedSurfaces: [],
    governance: {
      mission: "",
      charterInvariants: [],
      sourcesOfTruth: [],
      validationCommandNames: [],
    },
  };
}

/**
 * The reserved worktree-relative locator for the pinned spec revision a
 * delivery run implements. The engine writes that file into every lane
 * worktree at launch, so it is the one spelling of the plan's own spec that a
 * lane agent can actually open.
 *
 * Owned here, beside the source-of-truth shape that cites it, because this
 * module is a leaf: the launch-side renderer and the propose-time lint both
 * read it from here rather than each hard-coding a path that can drift.
 */
export function pinnedSpecDocumentPath(slug: string): string {
  return `.cc/graph-workflow-docs/spec/${slug}.md`;
}

/** The reserved id of that entry, so re-installing it replaces rather than duplicates. */
export const PINNED_SPEC_SOURCE_ID = "pinned-spec";

/**
 * The plan's own spec as a source of truth a lane can read: rank 1, because
 * nothing outranks the contract the run is judged against, and
 * `worktree-relative`, because the file is materialized into the worktree.
 * `external-readonly` is reserved for genuinely out-of-worktree sources, whose
 * charter rule forbids an agent from reading them without a human's say-so.
 */
export function pinnedSpecSourceOfTruth(input: {
  readonly specSlug: string;
  readonly pinnedRevisionId: string;
}): DeliveryPlanSourceOfTruth {
  return {
    rank: 1,
    id: PINNED_SPEC_SOURCE_ID,
    label: `Pinned spec ${input.specSlug}`,
    type: "spec",
    locator: pinnedSpecDocumentPath(input.specSlug),
    description: `The pinned revision ${input.pinnedRevisionId} of ${input.specSlug}, materialized into every lane worktree at launch. It is the contract this run is judged against; read it rather than live spec state, which a mid-run amendment legitimately moves.`,
    appliesTo: null,
    accessPolicy: "worktree-relative",
  };
}

/**
 * Install the reserved entry at rank 1 without rewriting anything an author
 * wrote. Carried entries keep their relative order and their identity; only
 * their rank shifts by one, which the charter allows because ranks owe it
 * nothing but uniqueness and positivity. An entry that already claims the
 * reserved id or locator IS this entry, so it is replaced rather than
 * duplicated.
 *
 * A carried entry that names the same spec through an unreadable spelling
 * survives deliberately: deleting an authored source would be exactly the
 * synthesis the plan document exists to remove, so `plan/spec-source-unreadable`
 * names it and the author retires it.
 */
export function withPinnedSpecSource(
  document: DeliveryPlanDocument,
  input: { readonly specSlug: string; readonly pinnedRevisionId: string },
): DeliveryPlanDocument {
  const reserved = pinnedSpecSourceOfTruth(input);
  const carried = document.governance.sourcesOfTruth
    .filter(
      (entry) => entry.id !== reserved.id && entry.locator !== reserved.locator,
    )
    .map((entry) => ({ ...entry, rank: entry.rank + 1 }));
  return {
    ...document,
    governance: {
      ...document.governance,
      sourcesOfTruth: [reserved, ...carried],
    },
  };
}

/**
 * The immutable identity of one compiled candidate. All three parts are
 * required because each of them can move on its own: the plan hash covers the
 * authored document, the compiled hash covers the bytes a launch actually
 * runs, and the candidate id names the row those bytes live in. An approval
 * that bound only the plan hash would still stand over a candidate compiled
 * from different inherited defaults — the substitution `exact-approval` exists
 * to refuse.
 */
export const deliveryPlanCandidateIdentitySchema = z
  .object({
    candidateId: elementIdSchema,
    planHash: z.string().min(1),
    compiledDefinitionHash: z.string().min(1),
  })
  .strict();
export type DeliveryPlanCandidateIdentity = z.infer<
  typeof deliveryPlanCandidateIdentitySchema
>;

/**
 * The approval stored on an attempt: which frozen snapshot a human signed off
 * and the exact candidate identity it binds. A reopen clears it, and nothing
 * ever rewrites the snapshot or the candidate it names (`exact-approval`).
 */
export const deliveryPlanApprovalSchema = deliveryPlanCandidateIdentitySchema
  .extend({
    snapshotId: elementIdSchema,
    approvedAt: timestampSchema,
    approvedBy: actorProvenanceSchema,
  })
  .strict();
export type DeliveryPlanApproval = z.infer<typeof deliveryPlanApprovalSchema>;

/**
 * The durable spec-side prelaunch review record `spec start --park` writes. It
 * is deliberately NOT cleared by a reopen: the candidate a human parked for
 * review is what a later launch refusal has to name as the old hash, and an
 * approval invalidated by the reopen leaves nothing else that remembers it
 * (design §5, "any parked tuning that changes the candidate hash is displayed
 * and re-approved").
 */
export const deliveryPlanPrelaunchSchema = z
  .object({
    parkedAt: timestampSchema,
    parkedBy: actorProvenanceSchema,
    reason: z.string().max(2000).nullable(),
    /** The candidate the park held for review. */
    candidate: deliveryPlanCandidateIdentitySchema,
    /** Whether that candidate already carried an approval when it was parked. */
    approvedAtPark: z.boolean(),
  })
  .strict();
export type DeliveryPlanPrelaunch = z.infer<typeof deliveryPlanPrelaunchSchema>;

/**
 * The attempt every plan verb addresses: the most recently opened one that has
 * not been abandoned. An abandoned attempt is history — addressing it would
 * give every verb a refusal whose only remedy is to open a new attempt anyway.
 *
 * One authority, because `spec capture` decides whether it is looking at a
 * launched run from the SAME attempt the plan verbs would edit; two copies of
 * this rule would let capture and reopen disagree about which plan is live.
 */
export function liveDeliveryPlanAttempt<
  T extends { readonly status: DeliveryPlanAttemptStatus },
>(attempts: readonly T[]): T | null {
  const live = attempts.filter((attempt) => attempt.status !== "abandoned");
  return live[live.length - 1] ?? null;
}

/**
 * The three explicit paths out of a launched run (design §11), in the order a
 * receipt should present them. One owner, because the reopen refusal, the
 * capture receipt, and `cctl spec` help must name the same three: a second
 * copy is how a fourth path — or a stale one — quietly appears in a receipt.
 *
 * Bounded to exactly these three. Anything else that mutated a running plan
 * would be the silent scope drift `exact-approval` exists to prevent.
 */
export function postLaunchPathActs(input: {
  /** Omitted where the caller has only the run in hand, as storage does. */
  readonly slug?: string;
  readonly executionId: string;
}): readonly [string, string, string] {
  const target = input.slug ?? `--execution ${input.executionId}`;
  return [
    `record a non-blocking discovery for the next plan with \`cctl spec capture ${target} --file <task.json>\``,
    `abandon this run and open a seeded replacement with \`cctl spec capture ${target} --file <task.json> --blocking-reason <why>\``,
    "amend the running definition with `cctl workflow live amend`",
  ];
}

/** The sentence every refusal and receipt uses to state those three paths. */
export function postLaunchPathsSentence(input: {
  readonly slug?: string;
  readonly executionId: string;
}): string {
  return `The plan is already running as execution ${input.executionId}, so its scope is pinned. Take one of the three post-launch paths: ${postLaunchPathActs(
    input,
  ).join("; ")}.`;
}
