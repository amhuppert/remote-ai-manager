import type Database from "better-sqlite3";
import {
  specLinkRowSchema,
  type SpecLinkObjectKind,
  type SpecLinkRow,
} from "@/lib/specs/schemas";
import { createSpecRepoHelpers } from "./spec-repo-helpers";

type Db = InstanceType<typeof Database>;

const { parseRow, readMany, readOne, timed } = createSpecRepoHelpers(
  "state-store.spec-links",
);

export interface SpecLinksRepo {
  insertLink(link: SpecLinkRow): void;
  updateLinkSnapshot(linkId: string, snapshotJson: string): void;
  findLinkById(id: string): SpecLinkRow | null;
  findBySpecId(specId: string): SpecLinkRow[];
  findByLinkedObject(
    objectKind: SpecLinkObjectKind,
    objectRefJson: string,
  ): SpecLinkRow[];
}

export function createSpecLinksRepo(db: Db): SpecLinksRepo {
  const insertLinkStmt = db.prepare(
    `INSERT INTO spec_links (
       id, spec_id, object_kind, object_ref_json, direction, category,
       snapshot_json, element_ids_json, actor_json, created_at
     ) VALUES (
       @id, @spec_id, @object_kind, @object_ref_json, @direction, @category,
       @snapshot_json, @element_ids_json, @actor_json, @created_at
     )`,
  );
  const findLinkStmt = db.prepare(
    "SELECT * FROM spec_links WHERE id = ? LIMIT 1",
  );
  const updateLinkSnapshotStmt = db.prepare(
    "UPDATE spec_links SET snapshot_json = ? WHERE id = ?",
  );
  const findBySpecStmt = db.prepare(
    `SELECT * FROM spec_links
     WHERE spec_id = ?
     ORDER BY created_at ASC, id ASC`,
  );
  const findByLinkedObjectStmt = db.prepare(
    `SELECT * FROM spec_links
     WHERE object_kind = ? AND object_ref_json = ?
     ORDER BY created_at ASC, id ASC`,
  );

  return {
    insertLink(link) {
      timed("insert", "spec_link", link.id, () => {
        insertLinkStmt.run(
          parseRow(specLinkRowSchema, "spec_link", link.id, link),
        );
      });
    },
    updateLinkSnapshot(linkId, snapshotJson) {
      timed("update_snapshot", "spec_link", linkId, () => {
        const result = updateLinkSnapshotStmt.run(snapshotJson, linkId);
        if (result.changes !== 1) {
          throw new Error(`spec link ${linkId} not found`);
        }
      });
    },
    findLinkById(id) {
      return timed("find_by_id", "spec_link", id, () =>
        readOne(specLinkRowSchema, "spec_link", id, () => findLinkStmt.get(id)),
      );
    },
    findBySpecId(specId) {
      return timed("find_by_spec", "spec_link", specId, () =>
        readMany(specLinkRowSchema, "spec_link", `spec:${specId}`, () =>
          findBySpecStmt.all(specId),
        ),
      );
    },
    findByLinkedObject(objectKind, objectRefJson) {
      const identifier = `${objectKind}:${objectRefJson}`;
      return timed("find_by_linked_object", "spec_link", identifier, () =>
        readMany(specLinkRowSchema, "spec_link", identifier, () =>
          findByLinkedObjectStmt.all(objectKind, objectRefJson),
        ),
      );
    },
  };
}
