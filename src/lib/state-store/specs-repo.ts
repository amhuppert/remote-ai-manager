import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { timed, timedSync } from "@/lib/logging/timed";
import { formatBareElementHandle } from "@/lib/specs/handles";
import {
  externalDeliverySchema,
  specAssumptionCitationRowSchema,
  specAssumptionCitationSchema,
  specAssumptionCitationSnapshotSchema,
  specAliasRowSchema,
  specAliasSchema,
  specAuthoringStageSchema,
  specCounterRowSchema,
  specCounterSchema,
  specCounterScopeKeySchema,
  specElementKindSchema,
  specElementPayloadSchema,
  specElementRowSchema,
  specElementSchema,
  specElementVersionRowSchema,
  specElementVersionSchema,
  specGatePolicySchema,
  specRevisionRowSchema,
  specRevisionSchema,
  specRevisionSnapshotSchema,
  specRowSchema,
  specSchema,
  type Spec,
  type SpecAlias,
  type SpecAssumptionCitation,
  type SpecAssumptionCitationSnapshot,
  type SpecAuthoringStage,
  type SpecCounter,
  type SpecCounterScopeKey,
  type SpecElement,
  type SpecElementKind,
  type SpecElementPayload,
  type SpecElementVersion,
  type SpecRevision,
  type SpecRevisionElement,
  type SpecRevisionSnapshot,
} from "@/lib/specs/schemas";
import { PersistenceError, getErrorMessage } from "@/lib/shared/errors";
import { stableStringify } from "./serialization";
import type { WriteQueue } from "./write-queue";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.specs");

const createSpecInputSchema = z
  .object({
    spec: specSchema.omit({
      abandonedAt: true,
      abandonedReason: true,
    }),
    initialRevision: z
      .object({
        id: z.string().min(1),
        authoringStage: specAuthoringStageSchema,
        createdAt: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type CreateSpecInput = z.infer<typeof createSpecInputSchema>;

const renameSpecInputSchema = z
  .object({
    specId: z.string().min(1),
    slug: z.string().min(1),
    name: z.string(),
    updatedAt: z.string().min(1),
    aliasCreatedAt: z.string().min(1),
  })
  .strict();
export type RenameSpecInput = z.infer<typeof renameSpecInputSchema>;

const abandonSpecInputSchema = z
  .object({
    specId: z.string().min(1),
    abandonedAt: z.string().min(1),
    reason: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type AbandonSpecInput = z.infer<typeof abandonSpecInputSchema>;

const updateGatePolicyInputSchema = z
  .object({
    specId: z.string().min(1),
    gatePolicy: specGatePolicySchema,
    updatedAt: z.string().min(1),
  })
  .strict();
export type UpdateGatePolicyInput = z.infer<typeof updateGatePolicyInputSchema>;

const createDraftFromBaseInputSchema = z
  .object({
    id: z.string().min(1),
    specId: z.string().min(1),
    baseRevisionId: z.string().min(1),
    authoringStage: specAuthoringStageSchema,
    createdAt: z.string().min(1),
  })
  .strict();
export type CreateDraftFromBaseInput = z.infer<
  typeof createDraftFromBaseInputSchema
>;

const advanceDraftAuthoringStageInputSchema = z
  .object({
    specId: z.string().min(1),
    revisionId: z.string().min(1),
    expectedStage: specAuthoringStageSchema,
    targetStage: specAuthoringStageSchema,
  })
  .strict();
export type AdvanceDraftAuthoringStageInput = z.infer<
  typeof advanceDraftAuthoringStageInputSchema
>;

const approveRevisionInputSchema = z
  .object({
    revisionId: z.string().min(1),
    approvedAt: z.string().min(1),
  })
  .strict();
export type ApproveRevisionInput = z.infer<typeof approveRevisionInputSchema>;

const withdrawRevisionInputSchema = z
  .object({ revisionId: z.string().min(1) })
  .strict();
export type WithdrawRevisionInput = z.infer<typeof withdrawRevisionInputSchema>;

/**
 * Record that an imported revision's work already shipped elsewhere. It is a
 * write of its own rather than a field on revision creation because it is not
 * a lifecycle act: nothing about the revision's state changes, and the record
 * discharges no gate.
 */
const recordExternalDeliveryInputSchema = z
  .object({
    revisionId: z.string().min(1),
    externalDelivery: externalDeliverySchema,
  })
  .strict();
export type RecordExternalDeliveryInput = z.infer<
  typeof recordExternalDeliveryInputSchema
>;

const createDraftElementInputSchema = z
  .object({
    id: z.string().min(1),
    specId: z.string().min(1),
    revisionId: z.string().min(1),
    kind: specElementKindSchema,
    parentElementId: z.string().min(1).nullable(),
    /**
     * Omitted means append (R24.12): the server assigns the next position in
     * the revision's one global order inside the insert transaction, so no
     * caller has to read the revision to place an element and two concurrent
     * appends cannot collide on a position.
     */
    position: z.number().int().nonnegative().optional(),
    payload: specElementPayloadSchema,
    /**
     * Explicit intent to bring an identity this spec already owns back into
     * the target revision. Element ids are global and their rows are never
     * deleted, so an element whose only versions live outside this revision
     * would otherwise be unreachable: a create refuses the taken id and an
     * update finds no version to compare against. The marker is required
     * rather than inferred, because silently reviving an id is how an author
     * unknowingly re-opens content a review already ended.
     */
    reintroduceHistorical: z.boolean().optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type CreateDraftElementInput = z.infer<
  typeof createDraftElementInputSchema
>;

const updateDraftElementInputSchema = z
  .object({
    revisionId: z.string().min(1),
    elementId: z.string().min(1),
    expectedElementVersion: z.number().int().positive(),
    payload: specElementPayloadSchema,
    position: z.number().int().nonnegative().optional(),
    updatedAt: z.string().min(1).optional(),
  })
  .strict();
export type UpdateDraftElementInput = z.infer<
  typeof updateDraftElementInputSchema
>;

const removeDraftElementInputSchema = z
  .object({
    revisionId: z.string().min(1),
    elementId: z.string().min(1),
    expectedElementVersion: z.number().int().positive(),
  })
  .strict();
export type RemoveDraftElementInput = z.infer<
  typeof removeDraftElementInputSchema
>;

const reorderDraftElementInputSchema = z
  .object({
    revisionId: z.string().min(1),
    elementId: z.string().min(1),
    expectedElementVersion: z.number().int().positive(),
    position: z.number().int().nonnegative(),
    updatedAt: z.string().min(1).optional(),
  })
  .strict();
export type ReorderDraftElementInput = z.infer<
  typeof reorderDraftElementInputSchema
>;

const snapshotStorageRowSchema = z.object({
  element_id: z.string().min(1),
  element_spec_id: z.string().min(1),
  element_kind: specElementKindSchema,
  element_number: z.number().int().positive().nullable(),
  parent_element_id: z.string().min(1).nullable(),
  element_created_at: z.string().min(1),
  revision_id: z.string().min(1),
  position: z.number().int().nonnegative(),
  payload_json: z.string(),
  payload_hash: z.string().min(1),
  element_version: z.number().int().positive(),
  version_created_at: z.string().min(1),
  version_updated_at: z.string().min(1),
});

export interface CreateSpecResult {
  readonly spec: Spec;
  readonly revision: SpecRevision;
}

export interface RenameSpecResult {
  readonly spec: Spec;
  readonly alias: SpecAlias;
}

export interface CreateDraftElementResult {
  readonly element: SpecElement;
  readonly version: SpecElementVersion;
  /**
   * True when the write brought an identity the spec already owned back into
   * the revision rather than minting a new one. A revived element keeps its
   * number, so its handle is the address readers already know it by.
   */
  readonly revived: boolean;
}

export interface RevisionVerification {
  readonly ok: boolean;
  readonly expectedContentHash: string | null;
  readonly actualContentHash: string;
  readonly expectedCitationHash: string;
  readonly actualCitationHash: string;
  readonly mismatchedElementIds: string[];
}

const citationReplacementSchema = z
  .object({
    assumptionId: z.string().min(1),
    elementIds: z.array(z.string().min(1)),
    snapshot: specAssumptionCitationSnapshotSchema,
  })
  .strict()
  .superRefine((replacement, ctx) => {
    if (
      new Set(replacement.elementIds).size !== replacement.elementIds.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["elementIds"],
        message: "citation element ids must be unique",
      });
    }
    if (replacement.snapshot.assumptionId !== replacement.assumptionId) {
      ctx.addIssue({
        code: "custom",
        path: ["snapshot", "assumptionId"],
        message: "citation snapshot must identify its assumption",
      });
    }
  });

const replaceAssumptionDraftCitationsInputSchema = z
  .object({
    revisionId: z.string().min(1),
    specId: z.string().min(1),
    expectedCitationVersion: z.number().int().positive(),
    replacements: z.array(citationReplacementSchema),
    updatedAt: z.string().min(1),
  })
  .strict()
  .superRefine((input, ctx) => {
    const assumptionIds = input.replacements.map(
      (replacement) => replacement.assumptionId,
    );
    if (new Set(assumptionIds).size !== assumptionIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["replacements"],
        message: "each assumption may be replaced only once",
      });
    }
  });
export type ReplaceAssumptionDraftCitationsInput = z.infer<
  typeof replaceAssumptionDraftCitationsInputSchema
>;

const mutateDraftCitationInputSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("cite"),
      revisionId: z.string().min(1),
      specId: z.string().min(1),
      assumptionId: z.string().min(1),
      elementId: z.string().min(1),
      expectedCitationVersion: z.number().int().positive(),
      snapshot: specAssumptionCitationSnapshotSchema,
      updatedAt: z.string().min(1),
    })
    .strict(),
  z
    .object({
      operation: z.literal("uncite"),
      revisionId: z.string().min(1),
      specId: z.string().min(1),
      assumptionId: z.string().min(1),
      elementId: z.string().min(1),
      expectedCitationVersion: z.number().int().positive(),
      updatedAt: z.string().min(1),
    })
    .strict(),
]);
export type MutateDraftCitationInput = z.infer<
  typeof mutateDraftCitationInputSchema
>;

export interface SpecCitationReference {
  readonly elementId: string;
  readonly assumptionId: string;
}

export type CitationRelationFailure =
  | "revision_spec_mismatch"
  | "assumption_spec_mismatch"
  | "element_not_in_revision";

export type CitationCasOutcome =
  | {
      readonly kind: "success";
      readonly changed: boolean;
      readonly revision: SpecRevision;
      readonly citations: SpecAssumptionCitation[];
      readonly added: SpecCitationReference[];
      readonly removed: SpecCitationReference[];
      readonly refreshed: SpecCitationReference[];
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "stale_version"; readonly currentVersion: number }
  | {
      readonly kind: "illegal_lifecycle";
      readonly state: SpecRevision["state"];
    }
  | {
      readonly kind: "invalid_relation";
      readonly reason: CitationRelationFailure;
    };

export class SpecElementIdTakenError extends Error {
  readonly code = "element_id_taken" as const;

