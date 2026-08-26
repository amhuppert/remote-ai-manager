import { z } from "zod";

// ============================================================
// Identity
// ============================================================

/**
 * The three sibling scopes a profile can live in. Tiers do NOT shadow each
 * other: a profile is addressed only as `{tier, id}`, so `builtin:general-reviewer`
 * and `project:general-reviewer` are two different profiles that coexist.
 */
export const agentProfileTierSchema = z.enum(["builtin", "global", "project"]);
export type AgentProfileTier = z.infer<typeof agentProfileTierSchema>;

/** Lowercase kebab-case slug: the immutable identity of a profile in its tier. */
const PROFILE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const agentProfileIdSchema = z.string().regex(PROFILE_ID);
export type AgentProfileId = z.infer<typeof agentProfileIdSchema>;

export class AgentProfileInvalidIdError extends Error {
  readonly code = "agent_profile_invalid_id" as const;

  constructor(readonly id: string) {
    super(
      `Invalid agent profile id ${JSON.stringify(id)}. Ids are lowercase kebab-case slugs, for example "security-reviewer".`,
    );
    this.name = "AgentProfileInvalidIdError";
  }
}

/**
 * The id an authoring surface pre-fills from a profile's name. The author may
 * edit it before create — after that the id is immutable — so this is a
 * default, never a rename: nothing derives an id from a name again later.
 *
 * The result is not guaranteed valid: a name with no alphanumeric characters
 * yields the empty string, which `agentProfileIdSchema` refuses. That refusal
 * is deliberate — inventing an id for an unnameable profile would produce an
 * identity the author never saw.
 */
export function deriveAgentProfileId(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `deriveAgentProfileId` plus validation, for callers that need a usable id. */
export function assertValidAgentProfileId(id: string): AgentProfileId {
  const parsed = agentProfileIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new AgentProfileInvalidIdError(id);
  }
  return parsed.data;
}

/**
 * Who a profile is advisory-recommended for. Pickers filter and warn on this;
 * nothing enforces it — a profile recommended for validators can still be
 * chosen for a conversation.
 */
export const agentProfileAudienceSchema = z.enum([
  "conversation",
  "workflow_implementer",
  "workflow_validator",
]);
export type AgentProfileAudience = z.infer<typeof agentProfileAudienceSchema>;

/**
 * A profile is prompt identity only. `.strict()` is the enforcement of that
 * boundary, not a formality: runtime (backend/modelSelection) and policy
 * (tools/mcp/skills/permissions/output schemas) keys must FAIL to parse so a
 * profile can never grow into a second, competing runtime or policy cascade.
 * The tier is likewise absent — it comes from the scope the record was read
 * from, and a stored record that carried its own tier could contradict it.
 */
export const agentProfileSchema = z
  .object({
    id: agentProfileIdSchema,
    revision: z.number().int().positive(),
    name: z.string().min(1),
    // Required and non-empty: the library is machine-discoverable by
    // description, so a planning agent staffs assignments by reading this.
    description: z.string().min(1),
    // May be empty: a profile with no instruction content is a no-op lens —
    // a real, selectable, named record that composes to no prompt bytes at all
    // (see `renderProfileBlock`). Identity lives in the fields above it.
    instructions: z.string(),
    recommendedFor: z
      .array(agentProfileAudienceSchema)
      .refine((values) => new Set(values).size === values.length, {
        message: "recommendedFor must not repeat an audience",
      })
      .default([]),
    tags: z
      .array(z.string().min(1))
      .refine((values) => new Set(values).size === values.length, {
        message: "tags must not repeat a tag",
      })
      .default([]),
  })
  .strict();
export type AgentProfile = z.infer<typeof agentProfileSchema>;

/**
 * The qualified reference. Every persisted reference is this structured form —
 * the compact `tier:id` spelling exists only at text/CLI boundaries and is
 * normalized here at parse (see `parseAgentProfileRef`).
 */
export const agentProfileRefSchema = z
  .object({
    tier: agentProfileTierSchema,
    id: agentProfileIdSchema,
  })
  .strict();
export type AgentProfileRef = z.infer<typeof agentProfileRefSchema>;

// ============================================================
// Tier mutability
// ============================================================

