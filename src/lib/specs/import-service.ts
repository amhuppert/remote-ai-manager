import { randomUUID } from "node:crypto";
import { z } from "zod";

import { createLogger } from "@/lib/logging";
import { stableStringify } from "@/lib/state-store/serialization";
import type { SpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import type { SpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import type {
  SpecsRepo,
  SpecsRepoTransaction,
} from "@/lib/state-store/specs-repo";

import { draftHealth, type DraftHealth } from "./draft-health";
import {
  assumptionAuditSnapshot,
  questionAuditSnapshot,
} from "./attention-records";
import type {
  PreparedSpecEventPublication,
  SpecEventsPublisher,
} from "./events";
import { formatBareElementHandle } from "./handles";
import { lint, type LintFinding } from "./lint";
import { loadProposalState } from "./review-state";
import {
  actorProvenanceSchema,
  importBundleSchema,
  resolveImportedValidationStrategy,
  specReviewRecordMutatedEventPayloadSchema,
  type ActorProvenance,
  type ImportBundle,
  type Refusal,
  type Spec,
  type SpecAssumptionRow,
  type SpecElementPayload,
  type SpecGate,
  type SpecImportedCounts,
  type SpecQuestionRow,
  type SpecRevision,
} from "./schemas";

const logger = createLogger("specs.import-service");

/**
 * The authoring gates an imported revision is born past. Delivery and
 * execution-start gates are deliberately absent: an import is testimony about
 * authoring content, and admitting a run or a delivery on that basis would let
 * an import satisfy a gate no human or machine ever answered.
 */
const IMPORT_ADMITTED_GATES: readonly SpecGate[] = ["requirements", "design"];

/**
 * What an import counted into the spec. It rides on the durable
 * `spec_imported` event so the shape of a born-approved spec is reconstructable
 * from the event log alone, without re-reading the revision it created.
 */
export type ImportCounts = SpecImportedCounts;

export interface ImportReceipt {
  readonly spec: Spec;
  readonly revision: SpecRevision;
  readonly counts: ImportCounts;
}

/** One handle a real import would allocate, beside the text it will address. */
export interface ImportHandlePreviewEntry {
  readonly handle: string;
  readonly summary: string;
}

/**
 * The numbering an import would produce, grouped by the counter that produces
 * it. An agent authoring a bundle writes cross-references against these handles
 * before any of them exists, so a preview that only counted rows would leave it
 * guessing which requirement becomes R1.
 */
export interface ImportHandlePreview {
  readonly requirements: readonly ImportHandlePreviewEntry[];
  readonly criteria: readonly ImportHandlePreviewEntry[];
  readonly decisions: readonly ImportHandlePreviewEntry[];
  readonly questions: readonly ImportHandlePreviewEntry[];
  readonly assumptions: readonly ImportHandlePreviewEntry[];
}

export interface ImportPreview {
  readonly counts: ImportCounts;
  readonly handles: ImportHandlePreview;
  /**
   * Every lint finding, severity-ranked — the identical array a propose refusal
   * and a real import's `lint_blocked` refusal carry, so one remediation loop
   * reads all three.
   */
  readonly findings: readonly LintFinding[];
  /** How many of those findings block. Above zero the real import refuses. */
  readonly blocking: number;
}

export type ImportResult =
  | { readonly ok: true; readonly dryRun: false; readonly value: ImportReceipt }
  | {
      readonly ok: true;
      readonly dryRun: true;
      readonly preview: ImportPreview;
    }
  | { readonly ok: false; readonly refusal: Refusal };

/**
 * The handles a real import would allocate, derived from the bundle's shape
 * alone. A new spec starts every counter at zero, so the bundle's own order
 * already decides each number — which is what lets a dry run show the numbering
 * without consuming it. Reading a counter here would be both unnecessary and
 * unsound: the preview would then depend on rows the dry run must not create.
 */
export function previewImportHandles(
  bundle: ImportBundle,
): ImportHandlePreview {
  const requirements: ImportHandlePreviewEntry[] = [];
  const criteria: ImportHandlePreviewEntry[] = [];
  bundle.requirements.forEach((requirement, index) => {
    const requirementNumber = index + 1;
    requirements.push({
      handle: formatBareElementHandle({
        kind: "requirement",
        requirementNumber,
      }),
      summary: requirement.statement,
    });
    // Criterion numbers restart inside each requirement, exactly as the
    // per-requirement counter the write path allocates from does.
    requirement.criteria.forEach((criterion, criterionIndex) => {
      criteria.push({
        handle: formatBareElementHandle({
          kind: "criterion",
          requirementNumber,
          criterionNumber: criterionIndex + 1,
        }),
        summary: criterion.text,
      });
    });
  });
  return {
    requirements,
    criteria,
    decisions: bundle.decisions.map((decision, index) => ({
      handle: formatBareElementHandle({ kind: "decision", number: index + 1 }),
      summary: decision.title,
    })),
    questions: bundle.questions.map((question, index) => ({
      handle: formatBareElementHandle({ kind: "question", number: index + 1 }),
      summary: question.text,
    })),
    assumptions: bundle.assumptions.map((assumption, index) => ({
      handle: formatBareElementHandle({
        kind: "assumption",
        number: index + 1,
      }),
      summary: assumption.text,
    })),
  };
}

export interface ImportSpecInput {
  readonly projectPath: string;
  /**
   * The bundle as authored, before this service has judged it. It is `unknown`
   * because admissibility is this module's decision, not its caller's: an agent
   * translating an arbitrary external source needs the schema issues back as a
   * typed refusal it can iterate against, which a thrown parse error at the
   * boundary could not give it.
   */
  readonly bundle: unknown;
  readonly actor: ActorProvenance;
}

export interface ImportServiceDeps {
  specs: SpecsRepo;
  /**
   * The whole review surface, not the three write verbs an import uses: the
   * propose-parity lint reads this spec's questions, assumptions, and
   * approvals back through `loadProposalState`, so narrowing the type here
   * would only push a cast into the lint call.
   */
  review: SpecReviewRepo;
  /**
   * Materialized-task links, read by the same lint. A spec created inside this
   * transaction can have none, but the dependency is injected rather than
   * stubbed so an imported revision is judged by exactly the projection an
   * authored propose is judged by.
   */
  links: Pick<SpecLinksRepo, "findBySpecId">;
  events: SpecEventsPublisher;
  newId?(prefix: string): string;
  now?(): string;
}

/**
 * A blocking lint finding, raised after the bundle's content is written.
 * It aborts the transaction by throwing, which is what rolls the whole import
 * back: unlike the schema, reference, and collision refusals — all decidable
 * before the first write — lint can only judge content that already exists.
 * Module-private: callers see the `lint_blocked` refusal, never this error.
 */
class ImportLintBlockedError extends Error {
  constructor(
    readonly blockingFindings: readonly LintFinding[],
    readonly orderedFindings: readonly LintFinding[],
  ) {
    super(`import blocked by ${blockingFindings.length} lint finding(s)`);
    this.name = "ImportLintBlockedError";
  }
}

/**
 * A dry run reaching its verdict. Like the lint error it aborts the transaction
 * by throwing, and for the same reason: the only way to judge the revision an
 * import would create is to create it, so discarding it again is what makes the
 * rehearsal free of consequence.
 */
class ImportDryRunError extends Error {
  constructor(readonly health: DraftHealth) {
    super("import dry run complete");
    this.name = "ImportDryRunError";
  }
}

export interface ImportService {
  importSpec(input: ImportSpecInput): Promise<ImportResult>;
}

const importSpecIdentitySchema = z
  .object({
    projectPath: z.string().min(1),
    actor: actorProvenanceSchema,
  })
  .strict();

function refused(
  code: Refusal["code"],
  unmetConditions: string[],
  instruction: string,
  details?: Record<string, unknown>,
  findings?: unknown[],
): ImportResult {
  return {
    ok: false,
    refusal: {
      code,
      unmetConditions,
      instruction,
      ...(details === undefined ? {} : { details }),
      ...(findings === undefined ? {} : { findings }),
    },
  };
}

/**
 * Requirement refs the bundle declares more than once. A ref is the only
 * address a decision trace has, so a duplicate makes the trace ambiguous — and
 * resolving it silently to one of them would point the decision at a
 * requirement the author never chose.
 */
function duplicateRefs(bundle: ImportBundle): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const { ref } of bundle.requirements) {
    if (ref === undefined) continue;
    if (seen.has(ref)) duplicated.add(ref);
    seen.add(ref);
  }
  return [...duplicated];
}