  constructor(
    readonly elementId: string,
    readonly existingSpecId: string,
  ) {
    super(
      `Spec element ID "${elementId}" is already used by spec "${existingSpecId}"; element IDs are globally unique.`,
    );
    this.name = "SpecElementIdTakenError";
  }
}

/**
 * Why a write against an id this spec already owns cannot proceed as asked.
 * `reintroduction_required` is recoverable by retrying with the marker; the
 * other two are not, because a reintroduced element keeps the identity facts
 * its number, handle, and containment were assigned from.
 */
export type SpecHistoricalElementReason =
  | "reintroduction_required"
  | "kind_changed"
  | "parent_changed";

export interface SpecHistoricalElementFacts {
  readonly reason: SpecHistoricalElementReason;
  readonly elementId: string;
  readonly specId: string;
  readonly revisionId: string;
  /** The kind the identity was created as. */
  readonly kind: SpecElementKind;
  /** The parent the identity was created under; null for a top-level element. */
  readonly parentElementId: string | null;
  /** The address the element keeps when it returns; null for a section. */
  readonly handle: string | null;
  readonly attemptedKind: SpecElementKind;
  readonly attemptedParentElementId: string | null;
}

/**
 * A same-spec element id whose versions all live outside the target revision.
 * Distinct from `SpecElementIdTakenError`, which reports an id owned by
 * ANOTHER spec: that one can only be resolved by choosing a different id,
 * while this one names a recovery the caller can actually take.
 */
export class SpecHistoricalElementError extends Error {
  readonly code = "historical_element_id" as const;
  readonly reason: SpecHistoricalElementReason;
  readonly elementId: string;
  readonly specId: string;
  readonly revisionId: string;
  readonly kind: SpecElementKind;
  readonly parentElementId: string | null;
  readonly handle: string | null;
  readonly attemptedKind: SpecElementKind;
  readonly attemptedParentElementId: string | null;

  constructor(facts: SpecHistoricalElementFacts) {
    super(historicalElementMessage(facts));
    this.reason = facts.reason;
    this.elementId = facts.elementId;
    this.specId = facts.specId;
    this.revisionId = facts.revisionId;
    this.kind = facts.kind;
    this.parentElementId = facts.parentElementId;
    this.handle = facts.handle;
    this.attemptedKind = facts.attemptedKind;
    this.attemptedParentElementId = facts.attemptedParentElementId;
    this.name = "SpecHistoricalElementError";
  }
}

function historicalElementMessage(facts: SpecHistoricalElementFacts): string {
  const address =
    facts.handle === null
      ? `a ${facts.kind}`
      : `${facts.handle} (${facts.kind})`;
  switch (facts.reason) {
    case "reintroduction_required":
      return `Spec element ID "${facts.elementId}" is ${address} this spec already owns, and no version of it lives in revision ${facts.revisionId}.`;
    case "kind_changed":
      return `Spec element ID "${facts.elementId}" is ${address} this spec already owns; a reintroduced element keeps its original kind, so it cannot return as a ${facts.attemptedKind}.`;
    case "parent_changed":
      return `Spec element ID "${facts.elementId}" is ${address} this spec already owns under ${facts.parentElementId ?? "no parent"}; a reintroduced element keeps the parent it was created under.`;
  }
}

export class StaleElementConflictError extends Error {
  readonly code = "stale_element" as const;

  constructor(
    readonly revisionId: string,
    readonly elementId: string,
    readonly expectedElementVersion: number,
    readonly current: SpecElementVersion,
  ) {
    super(
      `spec element ${elementId} in revision ${revisionId} is at version ${current.elementVersion}, not ${expectedElementVersion}`,
    );
    this.name = "StaleElementConflictError";
  }
}

export class StaleStageConflictError extends Error {
  readonly code = "stale_stage" as const;

  constructor(
    readonly specId: string,
    readonly expectedRevisionId: string,
    readonly expectedStage: SpecAuthoringStage,
    readonly currentRevision: SpecRevision | null,
  ) {
    super(
      currentRevision === null
        ? `spec ${specId} has no current draft; expected ${expectedRevisionId} at ${expectedStage}`
        : `spec ${specId} current draft is ${currentRevision.id} at ${currentRevision.authoringStage}; expected ${expectedRevisionId} at ${expectedStage}`,
    );
    this.name = "StaleStageConflictError";
  }
}

export class SpecRevisionImmutableError extends Error {
  constructor(
    readonly revisionId: string,
    /**
     * Carried alongside the id because every refusal built from this error
     * addresses the revision the way its reader does — by number.
     */
    readonly revisionNumber: number,
    readonly state: SpecRevision["state"],
  ) {
    super(`spec revision ${revisionId} is ${state}; only drafts are editable`);
    this.name = "SpecRevisionImmutableError";
  }
}

export interface SpecsRepo {
  transaction<T>(
    label: string,
    operation: (repo: SpecsRepoTransaction) => T,
  ): Promise<T>;
  /**
   * Compose several reads into one answer without entering the global write
   * queue or `BEGIN IMMEDIATE`.
   *
   * The queue serializes every writer in the process, so a read admitted through
   * {@link transaction} waits behind them and then makes them wait behind it —
   * for a body that changes nothing. This seam exists for exactly that body, and
   * {@link SpecsRepoRead} is what enforces it: the operation is handed the read
   * methods only, so a caller that needs to write cannot use it at all and must
   * go back to {@link transaction}.
   */
  readOutsideWriteQueue<T>(
    label: string,
    operation: (repo: SpecsRepoRead) => T,
  ): T;
  create(input: CreateSpecInput): Promise<CreateSpecResult>;
  findById(specId: string): Promise<Spec | null>;
  listByProject(projectPath: string): Promise<Spec[]>;
  resolve(projectPath: string, slug: string): Promise<Spec | null>;
  rename(input: RenameSpecInput): Promise<RenameSpecResult>;
  abandon(input: AbandonSpecInput): Promise<Spec>;
  updateGatePolicy(input: UpdateGatePolicyInput): Promise<Spec>;
  abandonInTransaction(input: AbandonSpecInput): Spec;
  findByIdInTransaction(specId: string): Spec | null;
  listAliases(specId: string): Promise<SpecAlias[]>;
  allocateNumber(
    specId: string,
    scopeKey: SpecCounterScopeKey,
  ): Promise<number>;
  findCounter(
    specId: string,
    scopeKey: SpecCounterScopeKey,
  ): Promise<SpecCounter | null>;
  findElement(elementId: string): Promise<SpecElement | null>;
  listRevisions(specId: string): Promise<SpecRevision[]>;
  findDraft(specId: string): Promise<SpecRevision | null>;
  findLatestApproved(specId: string): Promise<SpecRevision | null>;
  createDraftElement(
    input: CreateDraftElementInput,
  ): Promise<CreateDraftElementResult>;
  findRevision(revisionId: string): Promise<SpecRevision | null>;
  findDraftRevisionBySpecId(specId: string): Promise<SpecRevision | null>;
  createDraftFromBase(input: CreateDraftFromBaseInput): Promise<SpecRevision>;
  advanceDraftAuthoringStage(
    input: AdvanceDraftAuthoringStageInput,
  ): Promise<SpecRevision>;
  approveRevision(input: ApproveRevisionInput): Promise<SpecRevision>;
  withdrawAuthoringRevision(
    input: WithdrawRevisionInput,
  ): Promise<SpecRevision>;
  recordExternalDelivery(
    input: RecordExternalDeliveryInput,
  ): Promise<SpecRevision>;
  getRevisionSnapshot(revisionId: string): Promise<SpecRevisionSnapshot | null>;
  readRevisionCitations(revisionId: string): Promise<SpecAssumptionCitation[]>;
  replaceAssumptionDraftCitations(
    input: ReplaceAssumptionDraftCitationsInput,
  ): Promise<CitationCasOutcome>;
  mutateDraftCitation(
    input: MutateDraftCitationInput,
  ): Promise<CitationCasOutcome>;
  verifyRevision(revisionId: string): Promise<RevisionVerification>;
  findElementVersion(
    revisionId: string,
    elementId: string,
  ): Promise<SpecElementVersion | null>;
  updateDraftElement(
    input: UpdateDraftElementInput,
  ): Promise<SpecElementVersion>;
  removeDraftElement(input: RemoveDraftElementInput): Promise<void>;
  reorderDraftElement(
    input: ReorderDraftElementInput,
  ): Promise<SpecElementVersion>;
}

export interface SpecsRepoTransaction {
  create(input: CreateSpecInput): CreateSpecResult;
  rename(input: RenameSpecInput): RenameSpecResult;
  updateGatePolicy(input: UpdateGatePolicyInput): Spec;
  allocateNumber(specId: string, scopeKey: SpecCounterScopeKey): number;
  findById(specId: string): Spec | null;
  resolve(projectPath: string, slug: string): Spec | null;
  findRevision(revisionId: string): SpecRevision | null;
  listRevisions(specId: string): SpecRevision[];
  findDraft(specId: string): SpecRevision | null;
  findLatestApproved(specId: string): SpecRevision | null;
  getRevisionSnapshot(revisionId: string): SpecRevisionSnapshot | null;
  readRevisionCitations(revisionId: string): SpecAssumptionCitation[];
  replaceAssumptionDraftCitations(
    input: ReplaceAssumptionDraftCitationsInput,
  ): CitationCasOutcome;
  mutateDraftCitation(input: MutateDraftCitationInput): CitationCasOutcome;
  findElementVersion(
    revisionId: string,
    elementId: string,
  ): SpecElementVersion | null;
  createDraftFromBase(input: CreateDraftFromBaseInput): SpecRevision;
  advanceDraftAuthoringStage(
    input: AdvanceDraftAuthoringStageInput,
  ): SpecRevision;
  /** Freezes the draft: computes its content hash and marks it approved. */
  approveRevision(input: ApproveRevisionInput): SpecRevision;
  withdrawAuthoringRevision(input: WithdrawRevisionInput): SpecRevision;
  recordExternalDelivery(input: RecordExternalDeliveryInput): SpecRevision;
  createDraftElement(input: CreateDraftElementInput): CreateDraftElementResult;
  updateDraftElement(input: UpdateDraftElementInput): SpecElementVersion;
  removeDraftElement(input: RemoveDraftElementInput): void;
  reorderDraftElement(input: ReorderDraftElementInput): SpecElementVersion;
}

/**
 * The half of {@link SpecsRepoTransaction} that answers questions. Every method
 * here is a pure SELECT, which is what lets {@link SpecsRepo.readOutsideWriteQueue}
 * run a composed read with no queue admission and no write lock.
 */
export type SpecsRepoRead = Pick<
  SpecsRepoTransaction,
  | "findById"
  | "resolve"
  | "findRevision"
  | "listRevisions"
  | "findDraft"
  | "findLatestApproved"
  | "getRevisionSnapshot"
  | "readRevisionCitations"
  | "findElementVersion"
>;

function validationFailure(
  entity: string,
  identifier: string,
  issues: unknown,
): never {
  logger.error("state-store.specs.schema_validation_failure", {
    entity,
    identifier,
    issues,
  });
  throw new PersistenceError({
    kind: "validation",
    entity,
    identifier,
    issues,
  });
}

