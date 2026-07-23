import {
  specAuthoringStageSchema,
  specElementKindSchema,
  specElementPayloadSchema,
} from "@/lib/specs/schemas";
import {
  computeSpecRevisionContentHashFromCanonical,
  type CanonicalSpecRevisionElement,
} from "../specs-repo";
import type { StateMigration } from "./types";

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

function hasAuthoringStageColumn(
  columns: readonly { name: string }[],
): boolean {
  return columns.some((column) => column.name === "authoring_stage");
}

function parseCanonicalElement(
  row: CanonicalElementRow,
): CanonicalSpecRevisionElement {
  return {
    elementId: row.element_id,
    kind: specElementKindSchema.parse(row.kind),
    number: row.number,
    parentElementId: row.parent_element_id,
    position: row.position,
    payload: specElementPayloadSchema.parse(JSON.parse(row.payload_json)),
  };
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
        const authoringStage = specAuthoringStageSchema.parse(
          revision.authoring_stage,
        );
        const elements = (
          elementRows.all(revision.id) as CanonicalElementRow[]
        ).map(parseCanonicalElement);
        updateHash.run(
          computeSpecRevisionContentHashFromCanonical(authoringStage, elements),
          revision.id,
        );
      }
    });
    migrate.immediate();
  },
};