/**
 * Built-ins ship with the product and are read-only through CRUD; editing one
 * means duplicating it into a mutable tier. The rule is tier identity, so it
 * lives with the tier definition and the library service composes it rather
 * than re-deriving "is this a builtin" at each mutation entry point.
 */
export function isMutableProfileTier(tier: AgentProfileTier): boolean {
  return tier !== "builtin";
}

/**
 * The tiers a record can actually be written to. Derived from the tier enum
 * rather than re-listed, so adding a tier forces every mutation path to decide
 * whether it is writable instead of silently defaulting to read-only.
 */
export type MutableAgentProfileTier = Exclude<AgentProfileTier, "builtin">;

export type AgentProfileMutation = "create" | "update" | "delete";

export class AgentProfileTierReadOnlyError extends Error {
  readonly code = "agent_profile_tier_read_only" as const;

  constructor(
    readonly ref: AgentProfileRef,
    readonly operation: AgentProfileMutation,
  ) {
    super(
      `Cannot ${operation} ${formatAgentProfileRef(ref)}: the builtin tier is read-only. Duplicate it into the global or project tier to edit it.`,
    );
    this.name = "AgentProfileTierReadOnlyError";
  }
}

/** A reference that has been proven to address a writable tier. */
export interface MutableAgentProfileRef extends AgentProfileRef {
  tier: MutableAgentProfileTier;
}

/**
 * Throws `AgentProfileTierReadOnlyError` when `ref` addresses a built-in.
 *
 * Narrows rather than returning void: past this call the tier is writable in
 * the type system too, so a mutation path cannot forget the check and reach a
 * storage scope that has no builtin equivalent.
 */
export function assertMutableProfileTier(
  ref: AgentProfileRef,
  operation: AgentProfileMutation,
): asserts ref is MutableAgentProfileRef {
  if (!isMutableProfileTier(ref.tier)) {
    throw new AgentProfileTierReadOnlyError(ref, operation);
  }
}

// ============================================================
// Content hash envelope
// ============================================================

/**
 * The persisted hash envelope. The `sha256:` prefix is self-describing so a
 * future algorithm change is an explicit, readable migration rather than a
 * silent reinterpretation of stored hex. `computeContentHash` in `./hashing`
 * produces it; the format lives here because schema consumers (including
 * client code) validate the envelope without needing node:crypto.
 */
export const contentHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export type ContentHash = z.infer<typeof contentHashSchema>;

// ============================================================
// Stored library records
// ============================================================

/**
 * A profile as it persists in a mutable tier. `sourceContentHash` is derived at
 * write from `instructions` and stored beside them, so a reader knows which
 * library content a snapshot was taken from without re-hashing (and a record
 * whose hash stops covering its instructions is detectable rather than silent).
 * The tier is absent for the same reason it is absent from `agentProfileSchema`
 * — it comes from the scope the record was read from.
 */