function parseRow<TSchema extends z.ZodType>(
  schema: TSchema,
  raw: unknown,
  entity: string,
  identifier: string,
): z.infer<TSchema> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return validationFailure(entity, identifier, parsed.error.issues);
  }
  return parsed.data;
}

function parseJson<TSchema extends z.ZodType>(
  schema: TSchema,
  raw: string,
  entity: string,
  identifier: string,
  field: string,
): z.infer<TSchema> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return validationFailure(entity, identifier, [
      {
        code: "invalid_json",
        path: [field],
        message: getErrorMessage(error),
      },
    ]);
  }
  return parseRow(schema, value, entity, identifier);
}

export function computeSpecElementPayloadHash(
  payload: SpecElementPayload,
): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export interface CanonicalSpecRevisionElement {
  readonly elementId: string;
  readonly kind: SpecElementKind;
  readonly number: number | null;
  readonly parentElementId: string | null;
  readonly position: number;
  readonly payload: SpecElementPayload;
}

export function computeSpecRevisionContentHashFromCanonical(
  authoringStage: SpecAuthoringStage,
  elements: readonly CanonicalSpecRevisionElement[],
): string {
  return createHash("sha256")
    .update(stableStringify({ authoringStage, elements }))
    .digest("hex");
}

function canonicalElements(
  elements: readonly SpecRevisionElement[],
): CanonicalSpecRevisionElement[] {
  return elements.map(({ element, version }) => ({
    elementId: element.id,
    kind: element.kind,
    number: element.number,
    parentElementId: element.parentElementId,
    position: version.position,
    payload: version.payload,
  }));
}

export function computeSpecRevisionContentHash(
  authoringStage: SpecAuthoringStage,
  elements: readonly SpecRevisionElement[],
): string {
  return computeSpecRevisionContentHashFromCanonical(
    authoringStage,
    canonicalElements(elements),
  );
}

export function computeSpecRevisionCitationHash(
  citationContractVersion: 1 | 2,
  citations: readonly Pick<
    SpecAssumptionCitation,
    "elementId" | "assumptionId" | "snapshot"
  >[],
): string {
  return createHash("sha256")
    .update(
      stableStringify({
        citationContractVersion,
        citations: citations.map(({ elementId, assumptionId, snapshot }) => ({
          elementId,
          assumptionId,
          snapshot,
        })),
      }),
    )
    .digest("hex");
}

function counterScopeFor(
  kind: SpecElementKind,
  parentElementId: string | null,
): SpecCounterScopeKey | null {
  switch (kind) {
    case "section":
      return null;
    case "requirement":
      return "R";
    case "criterion":
      if (parentElementId === null) {
        return validationFailure("spec_element", kind, [
          {
            code: "custom",
            path: ["parentElementId"],
            message: "criterion elements require a requirement parent",
          },
        ]);
      }
      return `C:${parentElementId}`;
    case "decision":
      return "D";
    case "task":
      return "T";
  }
}

function notFound(entity: string, identifier: string): never {
  throw new PersistenceError({ kind: "not_found", entity, identifier });
}

