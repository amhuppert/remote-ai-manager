import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { stableStringify } from "../serialization";
import { addSpecAuthoringStage } from "./0008-add-spec-authoring-stage";

const PROJECT_PATH = "/repos/command-center";
const CREATED_AT = "2026-07-22T12:00:00.000Z";

let fixture: PersistenceFixture | null = null;

afterEach(() => {
  fixture?.close();
  fixture = null;
});

async function runMigration(): Promise<void> {
  if (fixture === null) throw new Error("fixture is unavailable");
  await addSpecAuthoringStage.up({
    name: addSpecAuthoringStage.name,
    context: { db: fixture.db, configDir: null },
  });
}

describe("0008-add-spec-authoring-stage", () => {
  it("rehashes legacy frozen revisions after backfilling them to plan stage", async () => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    const created = await fixture.specs.create({
      spec: {
        id: "spec-1",
        projectPath: PROJECT_PATH,
        slug: "native-sdd",
        name: "Native SDD",
        gatePolicy: { preset: "contract-bearing" },
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
      initialRevision: {
        id: "revision-1",
        authoringStage: "plan",
        createdAt: CREATED_AT,
      },
    });
    await fixture.specs.createDraftElement({
      id: "requirement-1",
      specId: created.spec.id,
      revisionId: created.revision.id,
      kind: "requirement",
      parentElementId: null,
      position: 0,
      payload: {
        kind: "requirement",
        statement: "Legacy revisions remain verifiable.",
        priority: "must",
        risk: "high",
      },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    await fixture.specs.proposeRevision({
      revisionId: created.revision.id,
      proposedAt: CREATED_AT,
    });
    const snapshot = await fixture.specs.getRevisionSnapshot(
      created.revision.id,
    );
    if (snapshot === null) throw new Error("snapshot is unavailable");
    const legacyCanonical = snapshot.elements.map(({ element, version }) => ({
      elementId: element.id,
      kind: element.kind,
      number: element.number,
      parentElementId: element.parentElementId,
      position: version.position,
      payload: version.payload,
    }));
    const legacyHash = createHash("sha256")
      .update(stableStringify(legacyCanonical))
      .digest("hex");
    fixture.db
      .prepare("UPDATE spec_revisions SET content_hash = ? WHERE id = ?")
      .run(legacyHash, created.revision.id);

    expect((await fixture.specs.verifyRevision(created.revision.id)).ok).toBe(
      false,
    );

    await runMigration();
    await runMigration();

    expect(await fixture.specs.findRevision(created.revision.id)).toMatchObject(
      {
        authoringStage: "plan",
      },
    );
    await expect(
      fixture.specs.verifyRevision(created.revision.id),
    ).resolves.toMatchObject({ ok: true });
  });
});