/**
 * Bundle-local requirement refs a decision traces but the bundle never
 * declares. They are resolved from the bundle alone, before the first write, so
 * the refusal is decided without the spec ever existing (R1.2).
 */
function unresolvedTraces(bundle: ImportBundle): string[] {
  const declared = new Set(
    bundle.requirements.flatMap(({ ref }) => (ref === undefined ? [] : [ref])),
  );
  return [
    ...new Set(
      bundle.decisions.flatMap(({ traces }) =>
        traces.filter((ref) => !declared.has(ref)),
      ),
    ),
  ];
}

/** One bundle entry ready to be written, in the revision's global order. */
interface PlannedElement {
  readonly elementId: string;
  readonly kind: "section" | "requirement" | "criterion" | "decision";
  readonly parentRef: string | null;
  readonly payload: SpecElementPayload;
}

export function createImportService(deps: ImportServiceDeps): ImportService {
  const newId = deps.newId ?? ((prefix: string) => `${prefix}-${randomUUID()}`);
  const now = deps.now ?? (() => new Date().toISOString());

  /**
   * Lay the whole bundle out as element writes before the transaction opens.
   * Element ids are minted here rather than taken from the bundle: a bundle is
   * authored against an external document that has no notion of this system's
   * global element identity, and the handles readers address elements by come
   * from the counters, not from these ids.
   */
  function planElements(bundle: ImportBundle): {
    planned: PlannedElement[];
    elementIdByRef: Map<string, string>;
  } {
    const elementIdByRef = new Map<string, string>();
    const planned: PlannedElement[] = [];

    for (const section of bundle.sections) {
      planned.push({
        elementId: newId("element"),
        kind: "section",
        parentRef: null,
        payload: { kind: "section", ...section },
      });
    }

    for (const requirement of bundle.requirements) {
      const requirementElementId = newId("element");
      if (requirement.ref !== undefined) {
        elementIdByRef.set(requirement.ref, requirementElementId);
      }
      planned.push({
        elementId: requirementElementId,
        kind: "requirement",
        parentRef: null,
        payload: {
          kind: "requirement",
          statement: requirement.statement,
          priority: requirement.priority,
          risk: requirement.risk,
        },
      });
      for (const criterion of requirement.criteria) {
        planned.push({
          elementId: newId("element"),
          kind: "criterion",
          // Criterion parenting is positional in the bundle — a criterion is
          // written inside its requirement — so it resolves to the element id
          // this plan just minted rather than to a caller-supplied ref.
          parentRef: requirementElementId,
          payload: {
            kind: "criterion",
            text: criterion.text,
            validationStrategy: resolveImportedValidationStrategy(
              criterion.validationStrategy,
            ),
          },
        });
      }
    }

    for (const decision of bundle.decisions) {
      planned.push({
        elementId: newId("element"),
        kind: "decision",
        parentRef: null,
        payload: {
          kind: "decision",
          title: decision.title,
          chosenApproach: decision.chosenApproach,
          rejectedAlternatives: decision.rejectedAlternatives,
          reason: decision.reason,
          tracedRequirementElementIds: decision.traces.flatMap((ref) => {
            const elementId = elementIdByRef.get(ref);
            return elementId === undefined ? [] : [elementId];
          }),
        },
      });
    }

    return { planned, elementIdByRef };
  }

  function countBundle(bundle: ImportBundle): ImportCounts {
    return {
      sections: bundle.sections.length,
      requirements: bundle.requirements.length,
      criteria: bundle.requirements.reduce(
        (total, { criteria }) => total + criteria.length,
        0,
      ),
      decisions: bundle.decisions.length,
      questions: bundle.questions.length,
      assumptions: bundle.assumptions.length,
    };
  }

  function writeQuestions(
    bundle: ImportBundle,
    repo: SpecsRepoTransaction,
    specId: string,
    actor: ActorProvenance,
    occurredAt: string,
  ): void {
    for (const question of bundle.questions) {
      const answered = question.answer !== undefined;
      const row: SpecQuestionRow = {
        id: newId("question"),
        spec_id: specId,
        number: repo.allocateNumber(specId, "Q"),
        element_id: null,
        text: question.text,
        // The importing agent, never a human: an imported answer was written
        // in the external source, and attributing it to a human here would
        // claim an act on this surface that nobody performed.
        provenance_json: stableStringify(actor),
        record_version: 1,
        status: answered ? "answered" : "open",
        answer: question.answer ?? null,
        answered_at: answered ? occurredAt : null,
        withdrawn_at: null,
        created_at: occurredAt,
        updated_at: occurredAt,
      };
      const inserted = deps.review.insertQuestion(row);
      if (inserted.kind !== "success") {
        throw new Error(`import question identity conflict: ${row.id}`);
      }
      deps.events.appendDurableInTransaction({
        specId,
        occurredAt,
        actor,
        durableEventType: "spec-review-record-mutated",
        durablePayload: specReviewRecordMutatedEventPayloadSchema.parse({
          schemaVersion: 1,
          recordKind: "question",
          recordId: row.id,
          recordNumber: row.number,
          attentionId: row.id,
          operation: "imported",
          active: row.status === "open",
          before: null,
          after: questionAuditSnapshot(row),
        }),
      });
    }
  }

  function writeAssumptions(
    bundle: ImportBundle,
    repo: SpecsRepoTransaction,
    specId: string,
    actor: ActorProvenance,
    occurredAt: string,
  ): void {
    for (const assumption of bundle.assumptions) {
      // An omitted disposition is `proposed`, the same undecided state native
      // authoring opens an assumption in: the bundle stated nothing, so the
      // import must not invent a disposition nobody took.
      const disposition = assumption.disposition ?? "proposed";
      const row: SpecAssumptionRow = {
        id: newId("assumption"),
        spec_id: specId,
        number: repo.allocateNumber(specId, "A"),
        element_id: null,
        text: assumption.text,
        proposed_by_json: stableStringify(actor),
        record_version: 1,
        disposition,
        disposed_at:
          disposition === "proposed" || disposition === "withdrawn"
            ? null
            : occurredAt,
        withdrawn_at: disposition === "withdrawn" ? occurredAt : null,
        supersedes_assumption_id: null,
        supersession_operation_id: null,
        supersession_request_hash: null,
        created_at: occurredAt,
        updated_at: occurredAt,
      };
      const inserted = deps.review.insertAssumption(row);
      if (inserted.kind !== "success") {
        throw new Error(`import assumption identity conflict: ${row.id}`);
      }
      deps.events.appendDurableInTransaction({
        specId,
        occurredAt,
        actor,
        durableEventType: "spec-review-record-mutated",
        durablePayload: specReviewRecordMutatedEventPayloadSchema.parse({
          schemaVersion: 1,
          recordKind: "assumption",
          recordId: row.id,
          recordNumber: row.number,
          attentionId: row.id,
          operation: "imported",
          active: row.disposition === "proposed",
          before: null,
          after: assumptionAuditSnapshot(row, null),
        }),
      });
    }
  }

  /**
   * Gate admissions on the `import` basis. `approval_id` is null because no
   * approval backs them and none ever will: the row records how the revision
   * came to be past the gate, not that anyone answered it.
   */
  function writeAdmissions(
    specId: string,
    revisionId: string,
    actor: ActorProvenance,
    occurredAt: string,
  ): void {
    for (const gate of IMPORT_ADMITTED_GATES) {
      deps.review.insertGateAdmission({
        id: newId("admission"),
        spec_id: specId,
        gate,
        basis: "import",
        approval_id: null,
        revision_id: revisionId,
        execution_id: null,
        actor_json: stableStringify(actor),
        created_at: occurredAt,
      });
    }
  }

  return {
    async importSpec(input) {
      const identity = importSpecIdentitySchema.parse({
        projectPath: input.projectPath,
        actor: input.actor,
      });
      const parsedBundle = importBundleSchema.safeParse(input.bundle);
      if (!parsedBundle.success) {
        logger.warn("specs.import.refused", {
          projectPath: identity.projectPath,
          refusalCode: "validation",
        });
        return refused(
          "validation",
          parsedBundle.error.issues.map(
            (issue) =>
              `${issue.path.join(".") || "<bundle>"}: ${issue.message}`,
          ),
          "Correct the bundle against the published import bundle schema and retry the import.",
          { issues: parsedBundle.error.issues },
        );
      }
      const bundle = parsedBundle.data;

      const duplicated = duplicateRefs(bundle);
      if (duplicated.length > 0) {
        logger.warn("specs.import.refused", {
          projectPath: identity.projectPath,
          slug: bundle.slug,
          refusalCode: "validation",
        });
        return refused(
          "validation",
          duplicated.map(
            (ref) =>
              `More than one requirement declares the ref "${ref}", so a decision tracing it names no single requirement.`,
          ),
          `Give every requirement its own ref — ${duplicated.join(", ")} is declared twice — then retry the import.`,
          { duplicateRefs: duplicated },
        );
      }

      const dangling = unresolvedTraces(bundle);
      if (dangling.length > 0) {
        logger.warn("specs.import.refused", {
          projectPath: identity.projectPath,
          slug: bundle.slug,
          refusalCode: "dangling_reference",
        });
        return refused(
          "dangling_reference",
          dangling.map(
            (ref) =>
              `A decision traces "${ref}", which no requirement in this bundle declares as its ref.`,
          ),
          `Nothing was written. Declare ${dangling.join(", ")} as a requirement ref in the bundle, or drop the trace from the decision, then retry the import.`,
          { unresolvedTraces: dangling },
        );
      }

      const counts = countBundle(bundle);
      // The delivered claim rides on the imported criteria — every surface
      // reads the spec as delivered because each criterion does — so a bundle
      // with none has nothing to carry it. Refusing here, before the first
      // write, is what keeps the marking explicit: the alternative is importing
      // as approved and dropping a delivery the author claimed.
      if (bundle.delivered && counts.criteria === 0) {
        logger.warn("specs.import.refused", {
          projectPath: identity.projectPath,
          slug: bundle.slug,
          refusalCode: "validation",
        });
        return refused(
          "validation",
          [
            "The bundle marks the source as already delivered but declares no acceptance criterion for the delivery to be recorded against.",
          ],
          'Nothing was written. Give the bundle at least one requirement criterion, or set `"delivered": false` to import a criteria-less source as approved without claiming delivery, then retry the import.',
          { delivered: true, criteria: 0 },
        );
      }

      const occurredAt = now();
      const { planned } = planElements(bundle);

      const outcome = await deps.specs
        .transaction("specs.import", (repo) => {
          const existing = repo.resolve(identity.projectPath, bundle.slug);
          if (existing !== null) {
            // The one read of an existing spec this action performs, and the only
            // thing it can do with the answer is refuse. Import has no
            // continuation, revival, or amendment semantics — an abandoned spec
            // holding the slug refuses exactly like a live one.
            return {
              result: refused(
                "slug_taken",
                [
                  `spec slug "${bundle.slug}" already names "${existing.name}" (${existing.id}) in this project`,
                ],
                "Import creates new specs only. Choose an unused slug, or read the existing spec with `cctl spec show <slug>` and amend it through ordinary authoring.",
                { existingSpecId: existing.id, name: existing.name },
              ),
              prepared: null,
            };
          }

          const created = repo.create({
            spec: {
              id: newId("spec"),
              projectPath: identity.projectPath,
              slug: bundle.slug,
              name: bundle.name,
              gatePolicy: bundle.gatePolicy,
              createdAt: occurredAt,
              updatedAt: occurredAt,
            },
            initialRevision: {
              id: newId("revision"),
              // Born at design: an imported bundle carries intent and design
              // content together, so the revision it creates is the one an
              // amendment would fork from, not a requirements-stage draft.
              authoringStage: "design",
              createdAt: occurredAt,
            },
          });

          planned.forEach((element, position) => {
            repo.createDraftElement({
              id: element.elementId,
              specId: created.spec.id,
              revisionId: created.revision.id,
              kind: element.kind,
              parentElementId: element.parentRef,
              position,
              payload: element.payload,
              createdAt: occurredAt,
              updatedAt: occurredAt,
            });
          });

          // Questions and assumptions land before the lint gate, not after the
          // approval: they are content the propose-parity sweep reads, so an
          // import judged without them would be judged on a different spec than
          // the one it is about to approve.
          writeQuestions(
            bundle,
            repo,
            created.spec.id,
            identity.actor,
            occurredAt,
          );
          writeAssumptions(
            bundle,
            repo,
            created.spec.id,
            identity.actor,
            occurredAt,
          );

          // The propose-parity gate (R1.2). An import is a propose and an
          // approval collapsed into one act, so it owes the same lint an
          // authored propose owes — evaluated through the shared projection, so
          // `cctl spec lint`, the propose refusal, and this one cannot disagree
          // about what blocks. A blocking finding throws, and the throw is what
          // discards every row written above.
          const draftSnapshot = repo.getRevisionSnapshot(created.revision.id);
          if (draftSnapshot === null) {
            throw new Error(
              `imported revision ${created.revision.id} has no snapshot to lint`,
            );
          }
          const loaded = loadProposalState(
            repo,
            deps.review,
            deps.links,
            created.spec,
            draftSnapshot,
          );
          const health = draftHealth(lint(loaded.draft, loaded.records));
          // A dry run stops here and reports the verdict rather than acting on
          // it: refusing on a blocking finding would withhold the preview at
          // the one moment the agent is still fixing the bundle and most needs
          // to see the numbering its cross-references will use. `blocking`
          // carries what the real import would do with the same findings.
          if (bundle.dryRun) throw new ImportDryRunError(health);
          if (health.blocking > 0) {
            throw new ImportLintBlockedError(
              health.blockingFindings,
              health.ordered,
            );
          }

          // Propose then approve, through the same statements ordinary authoring
          // uses: propose is what computes the content hash the approval is
          // pinned to, so an imported revision hashes exactly like an authored
          // one and every integrity check reads it the same way.
          repo.proposeRevision({
            revisionId: created.revision.id,
            proposedAt: occurredAt,
          });
          const approved = repo.approveRevision({
            revisionId: created.revision.id,
            approvedAt: occurredAt,
          });
          // Testimony that the source shipped before this import, written in
          // the same transaction as the content it is about and pinned to this
          // revision: an amendment forks a revision carrying no record, so the
          // claim cannot outlive the content it was made about. It discharges
          // no gate — the delivery gate never reads it.
          const revision = bundle.delivered
            ? repo.recordExternalDelivery({
                revisionId: approved.id,
                externalDelivery: {
                  at: occurredAt,
                  actor: identity.actor,
                  source: bundle.source,
                },
              })
            : approved;

          writeAdmissions(
            created.spec.id,
            revision.id,
            identity.actor,
            occurredAt,
          );

          return {
            result: {
              ok: true as const,
              dryRun: false as const,
              value: { spec: created.spec, revision, counts },
            },
            prepared: deps.events.appendInTransaction({
              actor: identity.actor,
              durableEventType: "spec_imported",
              durablePayload: {
                source: bundle.source,
                revisionId: revision.id,
                counts,
              },
              sseEvent: {
                type: "spec-changed",
                kind: "spec-imported",
                projectPath: created.spec.projectPath,
                specId: created.spec.id,
                specSlug: created.spec.slug,
                occurredAt,
                revisionId: revision.id,
              },
            }) satisfies PreparedSpecEventPublication,
          };
        })
        .catch(
          (
            error: unknown,
          ): {
            result: ImportResult;
            prepared: PreparedSpecEventPublication | null;
          } => {
            // The transaction has already rolled back by the time this runs, so
            // both outcomes are built out here: nothing either one says can reach
            // the database.
            if (error instanceof ImportDryRunError) {
              return {
                result: {
                  ok: true,
                  dryRun: true,
                  preview: {
                    counts,
                    handles: previewImportHandles(bundle),
                    findings: error.health.ordered,
                    blocking: error.health.blocking,
                  },
                },
                prepared: null,
              };
            }
            if (!(error instanceof ImportLintBlockedError)) throw error;
            return {
              result: refused(
                "lint_blocked",
                error.blockingFindings.map((finding) => finding.message),
                `Nothing was imported. Resolve every blocking finding in the bundle — an import is a propose and an approval in one act, so it owes the same lint an authored propose owes — then retry \`cctl spec import\`.`,
                { findingCount: error.orderedFindings.length },
                [...error.orderedFindings],
              ),
              prepared: null,
            };
          },
        );

      if (!outcome.result.ok) {
        logger.warn("specs.import.refused", {
          projectPath: identity.projectPath,
          slug: bundle.slug,
          refusalCode: outcome.result.refusal.code,
        });
        return outcome.result;
      }
      if (outcome.result.dryRun) {
        logger.info("specs.import.dry_run", {
          projectPath: identity.projectPath,
          slug: bundle.slug,
          sourceLabel: bundle.source.label,
          blockingFindings: outcome.result.preview.blocking,
          findingCount: outcome.result.preview.findings.length,
          ...counts,
        });
        return outcome.result;
      }
      if (outcome.prepared !== null) {
        deps.events.publishAfterCommit(outcome.prepared);
      }
      logger.info("specs.import.complete", {
        projectPath: identity.projectPath,
        specId: outcome.result.value.spec.id,
        revisionId: outcome.result.value.revision.id,
        sourceLabel: bundle.source.label,
        ...counts,
      });
      return outcome.result;
    },
  };
}