export function createSpecsRepo(db: Db, writeQueue: WriteQueue): SpecsRepo {
  const ensureProjectStmt = db.prepare(
    `INSERT INTO projects (root_path) VALUES (?)
     ON CONFLICT(root_path) DO NOTHING`,
  );
  const insertSpecStmt = db.prepare(
    `INSERT INTO specs
       (id, project_path, slug, name, gate_policy_json, abandoned_at,
        abandoned_reason, created_at, updated_at)
     VALUES
       (@id, @project_path, @slug, @name, @gate_policy_json, NULL, NULL,
        @created_at, @updated_at)`,
  );
  const findSpecByIdStmt = db.prepare(
    "SELECT * FROM specs WHERE id = ? LIMIT 1",
  );
  const listSpecsByProjectStmt = db.prepare(
    `SELECT * FROM specs
     WHERE project_path = ?
     ORDER BY updated_at DESC, slug ASC`,
  );
  const findSpecBySlugStmt = db.prepare(
    `SELECT * FROM specs
     WHERE project_path = ? AND slug = ?
     LIMIT 1`,
  );
  const resolveAliasStmt = db.prepare(
    `SELECT s.* FROM spec_aliases a
     JOIN specs s ON s.id = a.spec_id
     WHERE a.project_path = ? AND a.slug = ?
     LIMIT 1`,
  );
  const updateSpecRenameStmt = db.prepare(
    `UPDATE specs
     SET slug = @slug, name = @name, updated_at = @updated_at
     WHERE id = @id`,
  );
  const insertAliasStmt = db.prepare(
    `INSERT INTO spec_aliases (project_path, slug, spec_id, created_at)
     VALUES (@project_path, @slug, @spec_id, @created_at)`,
  );
  const findAliasStmt = db.prepare(
    `SELECT * FROM spec_aliases
     WHERE project_path = ? AND slug = ?
     LIMIT 1`,
  );
  const listAliasesStmt = db.prepare(
    `SELECT * FROM spec_aliases
     WHERE spec_id = ?
     ORDER BY created_at ASC, slug ASC`,
  );
  const abandonSpecStmt = db.prepare(
    `UPDATE specs
     SET abandoned_at = @abandoned_at,
         abandoned_reason = @abandoned_reason,
         updated_at = @updated_at
     WHERE id = @id`,
  );
  const updateGatePolicyStmt = db.prepare(
    `UPDATE specs
     SET gate_policy_json = @gate_policy_json, updated_at = @updated_at
     WHERE id = @id`,
  );
  const allocateNumberStmt = db.prepare(
    `INSERT INTO spec_counters (spec_id, scope_key, last_number)
     VALUES (?, ?, 1)
     ON CONFLICT(spec_id, scope_key)
     DO UPDATE SET last_number = last_number + 1
     RETURNING last_number`,
  );
  const findCounterStmt = db.prepare(
    `SELECT * FROM spec_counters
     WHERE spec_id = ? AND scope_key = ?
     LIMIT 1`,
  );
  const insertRevisionStmt = db.prepare(
    `INSERT INTO spec_revisions
       (id, spec_id, number, state, authoring_stage, based_on_revision_id,
        content_hash, proposed_at, approved_at, created_at)
     VALUES
       (@id, @spec_id, @number, @state, @authoring_stage,
        @based_on_revision_id, @content_hash, @proposed_at, @approved_at,
        @created_at)`,
  );
  const findRevisionStmt = db.prepare(
    "SELECT * FROM spec_revisions WHERE id = ? LIMIT 1",
  );
  const listRevisionsStmt = db.prepare(
    `SELECT * FROM spec_revisions
     WHERE spec_id = ?
     ORDER BY number ASC`,
  );
  const findDraftRevisionBySpecStmt = db.prepare(
    `SELECT * FROM spec_revisions
     WHERE spec_id = ? AND state = 'draft'
     ORDER BY number DESC
     LIMIT 1`,
  );
  const findLatestApprovedStmt = db.prepare(
    `SELECT * FROM spec_revisions
     WHERE spec_id = ? AND state = 'approved'
     ORDER BY number DESC
     LIMIT 1`,
  );
  const advanceDraftAuthoringStageStmt = db.prepare(
    `UPDATE spec_revisions
     SET authoring_stage = @target_stage
     WHERE id = @revision_id
       AND spec_id = @spec_id
       AND state = 'draft'
       AND authoring_stage = @expected_stage`,
  );
  const nextRevisionNumberStmt = db
    .prepare(
      `SELECT COALESCE(MAX(number), 0) + 1
       FROM spec_revisions
       WHERE spec_id = ?`,
    )
    .pluck();
  const copyElementVersionsStmt = db.prepare(
    `INSERT INTO spec_element_versions
       (revision_id, element_id, position, payload_json, payload_hash,
        element_version, created_at, updated_at)
     SELECT @revision_id, element_id, position, payload_json, payload_hash,
            1, @created_at, @created_at
     FROM spec_element_versions AS versions
     WHERE revision_id = @base_revision_id
       AND (
         @copy_tasks = 1 OR NOT EXISTS (
           SELECT 1
           FROM spec_elements AS elements
           WHERE elements.id = versions.element_id
             AND elements.kind = 'task'
         )
       )
     ORDER BY position ASC, element_id ASC`,
  );
  // `proposed_at` records when the content froze, which is the sign-off
  // itself: a draft is reviewed while it stays editable.
  const approveRevisionStmt = db.prepare(
    `UPDATE spec_revisions
     SET state = 'approved', content_hash = @content_hash,
         proposed_at = @approved_at, approved_at = @approved_at
     WHERE id = @id AND state = 'draft'`,
  );
  const withdrawAuthoringRevisionStmt = db.prepare(
    `UPDATE spec_revisions
     SET state = 'withdrawn', content_hash = @content_hash
     WHERE id = @id AND state = 'draft'`,
  );
  const recordExternalDeliveryStmt = db.prepare(
    `UPDATE spec_revisions
     SET external_delivery_json = @external_delivery_json
     WHERE id = @id`,
  );
  const insertElementStmt = db.prepare(
    `INSERT INTO spec_elements
       (id, spec_id, kind, number, parent_element_id, created_at)
     VALUES
       (@id, @spec_id, @kind, @number, @parent_element_id, @created_at)`,
  );
  const findElementStmt = db.prepare(
    "SELECT * FROM spec_elements WHERE id = ? LIMIT 1",
  );
  const insertElementVersionStmt = db.prepare(
    `INSERT INTO spec_element_versions
       (revision_id, element_id, position, payload_json, payload_hash,
        element_version, created_at, updated_at)
     VALUES
       (@revision_id, @element_id, @position, @payload_json, @payload_hash,
        1, @created_at, @updated_at)`,
  );
  const findElementVersionStmt = db.prepare(
    `SELECT * FROM spec_element_versions
     WHERE revision_id = ? AND element_id = ?
     LIMIT 1`,
  );
  const nextElementPositionStmt = db.prepare(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next_position
     FROM spec_element_versions
     WHERE revision_id = ?`,
  );
  const updateDraftElementCasStmt = db.prepare(
    `UPDATE spec_element_versions
     SET payload_json = @payload_json,
         payload_hash = @payload_hash,
         position = COALESCE(@position, position),
         element_version = element_version + 1,
         updated_at = @updated_at
     WHERE revision_id = @revision_id
       AND element_id = @element_id
       AND element_version = @expected_element_version`,
  );
  const removeDraftElementCasStmt = db.prepare(
    `DELETE FROM spec_element_versions
     WHERE revision_id = ? AND element_id = ? AND element_version = ?`,
  );
  const reorderDraftElementCasStmt = db.prepare(
    `UPDATE spec_element_versions
     SET position = @position,
         element_version = element_version + 1,
         updated_at = @updated_at
     WHERE revision_id = @revision_id
       AND element_id = @element_id
       AND element_version = @expected_element_version`,
  );
  const snapshotRowsStmt = db.prepare(
    `SELECT
       e.id AS element_id,
       e.spec_id AS element_spec_id,
       e.kind AS element_kind,
       e.number AS element_number,
       e.parent_element_id AS parent_element_id,
       e.created_at AS element_created_at,
       v.revision_id AS revision_id,
       v.position AS position,
       v.payload_json AS payload_json,
       v.payload_hash AS payload_hash,
       v.element_version AS element_version,
       v.created_at AS version_created_at,
       v.updated_at AS version_updated_at
     FROM spec_element_versions v
     JOIN spec_elements e ON e.id = v.element_id
     WHERE v.revision_id = ?
     ORDER BY v.position ASC, e.id ASC`,
  );
  const snapshotAssumptionCitationsStmt = db.prepare(
    `SELECT * FROM spec_revision_assumption_citations
     WHERE revision_id = ?
     ORDER BY element_id ASC, assumption_id ASC`,
  );
  const findAssumptionOwnerStmt = db.prepare(
    "SELECT spec_id FROM spec_assumptions WHERE id = ? LIMIT 1",
  );
  const findRevisionElementOwnerStmt = db.prepare(
    `SELECT elements.spec_id
     FROM spec_element_versions AS versions
     JOIN spec_elements AS elements ON elements.id = versions.element_id
     WHERE versions.revision_id = ? AND versions.element_id = ?
     LIMIT 1`,
  );
  const insertAssumptionCitationStmt = db.prepare(
    `INSERT INTO spec_revision_assumption_citations (
       revision_id, spec_id, element_id, assumption_id,
       assumption_snapshot_json, created_at, updated_at
     ) VALUES (
       @revision_id, @spec_id, @element_id, @assumption_id,
       @assumption_snapshot_json, @created_at, @updated_at
     )`,
  );
  const updateAssumptionCitationSnapshotStmt = db.prepare(
    `UPDATE spec_revision_assumption_citations
     SET assumption_snapshot_json = @assumption_snapshot_json,
         updated_at = @updated_at
     WHERE revision_id = @revision_id
       AND element_id = @element_id
       AND assumption_id = @assumption_id`,
  );
  const deleteAssumptionCitationStmt = db.prepare(
    `DELETE FROM spec_revision_assumption_citations
     WHERE revision_id = ? AND element_id = ? AND assumption_id = ?`,
  );
  const updateDraftCitationIntegrityStmt = db.prepare(
    `UPDATE spec_revisions
     SET citation_version = citation_version + 1,
         citation_hash = @citation_hash
     WHERE id = @revision_id
       AND spec_id = @spec_id
       AND state = 'draft'
       AND citation_version = @expected_citation_version`,
  );
  const initializeDraftCitationIntegrityStmt = db.prepare(
    `UPDATE spec_revisions
     SET citation_contract_version = 2,
         citation_version = 1,
         citation_hash = @citation_hash
     WHERE id = @revision_id AND state = 'draft'`,
  );
  const copyRevisionCitationsStmt = db.prepare(
    `INSERT INTO spec_revision_assumption_citations (
       revision_id, spec_id, element_id, assumption_id,
       assumption_snapshot_json, created_at, updated_at
     )
     SELECT @revision_id, source.spec_id, source.element_id,
            source.assumption_id, source.assumption_snapshot_json,
            @created_at, @created_at
     FROM spec_revision_assumption_citations AS source
     WHERE source.revision_id = @base_revision_id
       AND EXISTS (
         SELECT 1 FROM spec_element_versions AS target
         WHERE target.revision_id = @revision_id
           AND target.element_id = source.element_id
       )
     ORDER BY source.element_id, source.assumption_id`,
  );
  const countElementCitationsStmt = db.prepare(
    `SELECT COUNT(*) AS count
     FROM spec_revision_assumption_citations
     WHERE revision_id = ? AND element_id = ?`,
  );

  function rowToSpec(raw: unknown): Spec {
    const row = parseRow(specRowSchema, raw, "spec", "<unknown>");
    const gatePolicy = parseJson(
      specGatePolicySchema,
      row.gate_policy_json,
      "spec",
      row.id,
      "gate_policy_json",
    );
    return parseRow(
      specSchema,
      {
        id: row.id,
        projectPath: row.project_path,
        slug: row.slug,
        name: row.name,
        gatePolicy,
        abandonedAt: row.abandoned_at,
        abandonedReason: row.abandoned_reason,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      "spec",
      row.id,
    );
  }

  function rowToAlias(raw: unknown): SpecAlias {
    const row = parseRow(specAliasRowSchema, raw, "spec_alias", "<unknown>");
    return parseRow(
      specAliasSchema,
      {
        projectPath: row.project_path,
        slug: row.slug,
        specId: row.spec_id,
        createdAt: row.created_at,
      },
      "spec_alias",
      `${row.project_path}/${row.slug}`,
    );
  }

  function rowToCounter(raw: unknown): SpecCounter {
    const row = parseRow(
      specCounterRowSchema,
      raw,
      "spec_counter",
      "<unknown>",
    );
    return parseRow(
      specCounterSchema,
      {
        specId: row.spec_id,
        scopeKey: row.scope_key,
        lastNumber: row.last_number,
      },
      "spec_counter",
      `${row.spec_id}/${row.scope_key}`,
    );
  }

  function rowToElement(raw: unknown): SpecElement {
    const row = parseRow(
      specElementRowSchema,
      raw,
      "spec_element",
      "<unknown>",
    );
    return parseRow(
      specElementSchema,
      {
        id: row.id,
        specId: row.spec_id,
        kind: row.kind,
        number: row.number,
        parentElementId: row.parent_element_id,
        createdAt: row.created_at,
      },
      "spec_element",
      row.id,
    );
  }

  function rowToRevision(raw: unknown): SpecRevision {
    const row = parseRow(
      specRevisionRowSchema,
      raw,
      "spec_revision",
      "<unknown>",
    );
    return parseRow(
      specRevisionSchema,
      {
        id: row.id,
        specId: row.spec_id,
        number: row.number,
        state: row.state,
        authoringStage: row.authoring_stage,
        basedOnRevisionId: row.based_on_revision_id,
        contentHash: row.content_hash,
        citationContractVersion: row.citation_contract_version,
        citationVersion: row.citation_version,
        citationHash: row.citation_hash,
        proposedAt: row.proposed_at,
        approvedAt: row.approved_at,
        externalDelivery:
          row.external_delivery_json === null
            ? null
            : parseJson(
                externalDeliverySchema,
                row.external_delivery_json,
                "spec_revision",
                row.id,
                "external_delivery_json",
              ),
        createdAt: row.created_at,
      },
      "spec_revision",
      row.id,
    );
  }

  function rowToAssumptionCitation(raw: unknown): SpecAssumptionCitation {
    const row = parseRow(
      specAssumptionCitationRowSchema,
      raw,
      "spec_assumption_citation",
      "<unknown>",
    );
    return parseRow(
      specAssumptionCitationSchema,
      {
        revisionId: row.revision_id,
        specId: row.spec_id,
        elementId: row.element_id,
        assumptionId: row.assumption_id,
        snapshot: parseJson(
          specAssumptionCitationSnapshotSchema,
          row.assumption_snapshot_json,
          "spec_assumption_citation",
          `${row.revision_id}:${row.element_id}:${row.assumption_id}`,
          "assumption_snapshot_json",
        ),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      "spec_assumption_citation",
      `${row.revision_id}:${row.element_id}:${row.assumption_id}`,
    );
  }

  function rowToElementVersion(raw: unknown): SpecElementVersion {
    const row = parseRow(
      specElementVersionRowSchema,
      raw,
      "spec_element_version",
      "<unknown>",
    );
    const payload = parseJson(
      specElementPayloadSchema,
      row.payload_json,
      "spec_element_version",
      `${row.revision_id}/${row.element_id}`,
      "payload_json",
    );
    return parseRow(
      specElementVersionSchema,
      {
        revisionId: row.revision_id,
        elementId: row.element_id,
        position: row.position,
        payload,
        payloadHash: row.payload_hash,
        elementVersion: row.element_version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      "spec_element_version",
      `${row.revision_id}/${row.element_id}`,
    );
  }

  function snapshotRowToDomain(raw: unknown): SpecRevisionElement {
    const row = parseRow(
      snapshotStorageRowSchema,
      raw,
      "spec_revision_snapshot",
      "<unknown>",
    );
    const element = parseRow(
      specElementSchema,
      {
        id: row.element_id,
        specId: row.element_spec_id,
        kind: row.element_kind,
        number: row.element_number,
        parentElementId: row.parent_element_id,
        createdAt: row.element_created_at,
      },
      "spec_element",
      row.element_id,
    );
    const payload = parseJson(
      specElementPayloadSchema,
      row.payload_json,
      "spec_element_version",
      `${row.revision_id}/${row.element_id}`,
      "payload_json",
    );
    const version = parseRow(
      specElementVersionSchema,
      {
        revisionId: row.revision_id,
        elementId: row.element_id,
        position: row.position,
        payload,
        payloadHash: row.payload_hash,
        elementVersion: row.element_version,
        createdAt: row.version_created_at,
        updatedAt: row.version_updated_at,
      },
      "spec_element_version",
      `${row.revision_id}/${row.element_id}`,
    );
    return { element, version };
  }

  function readSpec(specId: string): Spec | null {
    const raw: unknown = findSpecByIdStmt.get(specId);
    return raw === undefined ? null : rowToSpec(raw);
  }

  function requireSpec(specId: string): Spec {
    return readSpec(specId) ?? notFound("spec", specId);
  }

  function refuseAliasShadow(
    projectPath: string,
    slug: string,
    claimantSpecId?: string,
  ): void {
    const rawAlias: unknown = findAliasStmt.get(projectPath, slug);
    if (rawAlias === undefined) return;
    const alias = rowToAlias(rawAlias);
    if (alias.specId === claimantSpecId) return;
    throw new PersistenceError({
      kind: "constraint",
      constraint: "spec_slug_namespace",
      entity: "spec",
      identifier: `${projectPath}/${slug}`,
    });
  }

  function readRevision(revisionId: string): SpecRevision | null {
    const raw: unknown = findRevisionStmt.get(revisionId);
    return raw === undefined ? null : rowToRevision(raw);
  }

  function requireRevision(revisionId: string): SpecRevision {
    return readRevision(revisionId) ?? notFound("spec_revision", revisionId);
  }

  function listRevisions(specId: string): SpecRevision[] {
    return (listRevisionsStmt.all(specId) as unknown[]).map(rowToRevision);
  }

  function readDraft(specId: string): SpecRevision | null {
    const raw: unknown = findDraftRevisionBySpecStmt.get(specId);
    return raw === undefined ? null : rowToRevision(raw);
  }

  function readLatestApproved(specId: string): SpecRevision | null {
    const raw: unknown = findLatestApprovedStmt.get(specId);
    return raw === undefined ? null : rowToRevision(raw);
  }

  function requireDraft(revisionId: string): SpecRevision {
    const revision = requireRevision(revisionId);
    if (revision.state !== "draft") {
      throw new SpecRevisionImmutableError(
        revision.id,
        revision.number,
        revision.state,
      );
    }
    return revision;
  }

  function readElement(elementId: string): SpecElement | null {
    const raw: unknown = findElementStmt.get(elementId);
    return raw === undefined ? null : rowToElement(raw);
  }

  function readElementVersion(
    revisionId: string,
    elementId: string,
  ): SpecElementVersion | null {
    const raw: unknown = findElementVersionStmt.get(revisionId, elementId);
    return raw === undefined ? null : rowToElementVersion(raw);
  }

  /**
   * The append slot in the revision's one global order. Read inside the
   * creating transaction so the value cannot be stale by the time it is used.
   */
  function nextElementPosition(revisionId: string): number {
    return parseRow(
      z.object({ next_position: z.number().int().nonnegative() }),
      nextElementPositionStmt.get(revisionId),
      "spec_element_version",
      revisionId,
    ).next_position;
  }

  function readSnapshot(revisionId: string): SpecRevisionSnapshot | null {
    const revision = readRevision(revisionId);
    if (revision === null) return null;
    const elements = (snapshotRowsStmt.all(revisionId) as unknown[]).map(
      snapshotRowToDomain,
    );
    const assumptionCitations = readRevisionCitations(revisionId);
    return parseRow(
      specRevisionSnapshotSchema,
      { revision, elements, assumptionCitations },
      "spec_revision_snapshot",
      revisionId,
    );
  }

  function readRevisionCitations(revisionId: string): SpecAssumptionCitation[] {
    return (snapshotAssumptionCitationsStmt.all(revisionId) as unknown[])
      .map(rowToAssumptionCitation)
      .sort(compareCitationIdentity);
  }

  function assertElementAndCitationIntegrity(
    snapshot: SpecRevisionSnapshot,
  ): void {
    const hasMismatchedElement = snapshot.elements.some(
      ({ version }) =>
        computeSpecElementPayloadHash(version.payload) !== version.payloadHash,
    );
    if (hasMismatchedElement) {
      throw new PersistenceError({
        kind: "constraint",
        constraint: "spec_element_versions.payload_hash",
        entity: "spec_revision",
        identifier: snapshot.revision.id,
      });
    }

    const actualCitationHash = computeSpecRevisionCitationHash(
      snapshot.revision.citationContractVersion,
      snapshot.assumptionCitations,
    );
    if (actualCitationHash !== snapshot.revision.citationHash) {
      throw new PersistenceError({
        kind: "constraint",
        constraint: "spec_revisions.citation_hash",
        entity: "spec_revision",
        identifier: snapshot.revision.id,
      });
    }
  }

  function citationReference(
    citation: Pick<SpecAssumptionCitation, "elementId" | "assumptionId">,
  ): SpecCitationReference {
    return {
      elementId: citation.elementId,
      assumptionId: citation.assumptionId,
    };
  }

  function compareCitationIdentity(
    left: SpecCitationReference,
    right: SpecCitationReference,
  ): number {
    const leftKey = `${left.elementId}\u0000${left.assumptionId}`;
    const rightKey = `${right.elementId}\u0000${right.assumptionId}`;
    return compareCodeUnits(leftKey, rightKey);
  }

  function compareCodeUnits(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }

  function replaceAssumptionCitationSets(
    input: ReplaceAssumptionDraftCitationsInput,
  ): CitationCasOutcome {
    const revision = readRevision(input.revisionId);
    if (revision === null) return { kind: "not_found" };
    if (revision.specId !== input.specId) {
      return {
        kind: "invalid_relation",
        reason: "revision_spec_mismatch",
      };
    }
    if (revision.state !== "draft") {
      return { kind: "illegal_lifecycle", state: revision.state };
    }
    if (revision.citationVersion !== input.expectedCitationVersion) {
      return {
        kind: "stale_version",
        currentVersion: revision.citationVersion,
      };
    }

    for (const replacement of input.replacements) {
      const owner = findAssumptionOwnerStmt.get(replacement.assumptionId) as
        | { spec_id: string }
        | undefined;
      if (owner?.spec_id !== input.specId) {
        return {
          kind: "invalid_relation",
          reason: "assumption_spec_mismatch",
        };
      }
      for (const elementId of replacement.elementIds) {
        const elementOwner = findRevisionElementOwnerStmt.get(
          input.revisionId,
          elementId,
        ) as { spec_id: string } | undefined;
        if (elementOwner?.spec_id !== input.specId) {
          return {
            kind: "invalid_relation",
            reason: "element_not_in_revision",
          };
        }
      }
    }

    const current = readRevisionCitations(input.revisionId);
    const targetAssumptionIds = new Set(
      input.replacements.map((replacement) => replacement.assumptionId),
    );
    const currentByKey = new Map(
      current
        .filter((citation) => targetAssumptionIds.has(citation.assumptionId))
        .map((citation) => [
          `${citation.elementId}\u0000${citation.assumptionId}`,
          citation,
        ]),
    );
    const desiredByKey = new Map<
      string,
      {
        readonly elementId: string;
        readonly assumptionId: string;
        readonly snapshot: SpecAssumptionCitationSnapshot;
      }
    >();
    for (const replacement of input.replacements) {
      for (const elementId of [...replacement.elementIds].sort()) {
        desiredByKey.set(`${elementId}\u0000${replacement.assumptionId}`, {
          elementId,
          assumptionId: replacement.assumptionId,
          snapshot: replacement.snapshot,
        });
      }
    }

    const removed = [...currentByKey.entries()]
      .filter(([key]) => !desiredByKey.has(key))
      .map(([, citation]) => citation);
    const added = [...desiredByKey.entries()]
      .filter(([key]) => !currentByKey.has(key))
      .map(([, citation]) => citation);
    const refreshed = [...desiredByKey.entries()]
      .filter(([key, desired]) => {
        const existing = currentByKey.get(key);
        return (
          existing !== undefined &&
          stableStringify(existing.snapshot) !==
            stableStringify(desired.snapshot)
        );
      })
      .map(([, citation]) => citation);
    const changed =
      removed.length > 0 || added.length > 0 || refreshed.length > 0;
    if (!changed) {
      return {
        kind: "success",
        changed: false,
        revision,
        citations: current,
        added: [],
        removed: [],
        refreshed: [],
      };
    }

    const untouched = current.filter(
      (citation) => !targetAssumptionIds.has(citation.assumptionId),
    );
    const resultingHash = computeSpecRevisionCitationHash(
      revision.citationContractVersion,
      [...untouched, ...desiredByKey.values()].sort(compareCitationIdentity),
    );
    const integrityUpdate = updateDraftCitationIntegrityStmt.run({
      revision_id: input.revisionId,
      spec_id: input.specId,
      expected_citation_version: input.expectedCitationVersion,
      citation_hash: resultingHash,
    });
    if (integrityUpdate.changes !== 1) {
      throw new PersistenceError({
        kind: "constraint",
        constraint: "spec_revisions.citation_version",
        entity: "spec_revision",
        identifier: input.revisionId,
      });
    }

    for (const citation of removed) {
      deleteAssumptionCitationStmt.run(
        input.revisionId,
        citation.elementId,
        citation.assumptionId,
      );
    }
    for (const citation of refreshed) {
      updateAssumptionCitationSnapshotStmt.run({
        revision_id: input.revisionId,
        element_id: citation.elementId,
        assumption_id: citation.assumptionId,
        assumption_snapshot_json: stableStringify(citation.snapshot),
        updated_at: input.updatedAt,
      });
    }
    for (const citation of added) {
      insertAssumptionCitationStmt.run({
        revision_id: input.revisionId,
        spec_id: input.specId,
        element_id: citation.elementId,
        assumption_id: citation.assumptionId,
        assumption_snapshot_json: stableStringify(citation.snapshot),
        created_at: input.updatedAt,
        updated_at: input.updatedAt,
      });
    }

    return {
      kind: "success",
      changed: true,
      revision: requireRevision(input.revisionId),
      citations: readRevisionCitations(input.revisionId),
      added: added.map(citationReference),
      removed: removed.map(citationReference),
      refreshed: refreshed.map(citationReference),
    };
  }

  const replaceAssumptionDraftCitationsTx = db.transaction(
    replaceAssumptionCitationSets,
  );

  const mutateDraftCitationTx = db.transaction(
    (input: MutateDraftCitationInput): CitationCasOutcome => {
      const revision = readRevision(input.revisionId);
      if (revision === null) return { kind: "not_found" };
      if (revision.specId !== input.specId) {
        return {
          kind: "invalid_relation",
          reason: "revision_spec_mismatch",
        };
      }
      if (revision.state !== "draft") {
        return { kind: "illegal_lifecycle", state: revision.state };
      }
      if (revision.citationVersion !== input.expectedCitationVersion) {
        return {
          kind: "stale_version",
          currentVersion: revision.citationVersion,
        };
      }
      const assumptionCitations = readRevisionCitations(
        input.revisionId,
      ).filter((citation) => citation.assumptionId === input.assumptionId);
      const existing = assumptionCitations.find(
        (citation) => citation.elementId === input.elementId,
      );
      if (
        (input.operation === "cite" && existing !== undefined) ||
        (input.operation === "uncite" && existing === undefined)
      ) {
        return {
          kind: "success",
          changed: false,
          revision,
          citations: readRevisionCitations(input.revisionId),
          added: [],
          removed: [],
          refreshed: [],
        };
      }

      const elementIds = assumptionCitations
        .filter(
          (citation) =>
            input.operation !== "uncite" ||
            citation.elementId !== input.elementId,
        )
        .map((citation) => citation.elementId);
      if (input.operation === "cite") elementIds.push(input.elementId);
      const snapshot =
        input.operation === "cite"
          ? input.snapshot
          : assumptionCitations[0]?.snapshot;
      if (snapshot === undefined) {
        return {
          kind: "success",
          changed: false,
          revision,
          citations: readRevisionCitations(input.revisionId),
          added: [],
          removed: [],
          refreshed: [],
        };
      }
      return replaceAssumptionCitationSets({
        revisionId: input.revisionId,
        specId: input.specId,
        expectedCitationVersion: input.expectedCitationVersion,
        replacements: [
          {
            assumptionId: input.assumptionId,
            elementIds,
            snapshot,
          },
        ],
        updatedAt: input.updatedAt,
      });
    },
  );

  function validateElementParent(
    specId: string,
    kind: SpecElementKind,
    parentElementId: string | null,
  ): void {
    if (kind !== "criterion") {
      if (parentElementId !== null) {
        validationFailure("spec_element", specId, [
          {
            code: "custom",
            path: ["parentElementId"],
            message: "only criterion elements have a parent",
          },
        ]);
      }
      return;
    }

    if (parentElementId === null) {
      validationFailure("spec_element", specId, [
        {
          code: "custom",
          path: ["parentElementId"],
          message: "criterion elements require a requirement parent",
        },
      ]);
    }

    const parent = readElement(parentElementId);
    if (
      parent === null ||
      parent.specId !== specId ||
      parent.kind !== "requirement"
    ) {
      validationFailure("spec_element", parentElementId, [
        {
          code: "custom",
          path: ["parentElementId"],
          message: "criterion parent must be a requirement in the same spec",
        },
      ]);
    }
  }

  const createTx = db.transaction(
    (input: z.output<typeof createSpecInputSchema>): CreateSpecResult => {
      ensureProjectStmt.run(input.spec.projectPath);
      refuseAliasShadow(input.spec.projectPath, input.spec.slug);
      insertSpecStmt.run({
        id: input.spec.id,
        project_path: input.spec.projectPath,
        slug: input.spec.slug,
        name: input.spec.name,
        gate_policy_json: stableStringify(input.spec.gatePolicy),
        created_at: input.spec.createdAt,
        updated_at: input.spec.updatedAt,
      });
      insertRevisionStmt.run({
        id: input.initialRevision.id,
        spec_id: input.spec.id,
        number: 1,
        state: "draft",
        authoring_stage: input.initialRevision.authoringStage,
        based_on_revision_id: null,
        content_hash: null,
        proposed_at: null,
        approved_at: null,
        created_at: input.initialRevision.createdAt,
      });
      return {
        spec: requireSpec(input.spec.id),
        revision: requireRevision(input.initialRevision.id),
      };
    },
  );

  const renameTx = db.transaction(
    (input: z.output<typeof renameSpecInputSchema>): RenameSpecResult => {
      const current = requireSpec(input.specId);
      if (current.slug === input.slug) {
        return validationFailure("spec", input.specId, [
          {
            code: "custom",
            path: ["slug"],
            message: "rename requires a different slug",
          },
        ]);
      }
      refuseAliasShadow(current.projectPath, input.slug, current.id);

      const rawExistingAlias: unknown = findAliasStmt.get(
        current.projectPath,
        current.slug,
      );
      let alias: SpecAlias;
      if (rawExistingAlias === undefined) {
        insertAliasStmt.run({
          project_path: current.projectPath,
          slug: current.slug,
          spec_id: current.id,
          created_at: input.aliasCreatedAt,
        });
        const rawAlias: unknown = findAliasStmt.get(
          current.projectPath,
          current.slug,
        );
        if (rawAlias === undefined) {
          return notFound(
            "spec_alias",
            `${current.projectPath}/${current.slug}`,
          );
        }
        alias = rowToAlias(rawAlias);
      } else {
        alias = rowToAlias(rawExistingAlias);
        if (alias.specId !== current.id) {
          throw new PersistenceError({
            kind: "constraint",
            constraint: "spec_aliases.project_path_slug",
            entity: "spec_alias",
            identifier: `${current.projectPath}/${current.slug}`,
          });
        }
      }

      updateSpecRenameStmt.run({
        id: current.id,
        slug: input.slug,
        name: input.name,
        updated_at: input.updatedAt,
      });
      return { spec: requireSpec(current.id), alias };
    },
  );

  function abandonRecord(input: z.output<typeof abandonSpecInputSchema>): Spec {
    requireSpec(input.specId);
    abandonSpecStmt.run({
      id: input.specId,
      abandoned_at: input.abandonedAt,
      abandoned_reason: input.reason,
      updated_at: input.updatedAt,
    });
    return requireSpec(input.specId);
  }

  const abandonTx = db.transaction(abandonRecord);

  const updateGatePolicyTx = db.transaction(
    (input: z.output<typeof updateGatePolicyInputSchema>): Spec => {
      requireSpec(input.specId);
      updateGatePolicyStmt.run({
        id: input.specId,
        gate_policy_json: stableStringify(input.gatePolicy),
        updated_at: input.updatedAt,
      });
      return requireSpec(input.specId);
    },
  );

  const allocateNumberTx = db.transaction(
    (specId: string, scopeKey: SpecCounterScopeKey): number => {
      requireSpec(specId);
      const raw = allocateNumberStmt.get(specId, scopeKey);
      const row = parseRow(
        z.object({ last_number: z.number().int().positive() }),
        raw,
        "spec_counter",
        `${specId}/${scopeKey}`,
      );
      return row.last_number;
    },
  );

  const createDraftFromBaseTx = db.transaction(
    (input: z.output<typeof createDraftFromBaseInputSchema>): SpecRevision => {
      requireSpec(input.specId);
      const base = requireRevision(input.baseRevisionId);
      if (base.specId !== input.specId) {
        return validationFailure("spec_revision", input.id, [
          {
            code: "custom",
            path: ["baseRevisionId"],
            message: "base revision belongs to a different spec",
          },
        ]);
      }
      const nextNumberRaw: unknown = nextRevisionNumberStmt.get(input.specId);
      const nextNumber = parseRow(
        z.number().int().positive(),
        nextNumberRaw,
        "spec_revision",
        input.id,
      );
      insertRevisionStmt.run({
        id: input.id,
        spec_id: input.specId,
        number: nextNumber,
        state: "draft",
        authoring_stage: input.authoringStage,
        based_on_revision_id: input.baseRevisionId,
        content_hash: null,
        proposed_at: null,
        approved_at: null,
        created_at: input.createdAt,
      });
      copyElementVersionsStmt.run({
        revision_id: input.id,
        base_revision_id: input.baseRevisionId,
        created_at: input.createdAt,
        copy_tasks: input.authoringStage === "plan" ? 1 : 0,
      });
      copyRevisionCitationsStmt.run({
        revision_id: input.id,
        base_revision_id: input.baseRevisionId,
        created_at: input.createdAt,
      });
      const copiedCitations = readRevisionCitations(input.id);
      initializeDraftCitationIntegrityStmt.run({
        revision_id: input.id,
        citation_hash: computeSpecRevisionCitationHash(2, copiedCitations),
      });
      return requireRevision(input.id);
    },
  );

  const authoringStageOrder: Record<SpecAuthoringStage, number> = {
    requirements: 0,
    design: 1,
    plan: 2,
  };

  const advanceDraftAuthoringStageTx = db.transaction(
    (
      input: z.output<typeof advanceDraftAuthoringStageInputSchema>,
    ): SpecRevision => {
      requireSpec(input.specId);
      const current = readDraft(input.specId);
      if (
        current !== null &&
        current.id === input.revisionId &&
        authoringStageOrder[current.authoringStage] >=
          authoringStageOrder[input.targetStage]
      ) {
        return current;
      }
      if (current === null || current.id !== input.revisionId) {
        throw new StaleStageConflictError(
          input.specId,
          input.revisionId,
          input.expectedStage,
          current,
        );
      }

      const result = advanceDraftAuthoringStageStmt.run({
        spec_id: input.specId,
        revision_id: input.revisionId,
        expected_stage: input.expectedStage,
        target_stage: input.targetStage,
      });
      if (result.changes === 0) {
        throw new StaleStageConflictError(
          input.specId,
          input.revisionId,
          input.expectedStage,
          readDraft(input.specId),
        );
      }
      return requireRevision(input.revisionId);
    },
  );

  const approveRevisionTx = db.transaction(
    (input: z.output<typeof approveRevisionInputSchema>): SpecRevision => {
      requireDraft(input.revisionId);
      const snapshot = readSnapshot(input.revisionId);
      if (snapshot === null) return notFound("spec_revision", input.revisionId);
      assertElementAndCitationIntegrity(snapshot);
      const result = approveRevisionStmt.run({
        id: input.revisionId,
        content_hash: computeSpecRevisionContentHash(
          snapshot.revision.authoringStage,
          snapshot.elements,
        ),
        approved_at: input.approvedAt,
      });
      if (result.changes !== 1) {
        const current = requireRevision(input.revisionId);
        throw new SpecRevisionImmutableError(
          current.id,
          current.number,
          current.state,
        );
      }
      return requireRevision(input.revisionId);
    },
  );

  const recordExternalDeliveryTx = db.transaction(
    (
      input: z.output<typeof recordExternalDeliveryInputSchema>,
    ): SpecRevision => {
      requireRevision(input.revisionId);
      recordExternalDeliveryStmt.run({
        id: input.revisionId,
        external_delivery_json: stableStringify(input.externalDelivery),
      });
      return requireRevision(input.revisionId);
    },
  );

  const withdrawAuthoringRevisionTx = db.transaction(
    (input: z.output<typeof withdrawRevisionInputSchema>): SpecRevision => {
      const current = requireRevision(input.revisionId);
      if (current.state !== "draft") {
        return validationFailure("spec_revision", input.revisionId, [
          {
            code: "custom",
            path: ["state"],
            message: "only a draft revision can be withdrawn",
          },
        ]);
      }
      const snapshot = readSnapshot(input.revisionId);
      if (snapshot === null) return notFound("spec_revision", input.revisionId);
      const contentHash = computeSpecRevisionContentHash(
        snapshot.revision.authoringStage,
        snapshot.elements,
      );
      const result = withdrawAuthoringRevisionStmt.run({
        id: input.revisionId,
        content_hash: contentHash,
      });
      if (result.changes !== 1) {
        throw new PersistenceError({
          kind: "constraint",
          constraint:
            "spec_revisions.authoring_withdrawal_requires_open_revision",
          entity: "spec_revision",
          identifier: input.revisionId,
        });
      }
      return requireRevision(input.revisionId);
    },
  );

  function writtenElement(
    revisionId: string,
    elementId: string,
    revived: boolean,
  ): CreateDraftElementResult {
    const element = readElement(elementId);
    const version = readElementVersion(revisionId, elementId);
    if (element === null || version === null) {
      return notFound("spec_element", elementId);
    }
    return { element, version, revived };
  }

  /**
   * The address a reader knows an element by, composed from the durable
   * element rows rather than a revision snapshot: the element a reintroduction
   * refusal names has no version in the revision the caller is writing into,
   * so there is no snapshot to read its handle from.
   */
  function durableElementHandle(element: SpecElement): string | null {
    const number = element.number;
    if (number === null) return null;
    switch (element.kind) {
      case "requirement":
        return formatBareElementHandle({
          kind: "requirement",
          requirementNumber: number,
        });
      case "decision":
        return formatBareElementHandle({ kind: "decision", number });
      case "task":
        return formatBareElementHandle({ kind: "task", number });
      case "criterion": {
        const parent =
          element.parentElementId === null
            ? null
            : readElement(element.parentElementId);
        return parent === null || parent.number === null
          ? null
          : formatBareElementHandle({
              kind: "criterion",
              requirementNumber: parent.number,
              criterionNumber: number,
            });
      }
      case "section":
        return null;
    }
  }

  /**
   * Brings an identity this spec already owns back into the target revision.
   * Only a revision-local version row is written: the element row carries the
   * number, containment and creation provenance the spec allocated once, so
   * reusing it is what makes R3 come back as R3 rather than as a new R7 that
   * every approval, evidence row and comment now addresses under two ids.
   */
  function reintroduceElement(
    input: z.output<typeof createDraftElementInputSchema>,
    existing: SpecElement,
  ): CreateDraftElementResult {
    const live = readElementVersion(input.revisionId, input.id);
    if (live !== null) {
      // The identity is present in this very revision, so this is an ordinary
      // create-over-existing conflict, not a recovery: the caller is at
      // version 0 of an element that already has one.
      throw new StaleElementConflictError(input.revisionId, input.id, 0, live);
    }
    const facts = {
      elementId: input.id,
      specId: input.specId,
      revisionId: input.revisionId,
      kind: existing.kind,
      parentElementId: existing.parentElementId,
      handle: durableElementHandle(existing),
      attemptedKind: input.kind,
      attemptedParentElementId: input.parentElementId,
    } as const;
    if (input.reintroduceHistorical !== true) {
      throw new SpecHistoricalElementError({
        ...facts,
        reason: "reintroduction_required",
      });
    }
    if (existing.kind !== input.kind) {
      throw new SpecHistoricalElementError({
        ...facts,
        reason: "kind_changed",
      });
    }
    if (existing.parentElementId !== input.parentElementId) {
      throw new SpecHistoricalElementError({
        ...facts,
        reason: "parent_changed",
      });
    }
    insertElementVersionStmt.run({
      revision_id: input.revisionId,
      element_id: input.id,
      position: input.position ?? nextElementPosition(input.revisionId),
      payload_json: stableStringify(input.payload),
      payload_hash: computeSpecElementPayloadHash(input.payload),
      created_at: input.createdAt,
      updated_at: input.updatedAt,
    });
    logger.info("state-store.specs.element_reintroduced", {
      specId: input.specId,
      revisionId: input.revisionId,
      elementId: input.id,
      elementKind: existing.kind,
      elementNumber: existing.number,
    });
    return writtenElement(input.revisionId, input.id, true);
  }

  const createDraftElementTx = db.transaction(
    (
      input: z.output<typeof createDraftElementInputSchema>,
    ): CreateDraftElementResult => {
      const revision = requireDraft(input.revisionId);
      if (revision.specId !== input.specId) {
        return validationFailure("spec_element", input.id, [
          {
            code: "custom",
            path: ["specId"],
            message: "revision belongs to a different spec",
          },
        ]);
      }
      const existingElement = readElement(input.id);
      if (existingElement !== null && existingElement.specId !== input.specId) {
        throw new SpecElementIdTakenError(input.id, existingElement.specId);
      }
      if (input.payload.kind !== input.kind) {
        return validationFailure("spec_element", input.id, [
          {
            code: "custom",
            path: ["payload", "kind"],
            message: "payload kind must match element identity kind",
          },
        ]);
      }
      if (existingElement !== null) {
        return reintroduceElement(input, existingElement);
      }
      validateElementParent(input.specId, input.kind, input.parentElementId);
      const scopeKey = counterScopeFor(input.kind, input.parentElementId);
      const number =
        scopeKey === null
          ? null
          : parseRow(
              z.object({ last_number: z.number().int().positive() }),
              allocateNumberStmt.get(input.specId, scopeKey),
              "spec_counter",
              `${input.specId}/${scopeKey}`,
            ).last_number;
      const hash = computeSpecElementPayloadHash(input.payload);
      insertElementStmt.run({
        id: input.id,
        spec_id: input.specId,
        kind: input.kind,
        number,
        parent_element_id: input.parentElementId,
        created_at: input.createdAt,
      });
      insertElementVersionStmt.run({
        revision_id: input.revisionId,
        element_id: input.id,
        position: input.position ?? nextElementPosition(input.revisionId),
        payload_json: stableStringify(input.payload),
        payload_hash: hash,
        created_at: input.createdAt,
        updated_at: input.updatedAt,
      });
      return writtenElement(input.revisionId, input.id, false);
    },
  );

  const updateDraftElementTx = db.transaction(
    (
      input: z.output<typeof updateDraftElementInputSchema>,
    ): SpecElementVersion => {
      const revision = requireDraft(input.revisionId);
      const element = readElement(input.elementId);
      if (element === null) return notFound("spec_element", input.elementId);
      if (element.kind !== input.payload.kind) {
        return validationFailure("spec_element", input.elementId, [
          {
            code: "custom",
            path: ["payload", "kind"],
            message: "payload kind must match element identity kind",
          },
        ]);
      }

      const before = readElementVersion(input.revisionId, input.elementId);
      if (before === null) {
        // The other half of the orphaned-id dead zone: this spec owns the
        // identity, but no version of it lives in the target revision, so a
        // caller replaying the version it read on an ended attempt has nothing
        // to compare against. Reporting a missing version row would name an
        // internal table instead of the recovery, leaving the caller to rename
        // the element around a dead id.
        if (element.specId === revision.specId) {
          throw new SpecHistoricalElementError({
            reason: "reintroduction_required",
            elementId: input.elementId,
            specId: element.specId,
            revisionId: input.revisionId,
            kind: element.kind,
            parentElementId: element.parentElementId,
            handle: durableElementHandle(element),
            attemptedKind: input.payload.kind,
            attemptedParentElementId: element.parentElementId,
          });
        }
        return notFound(
          "spec_element_version",
          `${input.revisionId}/${input.elementId}`,
        );
      }
      const result = updateDraftElementCasStmt.run({
        payload_json: stableStringify(input.payload),
        payload_hash: computeSpecElementPayloadHash(input.payload),
        position: input.position ?? null,
        updated_at: input.updatedAt ?? before.updatedAt,
        revision_id: input.revisionId,
        element_id: input.elementId,
        expected_element_version: input.expectedElementVersion,
      });
      const current = readElementVersion(input.revisionId, input.elementId);
      if (current === null) {
        return notFound(
          "spec_element_version",
          `${input.revisionId}/${input.elementId}`,
        );
      }
      if (result.changes === 0) {
        throw new StaleElementConflictError(
          input.revisionId,
          input.elementId,
          input.expectedElementVersion,
          current,
        );
      }
      return current;
    },
  );

  const removeDraftElementTx = db.transaction(
    (input: z.output<typeof removeDraftElementInputSchema>): void => {
      const revision = requireDraft(input.revisionId);
      const current = readElementVersion(input.revisionId, input.elementId);
      if (current === null) {
        return notFound(
          "spec_element_version",
          `${input.revisionId}/${input.elementId}`,
        );
      }
      const removedCitationCount = parseRow(
        z.object({ count: z.number().int().nonnegative() }),
        countElementCitationsStmt.get(input.revisionId, input.elementId),
        "spec_assumption_citation",
        `${input.revisionId}/${input.elementId}`,
      ).count;
      const result = removeDraftElementCasStmt.run(
        input.revisionId,
        input.elementId,
        input.expectedElementVersion,
      );
      if (result.changes === 0) {
        throw new StaleElementConflictError(
          input.revisionId,
          input.elementId,
          input.expectedElementVersion,
          current,
        );
      }
      if (removedCitationCount === 0) return;
      const citations = readRevisionCitations(input.revisionId);
      const integrityUpdate = updateDraftCitationIntegrityStmt.run({
        revision_id: input.revisionId,
        spec_id: revision.specId,
        expected_citation_version: revision.citationVersion,
        citation_hash: computeSpecRevisionCitationHash(
          revision.citationContractVersion,
          citations,
        ),
      });
      if (integrityUpdate.changes !== 1) {
        throw new PersistenceError({
          kind: "constraint",
          constraint: "spec_revisions.citation_version",
          entity: "spec_revision",
          identifier: input.revisionId,
        });
      }
    },
  );

  const reorderDraftElementTx = db.transaction(
    (
      input: z.output<typeof reorderDraftElementInputSchema>,
    ): SpecElementVersion => {
      requireDraft(input.revisionId);
      const before = readElementVersion(input.revisionId, input.elementId);
      if (before === null) {
        return notFound(
          "spec_element_version",
          `${input.revisionId}/${input.elementId}`,
        );
      }
      const result = reorderDraftElementCasStmt.run({
        revision_id: input.revisionId,
        element_id: input.elementId,
        expected_element_version: input.expectedElementVersion,
        position: input.position,
        updated_at: input.updatedAt ?? before.updatedAt,
      });
      if (result.changes === 0) {
        throw new StaleElementConflictError(
          input.revisionId,
          input.elementId,
          input.expectedElementVersion,
          before,
        );
      }
      return (
        readElementVersion(input.revisionId, input.elementId) ??
        notFound(
          "spec_element_version",
          `${input.revisionId}/${input.elementId}`,
        )
      );
    },
  );

  const transactionRepo: SpecsRepoTransaction = {
    create(input) {
      return createTx(createSpecInputSchema.parse(input));
    },
    rename(input) {
      return renameTx(renameSpecInputSchema.parse(input));
    },
    findById: readSpec,
    updateGatePolicy(input) {
      return updateGatePolicyTx(updateGatePolicyInputSchema.parse(input));
    },
    allocateNumber(specId, scopeKey) {
      return allocateNumberTx(
        specId,
        specCounterScopeKeySchema.parse(scopeKey),
      );
    },
    resolve(projectPath, slug) {
      const direct: unknown = findSpecBySlugStmt.get(projectPath, slug);
      if (direct !== undefined) return rowToSpec(direct);
      const aliased: unknown = resolveAliasStmt.get(projectPath, slug);
      return aliased === undefined ? null : rowToSpec(aliased);
    },
    findRevision: readRevision,
    listRevisions,
    findDraft: readDraft,
    findLatestApproved: readLatestApproved,
    getRevisionSnapshot: readSnapshot,
    readRevisionCitations,
    replaceAssumptionDraftCitations(input) {
      return replaceAssumptionDraftCitationsTx(
        replaceAssumptionDraftCitationsInputSchema.parse(input),
      );
    },
    mutateDraftCitation(input) {
      return mutateDraftCitationTx(mutateDraftCitationInputSchema.parse(input));
    },
    findElementVersion: readElementVersion,
    createDraftFromBase(input) {
      return createDraftFromBaseTx(createDraftFromBaseInputSchema.parse(input));
    },
    advanceDraftAuthoringStage(input) {
      return advanceDraftAuthoringStageTx(
        advanceDraftAuthoringStageInputSchema.parse(input),
      );
    },
    approveRevision(input) {
      return approveRevisionTx(approveRevisionInputSchema.parse(input));
    },
    withdrawAuthoringRevision(input) {
      return withdrawAuthoringRevisionTx(
        withdrawRevisionInputSchema.parse(input),
      );
    },
    recordExternalDelivery(input) {
      return recordExternalDeliveryTx(
        recordExternalDeliveryInputSchema.parse(input),
      );
    },
    createDraftElement(input) {
      return createDraftElementTx(createDraftElementInputSchema.parse(input));
    },
    updateDraftElement(input) {
      return updateDraftElementTx(updateDraftElementInputSchema.parse(input));
    },
    removeDraftElement(input) {
      removeDraftElementTx(removeDraftElementInputSchema.parse(input));
    },
    reorderDraftElement(input) {
      return reorderDraftElementTx(reorderDraftElementInputSchema.parse(input));
    },
  };

  return {
    async transaction(label, operation) {
      return timed(logger, "state-store.specs.transaction", { label }, () =>
        writeQueue.withWriteQueue(label, async () =>
          db.transaction(() => operation(transactionRepo)).immediate(),
        ),
      );
    },
    readOutsideWriteQueue(label, operation) {
      // Deferred, not immediate: the reads still share one snapshot against a
      // concurrent writer in another process, and a deferred BEGIN takes no
      // write lock, so nothing here can make a writer wait.
      return timedSync(logger, "state-store.specs.read", { label }, () =>
        db.transaction(() => operation(transactionRepo)).deferred(),
      );
    },
    async create(input) {
      const validated = createSpecInputSchema.parse(input);
      return timed(
        logger,
        "state-store.specs.create",
        { specId: validated.spec.id, projectPath: validated.spec.projectPath },
        () =>
          writeQueue.withWriteQueue("specs.create", async () =>
            createTx.immediate(validated),
          ),
      );
    },

    async findById(specId) {
      return timed(
        logger,
        "state-store.specs.find_by_id",
        { specId },
        async () => readSpec(specId),
      );
    },

    async listByProject(projectPath) {
      return timed(
        logger,
        "state-store.specs.list_by_project",
        { projectPath },
        async () =>
          (listSpecsByProjectStmt.all(projectPath) as unknown[]).map(rowToSpec),
      );
    },

    async resolve(projectPath, slug) {
      return timed(
        logger,
        "state-store.specs.resolve",
        { projectPath, slug },
        async () => {
          const direct: unknown = findSpecBySlugStmt.get(projectPath, slug);
          if (direct !== undefined) return rowToSpec(direct);
          const aliased: unknown = resolveAliasStmt.get(projectPath, slug);
          return aliased === undefined ? null : rowToSpec(aliased);
        },
      );
    },

    async rename(input) {
      const validated = renameSpecInputSchema.parse(input);
      return timed(
        logger,
        "state-store.specs.rename",
        { specId: validated.specId, slug: validated.slug },
        () =>
          writeQueue.withWriteQueue("specs.rename", async () =>
            renameTx.immediate(validated),
          ),
      );
    },

    async abandon(input) {
      const validated = abandonSpecInputSchema.parse(input);
      return timed(
        logger,
        "state-store.specs.abandon",
        { specId: validated.specId },
        () =>
          writeQueue.withWriteQueue("specs.abandon", async () =>
            abandonTx.immediate(validated),
          ),
      );
    },

    async updateGatePolicy(input) {
      const validated = updateGatePolicyInputSchema.parse(input);
      return timed(
        logger,
        "state-store.specs.update_gate_policy",
        { specId: validated.specId, preset: validated.gatePolicy.preset },
        () =>
          writeQueue.withWriteQueue("specs.updateGatePolicy", async () =>
            updateGatePolicyTx.immediate(validated),
          ),
      );
    },
    abandonInTransaction(input) {
      return abandonRecord(abandonSpecInputSchema.parse(input));
    },
    findByIdInTransaction(specId) {
      return readSpec(specId);
    },

    async listAliases(specId) {
      return timed(
        logger,
        "state-store.specs.list_aliases",
        { specId },
        async () => (listAliasesStmt.all(specId) as unknown[]).map(rowToAlias),
      );
    },

    async allocateNumber(specId, scopeKey) {
      const validatedScope = specCounterScopeKeySchema.parse(scopeKey);
      return timed(
        logger,
        "state-store.specs.allocate_number",
        { specId, scopeKey: validatedScope },
        () =>
          writeQueue.withWriteQueue("specs.allocateNumber", async () =>
            allocateNumberTx.immediate(specId, validatedScope),
          ),
      );
    },

    async findCounter(specId, scopeKey) {
      const validatedScope = specCounterScopeKeySchema.parse(scopeKey);
      return timed(
        logger,
        "state-store.specs.find_counter",
        { specId, scopeKey: validatedScope },
        async () => {
          const raw: unknown = findCounterStmt.get(specId, validatedScope);
          return raw === undefined ? null : rowToCounter(raw);
        },
      );
    },

    async findElement(elementId) {
      return timed(
        logger,
        "state-store.specs.find_element",
        { elementId },
        async () => readElement(elementId),
      );
    },

    async listRevisions(specId) {
      return timed(
        logger,
        "state-store.specs.list_revisions",
        { specId },
        async () => listRevisions(specId),
      );
    },

    async findDraft(specId) {
      return timed(
        logger,
        "state-store.specs.find_draft",
        { specId },
        async () => readDraft(specId),
      );
    },

    async findLatestApproved(specId) {
      return timed(
        logger,
        "state-store.specs.find_latest_approved",
        { specId },
        async () => readLatestApproved(specId),
      );
    },

    async createDraftElement(input) {
      const validated = createDraftElementInputSchema.parse(input);
      return timed(
        logger,
        "state-store.specs.create_draft_element",
        {
          specId: validated.specId,
          revisionId: validated.revisionId,
          elementId: validated.id,
          kind: validated.kind,
        },
        () =>
          writeQueue.withWriteQueue("specs.createDraftElement", async () =>
            createDraftElementTx.immediate(validated),
          ),
      );
    },

    async findRevision(revisionId) {
      return timed(
        logger,
        "state-store.specs.find_revision",
        { revisionId },
        async () => readRevision(revisionId),
      );
    },
    async findDraftRevisionBySpecId(specId) {
      return timed(
        logger,
        "state-store.specs.find_draft_revision",
        { specId },
        async () => {
          const row: unknown = findDraftRevisionBySpecStmt.get(specId);
          return row === undefined ? null : rowToRevision(row);
        },
      );
    },

    async createDraftFromBase(input) {
      const validated = createDraftFromBaseInputSchema.parse(input);
      return timed(
        logger,
        "state-store.specs.create_draft_from_base",
        {
          specId: validated.specId,
          revisionId: validated.id,
          baseRevisionId: validated.baseRevisionId,
        },
        () =>
          writeQueue.withWriteQueue("specs.createDraftFromBase", async () =>
            createDraftFromBaseTx.immediate(validated),
          ),
      );
    },

    async advanceDraftAuthoringStage(input) {
      const validated = advanceDraftAuthoringStageInputSchema.parse(input);
      return timed(
        logger,
        "state-store.specs.advance_authoring_stage",
        {
          specId: validated.specId,
          revisionId: validated.revisionId,
          expectedStage: validated.expectedStage,
          targetStage: validated.targetStage,
        },
        () =>
          writeQueue.withWriteQueue(
            "specs.advanceDraftAuthoringStage",
            async () => advanceDraftAuthoringStageTx.immediate(validated),
          ),
      );
    },

    async approveRevision(input) {
      const validated = approveRevisionInputSchema.parse(input);
      return timed(
        logger,
        "state-store.specs.approve_revision",
        { revisionId: validated.revisionId },
        () =>
          writeQueue.withWriteQueue("specs.approveRevision", async () =>
            approveRevisionTx.immediate(validated),
          ),
      );
    },

    async withdrawAuthoringRevision(input) {
      const validated = withdrawRevisionInputSchema.parse(input);
      return timed(
        logger,
        "state-store.specs.withdraw_authoring_revision",
        { revisionId: validated.revisionId },
        () =>
          writeQueue.withWriteQueue(
            "specs.withdrawAuthoringRevision",
            async () => withdrawAuthoringRevisionTx.immediate(validated),
          ),
      );
    },

    async recordExternalDelivery(input) {
      const validated = recordExternalDeliveryInputSchema.parse(input);
      return timed(
        logger,
        "state-store.specs.record_external_delivery",
        { revisionId: validated.revisionId },
        () =>
          writeQueue.withWriteQueueSync("specs.recordExternalDelivery", () =>
            recordExternalDeliveryTx.immediate(validated),
          ),
      );
    },

    async getRevisionSnapshot(revisionId) {
      return timed(
        logger,
        "state-store.specs.get_revision_snapshot",
        { revisionId },
        async () => readSnapshot(revisionId),
      );
    },

    async readRevisionCitations(revisionId) {
      return timed(
        logger,
        "state-store.specs.read_revision_citations",
        { revisionId },
        async () => readRevisionCitations(revisionId),
      );
    },

    async replaceAssumptionDraftCitations(input) {
      const validated = replaceAssumptionDraftCitationsInputSchema.parse(input);
      return timed(
        logger,
        "state-store.specs.replace_assumption_draft_citations",
        {
          revisionId: validated.revisionId,
          specId: validated.specId,
          expectedCitationVersion: validated.expectedCitationVersion,
          replacementCount: validated.replacements.length,
        },
        () =>
          writeQueue.withWriteQueueSync(
            "specs.replaceAssumptionDraftCitations",
            () => replaceAssumptionDraftCitationsTx.immediate(validated),
          ),
      );
    },

    async mutateDraftCitation(input) {
      const validated = mutateDraftCitationInputSchema.parse(input);
      return timed(
        logger,
        "state-store.specs.mutate_draft_citation",
        {
          revisionId: validated.revisionId,
          specId: validated.specId,
          assumptionId: validated.assumptionId,
          elementId: validated.elementId,
          operation: validated.operation,
          expectedCitationVersion: validated.expectedCitationVersion,
        },
        () =>
          writeQueue.withWriteQueueSync("specs.mutateDraftCitation", () =>
            mutateDraftCitationTx.immediate(validated),
          ),
      );
    },

    async verifyRevision(revisionId) {
      return timed(
        logger,
        "state-store.specs.verify_revision",
        { revisionId },
        async () => {
          const snapshot = readSnapshot(revisionId);
          if (snapshot === null) return notFound("spec_revision", revisionId);
          const mismatchedElementIds = snapshot.elements
            .filter(
              ({ version }) =>
                computeSpecElementPayloadHash(version.payload) !==
                version.payloadHash,
            )
            .map(({ element }) => element.id);
          const actualContentHash = computeSpecRevisionContentHash(
            snapshot.revision.authoringStage,
            snapshot.elements,
          );
          const actualCitationHash = computeSpecRevisionCitationHash(
            snapshot.revision.citationContractVersion,
            snapshot.assumptionCitations,
          );
          return {
            ok:
              snapshot.revision.contentHash !== null &&
              snapshot.revision.contentHash === actualContentHash &&
              snapshot.revision.citationHash === actualCitationHash &&
              mismatchedElementIds.length === 0,
            expectedContentHash: snapshot.revision.contentHash,
            actualContentHash,
            expectedCitationHash: snapshot.revision.citationHash,
            actualCitationHash,
            mismatchedElementIds,
          };
        },
      );
    },

    async findElementVersion(revisionId, elementId) {
      return timed(
        logger,
        "state-store.specs.find_element_version",
        { revisionId, elementId },
        async () => readElementVersion(revisionId, elementId),
      );
    },

    async updateDraftElement(input) {
      const validated = updateDraftElementInputSchema.parse(input);
      return timed(
        logger,
        "state-store.specs.update_draft_element",
        {
          revisionId: validated.revisionId,
          elementId: validated.elementId,
          expectedElementVersion: validated.expectedElementVersion,
        },
        () =>
          writeQueue.withWriteQueue("specs.updateDraftElement", async () =>
            updateDraftElementTx.immediate(validated),
          ),
      );
    },

    async removeDraftElement(input) {
      const validated = removeDraftElementInputSchema.parse(input);
      return timed(
        logger,
        "state-store.specs.remove_draft_element",
        {
          revisionId: validated.revisionId,
          elementId: validated.elementId,
          expectedElementVersion: validated.expectedElementVersion,
        },
        () =>
          writeQueue.withWriteQueue("specs.removeDraftElement", async () =>
            removeDraftElementTx.immediate(validated),
          ),
      );
    },

    async reorderDraftElement(input) {
      const validated = reorderDraftElementInputSchema.parse(input);
      return timed(
        logger,
        "state-store.specs.reorder_draft_element",
        {
          revisionId: validated.revisionId,
          elementId: validated.elementId,
          expectedElementVersion: validated.expectedElementVersion,
          position: validated.position,
        },
        () =>
          writeQueue.withWriteQueue("specs.reorderDraftElement", async () =>
            reorderDraftElementTx.immediate(validated),
          ),
      );
    },
  };
}