export const storedAgentProfileRecordSchema = agentProfileSchema
  .extend({
    sourceContentHash: contentHashSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type StoredAgentProfileRecord = z.infer<
  typeof storedAgentProfileRecordSchema
>;

/**
 * The editable content of a profile: everything except the fields storage owns.
 * `id` is absent because an id is immutable across revisions (R1.4) — an update
 * that could carry one would make the refusal a runtime check instead of a
 * type-level impossibility.
 */
export const agentProfileContentSchema = agentProfileSchema.omit({
  id: true,
  revision: true,
});
export type AgentProfileContent = z.infer<typeof agentProfileContentSchema>;

/**
 * The authoring-side shape, where `recommendedFor` and `tags` may be omitted
 * and take their schema defaults. Authoring surfaces (forms, routes, the CLI)
 * accept this; everything past the parse holds `AgentProfileContent`, whose
 * arrays are always present.
 */
export type AgentProfileContentInput = z.input<
  typeof agentProfileContentSchema
>;

/** Create input: the editable content plus the id the author chose. */
export const agentProfileCreateInputSchema = agentProfileContentSchema.extend({
  id: agentProfileIdSchema,
});
export type AgentProfileCreateInput = z.infer<
  typeof agentProfileCreateInputSchema
>;

// ============================================================
// Resolution and snapshots
// ============================================================

/**
 * A profile resolved for one consumer: the record's identity plus the tier it
 * was found in and the hash of its stored instructions. This is the composer's
 * input — the snapshot below is what the consumer persists.
 */
export const resolvedAgentProfileSchema = z
  .object({
    tier: agentProfileTierSchema,
    id: agentProfileIdSchema,
    name: z.string().min(1),
    revision: z.number().int().positive(),
    sourceContentHash: contentHashSchema,
    /** Empty for a no-op profile, which the composer renders as no block. */
    instructions: z.string(),
  })
  .strict();
export type ResolvedAgentProfile = z.infer<typeof resolvedAgentProfileSchema>;

/**
 * The private snapshot a consumer persists so later library edits never change
 * live work. It stores the rendered block verbatim: restart replays exactly
 * what was delivered, which is why `resolvedInstructionHash` can never drift
 * from what the model actually received. Verbatim includes the empty string —
 * a no-op profile delivered no bytes, and that is what its snapshot records.
 */
export const agentProfileSnapshotSchema = resolvedAgentProfileSchema
  .extend({
    renderedInstructionBlock: z.string(),
    resolvedInstructionHash: contentHashSchema,
  })
  .strict();
export type AgentProfileSnapshot = z.infer<typeof agentProfileSnapshotSchema>;

/**
 * The snapshot as it crosses a read surface (API, CLI, UI): identity and both
 * provenance hashes, never instruction text. `.strict()` makes a leak a parse
 * failure instead of a quiet disclosure.
 */
export const redactedAgentProfileSnapshotSchema =
  agentProfileSnapshotSchema.omit({
    instructions: true,
    renderedInstructionBlock: true,
  });
export type RedactedAgentProfileSnapshot = z.infer<
  typeof redactedAgentProfileSnapshotSchema
>;

export function redactAgentProfileSnapshot(
  snapshot: AgentProfileSnapshot,
): RedactedAgentProfileSnapshot {
  const { instructions: _i, renderedInstructionBlock: _r, ...rest } = snapshot;
  return rest;
}

// ============================================================
// Library read surfaces
// ============================================================

/**
 * A profile as it appears in a listing: enough to pick one, without its text.
 * Instruction text is deliberately absent rather than optional — a listing is
 * the surface R6.3 keeps clear of it, and a schema that could carry it would
 * make that a convention instead of a contract.
 */
export const agentProfileLibraryItemSchema = z
  .object({
    ref: agentProfileRefSchema,
    name: z.string().min(1),
    description: z.string().min(1),
    revision: z.number().int().positive(),
    /** Advisory only — a picker filters and warns on it; nothing refuses on it. */
    recommendedFor: z.array(agentProfileAudienceSchema),
    tags: z.array(z.string().min(1)),
    /** True for the builtin tier, whose records are read-only through CRUD. */
    readOnly: z.boolean(),
  })
  .strict();
export type AgentProfileLibraryItem = z.infer<
  typeof agentProfileLibraryItemSchema
>;

/**
 * A stored record that could not be read, reported alongside the healthy ones.
 * `id` is the raw filename stem rather than a parsed ref: a corrupt record can
 * carry an id that is not a valid slug, and the operator still needs to be told
 * which record to look at.
 */
export const agentProfileLibraryDiagnosticSchema = z
  .object({
    tier: agentProfileTierSchema.exclude(["builtin"]),
    id: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
export type AgentProfileLibraryDiagnostic = z.infer<
  typeof agentProfileLibraryDiagnosticSchema
>;

export const agentProfileLibraryListingSchema = z
  .object({
    profiles: z.array(agentProfileLibraryItemSchema),
    diagnostics: z.array(agentProfileLibraryDiagnosticSchema),
  })
  .strict();
export type AgentProfileLibraryListing = z.infer<
  typeof agentProfileLibraryListingSchema
>;

/**
 * A full profile plus the tier it was found in. Storage bookkeeping
 * (`sourceContentHash`, timestamps) is deliberately absent so an entry means
 * the same thing in every tier — built-ins have no stored record. Provenance
 * belongs to resolution.
 */
export const agentProfileLibraryEntrySchema = agentProfileSchema
  .extend({
    tier: agentProfileTierSchema,
    readOnly: z.boolean(),
  })
  .strict();
export type AgentProfileLibraryEntry = z.infer<
  typeof agentProfileLibraryEntrySchema
>;

/**
 * Where a referencing document lives. Discriminated rather than a nullable
 * project path so "the global tier" is a scope in its own right instead of the
 * absence of one — a global template holds a reference every project can see.
 */
export const agentProfileReferenceScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), projectPath: z.string() }).strict(),
  z.object({ kind: z.literal("global") }).strict(),
]);
export type AgentProfileReferenceScope = z.infer<
  typeof agentProfileReferenceScopeSchema
