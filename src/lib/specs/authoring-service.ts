import { randomUUID } from "node:crypto";
import { z } from "zod";

import { createLogger } from "@/lib/logging";
import {
  actorProvenanceSchema,
  specElementKindSchema,
  specElementPayloadSchema,
  specGatePolicySchema,
  type ActorProvenance,
  type Spec,
  type SpecElementVersion,
  type SpecRevision,
  type SpecRevisionSnapshot,
} from "@/lib/specs/schemas";
import {
  StaleElementConflictError,
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
import { loadProposalState, toDiffRows } from "./review-state";
import { propose, type TransitionRefusal } from "./transitions";

const logger = createLogger("specs.authoring-service");

export const draftElementWriteInputSchema = z
  .object({
    specId: z.string().min(1),
    revisionId: z.string().min(1),
    elementId: z.string().min(1),
    kind: specElementKindSchema,
    parentElementId: z.string().min(1).nullable(),
    position: z.number().int().nonnegative(),
    payload: specElementPayloadSchema,
    baseElementVersion: z.number().int().positive().nullable(),
    actor: actorProvenanceSchema,
  })
  .strict();
export type DraftElementWriteInput = z.infer<
  typeof draftElementWriteInputSchema
>;

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

/** Result of the atomic first draft save that creates the spec. */
export interface AuthoringSpecCreateResult {
  readonly spec: Spec;
  readonly draft: SpecRevision;
  readonly element: CreateDraftElementResult["element"];
  readonly version: SpecElementVersion;
}

export interface AuthoringService {
  createSpec(
    input: CreateAuthoringSpecInput,
  ): Promise<AuthoringSpecCreateResult>;
  getSpec(projectPath: string, slug: string): Promise<Spec | null>;
  getRevisionSnapshot(revisionId: string): Promise<SpecRevisionSnapshot | null>;
  upsertDraftElement(
    input: DraftElementWriteInput,
  ): Promise<CreateDraftElementResult>;
  reorderDraftElement(
    input: ReorderDraftElementInput,
  ): Promise<SpecElementVersion>;
  removeDraftElement(input: RemoveDraftElementInput): Promise<void>;
  openAmendment(input: OpenAmendmentInput): Promise<SpecRevision>;
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

  return {
    async createSpec(input) {
      const parsed = createAuthoringSpecInputSchema.parse(input);
      const occurredAt = now();

      function writeInitialElement(
        repo: SpecsRepoTransaction,
        specId: string,
        revisionId: string,
      ): CreateDraftElementResult {
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
        return repo.createDraftElement({
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
            const amendment = repo.createDraftFromBase({
              id: newId("revision"),
              specId: existing.id,
              baseRevisionId: approved.id,
              createdAt: occurredAt,
            });
            const written = writeInitialElement(
              repo,
              existing.id,
              amendment.id,
            );
            return {
              value: {
                spec: existing,
                draft: amendment,
                element: written.element,
                version: written.version,
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
              createdAt: occurredAt,
            },
          });
          const written = writeInitialElement(
            repo,
            created.spec.id,
            created.revision.id,
          );
          return {
            value: {
              spec: created.spec,
              draft: created.revision,
              element: written.element,
              version: written.version,
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
          const proposeGates = ["requirements", "design", "plan"] as const;
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
          requireOwnedRevision(repo, parsed.specId, parsed.revisionId);
          const current = repo.findElementVersion(
            parsed.revisionId,
            parsed.elementId,
          );

          let written: CreateDraftElementResult;
          if (parsed.baseElementVersion === null) {
            if (current !== null) {
              throw new StaleElementConflictError(
                parsed.revisionId,
                parsed.elementId,
                0,
                current,
              );
            }
            written = repo.createDraftElement({
              id: parsed.elementId,
              specId: parsed.specId,
              revisionId: parsed.revisionId,
              kind: parsed.kind,
              parentElementId: parsed.parentElementId,
              position: parsed.position,
              payload: parsed.payload,
              createdAt: occurredAt,
              updatedAt: occurredAt,
            });
          } else {
            const version = repo.updateDraftElement({
              revisionId: parsed.revisionId,
              elementId: parsed.elementId,
              expectedElementVersion: parsed.baseElementVersion,
              payload: parsed.payload,
              position: parsed.position,
              updatedAt: occurredAt,
            });
            const element = repo
              .getRevisionSnapshot(parsed.revisionId)
              ?.elements.find(
                ({ element: candidate }) => candidate.id === parsed.elementId,
              )?.element;
            if (element === undefined) {
              throw new SpecDraftUnavailableError(parsed.specId);
            }
            written = { element, version };
          }

          return {
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
      publish(result.prepared);
      logger.info("specs.authoring.upsert_element.complete", {
        specId: parsed.specId,
        revisionId: parsed.revisionId,
        elementId: parsed.elementId,
        elementVersion: result.value.version.elementVersion,
      });
      return result.value;
    },

    async reorderDraftElement(input) {
      const parsed = reorderDraftElementInputSchema.parse(input);
      const occurredAt = now();
      const result = await deps.specs.transaction(
        "specs.authoring.reorder-element",
        (repo) => {
          const spec = requireSpec(repo, parsed.specId);
          requireOwnedRevision(repo, parsed.specId, parsed.revisionId);
          const version = repo.reorderDraftElement({
            revisionId: parsed.revisionId,
            elementId: parsed.elementId,
            expectedElementVersion: parsed.baseElementVersion,
            position: parsed.position,
            updatedAt: occurredAt,
          });
          return {
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
      const prepared = await deps.specs.transaction(
        "specs.authoring.remove-element",
        (repo) => {
          const spec = requireSpec(repo, parsed.specId);
          requireOwnedRevision(repo, parsed.specId, parsed.revisionId);
          repo.removeDraftElement({
            revisionId: parsed.revisionId,
            elementId: parsed.elementId,
            expectedElementVersion: parsed.baseElementVersion,
          });
          return appendDraftEvent(
            spec,
            parsed.revisionId,
            [parsed.elementId],
            parsed.actor,
            occurredAt,
            "draft-element-removed",
          );
        },
      );
      publish(prepared);
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
          const revision = repo.createDraftFromBase({
            id: newId("revision"),
            specId: spec.id,
            baseRevisionId: approved.id,
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
