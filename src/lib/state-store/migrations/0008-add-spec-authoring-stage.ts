import { createHash } from "node:crypto";
import { z } from "zod";
import { stableStringify } from "../serialization";
import type { StateMigration } from "./types";

/**
 * FROZEN vocabulary — migration-local copies of the spec payload schemas
 * exactly as they stood when 0008 shipped (six evidence kinds, unconstrained
 * strategy kind list). This migration originally imported the live
 * `specElementPayloadSchema`; migration 0009 narrows that schema, which would
 * make 0008 itself throw on a legacy dropped-kind row in any pre-0008
 * database migrating through the chain — before 0009 can repair it. Frozen
 * code produces identical hashes for identical bytes, so recorded behavior is
 * unchanged for every database that already ran this migration.
 */
const frozenAuthoringStageSchema = z.enum(["requirements", "design", "plan"]);

const frozenElementKindSchema = z.enum([
  "section",
  "requirement",
  "criterion",
  "decision",
  "task",
]);

const frozenEvidenceKindSchema = z.enum([
  "diff",
  "commit",
  "test_run",
  "validator_verdict",
  "screenshot",
  "human_signoff",
]);

const frozenValidationStrategySchema = z
  .object({
    kinds: z.array(frozenEvidenceKindSchema),
    note: z.string().optional(),
  })
  .strict();

const frozenTouchedPathSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    const segments = value.split("/");
    const invalid =
      value !== value.trim() ||
      value.startsWith("/") ||
      /^[A-Za-z]:/.test(value) ||
      value.includes("\\") ||
      value.endsWith("/") ||
      segments.some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      );
    if (invalid) {
      ctx.addIssue({
        code: "custom",
        message:
          "touched paths must be normalized repo-relative POSIX paths without parent segments or trailing separators",
      });
    }
  });

const frozenElementPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("section"),
      role: z.enum([
        "intent_problem",
        "intent_outcomes",
        "intent_non_goals",
        "intent_success_measures",
        "intent_constraints",
        "design_narrative",
        "context",
      ]),
      title: z.string(),
      body: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("requirement"),
      statement: z.string(),
      priority: z.enum(["must", "should", "could"]),
      risk: z.enum(["high", "medium", "low"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("criterion"),
      text: z.string(),
      validationStrategy: frozenValidationStrategySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("decision"),
      title: z.string(),
      chosenApproach: z.string(),
      rejectedAlternatives: z.array(
        z.object({ label: z.string(), reason: z.string() }).strict(),
      ),
      reason: z.string(),
      tracedRequirementElementIds: z.array(z.string().min(1)),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task"),
      title: z.string(),
      instructions: z.string(),
      tracedRequirementElementIds: z.array(z.string().min(1)),
      tracedDecisionElementIds: z.array(z.string().min(1)),
      coveredCriterionElementIds: z.array(z.string().min(1)),
      dependsOnTaskElementIds: z.array(z.string().min(1)),
      laneGroup: z.string().min(1).optional(),
      touchedPaths: z.array(frozenTouchedPathSchema).optional(),
    })
    .strict(),
]);

interface FrozenRevisionRow {
  id: string;
  authoring_stage: string;
}

interface CanonicalElementRow {
  element_id: string;
  kind: string;
  number: number | null;
  parent_element_id: string | null;
  position: number;
  payload_json: string;
}

interface FrozenCanonicalElement {
  elementId: string;
  kind: z.infer<typeof frozenElementKindSchema>;
  number: number | null;
  parentElementId: string | null;
  position: number;
  payload: z.infer<typeof frozenElementPayloadSchema>;
}

function hasAuthoringStageColumn(
  columns: readonly { name: string }[],
): boolean {
  return columns.some((column) => column.name === "authoring_stage");
}

function parseCanonicalElement(
  row: CanonicalElementRow,
): FrozenCanonicalElement {
  return {
    elementId: row.element_id,
    kind: frozenElementKindSchema.parse(row.kind),
    number: row.number,
    parentElementId: row.parent_element_id,
    position: row.position,
    payload: frozenElementPayloadSchema.parse(JSON.parse(row.payload_json)),
  };
}

/**
 * Frozen byte-identical copy of the live
 * `computeSpecRevisionContentHashFromCanonical`: the live function's payload
 * type narrows with the vocabulary, so a frozen migration cannot call it over
 * frozen payloads without a cast. The hash contract is bytes
 * (`sha256(stableStringify({authoringStage, elements}))`); the migration test
 * proves the recomputed hashes verify through the live repository.
 */
function frozenRevisionContentHash(
  authoringStage: z.infer<typeof frozenAuthoringStageSchema>,
  elements: readonly FrozenCanonicalElement[],
): string {
  return createHash("sha256")
    .update(stableStringify({ authoringStage, elements }))
    .digest("hex");
}

export const addSpecAuthoringStage: StateMigration = {
  name: "0008-add-spec-authoring-stage",
  up: async ({ context }) => {
    const { db } = context;
    const migrate = db.transaction(() => {
      const columns = db.pragma("table_info(spec_revisions)") as Array<{
        name: string;
      }>;
      if (!hasAuthoringStageColumn(columns)) {
        db.exec(
          "ALTER TABLE spec_revisions ADD COLUMN authoring_stage TEXT NOT NULL DEFAULT 'plan' CHECK (authoring_stage IN ('requirements', 'design', 'plan'))",
        );
      }

      const revisions = db
        .prepare(
          `SELECT id, authoring_stage
           FROM spec_revisions
           WHERE content_hash IS NOT NULL
           ORDER BY id ASC`,
        )
        .all() as FrozenRevisionRow[];
      const elementRows = db.prepare(
        `SELECT
           e.id AS element_id,
           e.kind AS kind,
           e.number AS number,
           e.parent_element_id AS parent_element_id,
           v.position AS position,
           v.payload_json AS payload_json
         FROM spec_element_versions v
         JOIN spec_elements e ON e.id = v.element_id
         WHERE v.revision_id = ?
         ORDER BY v.position ASC, e.id ASC`,
      );
      const updateHash = db.prepare(
        "UPDATE spec_revisions SET content_hash = ? WHERE id = ?",
      );

      for (const revision of revisions) {
        const authoringStage = frozenAuthoringStageSchema.parse(
          revision.authoring_stage,
        );
        const elements = (
          elementRows.all(revision.id) as CanonicalElementRow[]
        ).map(parseCanonicalElement);
        updateHash.run(
          frozenRevisionContentHash(authoringStage, elements),
          revision.id,
        );
      }
    });
    migrate.immediate();
  },
};