>;

/**
 * One persisted artifact holding a reference to the profile, named the way the
 * human confirming a delete needs to find it: which document, and where inside
 * it.
 *
 * `contextId` is absent for a workflow-tier assignment, which belongs to the
 * document rather than to any one context. `dormant` marks a reference held by
 * an assignment inside a DISABLED cohort — configuration nothing currently
 * invokes, which is still persisted and re-enablable, so it is enumerated
 * rather than hidden (R15).
 */
export const agentProfileReferenceHolderSchema = z
  .object({
    scope: agentProfileReferenceScopeSchema,
    id: z.string().min(1),
    name: z.string(),
    contextId: z.string().min(1).optional(),
    dormant: z.boolean(),
  })
  .strict();
export type AgentProfileReferenceHolder = z.infer<
  typeof agentProfileReferenceHolderSchema
>;

/**
 * Every persisted holder of one profile reference: project-scope workflow
 * definitions, global-scope templates, and whether the global
 * `workflowDefaults` block names it.
 *
 * One shape serves the preview and the post-delete report, produced by one
 * reporter, so what the human was shown before confirming and what the delete
 * reports afterwards cannot drift.
 *
 * ADVISORY by construction (D14): it is a scan taken at one instant, with no
 * acceptance-time recheck. A reference authored between the preview and the
 * delete is caught by the fail-closed reference validation at validate and
 * launch, not by this enumeration.
 */
export const agentProfileSavedReferencesSchema = z
  .object({
    definitions: z.array(agentProfileReferenceHolderSchema),
    templates: z.array(agentProfileReferenceHolderSchema),
    workflowDefaults: z.boolean(),
  })
  .strict();
export type AgentProfileSavedReferences = z.infer<
  typeof agentProfileSavedReferencesSchema
>;

/**
 * What a delete actually costs. Live conversations are exempt by construction:
 * they persist a snapshot of the composed profile, not a reference into the
 * library, so deleting a record cannot change work already under way.
 *
 * The same shape answers the read-only preview, where `deletedRevision` is the
 * revision a delete WOULD remove — which is also the `expectedRevision` the
 * confirmed delete has to send.
 */
export const agentProfileDeletionReportSchema = z
  .object({
    ref: agentProfileRefSchema,
    deletedRevision: z.number().int().positive(),
    conversationSnapshotsExempt: z.literal(true),
    savedReferenceEnumeration: agentProfileSavedReferencesSchema,
  })
  .strict();
export type AgentProfileDeletionReport = z.infer<
  typeof agentProfileDeletionReportSchema
>;

// ============================================================
// Library change event
// ============================================================

export const agentProfileLibraryChangeActionSchema = z.enum([
  "created",
  "updated",
  "deleted",
]);
export type AgentProfileLibraryChangeAction = z.infer<
  typeof agentProfileLibraryChangeActionSchema
>;

const libraryChangeIdentityShape = {
  type: z.literal("agent-profile-library-changed"),
  id: agentProfileIdSchema,
  /** The revision the change produced; for a delete, the one it removed. */
  revision: z.number().int().positive(),
  action: agentProfileLibraryChangeActionSchema,
};

/**
 * A committed library mutation, announced so consumers can invalidate exactly
 * the queries the change can be seen through (D25).
 *
 * `scope` describes the CHANGED RECORD, not the route the change arrived on: a
 * global-tier profile edited from within one project is visible to every
 * project, so it must invalidate every project's library queries. That is why
 * the project variant carries `projectPath` structurally — a project-tier
 * change that could not name its project would force consumers to choose
 * between over-invalidating every project and missing the right one.
 *
 * `tier` agrees with `scope` by construction (the builtin tier is read-only, so
 * no change can originate there); both are on the wire because consumers
 * dispatch on the scope while displaying the record's qualified reference.
 */
