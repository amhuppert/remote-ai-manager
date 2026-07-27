import { randomUUID } from "node:crypto";
import { z } from "zod";

import { createLogger } from "@/lib/logging";
import {
  actorProvenanceSchema,
  specAuthoringStageSchema,
  specElementKindSchema,
  specElementPayloadSchema,
  specGatePolicySchema,
  type ActorProvenance,
  type Spec,
  type SpecAuthoringStage,
  type SpecElementKind,
  type SpecElementPayload,
  type SpecElementVersion,
  type SpecRevision,
  type SpecRevisionSnapshot,
} from "@/lib/specs/schemas";
import {
  computeSpecRevisionContentHash,
  SpecElementIdTakenError,
  SpecRevisionImmutableError,
  StaleElementConflictError,
  StaleStageConflictError,
  type CreateDraftElementResult,
  type RenameSpecResult,
  type SpecsRepo,
  type SpecsRepoTransaction,
} from "@/lib/state-store/specs-repo";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import type { SpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { stableStringify } from "@/lib/state-store/serialization";

import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";

import type {
  PreparedSpecEventPublication,
  SpecEventsPublisher,
} from "./events";
import type {
  SpecPolicyAdmissionNotice,
  SpecPolicyAdmissionNotifier,
} from "./policy-admissions";
import { markWaiversStaleAtSignOffInTransaction } from "./waiver-staleness";
import { specSlugSchema } from "./handles";
import { lint, type LintFinding } from "./lint";
import type { SpecMeasureEventPayload } from "./measures";
import { resolveDial } from "./policy";
import { diffRevisions, type RevisionDiffResult } from "./revision-diff";
import {
  elementHandleInSnapshot,
  loadProposalState,
  toDiffRows,
} from "./review-state";
import {
  admitDraftWrite,
  advanceAuthoringStage as evaluateAdvanceAuthoringStage,
  consultedAuthoringGates,
  nextAuthoringStage,
  openDraftAuthoringStage,
  propose,
  resolveAuthoringDials,
  type TransitionRefusal,
} from "./transitions";

const logger = createLogger("specs.authoring-service");

export const draftElementWriteInputSchema = z
  .object({
    specId: z.string().min(1),
    revisionId: z.string().min(1),
    elementId: z.string().min(1),
    kind: specElementKindSchema,
    parentElementId: z.string().min(1).nullable(),
    /**
     * One global order per revision, tiebroken by element id. Omit it to
     * append: a create takes the next slot, an update keeps the slot it has.
     * Nesting comes from `parentElementId` alone, never from position.
     */
    position: z.number().int().nonnegative().optional(),
    payload: specElementPayloadSchema,
    baseElementVersion: z.number().int().positive().nullable(),
    actor: actorProvenanceSchema,
  })
  .strict();
export type DraftElementWriteInput = z.infer<
  typeof draftElementWriteInputSchema
>;

/**
 * One element of a batch write. Identical to a single write minus the spec and
 * revision the batch as a whole names: per-element `baseElementVersion` is the
 * concurrency boundary in a batch exactly as it is alone, so two writers
 * touching disjoint elements never conflict (R7.3).
 */
export const draftElementBatchItemSchema = draftElementWriteInputSchema.omit({
  specId: true,
  revisionId: true,
  actor: true,
});
export type DraftElementBatchItem = z.infer<typeof draftElementBatchItemSchema>;

export const draftElementBatchInputSchema = z
  .object({
    specId: z.string().min(1),
    revisionId: z.string().min(1),
    elements: z.array(draftElementBatchItemSchema).min(1),
    /**
     * Optional stricter mode (R7.4). Supplying it additionally requires the
     * revision to be untouched since the token was read — useful for a writer
     * that reasoned about the whole document. It is never the default: a
     * revision-level compare-and-swap would make disjoint writers conflict.
     */
    expectedRevisionToken: z.string().min(1).optional(),
    actor: actorProvenanceSchema,
  })
  .strict();
export type DraftElementBatchInput = z.infer<
  typeof draftElementBatchInputSchema
>;

/** One element that landed, addressed by its index in the submitted array. */
export interface DraftElementBatchEntry extends DraftElementWriteResult {
  readonly index: number;
  readonly elementId: string;
}

/**
 * One element that refused, addressed by its index in the submitted array so a
 * caller can see which element refused and why without diffing arrays. The
 * revision-level token, when supplied and stale, refuses at index -1 with a
 * null element: no single element is at fault.
 */
export interface DraftElementBatchRefusal {
  readonly index: number;
  readonly elementId: string | null;
  readonly code: TransitionRefusal["code"];
  readonly unmetConditions: string[];
  readonly instruction: string;
  /** The version the element is actually at, for a stale-element refusal. */
  readonly currentElementVersion: number | null;
}

export type DraftElementBatchResult =
  | {
      readonly ok: true;
      readonly revisionId: string;
      readonly written: DraftElementBatchEntry[];
    }
  | { readonly ok: false; readonly refusals: DraftElementBatchRefusal[] };

/**
 * The first saved element, carried inside the create call: the durable spec
 * object is born from its first successful draft save (R4.1), so creation is
 * never a separate content-less step.
 */
export const createSpecInitialElementSchema = draftElementWriteInputSchema.omit(
  {
    specId: true,
    revisionId: true,
    baseElementVersion: true,
    actor: true,
  },
);
export type CreateSpecInitialElement = z.infer<
  typeof createSpecInitialElementSchema
>;

export const createAuthoringSpecInputSchema = z
  .object({
    projectPath: z.string().min(1),
    slug: z.string().min(1),
    name: z.string(),
    gatePolicy: specGatePolicySchema,
    initialElement: createSpecInitialElementSchema,
    actor: actorProvenanceSchema,
  })
  .strict();
export type CreateAuthoringSpecInput = z.infer<
  typeof createAuthoringSpecInputSchema
>;

const draftElementCasInputSchema = z
  .object({
    specId: z.string().min(1),
    revisionId: z.string().min(1),
    elementId: z.string().min(1),
    baseElementVersion: z.number().int().positive(),
    actor: actorProvenanceSchema,
  })
  .strict();

export const reorderDraftElementInputSchema = draftElementCasInputSchema
  .extend({ position: z.number().int().nonnegative() })
  .strict();
export type ReorderDraftElementInput = z.infer<
  typeof reorderDraftElementInputSchema
>;

export const removeDraftElementInputSchema = draftElementCasInputSchema;
export type RemoveDraftElementInput = z.infer<
  typeof removeDraftElementInputSchema
>;

export const openAmendmentInputSchema = z
  .object({
    specId: z.string().min(1),
    actor: actorProvenanceSchema,
  })
  .strict();
export type OpenAmendmentInput = z.infer<typeof openAmendmentInputSchema>;

export const renameAuthoringSpecInputSchema = z
  .object({
    specId: z.string().min(1),
    slug: specSlugSchema,
    name: z.string().min(1).optional(),
    actor: actorProvenanceSchema,
  })
  .strict();
export type RenameAuthoringSpecInput = z.infer<
  typeof renameAuthoringSpecInputSchema
>;

/**
 * Entry-path result shape shared with the linked-source flows (promotion and
 * graduation), where an existing spec's draft may legitimately be reused.
 */
export interface AuthoringSpecResult {
  readonly spec: Spec;
  readonly draft: SpecRevision;
  readonly reused: boolean;
}

/**
 * A draft write plus the handle the written element is now addressed by.
 * Handles are the authoring vocabulary, so the writer learns the address it
 * just created instead of having to re-read the spec to discover it. Sections
 * and unnumbered rows have no handle and report null.
 */
export interface DraftElementWriteResult extends CreateDraftElementResult {
  readonly handle: string | null;
}

/** Result of the atomic first draft save that creates the spec. */
export interface AuthoringSpecCreateResult {
  readonly spec: Spec;
  readonly draft: SpecRevision;
  readonly element: CreateDraftElementResult["element"];
  readonly version: SpecElementVersion;
  readonly handle: string | null;
}

export interface AuthoringService {
  createSpec(
    input: CreateAuthoringSpecInput,
  ): Promise<AuthoringSpecCreateResult>;
  getSpec(projectPath: string, slug: string): Promise<Spec | null>;
  getRevisionSnapshot(revisionId: string): Promise<SpecRevisionSnapshot | null>;
  upsertDraftElement(
    input: DraftElementWriteInput,
  ): Promise<DraftElementWriteResult>;
  upsertDraftElements(
    input: DraftElementBatchInput,
  ): Promise<DraftElementBatchResult>;
  /** The optional revision-level token a stricter batch may pin. */
  readRevisionToken(revisionId: string): Promise<string | null>;
  reorderDraftElement(
    input: ReorderDraftElementInput,
  ): Promise<SpecElementVersion>;
  removeDraftElement(input: RemoveDraftElementInput): Promise<void>;
  openAmendment(input: OpenAmendmentInput): Promise<SpecRevision>;
  advanceAuthoringStage(
    input: AdvanceAuthoringStageInput,
  ): Promise<AdvanceAuthoringStageResult>;
  renameSpec(input: RenameAuthoringSpecInput): Promise<RenameSpecResult>;
  lintDraft(specId: string, revisionId: string): Promise<LintFinding[]>;
  proposeRevision(input: ProposeAuthoringRevisionInput): Promise<ProposeResult>;
}

export interface AuthoringServiceDeps {
  specs: SpecsRepo;
  review: SpecReviewRepo;
  links: Pick<SpecLinksRepo, "findBySpecId">;
  events: SpecEventsPublisher;
  /**
   * R14.5 at the absorbed sign-off: a propose that auto-approves under
   * Notify/Off dials is a revision approval, so waivers whose criterion
   * changed must go stale in the same transaction.
   */
  waivers?: Pick<SpecDeliveryRepo, "findWaiversBySpecId" | "saveWaiver">;
  /** Post-hoc notices for Notify-dial authoring-gate admissions (R11.2). */
  policyNotifier?: SpecPolicyAdmissionNotifier;
  newId?(prefix: string): string;
  now?(): string;
}

export const proposeAuthoringRevisionInputSchema = z
  .object({
    specId: z.string().min(1),
    revisionId: z.string().min(1),
    actor: actorProvenanceSchema,
  })
  .strict();
export type ProposeAuthoringRevisionInput = z.infer<
  typeof proposeAuthoringRevisionInputSchema
>;

export type ProposeResult =
  | {
      readonly ok: true;
      readonly revision: SpecRevision;
      readonly diff: RevisionDiffResult;
      readonly absorbedSignOff: boolean;
    }
  | { readonly ok: false; readonly refusal: TransitionRefusal };

export const advanceAuthoringStageInputSchema = z
  .object({
    specId: z.string().min(1),
    revisionId: z.string().min(1),
    expectedStage: specAuthoringStageSchema,
    actor: actorProvenanceSchema,
  })
  .strict();
export type AdvanceAuthoringStageInput = z.infer<
  typeof advanceAuthoringStageInputSchema
>;

export type AdvanceAuthoringStageResult =
  | { readonly ok: true; readonly revision: SpecRevision }
  | { readonly ok: false; readonly refusal: TransitionRefusal };

export class StageBlockedWriteError extends Error {
  readonly code = "stage_blocked" as const;

  constructor(readonly refusal: TransitionRefusal) {
    super(refusal.unmetConditions.join(" "));
    this.name = "StageBlockedWriteError";
  }
}

export class SpecDraftUnavailableError extends Error {
  constructor(readonly specId: string) {
    super(`spec ${specId} has no editable draft or approved revision`);
    this.name = "SpecDraftUnavailableError";
  }
}

/**
 * Slugs are unique per project; a create for a slug whose spec already has an
 * editable draft is refused rather than silently reused, so the collision
 * surfaces on the very first save (R4.1) instead of merging two intents.
 */
export class SpecSlugTakenError extends Error {
  constructor(
    readonly projectPath: string,
    readonly slug: string,
    readonly existingSpecId: string,
    readonly existingName: string,
  ) {
    super(
      `spec slug "${slug}" already names "${existingName}" (${existingSpecId}) in this project`,
    );
    this.name = "SpecSlugTakenError";
  }
}

function requireSpec(repo: SpecsRepoTransaction, specId: string): Spec {
  const spec = repo.findById(specId);
  if (spec === null) {
    throw new SpecDraftUnavailableError(specId);
  }
  return spec;
}

function requireOwnedRevision(
  repo: SpecsRepoTransaction,
  specId: string,
  revisionId: string,
): SpecRevision {
  const revision = repo.findRevision(revisionId);
  if (revision === null || revision.specId !== specId) {
    throw new SpecDraftUnavailableError(specId);
  }
  return revision;
}

/**
 * Rolls the batch transaction back while carrying the indexed refusals out:
 * SQLite unwinds on a throw, and the refusals are the answer the caller needs,
 * so they travel on the error rather than in a return value that would commit.
 */
class BatchRefusedError extends Error {
  constructor(readonly refusals: DraftElementBatchRefusal[]) {
    super(`spec batch write refused ${refusals.length} element(s)`);
    this.name = "BatchRefusedError";
  }
}

function batchRefusalFor(
  index: number,
  elementId: string,
  error: unknown,
): DraftElementBatchRefusal {
  if (error instanceof StaleElementConflictError) {
    return {
      index,
      elementId,
      code: "stale_element",
      unmetConditions: [error.message],
      instruction: `Re-read ${elementId} and resubmit the batch with its current element version.`,
      currentElementVersion: error.current.elementVersion,
    };
  }
  if (error instanceof SpecElementIdTakenError) {
    return {
      index,
      elementId,
      code: "element_id_taken",
      unmetConditions: [error.message],
      instruction:
        "Choose a globally unique element ID, preferably prefixed with the spec slug, then resubmit the batch.",
      currentElementVersion: null,
    };
  }
  if (error instanceof SpecRevisionImmutableError) {
    return {
      index,
      elementId,
      code: "amendment_required",
      unmetConditions: [error.message],
      instruction: "Open an amendment draft before changing approved content.",
      currentElementVersion: null,
    };
  }
  return {
    index,
    elementId,
    code: "validation",
    unmetConditions: [
      error instanceof Error ? error.message : `Batch element ${index} failed.`,
    ],
    instruction: `Correct element ${index} (${elementId}) and resubmit the batch.`,
    currentElementVersion: null,
  };
}

/**
 * The revision-level token the optional stricter batch mode pins: the
 * revision's canonical content hash, so any committed element change moves it.
 */
function revisionToken(snapshot: SpecRevisionSnapshot): string {
  return computeSpecRevisionContentHash(
    snapshot.revision.authoringStage,
    snapshot.elements,
  );
}

/**
 * Writes one element and returns only its version: handles depend on numbers
 * assigned across the whole batch, and resolving them here would reload and
 * re-parse the entire revision snapshot per element, making an N-element batch
 * quadratic inside the write transaction. The caller resolves them once.
 */
function writeOneElement(
  repo: SpecsRepoTransaction,
  batch: DraftElementBatchInput,
  item: DraftElementBatchItem,
  occurredAt: string,
): SpecElementVersion {
  let version: SpecElementVersion;
  if (item.baseElementVersion === null) {
    const current = repo.findElementVersion(batch.revisionId, item.elementId);
    if (current !== null) {
      throw new StaleElementConflictError(
        batch.revisionId,
        item.elementId,
        0,
        current,
      );
    }
    version = repo.createDraftElement({
      id: item.elementId,
      specId: batch.specId,
      revisionId: batch.revisionId,
      kind: item.kind,
      parentElementId: item.parentElementId,
      position: item.position,
      payload: item.payload,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }).version;
  } else {
    version = repo.updateDraftElement({
      revisionId: batch.revisionId,
      elementId: item.elementId,
      expectedElementVersion: item.baseElementVersion,
      payload: item.payload,
      position: item.position,
      updatedAt: occurredAt,
    });
  }
  return version;
}

/**
 * Handle of an element that was just written, read back from the same
 * in-transaction snapshot so a criterion resolves its parent requirement's
 * number without a second derivation of the grammar.
 */
function writtenElementHandle(
  repo: SpecsRepoTransaction,
  revisionId: string,
  elementId: string,
): string | null {
  const snapshot = repo.getRevisionSnapshot(revisionId);
  return snapshot === null
    ? null
    : elementHandleInSnapshot(snapshot, elementId);
}

export function createAuthoringService(
  deps: AuthoringServiceDeps,
): AuthoringService {
  const newId = deps.newId ?? (() => randomUUID());
  const now = deps.now ?? (() => new Date().toISOString());

  function appendDraftEvent(
    spec: Spec,
    revisionId: string,
    elementIds: string[] | undefined,
    actor: CreateAuthoringSpecInput["actor"],
    occurredAt: string,
    kind: string,
  ): PreparedSpecEventPublication {
    return deps.events.appendInTransaction({
      actor,
      durableEventType: "spec-changed",
      durablePayload: {
        kind,
        revisionId,
        ...(elementIds === undefined ? {} : { elementIds }),
      },
      sseEvent: {
        type: "spec-changed",
        kind: elementIds === undefined ? "draft-opened" : "content-changed",
        projectPath: spec.projectPath,
        specId: spec.id,
        specSlug: spec.slug,
        occurredAt,
        revisionId,
        ...(elementIds === undefined ? {} : { elementIds }),
      },
    });
  }

  function appendRevisionEvent(
    spec: Spec,
    revisionId: string,
    actor: ActorProvenance,
    occurredAt: string,
    kind: string,
    measureEvents: SpecMeasureEventPayload[] = [],
  ): PreparedSpecEventPublication {
    return deps.events.appendInTransaction({
      actor,
      durableEventType: "spec-revision-changed",
      durablePayload: {
        kind,
        revisionId,
        ...(measureEvents.length === 0 ? {} : { measureEvents }),
      },
      sseEvent: {
        type: "spec-revision-changed",
        kind,
        projectPath: spec.projectPath,
        specId: spec.id,
        specSlug: spec.slug,
        occurredAt,
        revisionId,
      },
    });
  }

  function publish(prepared: PreparedSpecEventPublication | null): void {
    if (prepared !== null) deps.events.publishAfterCommit(prepared);
  }

  function writeDecision(
    spec: Spec,
    revision: SpecRevision,
    elementKind: SpecElementKind,
    payload: SpecElementPayload,
  ) {
    return admitDraftWrite(
      revision.authoringStage,
      elementKind,
      payload.kind === "section" ? payload.role : undefined,
      resolveAuthoringDials(spec.gatePolicy),
    );
  }

  function appendWriteIntervention(
    specId: string,
    revisionId: string,
    elementId: string,
    actor: ActorProvenance,
    occurredAt: string,
    refusal: TransitionRefusal,
  ): void {
    deps.events.appendDurableInTransaction({
      specId,
      occurredAt,
      actor,
      durableEventType: "spec-intervention-recorded",
      durablePayload: {
        kind: "draft-write-refused",
        revisionId,
        elementId,
        refusal,
      },
    });
  }

  const authoringStageOrder: Record<SpecAuthoringStage, number> = {
    requirements: 0,
    design: 1,
    plan: 2,
  };

  return {
    async createSpec(input) {
      const parsed = createAuthoringSpecInputSchema.parse(input);
      const occurredAt = now();
      const initialStage = openDraftAuthoringStage({
        policy: parsed.gatePolicy,
      });
      const initialDecision = admitDraftWrite(
        initialStage,
        parsed.initialElement.kind,
        parsed.initialElement.payload.kind === "section"
          ? parsed.initialElement.payload.role
          : undefined,
        resolveAuthoringDials(parsed.gatePolicy),
      );

      function writeInitialElement(
        repo: SpecsRepoTransaction,
        specId: string,
        revisionId: string,
      ): DraftElementWriteResult {
        const current = repo.findElementVersion(
          revisionId,
          parsed.initialElement.elementId,
        );
        if (current !== null) {
          throw new StaleElementConflictError(
            revisionId,
            parsed.initialElement.elementId,
            0,
            current,
          );
        }
        const written = repo.createDraftElement({
          id: parsed.initialElement.elementId,
          specId,
          revisionId,
          kind: parsed.initialElement.kind,
          parentElementId: parsed.initialElement.parentElementId,
          position: parsed.initialElement.position,
          payload: parsed.initialElement.payload,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        });
        return {
          ...written,
          handle: writtenElementHandle(repo, revisionId, written.element.id),
        };
      }

      const result = await deps.specs.transaction(
        "specs.authoring.create",
        (repo) => {
          const existing = repo.resolve(parsed.projectPath, parsed.slug);
          if (existing !== null) {
            const draft = repo.findDraft(existing.id);
            if (draft !== null) {
              throw new SpecSlugTakenError(
                parsed.projectPath,
                parsed.slug,
                existing.id,
                existing.name,
              );
            }

            const approved = repo.findLatestApproved(existing.id);
            if (approved === null) {
              throw new SpecDraftUnavailableError(existing.id);
            }
            const amendmentStage = openDraftAuthoringStage({
              policy: existing.gatePolicy,
              baseRevision: {
                state: "approved",
                authoringStage: approved.authoringStage,
              },
            });
            const amendmentDecision = admitDraftWrite(
              amendmentStage,
              parsed.initialElement.kind,
              parsed.initialElement.payload.kind === "section"
                ? parsed.initialElement.payload.role
                : undefined,
              resolveAuthoringDials(existing.gatePolicy),
            );
            if (!amendmentDecision.ok) {
              appendWriteIntervention(
                existing.id,
                approved.id,
                parsed.initialElement.elementId,
                parsed.actor,
                occurredAt,
                amendmentDecision.refusal,
              );
              return {
                ok: false as const,
                refusal: amendmentDecision.refusal,
              };
            }
            const amendment = repo.createDraftFromBase({
              id: newId("revision"),
              specId: existing.id,
              baseRevisionId: approved.id,
              authoringStage: amendmentStage,
              createdAt: occurredAt,
            });
            const written = writeInitialElement(
              repo,
              existing.id,
              amendment.id,
            );
            return {
              ok: true as const,
              value: {
                spec: existing,
                draft: amendment,
                element: written.element,
                version: written.version,
                handle: written.handle,
              },
              prepared: appendDraftEvent(
                existing,
                amendment.id,
                [parsed.initialElement.elementId],
                parsed.actor,
                occurredAt,
                "amendment-opened",
              ),
            };
          }

          if (!initialDecision.ok) {
            throw new StageBlockedWriteError(initialDecision.refusal);
          }

          // Spec, draft revision, and first element share one transaction and
          // one timestamp: the durable object is born from this first save.
          const created = repo.create({
            spec: {
              id: newId("spec"),
              projectPath: parsed.projectPath,
              slug: parsed.slug,
              name: parsed.name,
              gatePolicy: parsed.gatePolicy,
              createdAt: occurredAt,
              updatedAt: occurredAt,
            },
            initialRevision: {
              id: newId("revision"),
              authoringStage: initialStage,
              createdAt: occurredAt,
            },
          });
          const written = writeInitialElement(
            repo,
            created.spec.id,
            created.revision.id,
          );
          return {
            ok: true as const,
            value: {
              spec: created.spec,
              draft: created.revision,
              element: written.element,
              version: written.version,
              handle: written.handle,
            },
            prepared: appendDraftEvent(
              created.spec,
              created.revision.id,
              [parsed.initialElement.elementId],
              parsed.actor,
              occurredAt,
              "spec-created",
            ),
          };
        },
      );
      if (!result.ok) {
        logger.warn("specs.authoring.create.stage_refused", {
          projectPath: parsed.projectPath,
          slug: parsed.slug,
          refusalCode: result.refusal.code,
        });
        throw new StageBlockedWriteError(result.refusal);
      }
      publish(result.prepared);
      logger.info("specs.authoring.create.complete", {
        specId: result.value.spec.id,
        revisionId: result.value.draft.id,
        elementId: result.value.element.id,
      });
      return result.value;
    },

    getSpec(projectPath, slug) {
      return deps.specs.resolve(projectPath, slug);
    },

    getRevisionSnapshot(revisionId) {
      return deps.specs.getRevisionSnapshot(revisionId);
    },

    async lintDraft(specId, revisionId) {
      return deps.specs.transaction("specs.authoring.lint-draft", (repo) => {
        const spec = requireSpec(repo, specId);
        requireOwnedRevision(repo, specId, revisionId);
        const snapshot = repo.getRevisionSnapshot(revisionId);
        if (snapshot === null) throw new SpecDraftUnavailableError(specId);
        const loaded = loadProposalState(
          repo,
          deps.review,
          deps.links,
          spec,
          snapshot,
        );
        return lint(loaded.draft, loaded.records);
      });
    },

    async proposeRevision(input) {
      const parsed = proposeAuthoringRevisionInputSchema.parse(input);
      const occurredAt = now();
      const transactionResult = await deps.specs.transaction(
        "specs.authoring.propose-revision",
        (repo) => {
          const spec = requireSpec(repo, parsed.specId);
          const revision = requireOwnedRevision(
            repo,
            parsed.specId,
            parsed.revisionId,
          );
          const snapshot = repo.getRevisionSnapshot(revision.id);
          if (snapshot === null) {
            throw new SpecDraftUnavailableError(parsed.specId);
          }
          const loaded = loadProposalState(
            repo,
            deps.review,
            deps.links,
            spec,
            snapshot,
          );
          const decision = propose({
            revisionState: revision.state,
            authoringStage: revision.authoringStage,
            policy: spec.gatePolicy,
            draft: loaded.draft,
            records: loaded.records,
            review: loaded.reviewSnapshot,
          });
          const blocksPropose =
            !decision.ok &&
            (decision.refusal.findings ?? []).some(
              (finding) => finding.severity === "blocks_propose",
            );
          if (revision.state !== "draft" || blocksPropose) {
            const refusal = decision.ok
              ? {
                  code: "gate_blocked" as const,
                  unmetConditions: ["Only a draft revision can be proposed."],
                  instruction:
                    "Open or reuse a draft revision before proposing it.",
                }
              : decision.refusal;
            return {
              result: { ok: false, refusal } satisfies ProposeResult,
              prepared: [] as PreparedSpecEventPublication[],
              policyNotices: [] as SpecPolicyAdmissionNotice[],
            };
          }

          const baseRows =
            loaded.baseSnapshot === null ? [] : toDiffRows(loaded.baseSnapshot);
          const draftRows = toDiffRows(snapshot);
          const diff = diffRevisions(baseRows, draftRows);
          const classificationById = new Map(
            diff.classifications.map((classification) => [
              classification.elementId,
              classification.classification,
            ]),
          );
          let approvalValidityChanged = false;
          const staleSubjectIds: string[] = [];
          for (const approval of deps.review.findApprovalsBySpecId(spec.id)) {
            let validity = approval.validity;
            if (
              approval.validity === "valid" &&
              (approval.subject_kind === "requirement" ||
                approval.subject_kind === "decision") &&
              approval.element_id !== null
            ) {
              const classification = classificationById.get(
                approval.element_id,
              );
              if (classification === "removed") validity = "closed";
              if (classification === "modified") validity = "stale";
            }
            if (
              approval.validity === "valid" &&
              approval.subject_kind === "plan" &&
              diff.planStale
            ) {
              validity = "stale";
            }
            if (validity === approval.validity) continue;
            deps.review.saveApproval({ ...approval, validity });
            approvalValidityChanged = true;
            if (validity === "stale") {
              staleSubjectIds.push(
                approval.element_id ?? approval.subject_kind,
              );
            }
          }

          const changedIntentElementIds = diff.classifications
            .filter(
              ({ kind, classification }) =>
                (kind === "requirement" || kind === "criterion") &&
                classification !== "unchanged",
            )
            .map(({ elementId }) => elementId)
            .sort();
          const revisionMeasureEvents: SpecMeasureEventPayload[] =
            loaded.baseSnapshot?.revision.state === "approved"
              ? [
                  {
                    kind: "post-approval-revision-created",
                    revisionId: revision.id,
                    nonTrivial: diff.changeList.length > 0,
                    changedIntentElementIds,
                  },
                ]
              : [];

          let proposed = repo.proposeRevision({
            revisionId: revision.id,
            proposedAt: occurredAt,
          });
          const proposeGates = consultedAuthoringGates(
            revision.authoringStage,
            loaded.reviewSnapshot.baseRevisionRows,
            loaded.reviewSnapshot.revisionRows,
          );
          const resolvedGates = proposeGates.map((gate) => ({
            gate,
            dial: resolveDial(spec.gatePolicy, gate),
          }));
          const policyNotices: SpecPolicyAdmissionNotice[] = [];
          for (const { gate, dial } of resolvedGates) {
            if (dial !== "notify" && dial !== "off") continue;
            const admissionId = newId("admission");
            deps.review.insertGateAdmission({
              id: admissionId,
              spec_id: spec.id,
              gate,
              basis: dial === "notify" ? "notify_policy" : "off_policy",
              approval_id: null,
              revision_id: revision.id,
              execution_id: null,
              actor_json: stableStringify(parsed.actor),
              created_at: occurredAt,
            });
            if (dial === "notify") {
              // R11.2: the transition proceeded under Notify — surface the
              // admission to the human post hoc (never a Needs You request).
              policyNotices.push({
                specId: spec.id,
                specSlug: spec.slug,
                specName: spec.name,
                projectPath: spec.projectPath,
                gate,
                basis: "notify_policy",
                admissionId,
                revisionId: revision.id,
                executionId: null,
                occurredAt,
              });
            }
          }
          const absorbsSignOff = resolvedGates.every(
            ({ dial }) => dial === "notify" || dial === "off",
          );
          const absorbedRefusal = !decision.ok ? decision.refusal : null;
          const stalePrepared: PreparedSpecEventPublication[] = [];
          if (absorbsSignOff && absorbedRefusal === null) {
            proposed = repo.approveRevision({
              revisionId: revision.id,
              approvedAt: occurredAt,
            });
            if (deps.waivers !== undefined) {
              stalePrepared.push(
                ...markWaiversStaleAtSignOffInTransaction({
                  spec,
                  approvedRevisionId: revision.id,
                  getSnapshot: (targetRevisionId) =>
                    repo.getRevisionSnapshot(targetRevisionId),
                  waivers: deps.waivers,
                  events: deps.events,
                  actor: parsed.actor,
                  occurredAt,
                }),
              );
            }
          }

          const prepared = [
            appendRevisionEvent(
              spec,
              revision.id,
              parsed.actor,
              occurredAt,
              proposed.state === "approved" ? "approved" : "proposed",
              proposed.state === "approved"
                ? [
                    ...revisionMeasureEvents,
                    {
                      kind: "review-action",
                      action: "sign_off",
                      reviewAttemptId: revision.id,
                      activeStartedAt: occurredAt,
                      revisionId: revision.id,
                    },
                  ]
                : revisionMeasureEvents,
            ),
            ...stalePrepared,
          ];
          if (approvalValidityChanged) {
            prepared.push(
              deps.events.appendInTransaction({
                actor: parsed.actor,
                durableEventType: "spec-approval-changed",
                durablePayload: {
                  kind: "approval-validity-updated",
                  revisionId: revision.id,
                  measureEvents: staleSubjectIds.sort().map((subjectId) => ({
                    kind: "approval-staled" as const,
                    subjectId,
                  })),
                },
                sseEvent: {
                  type: "spec-approval-changed",
                  kind: "approval-validity-updated",
                  projectPath: spec.projectPath,
                  specId: spec.id,
                  specSlug: spec.slug,
                  occurredAt,
                  revisionId: revision.id,
                },
              }),
            );
          }
          if (absorbedRefusal !== null) {
            return {
              result: {
                ok: false,
                refusal: absorbedRefusal,
              } satisfies ProposeResult,
              prepared,
              policyNotices,
            };
          }
          return {
            result: {
              ok: true,
              revision: proposed,
              diff,
              absorbedSignOff: absorbsSignOff,
            } satisfies ProposeResult,
            prepared,
            policyNotices,
          };
        },
      );
      for (const prepared of transactionResult.prepared) publish(prepared);
      // The admission rows are committed even when an absorbed sign-off
      // surfaced a refusal — the Notify-dial propose itself proceeded, so the
      // post-hoc notices fire either way.
      for (const notice of transactionResult.policyNotices) {
        deps.policyNotifier?.policyAdmitted(notice);
      }
      logger.info("specs.authoring.propose_revision.complete", {
        specId: parsed.specId,
        revisionId: parsed.revisionId,
        ok: transactionResult.result.ok,
        ...(transactionResult.result.ok
          ? {
              state: transactionResult.result.revision.state,
              absorbedSignOff: transactionResult.result.absorbedSignOff,
            }
          : { refusalCode: transactionResult.result.refusal.code }),
      });
      return transactionResult.result;
    },

    async upsertDraftElement(input) {
      const parsed = draftElementWriteInputSchema.parse(input);
      const occurredAt = now();
      const result = await deps.specs.transaction(
        "specs.authoring.upsert-element",
        (repo) => {
          const spec = requireSpec(repo, parsed.specId);
          const revision = requireOwnedRevision(
            repo,
            parsed.specId,
            parsed.revisionId,
          );
          const decision = writeDecision(
            spec,
            revision,
            parsed.kind,
            parsed.payload,
          );
          if (!decision.ok) {
            appendWriteIntervention(
              spec.id,
              revision.id,
              parsed.elementId,
              parsed.actor,
              occurredAt,
              decision.refusal,
            );
            return { ok: false as const, refusal: decision.refusal };
          }
          const current = repo.findElementVersion(
            parsed.revisionId,
            parsed.elementId,
          );

          let version: SpecElementVersion;
          if (parsed.baseElementVersion === null) {
            if (current !== null) {
              throw new StaleElementConflictError(
                parsed.revisionId,
                parsed.elementId,
                0,
                current,
              );
            }
            version = repo.createDraftElement({
              id: parsed.elementId,
              specId: parsed.specId,
              revisionId: parsed.revisionId,
              kind: parsed.kind,
              parentElementId: parsed.parentElementId,
              position: parsed.position,
              payload: parsed.payload,
              createdAt: occurredAt,
              updatedAt: occurredAt,
            }).version;
          } else {
            version = repo.updateDraftElement({
              revisionId: parsed.revisionId,
              elementId: parsed.elementId,
              expectedElementVersion: parsed.baseElementVersion,
              payload: parsed.payload,
              position: parsed.position,
              updatedAt: occurredAt,
            });
          }
          // One post-write snapshot serves both the written row and its
          // handle, so a criterion resolves its parent requirement's number
          // from the same committed state the write produced.
          const snapshot = repo.getRevisionSnapshot(parsed.revisionId);
          const element = snapshot?.elements.find(
            ({ element: candidate }) => candidate.id === parsed.elementId,
          )?.element;
          if (snapshot === null || element === undefined) {
            throw new SpecDraftUnavailableError(parsed.specId);
          }
          const written: DraftElementWriteResult = {
            element,
            version,
            handle: elementHandleInSnapshot(snapshot, parsed.elementId),
          };

          return {
            ok: true as const,
            value: written,
            prepared: appendDraftEvent(
              spec,
              parsed.revisionId,
              [parsed.elementId],
              parsed.actor,
              occurredAt,
              current === null
                ? "draft-element-created"
                : "draft-element-updated",
            ),
          };
        },
      );
      if (!result.ok) {
        logger.warn("specs.authoring.upsert_element.stage_refused", {
          specId: parsed.specId,
          revisionId: parsed.revisionId,
          elementId: parsed.elementId,
          elementKind: parsed.kind,
        });
        throw new StageBlockedWriteError(result.refusal);
      }
      publish(result.prepared);
      logger.info("specs.authoring.upsert_element.complete", {
        specId: parsed.specId,
        revisionId: parsed.revisionId,
        elementId: parsed.elementId,
        elementVersion: result.value.version.elementVersion,
      });
      return result.value;
    },

    async readRevisionToken(revisionId) {
      const snapshot = await deps.specs.getRevisionSnapshot(revisionId);
      return snapshot === null ? null : revisionToken(snapshot);
    },

    async upsertDraftElements(input) {
      const parsed = draftElementBatchInputSchema.parse(input);
      const occurredAt = now();
      let transaction: {
        result: DraftElementBatchResult;
        prepared: PreparedSpecEventPublication;
      };
      const blockedWrites: Array<{
        elementId: string;
        refusal: TransitionRefusal;
      }> = [];
      try {
        transaction = await deps.specs.transaction(
          "specs.authoring.upsert-elements",
          (repo) => {
            const spec = requireSpec(repo, parsed.specId);
            const revision = requireOwnedRevision(
              repo,
              parsed.specId,
              parsed.revisionId,
            );
            if (parsed.expectedRevisionToken !== undefined) {
              const snapshot = repo.getRevisionSnapshot(revision.id);
              const actual = snapshot === null ? null : revisionToken(snapshot);
              if (actual !== parsed.expectedRevisionToken) {
                throw new BatchRefusedError([
                  {
                    index: -1,
                    elementId: null,
                    code: "stale_revision",
                    unmetConditions: [
                      `Revision ${revision.id} changed since the supplied token was read.`,
                    ],
                    instruction:
                      "Re-read the revision token and resubmit the batch.",
                    currentElementVersion: null,
                  },
                ]);
              }
            }

            const landed: {
              index: number;
              elementId: string;
              version: SpecElementVersion;
            }[] = [];
            const refusals: DraftElementBatchRefusal[] = [];
            parsed.elements.forEach((item, index) => {
              const decision = writeDecision(
                spec,
                revision,
                item.kind,
                item.payload,
              );
              if (!decision.ok) {
                // Recorded after this transaction unwinds, not here: the
                // intervention is the durable trace of the refusal, and a row
                // written inside the batch dies with the rollback that keeps
                // the element writes atomic.
                blockedWrites.push({
                  elementId: item.elementId,
                  refusal: decision.refusal,
                });
                refusals.push({
                  index,
                  elementId: item.elementId,
                  code: decision.refusal.code,
                  unmetConditions: decision.refusal.unmetConditions,
                  instruction: decision.refusal.instruction,
                  currentElementVersion: null,
                });
                return;
              }
              try {
                landed.push({
                  index,
                  elementId: item.elementId,
                  version: writeOneElement(repo, parsed, item, occurredAt),
                });
              } catch (error) {
                // Every element is attempted so one bad version does not hide
                // the next; the whole batch is rolled back below regardless.
                refusals.push(batchRefusalFor(index, item.elementId, error));
              }
            });

            if (refusals.length > 0) throw new BatchRefusedError(refusals);

            // One snapshot for the whole batch, read after every write so the
            // numbers each handle derives from are final.
            const snapshot = repo.getRevisionSnapshot(revision.id);
            if (snapshot === null) {
              throw new SpecDraftUnavailableError(parsed.specId);
            }
            const elementsById = new Map(
              snapshot.elements.map(({ element }) => [element.id, element]),
            );
            const written: DraftElementBatchEntry[] = landed.map((entry) => {
              const element = elementsById.get(entry.elementId);
              if (element === undefined) {
                throw new SpecDraftUnavailableError(parsed.specId);
              }
              return {
                index: entry.index,
                elementId: entry.elementId,
                element,
                version: entry.version,
                handle: elementHandleInSnapshot(snapshot, entry.elementId),
              };
            });
            return {
              result: {
                ok: true as const,
                revisionId: revision.id,
                written,
              },
              prepared: appendDraftEvent(
                spec,
                revision.id,
                parsed.elements.map((item) => item.elementId),
                parsed.actor,
                occurredAt,
                "draft-elements-written",
              ),
            };
          },
        );
      } catch (error) {
        if (!(error instanceof BatchRefusedError)) throw error;
        // Same ordering the single-element path uses: the intervention is
        // committed before the refusal reaches the caller. It takes a second
        // transaction here only because the first one had to unwind.
        if (blockedWrites.length > 0) {
          await deps.specs.transaction(
            "specs.authoring.upsert-elements.interventions",
            () => {
              for (const blocked of blockedWrites) {
                appendWriteIntervention(
                  parsed.specId,
                  parsed.revisionId,
                  blocked.elementId,
                  parsed.actor,
                  occurredAt,
                  blocked.refusal,
                );
              }
            },
          );
        }
        logger.warn("specs.authoring.upsert_elements.refused", {
          specId: parsed.specId,
          revisionId: parsed.revisionId,
          elementCount: parsed.elements.length,
          refusalCodes: error.refusals.map((refusal) => refusal.code),
        });
        return { ok: false, refusals: error.refusals };
      }
      publish(transaction.prepared);
      logger.info("specs.authoring.upsert_elements.complete", {
        specId: parsed.specId,
        revisionId: parsed.revisionId,
        elementCount: parsed.elements.length,
      });
      return transaction.result;
    },

    async advanceAuthoringStage(input) {
      const parsed = advanceAuthoringStageInputSchema.parse(input);
      const occurredAt = now();
      const transaction = await deps.specs.transaction(
        "specs.authoring.advance-stage",
        (repo) => {
          const spec = requireSpec(repo, parsed.specId);
          const targetStage = nextAuthoringStage(parsed.expectedStage);
          const current = repo.findDraft(spec.id);
          if (
            targetStage !== null &&
            current?.id === parsed.revisionId &&
            authoringStageOrder[current.authoringStage] >=
              authoringStageOrder[targetStage]
          ) {
            return {
              result: {
                ok: true,
                revision: current,
              } satisfies AdvanceAuthoringStageResult,
              prepared: null,
              policyNotice: null,
            };
          }
          if (
            current === null ||
            current.id !== parsed.revisionId ||
            current.authoringStage !== parsed.expectedStage
          ) {
            if (targetStage === null) {
              throw new StaleStageConflictError(
                parsed.specId,
                parsed.revisionId,
                parsed.expectedStage,
                current,
              );
            }
            repo.advanceDraftAuthoringStage({
              specId: parsed.specId,
              revisionId: parsed.revisionId,
              expectedStage: parsed.expectedStage,
              targetStage,
            });
          }

          const decision = evaluateAdvanceAuthoringStage(
            parsed.expectedStage,
            spec.gatePolicy,
          );
          if (!decision.ok || targetStage === null) {
            const refusal = decision.ok
              ? {
                  code: "gate_blocked" as const,
                  unmetConditions: ["Plan is the final authoring stage."],
                  instruction:
                    "Propose the plan stage when it is ready for review.",
                }
              : decision.refusal;
            deps.events.appendDurableInTransaction({
              specId: spec.id,
              occurredAt,
              actor: parsed.actor,
              durableEventType: "spec-intervention-recorded",
              durablePayload: {
                kind: "authoring-stage-advance-refused",
                revisionId: parsed.revisionId,
                expectedStage: parsed.expectedStage,
                refusal,
              },
            });
            return {
              result: {
                ok: false,
                refusal,
              } satisfies AdvanceAuthoringStageResult,
              prepared: null,
              policyNotice: null,
            };
          }

          const revision = repo.advanceDraftAuthoringStage({
            specId: parsed.specId,
            revisionId: parsed.revisionId,
            expectedStage: parsed.expectedStage,
            targetStage,
          });
          const dial = resolveDial(spec.gatePolicy, parsed.expectedStage);
          const basis =
            dial === "notify"
              ? ("notify_policy" as const)
              : ("off_policy" as const);
          const admissionId = newId("admission");
          deps.review.insertGateAdmission({
            id: admissionId,
            spec_id: spec.id,
            gate: parsed.expectedStage,
            basis,
            approval_id: null,
            revision_id: revision.id,
            execution_id: null,
            actor_json: stableStringify(parsed.actor),
            created_at: occurredAt,
          });
          const prepared = deps.events.appendInTransaction({
            actor: parsed.actor,
            durableEventType: "spec-revision-changed",
            durablePayload: {
              kind: "authoring-stage-advanced",
              revisionId: revision.id,
              fromStage: parsed.expectedStage,
              toStage: targetStage,
              admissionId,
            },
            sseEvent: {
              type: "spec-revision-changed",
              kind: "authoring-stage-advanced",
              projectPath: spec.projectPath,
              specId: spec.id,
              specSlug: spec.slug,
              occurredAt,
              revisionId: revision.id,
            },
          });
          const policyNotice =
            basis === "notify_policy"
              ? ({
                  specId: spec.id,
                  specSlug: spec.slug,
                  specName: spec.name,
                  projectPath: spec.projectPath,
                  gate: parsed.expectedStage,
                  basis,
                  admissionId,
                  revisionId: revision.id,
                  executionId: null,
                  occurredAt,
                } satisfies SpecPolicyAdmissionNotice)
              : null;
          return {
            result: {
              ok: true,
              revision,
            } satisfies AdvanceAuthoringStageResult,
            prepared,
            policyNotice,
          };
        },
      );
      publish(transaction.prepared);
      if (transaction.policyNotice !== null) {
        deps.policyNotifier?.policyAdmitted(transaction.policyNotice);
      }
      logger.info("specs.authoring.advance_stage.complete", {
        specId: parsed.specId,
        revisionId: parsed.revisionId,
        expectedStage: parsed.expectedStage,
        ok: transaction.result.ok,
        ...(transaction.result.ok
          ? { authoringStage: transaction.result.revision.authoringStage }
          : { refusalCode: transaction.result.refusal.code }),
      });
      return transaction.result;
    },

    async reorderDraftElement(input) {
      const parsed = reorderDraftElementInputSchema.parse(input);
      const occurredAt = now();
      const result = await deps.specs.transaction(
        "specs.authoring.reorder-element",
        (repo) => {
          const spec = requireSpec(repo, parsed.specId);
          const revision = requireOwnedRevision(
            repo,
            parsed.specId,
            parsed.revisionId,
          );
          const target = repo
            .getRevisionSnapshot(revision.id)
            ?.elements.find(({ element }) => element.id === parsed.elementId);
          if (target !== undefined) {
            const decision = writeDecision(
              spec,
              revision,
              target.element.kind,
              target.version.payload,
            );
            if (!decision.ok) {
              appendWriteIntervention(
                spec.id,
                revision.id,
                parsed.elementId,
                parsed.actor,
                occurredAt,
                decision.refusal,
              );
              return { ok: false as const, refusal: decision.refusal };
            }
          }
          const version = repo.reorderDraftElement({
            revisionId: parsed.revisionId,
            elementId: parsed.elementId,
            expectedElementVersion: parsed.baseElementVersion,
            position: parsed.position,
            updatedAt: occurredAt,
          });
          return {
            ok: true as const,
            value: version,
            prepared: appendDraftEvent(
              spec,
              parsed.revisionId,
              [parsed.elementId],
              parsed.actor,
              occurredAt,
              "draft-element-reordered",
            ),
          };
        },
      );
      if (!result.ok) throw new StageBlockedWriteError(result.refusal);
      publish(result.prepared);
      logger.info("specs.authoring.reorder_element.complete", {
        specId: parsed.specId,
        revisionId: parsed.revisionId,
        elementId: parsed.elementId,
        elementVersion: result.value.elementVersion,
        position: result.value.position,
      });
      return result.value;
    },

    async removeDraftElement(input) {
      const parsed = removeDraftElementInputSchema.parse(input);
      const occurredAt = now();
      const result = await deps.specs.transaction(
        "specs.authoring.remove-element",
        (repo) => {
          const spec = requireSpec(repo, parsed.specId);
          const revision = requireOwnedRevision(
            repo,
            parsed.specId,
            parsed.revisionId,
          );
          const target = repo
            .getRevisionSnapshot(revision.id)
            ?.elements.find(({ element }) => element.id === parsed.elementId);
          if (target !== undefined) {
            const decision = writeDecision(
              spec,
              revision,
              target.element.kind,
              target.version.payload,
            );
            if (!decision.ok) {
              appendWriteIntervention(
                spec.id,
                revision.id,
                parsed.elementId,
                parsed.actor,
                occurredAt,
                decision.refusal,
              );
              return { ok: false as const, refusal: decision.refusal };
            }
          }
          repo.removeDraftElement({
            revisionId: parsed.revisionId,
            elementId: parsed.elementId,
            expectedElementVersion: parsed.baseElementVersion,
          });
          return {
            ok: true as const,
            prepared: appendDraftEvent(
              spec,
              parsed.revisionId,
              [parsed.elementId],
              parsed.actor,
              occurredAt,
              "draft-element-removed",
            ),
          };
        },
      );
      if (!result.ok) throw new StageBlockedWriteError(result.refusal);
      publish(result.prepared);
      logger.info("specs.authoring.remove_element.complete", {
        specId: parsed.specId,
        revisionId: parsed.revisionId,
        elementId: parsed.elementId,
      });
    },

    async renameSpec(input) {
      const parsed = renameAuthoringSpecInputSchema.parse(input);
      const occurredAt = now();
      const result = await deps.specs.transaction(
        "specs.authoring.rename",
        (repo) => {
          const current = requireSpec(repo, parsed.specId);
          const renamed = repo.rename({
            specId: parsed.specId,
            slug: parsed.slug,
            name: parsed.name ?? current.name,
            updatedAt: occurredAt,
            aliasCreatedAt: occurredAt,
          });
          return {
            value: renamed,
            fromSlug: current.slug,
            // The slug pair travels only in the durable payload: the strict
            // SSE spec-changed schema drops events with unknown fields.
            prepared: deps.events.appendInTransaction({
              actor: parsed.actor,
              durableEventType: "spec-changed",
              durablePayload: {
                kind: "spec-renamed",
                fromSlug: current.slug,
                toSlug: renamed.spec.slug,
              },
              sseEvent: {
                type: "spec-changed",
                kind: "spec-renamed",
                projectPath: renamed.spec.projectPath,
                specId: renamed.spec.id,
                specSlug: renamed.spec.slug,
                occurredAt,
              },
            }),
          };
        },
      );
      publish(result.prepared);
      logger.info("specs.authoring.rename.complete", {
        specId: parsed.specId,
        fromSlug: result.fromSlug,
        toSlug: result.value.spec.slug,
      });
      return result.value;
    },

    async openAmendment(input) {
      const parsed = openAmendmentInputSchema.parse(input);
      const occurredAt = now();
      const result = await deps.specs.transaction(
        "specs.authoring.open-amendment",
        (repo) => {
          const spec = requireSpec(repo, parsed.specId);
          const existing = repo.findDraft(spec.id);
          if (existing !== null) return { revision: existing, prepared: null };

          const approved = repo.findLatestApproved(spec.id);
          if (approved === null) {
            throw new SpecDraftUnavailableError(spec.id);
          }
          const authoringStage = openDraftAuthoringStage({
            policy: spec.gatePolicy,
            baseRevision: {
              state: "approved",
              authoringStage: approved.authoringStage,
            },
          });
          const revision = repo.createDraftFromBase({
            id: newId("revision"),
            specId: spec.id,
            baseRevisionId: approved.id,
            authoringStage,
            createdAt: occurredAt,
          });
          return {
            revision,
            prepared: appendDraftEvent(
              spec,
              revision.id,
              undefined,
              parsed.actor,
              occurredAt,
              "amendment-opened",
            ),
          };
        },
      );
      publish(result.prepared);
      logger.info("specs.authoring.open_amendment.complete", {
        specId: parsed.specId,
        revisionId: result.revision.id,
        reused: result.prepared === null,
      });
      return result.revision;
    },
  };
}