export const agentProfileLibraryChangedEventSchema = z.discriminatedUnion(
  "scope",
  [
    z
      .object({
        ...libraryChangeIdentityShape,
        scope: z.literal("global"),
        tier: z.literal("global"),
      })
      .strict(),
    z
      .object({
        ...libraryChangeIdentityShape,
        scope: z.literal("project"),
        projectPath: z.string().min(1),
        tier: z.literal("project"),
      })
      .strict(),
  ],
);
export type AgentProfileLibraryChangedEvent = z.infer<
  typeof agentProfileLibraryChangedEventSchema
>;

// ============================================================
// tier:id shorthand
// ============================================================

/**
 * Why a compact reference could not be normalized. `unqualified` is the
 * common one: a bare id is ambiguous across sibling tiers, so it is refused
 * rather than guessed at.
 */
export type AgentProfileRefParseFailureKind =
  | "unqualified"
  | "unknown_tier"
  | "invalid_id";

/**
 * A located refusal: `offset`/`length` address the offending span in the
 * ENCLOSING source when the caller passes `sourceOffset`, so a text boundary
 * can point at the exact characters it rejected.
 */
export interface AgentProfileRefParseFailure {
  kind: AgentProfileRefParseFailureKind;
  message: string;
  /** The compact reference text that was parsed. */
  text: string;
  offset: number;
  length: number;
}

export type AgentProfileRefParseResult =
  | { ok: true; ref: AgentProfileRef }
  | { ok: false; failure: AgentProfileRefParseFailure };

export class AgentProfileRefParseError extends Error {
  constructor(readonly failure: AgentProfileRefParseFailure) {
    super(failure.message);
    this.name = "AgentProfileRefParseError";
  }
}

export interface ParseAgentProfileRefOptions {
  /** Index of `text` within the enclosing source, for located failures. */
  sourceOffset?: number;
}

/**
 * Normalize the compact `tier:id` spelling accepted at text and CLI boundaries
 * into the structured reference everything else uses. Never guesses a tier:
 * an unqualified id is refused with a located failure.
 */
export function parseAgentProfileRef(
  text: string,
  options?: ParseAgentProfileRefOptions,
): AgentProfileRefParseResult {
  const base = options?.sourceOffset ?? 0;
  const fail = (
    kind: AgentProfileRefParseFailureKind,
    message: string,
    localOffset: number,
    length: number,
  ): AgentProfileRefParseResult => ({
    ok: false,
    failure: { kind, message, text, offset: base + localOffset, length },
  });

  const separatorIndex = text.indexOf(":");
  if (separatorIndex === -1) {
    return fail(
      "unqualified",
      `Agent profile reference ${JSON.stringify(text)} is unqualified. Write it as tier:id, for example builtin:security-reviewer.`,
      0,
      text.length,
    );
  }

  const tierText = text.slice(0, separatorIndex);
  const tier = agentProfileTierSchema.safeParse(tierText);
  if (!tier.success) {
    return fail(
      "unknown_tier",
      `Unknown agent profile tier ${JSON.stringify(tierText)}. Expected builtin, global, or project.`,
      0,
      tierText.length,
    );
  }

  const idText = text.slice(separatorIndex + 1);
  const id = agentProfileIdSchema.safeParse(idText);
  if (!id.success) {
    return fail(
      "invalid_id",
      `Invalid agent profile id ${JSON.stringify(idText)}. Ids are lowercase kebab-case slugs.`,
      separatorIndex + 1,
      idText.length,
    );
  }

  return { ok: true, ref: { tier: tier.data, id: id.data } };
}

/** `parseAgentProfileRef` for callers whose failure path is a thrown error. */
export function parseAgentProfileRefOrThrow(
  text: string,
  options?: ParseAgentProfileRefOptions,
): AgentProfileRef {
  const result = parseAgentProfileRef(text, options);
  if (!result.ok) {
    throw new AgentProfileRefParseError(result.failure);
  }
  return result.ref;
}

/** The compact spelling for display and text boundaries. */
export function formatAgentProfileRef(ref: AgentProfileRef): string {
  return `${ref.tier}:${ref.id}`;
}
