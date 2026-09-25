import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  specAliasSchema,
  specCounterSchema,
  specElementSchema,
  specElementVersionSchema,
  specRevisionSchema,
  specSchema,
  type SpecAssumptionCitationSnapshot,
  type CriterionElementPayload,
  type RequirementElementPayload,
  type Spec,
  type SpecElementPayload,
  type TaskElementPayload,
} from "@/lib/specs/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { stableStringify } from "./serialization";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  computeSpecRevisionContentHash,
  SpecElementIdTakenError,
  SpecRevisionImmutableError,
  StaleElementConflictError,
  StaleStageConflictError,
  type SpecsRepo,
} from "./specs-repo";

const PROJECT_PATH = "/repos/command-center";
const CREATED_AT = "2026-07-18T10:11:12.000Z";
const UPDATED_AT = "2026-07-18T11:12:13.000Z";
const PROPOSED_AT = "2026-07-18T12:13:14.000Z";
const APPROVED_AT = "2026-07-18T13:14:15.000Z";

let fixture: PersistenceFixture;
let repo: SpecsRepo;
let sequence = 0;

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  repo = fixture.specs;
  sequence = 0;
});

afterEach(() => {
  fixture.close();
});

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

function requireFixtureString(value: string | null, field: string): string {
  if (value === null) throw new Error(`maximal fixture requires ${field}`);
  return value;
}

async function createSpec(
  overrides: Partial<Pick<Spec, "id" | "slug" | "name">> = {},
) {
  const id = overrides.id ?? nextId("spec");
  return repo.create({
    spec: {
      id,
      projectPath: PROJECT_PATH,
      slug: overrides.slug ?? `spec-${sequence}`,
      name: overrides.name ?? "Native SDD",
      gatePolicy: {
        preset: "contract-bearing",
        overrides: { delivery: "notify" },
      },
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    },
    initialRevision: {
      id: `${id}-revision-1`,
      authoringStage: "requirements",
      createdAt: CREATED_AT,
    },
  });
}

function requirementPayload(statement: string): RequirementElementPayload {
  return {
    kind: "requirement",
    statement,
    priority: "must",
    risk: "high",
  };
}

function criterionPayload(text: string): CriterionElementPayload {
  return {
    kind: "criterion",
    text,
    validationStrategy: {
      kinds: ["test_run", "validator_verdict"],
      note: "Run the repository contract tests.",
    },
  };
}

function maximalTaskPayload(): TaskElementPayload {
  return {
    kind: "task",
    title: "Persist the complete task contract",
    instructions: "Round-trip every task payload field.",
    tracedRequirementElementIds: ["requirement-maximal"],
    tracedDecisionElementIds: ["decision-maximal"],
    coveredCriterionElementIds: ["criterion-maximal"],
    dependsOnTaskElementIds: ["task-prerequisite"],
    laneGroup: "persistence",
    executionLane: "persistence-lane",
    touchedPaths: ["src/lib/specs", "src/lib/state-store"],
  };
}

function seedAssumption(input: {
  id: string;
  specId: string;
  number: number;
  elementId: string | null;
  text?: string;
}): SpecAssumptionCitationSnapshot {
  const text = input.text ?? `Premise ${input.number}`;
  const actor = {
    kind: "agent" as const,
    conversationId: "conversation-citation-contract",
  };
  fixture.db
    .prepare(
      `INSERT INTO spec_assumptions (
         id, spec_id, number, element_id, text, proposed_by_json,
         record_version, disposition, disposed_at, withdrawn_at,
         supersedes_assumption_id, supersession_operation_id,
         supersession_request_hash, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, 'proposed', NULL, NULL, NULL, NULL,
                 NULL, ?, ?)`,
    )
    .run(
      input.id,
      input.specId,
      input.number,
      input.elementId,
      text,
      stableStringify(actor),
      CREATED_AT,
      CREATED_AT,
    );
  return {
    schemaVersion: 1,
    captureKind: "native",
    capturedAt: UPDATED_AT,
    assumptionId: input.id,
    number: input.number,
    recordVersion: 1,
    text,
    elementId: input.elementId,
    proposedBy: actor,
    disposition: "proposed",
    disposedAt: null,
    withdrawnAt: null,
    supersedesAssumptionId: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function citationHash(
  contractVersion: 1 | 2,
  citations: ReadonlyArray<{
    elementId: string;
    assumptionId: string;
    snapshot: SpecAssumptionCitationSnapshot;
  }>,
): string {
  return createHash("sha256")
    .update(
      stableStringify({
        citationContractVersion: contractVersion,
        citations: citations.map(({ elementId, assumptionId, snapshot }) => ({
          elementId,
          assumptionId,
          snapshot,
        })),
      }),
    )
    .digest("hex");
}

async function addRequirement(
  specId: string,
  revisionId: string,
  statement = "The server enforces every lifecycle gate.",
) {
  return repo.createDraftElement({
    id: nextId("requirement"),
    specId,
    revisionId,
    kind: "requirement",
    parentElementId: null,
    position: 0,
    payload: requirementPayload(statement),
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  });
}

async function addCriterion(
  specId: string,
  revisionId: string,
  parentElementId: string,
  text = "A transition without approval is refused.",
  position = 1,
) {
  return repo.createDraftElement({
    id: nextId("criterion"),
    specId,
    revisionId,
    kind: "criterion",
    parentElementId,
    position,
    payload: criterionPayload(text),
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  });
}

describe("maximal persistence contracts", () => {
  it("round-trips every persisted spec field", async () => {
    await assertRoundTripDurability({
      label: "specs",
      schema: specSchema,
      buildMaximalFixture: () =>
        specSchema.parse({
          id: "spec-maximal",
          projectPath: PROJECT_PATH,
          slug: "native-sdd",
          name: "Native spec-driven development",
          gatePolicy: {
            preset: "exploratory",
            overrides: {
              requirements: "gate",
              delivery: "notify",
            },
          },
          abandonedAt: APPROVED_AT,
          abandonedReason: "The product direction changed.",
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
        }),
      persist: async (maximal) => {
        await repo.create({
          spec: {
            id: maximal.id,
            projectPath: maximal.projectPath,
            slug: maximal.slug,
            name: maximal.name,
            gatePolicy: maximal.gatePolicy,
            createdAt: maximal.createdAt,
            updatedAt: maximal.createdAt,
          },
          initialRevision: {
            id: "revision-for-maximal-spec",
            authoringStage: "requirements",
            createdAt: maximal.createdAt,
          },
        });
        return repo.abandon({
          specId: maximal.id,
          abandonedAt: requireFixtureString(maximal.abandonedAt, "abandonedAt"),
          reason: requireFixtureString(
            maximal.abandonedReason,
            "abandonedReason",
          ),
          updatedAt: maximal.updatedAt,
        });
      },
      reload: (expected) => repo.findById(expected.id),
      fieldPolicies: {},
    });
  });

  it("round-trips every persisted alias field through rename", async () => {
    const created = await createSpec({
      id: "spec-alias-maximal",
      slug: "old-native-sdd",
    });

    await assertRoundTripDurability({
      label: "spec-aliases",
      schema: specAliasSchema,
      buildMaximalFixture: () =>
        specAliasSchema.parse({
          projectPath: PROJECT_PATH,
          slug: "old-native-sdd",
          specId: created.spec.id,
          createdAt: PROPOSED_AT,
        }),
      persist: async (maximal) => {
        const renamed = await repo.rename({
          specId: maximal.specId,
          slug: "native-sdd",
          name: "Native SDD renamed",
          updatedAt: UPDATED_AT,
          aliasCreatedAt: maximal.createdAt,
        });
        return renamed.alias;
      },
      reload: async (expected) =>
        (await repo.listAliases(expected.specId)).find(
          (alias) => alias.slug === expected.slug,
        ) ?? null,
      fieldPolicies: {},
    });
  });

  it("round-trips every persisted counter field", async () => {
    const created = await createSpec({ id: "spec-counter-maximal" });

    await assertRoundTripDurability({
      label: "spec-counters",
      schema: specCounterSchema,
      buildMaximalFixture: () =>
        specCounterSchema.parse({
          specId: created.spec.id,
          scopeKey: "C:requirement-maximal",
          lastNumber: 7,
        }),
      persist: async (maximal) => {
        for (let index = 0; index < maximal.lastNumber; index += 1) {
          await repo.allocateNumber(maximal.specId, maximal.scopeKey);
        }
        const persisted = await repo.findCounter(
          maximal.specId,
          maximal.scopeKey,
        );
        if (!persisted) throw new Error("counter was not persisted");
        return persisted;
      },
      reload: (expected) =>
        repo.findCounter(expected.specId, expected.scopeKey),
      fieldPolicies: {},
    });
  });

  it("round-trips every persisted element field with criterion identity nested under its requirement", async () => {
    const created = await createSpec({ id: "spec-element-maximal" });
    const parent = await addRequirement(created.spec.id, created.revision.id);

    await assertRoundTripDurability({
      label: "spec-elements",
      schema: specElementSchema,
      buildMaximalFixture: () =>
        specElementSchema.parse({
          id: "criterion-maximal",
          specId: created.spec.id,
          kind: "criterion",
          number: 1,
          parentElementId: parent.element.id,
          createdAt: PROPOSED_AT,
        }),
      persist: async (maximal) => {
        const persisted = await repo.createDraftElement({
          id: maximal.id,
          specId: maximal.specId,
          revisionId: created.revision.id,
          kind: maximal.kind,
          parentElementId: maximal.parentElementId,
          position: 1,
          payload: criterionPayload("A maximal criterion payload."),
          createdAt: maximal.createdAt,
          updatedAt: UPDATED_AT,
        });
        return persisted.element;
      },
      reload: (expected) => repo.findElement(expected.id),
      fieldPolicies: { number: "derived-on-write" },
    });
  });

  it("round-trips every persisted revision field through draft and approval", async () => {
    const created = await createSpec({ id: "spec-revision-maximal" });
    await addRequirement(created.spec.id, created.revision.id);
    await repo.approveRevision({
      revisionId: created.revision.id,
      approvedAt: APPROVED_AT,
    });

    await assertRoundTripDurability({
      label: "spec-revisions",
      schema: specRevisionSchema,
      buildMaximalFixture: () =>
        specRevisionSchema.parse({
          id: "revision-maximal",
          specId: created.spec.id,
          number: 2,
          state: "approved",
          authoringStage: "design",
          basedOnRevisionId: created.revision.id,
          contentHash: "derived-by-approval",
          citationContractVersion: 2,
          citationVersion: 1,
          citationHash: citationHash(2, []),
          proposedAt: APPROVED_AT,
          approvedAt: APPROVED_AT,
          externalDelivery: {
            at: APPROVED_AT,
            actor: { kind: "agent", conversationId: "conversation-import" },
            source: { label: "kiro:.kiro/specs/native-sdd" },
          },
          createdAt: UPDATED_AT,
        }),
      persist: async (maximal) => {
        await repo.createDraftFromBase({
          id: maximal.id,
          specId: maximal.specId,
          baseRevisionId: requireFixtureString(
            maximal.basedOnRevisionId,
            "basedOnRevisionId",
          ),
          authoringStage: maximal.authoringStage,
          createdAt: maximal.createdAt,
        });
        await repo.approveRevision({
          revisionId: maximal.id,
          approvedAt: requireFixtureString(maximal.approvedAt, "approvedAt"),
        });
        if (maximal.externalDelivery === null) {
          throw new Error("maximal fixture requires externalDelivery");
        }
        return repo.recordExternalDelivery({
          revisionId: maximal.id,
          externalDelivery: maximal.externalDelivery,
        });
      },
      reload: (expected) => repo.findRevision(expected.id),
      // Approval is the freeze: it hashes the content and records the moment
      // the content froze as `proposedAt`, so neither is written from input.
      fieldPolicies: {
        contentHash: "derived-on-write",
        proposedAt: "derived-on-write",
      },
    });
  });

  it("reloads an ordinarily-authored revision with no external-delivery record", async () => {
    const created = await createSpec({ id: "spec-revision-no-external" });

    const reloaded = await repo.findRevision(created.revision.id);

    // Null is the meaningful value for every revision this system authored:
    // external delivery is a claim only an import can make, and a missing
    // column value must never read back as an empty record that looks like one.
    expect(reloaded?.externalDelivery).toBeNull();
  });

  it("refuses to persist an external-delivery claim dated in free text", async () => {
    const created = await createSpec({ id: "spec-revision-bad-date" });

    // The write path validates, not just the schema in isolation: an
    // unparseable date reaching the column would be durable forever, and no
    // later reader could order it against this system's own timestamps.
    await expect(
      repo.recordExternalDelivery({
        revisionId: created.revision.id,
        externalDelivery: {
          at: "not-an-iso-timestamp",
          actor: { kind: "human" },
          source: { label: "kiro:.kiro/specs/imported-feature" },
        },
      }),
    ).rejects.toThrow();
    expect(
      (await repo.findRevision(created.revision.id))?.externalDelivery,
    ).toBeNull();
  });

  it("round-trips every persisted element-version field", async () => {
    const created = await createSpec({ id: "spec-version-maximal" });

    await assertRoundTripDurability({
      label: "spec-element-versions",
      schema: specElementVersionSchema,
      buildMaximalFixture: () =>
        specElementVersionSchema.parse({
          revisionId: created.revision.id,
          elementId: "task-version-maximal",
          position: 7,
          payload: maximalTaskPayload(),
          payloadHash: "derived-from-payload",
          elementVersion: 1,
          createdAt: PROPOSED_AT,
          updatedAt: UPDATED_AT,
        }),
      persist: async (maximal) => {
        const persisted = await repo.createDraftElement({
          id: maximal.elementId,
          specId: created.spec.id,
          revisionId: maximal.revisionId,
          kind: "task",
          parentElementId: null,
          position: maximal.position,
          payload: maximal.payload,
          createdAt: maximal.createdAt,
          updatedAt: maximal.updatedAt,
        });
        return persisted.version;
      },
      reload: (expected) =>
        repo.findElementVersion(expected.revisionId, expected.elementId),
      fieldPolicies: { payloadHash: "derived-on-write" },
    });
  });

  it("round-trips every persisted criterion validation-strategy field", async () => {
    // The task round trip above never exercises `validationStrategy`; this
    // block keeps every strategy field (full surviving kind list plus note)
    // contract-backed, since migration 0009 rewrites exactly these bytes.
    const created = await createSpec({ id: "spec-criterion-maximal" });
    const requirement = await addRequirement(
      created.spec.id,
      created.revision.id,
    );

    await assertRoundTripDurability({
      label: "spec-element-versions (criterion strategy)",
      schema: specElementVersionSchema,
      buildMaximalFixture: () =>
        specElementVersionSchema.parse({
          revisionId: created.revision.id,
          elementId: "criterion-version-maximal",
          position: 3,
          payload: {
            kind: "criterion",
            text: "Every persisted strategy field survives a reload.",
            validationStrategy: {
              kinds: ["commit", "test_run", "validator_verdict"],
              note: "Run the full contract suite before granting proof.",
            },
          } satisfies CriterionElementPayload,
          payloadHash: "derived-from-payload",
          elementVersion: 1,
          createdAt: PROPOSED_AT,
          updatedAt: UPDATED_AT,
        }),
      persist: async (maximal) => {
        const persisted = await repo.createDraftElement({
          id: maximal.elementId,
          specId: created.spec.id,
          revisionId: maximal.revisionId,
          kind: "criterion",
          parentElementId: requirement.element.id,
          position: maximal.position,
          payload: maximal.payload,
          createdAt: maximal.createdAt,
          updatedAt: maximal.updatedAt,
        });
        return persisted.version;
      },
      reload: (expected) =>
        repo.findElementVersion(expected.revisionId, expected.elementId),
      fieldPolicies: { payloadHash: "derived-on-write" },
    });
  });
});

describe("revision snapshots and aliases", () => {
  it("withdraws an open authoring draft without erasing its snapshot", async () => {
    const created = await createSpec();
    const requirement = await addRequirement(
      created.spec.id,
      created.revision.id,
    );

    const withdrawn = await repo.withdrawAuthoringRevision({
      revisionId: created.revision.id,
    });

    expect(withdrawn.state).toBe("withdrawn");
    expect(withdrawn.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(withdrawn.proposedAt).toBeNull();
    expect(await repo.findDraft(created.spec.id)).toBeNull();
    expect(
      (await repo.getRevisionSnapshot(withdrawn.id))?.elements.map(
        ({ element }) => element.id,
      ),
    ).toEqual([requirement.element.id]);
  });

  it("refuses to withdraw an approved revision and leaves it approved", async () => {
    const created = await createSpec();
    await addRequirement(created.spec.id, created.revision.id);
    const approved = await repo.approveRevision({
      revisionId: created.revision.id,
      approvedAt: APPROVED_AT,
    });

    await expect(
      repo.withdrawAuthoringRevision({ revisionId: created.revision.id }),
    ).rejects.toThrow();
    expect(await repo.findRevision(created.revision.id)).toEqual(approved);
  });

  it("advances the identified draft stage conditionally and is idempotent", async () => {
    const created = await createSpec();

    const advanced = await repo.advanceDraftAuthoringStage({
      specId: created.spec.id,
      revisionId: created.revision.id,
      expectedStage: "requirements",
      targetStage: "design",
    });
    const replay = await repo.advanceDraftAuthoringStage({
      specId: created.spec.id,
      revisionId: created.revision.id,
      expectedStage: "requirements",
      targetStage: "design",
    });

    expect(advanced.authoringStage).toBe("design");
    expect(replay).toEqual(advanced);
  });

  it("returns a typed stale-stage conflict when the current draft was replaced", async () => {
    const created = await createSpec();
    await repo.withdrawAuthoringRevision({ revisionId: created.revision.id });
    const replacement = await repo.createDraftFromBase({
      id: "replacement-revision",
      specId: created.spec.id,
      baseRevisionId: created.revision.id,
      authoringStage: "requirements",
      createdAt: UPDATED_AT,
    });

    await expect(
      repo.advanceDraftAuthoringStage({
        specId: created.spec.id,
        revisionId: created.revision.id,
        expectedStage: "requirements",
        targetStage: "design",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<StaleStageConflictError>>({
        code: "stale_stage",
        currentRevision: replacement,
      }),
    );
  });

  it("copies a complete base row-set into one new draft snapshot", async () => {
    const created = await createSpec();
    const requirement = await addRequirement(
      created.spec.id,
      created.revision.id,
    );
    const criterion = await addCriterion(
      created.spec.id,
      created.revision.id,
      requirement.element.id,
    );
    await repo.approveRevision({
      revisionId: created.revision.id,
      approvedAt: APPROVED_AT,
    });

    const draft = await repo.createDraftFromBase({
      id: "revision-amendment",
      specId: created.spec.id,
      baseRevisionId: created.revision.id,
      authoringStage: "design",
      createdAt: UPDATED_AT,
    });
    const snapshot = await repo.getRevisionSnapshot(draft.id);

    expect(snapshot?.revision).toEqual(draft);
    expect(snapshot?.elements.map(({ element }) => element.id)).toEqual([
      requirement.element.id,
      criterion.element.id,
    ]);
    expect(
      snapshot?.elements.map(({ version }) => version.elementVersion),
    ).toEqual([1, 1]);
    expect(snapshot?.elements.map(({ version }) => version.createdAt)).toEqual([
      UPDATED_AT,
      UPDATED_AT,
    ]);
  });

  it("freezes an approved draft behind the canonical content hash of its snapshot", async () => {
    const created = await createSpec();
    await addRequirement(created.spec.id, created.revision.id);
    const draftSnapshot = await repo.getRevisionSnapshot(created.revision.id);
    if (draftSnapshot === null) throw new Error("draft snapshot is missing");
    expect(draftSnapshot.revision).toMatchObject({
      state: "draft",
      contentHash: null,
      proposedAt: null,
      approvedAt: null,
    });

    await repo.approveRevision({
      revisionId: created.revision.id,
      approvedAt: APPROVED_AT,
    });

    const reloaded = await repo.findRevision(created.revision.id);
    expect(reloaded).toMatchObject({
      state: "approved",
      contentHash: computeSpecRevisionContentHash(
        draftSnapshot.revision.authoringStage,
        draftSnapshot.elements,
      ),
      proposedAt: APPROVED_AT,
      approvedAt: APPROVED_AT,
    });
    expect(reloaded?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await repo.findDraft(created.spec.id)).toBeNull();
    expect(await repo.verifyRevision(created.revision.id)).toEqual({
      ok: true,
      expectedContentHash: reloaded?.contentHash,
      actualContentHash: reloaded?.contentHash,
      expectedCitationHash: draftSnapshot.revision.citationHash,
      actualCitationHash: draftSnapshot.revision.citationHash,
      mismatchedElementIds: [],
    });
  });

  it("refuses to approve a revision that is no longer a draft and leaves it unchanged", async () => {
    const approvedSpec = await createSpec();
    await addRequirement(approvedSpec.spec.id, approvedSpec.revision.id);
    const approved = await repo.approveRevision({
      revisionId: approvedSpec.revision.id,
      approvedAt: APPROVED_AT,
    });

    const withdrawnSpec = await createSpec();
    await addRequirement(withdrawnSpec.spec.id, withdrawnSpec.revision.id);
    const withdrawn = await repo.withdrawAuthoringRevision({
      revisionId: withdrawnSpec.revision.id,
    });

    for (const settled of [approved, withdrawn]) {
      await expect(
        repo.approveRevision({
          revisionId: settled.id,
          approvedAt: UPDATED_AT,
        }),
      ).rejects.toEqual(
        expect.objectContaining<Partial<SpecRevisionImmutableError>>({
          name: "SpecRevisionImmutableError",
          revisionId: settled.id,
          state: settled.state,
        }),
      );
      expect(await repo.findRevision(settled.id)).toEqual(settled);
    }
  });

  it("includes the declared authoring stage in the canonical content hash", async () => {
    const created = await createSpec();
    await addRequirement(created.spec.id, created.revision.id);
    await repo.approveRevision({
      revisionId: created.revision.id,
      approvedAt: APPROVED_AT,
    });

    fixture.db
      .prepare(
        "UPDATE spec_revisions SET authoring_stage = 'design' WHERE id = ?",
      )
      .run(created.revision.id);

    await expect(
      repo.verifyRevision(created.revision.id),
    ).resolves.toMatchObject({
      ok: false,
    });
  });

  it("refuses to freeze a draft whose element or citation integrity witness is corrupt", async () => {
    const elementHashCorruption = await createSpec({
      id: "spec-approval-element-hash-corruption",
    });
    const elementHashRequirement = await addRequirement(
      elementHashCorruption.spec.id,
      elementHashCorruption.revision.id,
    );
    fixture.db
      .prepare(
        `UPDATE spec_element_versions
         SET payload_json = ?
         WHERE revision_id = ? AND element_id = ?`,
      )
      .run(
        stableStringify(requirementPayload("Tampered outside the repository.")),
        elementHashCorruption.revision.id,
        elementHashRequirement.element.id,
      );

    const citationHashCorruption = await createSpec({
      id: "spec-approval-citation-hash-corruption",
    });
    const citationRequirement = await addRequirement(
      citationHashCorruption.spec.id,
      citationHashCorruption.revision.id,
    );
    const citationSnapshot = seedAssumption({
      id: "assumption-approval-citation-hash-corruption",
      specId: citationHashCorruption.spec.id,
      number: 1,
      elementId: citationRequirement.element.id,
    });
    await repo.replaceAssumptionDraftCitations({
      revisionId: citationHashCorruption.revision.id,
      specId: citationHashCorruption.spec.id,
      expectedCitationVersion: 1,
      replacements: [
        {
          assumptionId: citationSnapshot.assumptionId,
          elementIds: [citationRequirement.element.id],
          snapshot: citationSnapshot,
        },
      ],
      updatedAt: UPDATED_AT,
    });
    fixture.db
      .prepare(
        `UPDATE spec_revision_assumption_citations
         SET assumption_snapshot_json = ?
         WHERE revision_id = ? AND element_id = ? AND assumption_id = ?`,
      )
      .run(
        stableStringify({ ...citationSnapshot, text: "Tampered citation." }),
        citationHashCorruption.revision.id,
        citationRequirement.element.id,
        citationSnapshot.assumptionId,
      );

    for (const revisionId of [
      elementHashCorruption.revision.id,
      citationHashCorruption.revision.id,
    ]) {
      await expect(
        repo.approveRevision({ revisionId, approvedAt: APPROVED_AT }),
      ).rejects.toThrow();
      await expect(repo.findRevision(revisionId)).resolves.toMatchObject({
        state: "draft",
        contentHash: null,
        proposedAt: null,
        approvedAt: null,
      });
    }
  });

  it("resolves a renamed spec by both its current slug and appended alias", async () => {
    const created = await createSpec({ slug: "old-slug" });
    await repo.rename({
      specId: created.spec.id,
      slug: "current-slug",
      name: "Current name",
      updatedAt: UPDATED_AT,
      aliasCreatedAt: PROPOSED_AT,
    });

    expect(await repo.resolve(PROJECT_PATH, "current-slug")).toMatchObject({
      id: created.spec.id,
      slug: "current-slug",
    });
    expect(await repo.resolve(PROJECT_PATH, "old-slug")).toMatchObject({
      id: created.spec.id,
      slug: "current-slug",
    });
  });

  it("refuses to create a spec whose slug is another spec's historical alias", async () => {
    const original = await createSpec({
      id: "spec-original",
      slug: "reserved-slug",
    });
    await repo.rename({
      specId: original.spec.id,
      slug: "current-slug",
      name: "Current name",
      updatedAt: UPDATED_AT,
      aliasCreatedAt: PROPOSED_AT,
    });

    await expect(
      createSpec({ id: "spec-shadowing-create", slug: "reserved-slug" }),
    ).rejects.toMatchObject({
      failure: {
        kind: "constraint",
        constraint: "spec_slug_namespace",
        entity: "spec",
        identifier: `${PROJECT_PATH}/reserved-slug`,
      },
    });
    expect(await repo.findById("spec-shadowing-create")).toBeNull();
    expect(
      await repo.findRevision("spec-shadowing-create-revision-1"),
    ).toBeNull();
    expect(await repo.resolve(PROJECT_PATH, "reserved-slug")).toMatchObject({
      id: original.spec.id,
      slug: "current-slug",
    });
  });

  it("refuses to rename a spec to another spec's historical alias", async () => {
    const original = await createSpec({
      id: "spec-original",
      slug: "reserved-slug",
    });
    await repo.rename({
      specId: original.spec.id,
      slug: "current-slug",
      name: "Current name",
      updatedAt: UPDATED_AT,
      aliasCreatedAt: PROPOSED_AT,
    });
    const other = await createSpec({ id: "spec-other", slug: "other-slug" });

    await expect(
      repo.rename({
        specId: other.spec.id,
        slug: "reserved-slug",
        name: "Shadowing rename",
        updatedAt: UPDATED_AT,
        aliasCreatedAt: PROPOSED_AT,
      }),
    ).rejects.toMatchObject({
      failure: {
        kind: "constraint",
        constraint: "spec_slug_namespace",
        entity: "spec",
        identifier: `${PROJECT_PATH}/reserved-slug`,
      },
    });
    expect(await repo.resolve(PROJECT_PATH, "reserved-slug")).toMatchObject({
      id: original.spec.id,
      slug: "current-slug",
    });
    expect(await repo.resolve(PROJECT_PATH, "other-slug")).toMatchObject({
      id: other.spec.id,
      slug: "other-slug",
    });
  });

  it("allows a spec to rename back to one of its own historical aliases", async () => {
    const created = await createSpec({ slug: "first-slug" });
    await repo.rename({
      specId: created.spec.id,
      slug: "second-slug",
      name: "Second name",
      updatedAt: UPDATED_AT,
      aliasCreatedAt: PROPOSED_AT,
    });

    await expect(
      repo.rename({
        specId: created.spec.id,
        slug: "first-slug",
        name: "First name restored",
        updatedAt: APPROVED_AT,
        aliasCreatedAt: APPROVED_AT,
      }),
    ).resolves.toMatchObject({
      spec: { id: created.spec.id, slug: "first-slug" },
    });
  });
});

describe("revision-owned assumption citations", () => {
  it("starts every new draft on contract 2 with a verified empty citation set", async () => {
    const created = await createSpec();

    expect(await repo.getRevisionSnapshot(created.revision.id)).toMatchObject({
      revision: {
        citationContractVersion: 2,
        citationVersion: 1,
        citationHash: citationHash(2, []),
      },
      assumptionCitations: [],
    });
  });

  it("hashes citation mutations in snapshot code-unit order", async () => {
    const created = await createSpec();
    const upper = await repo.createDraftElement({
      id: "Z-citation-element",
      specId: created.spec.id,
      revisionId: created.revision.id,
      kind: "requirement",
      parentElementId: null,
      position: 0,
      payload: requirementPayload("Uppercase citation subject."),
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
    const lower = await repo.createDraftElement({
      id: "a-citation-element",
      specId: created.spec.id,
      revisionId: created.revision.id,
      kind: "requirement",
      parentElementId: null,
      position: 1,
      payload: requirementPayload("Lowercase citation subject."),
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
    const snapshot = seedAssumption({
      id: "assumption-mixed-case-citations",
      specId: created.spec.id,
      number: 1,
      elementId: upper.element.id,
    });

    const replaced = await repo.replaceAssumptionDraftCitations({
      revisionId: created.revision.id,
      specId: created.spec.id,
      expectedCitationVersion: 1,
      replacements: [
        {
          assumptionId: snapshot.assumptionId,
          elementIds: [lower.element.id, upper.element.id],
          snapshot,
        },
      ],
      updatedAt: UPDATED_AT,
    });
    const citations = await repo.readRevisionCitations(created.revision.id);

    expect(citations.map(({ elementId }) => elementId)).toEqual([
      upper.element.id,
      lower.element.id,
    ]);
    expect(replaced).toMatchObject({
      kind: "success",
      revision: { citationHash: citationHash(2, citations) },
    });
    await expect(
      repo.approveRevision({
        revisionId: created.revision.id,
        approvedAt: APPROVED_AT,
      }),
    ).resolves.toMatchObject({ state: "approved" });
  });

  it("reads citations in snapshot code-unit order when SQLite byte order differs", async () => {
    const created = await createSpec();
    const astral = await repo.createDraftElement({
      id: "id-\u{10000}",
      specId: created.spec.id,
      revisionId: created.revision.id,
      kind: "requirement",
      parentElementId: null,
      position: 0,
      payload: requirementPayload("Astral citation subject."),
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
    const privateUse = await repo.createDraftElement({
      id: "id-\uE000",
      specId: created.spec.id,
      revisionId: created.revision.id,
      kind: "requirement",
      parentElementId: null,
      position: 1,
      payload: requirementPayload("Private-use citation subject."),
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
    const assumptionSnapshot = seedAssumption({
      id: "assumption-unicode-citations",
      specId: created.spec.id,
      number: 1,
      elementId: astral.element.id,
    });

    await repo.replaceAssumptionDraftCitations({
      revisionId: created.revision.id,
      specId: created.spec.id,
      expectedCitationVersion: 1,
      replacements: [
        {
          assumptionId: assumptionSnapshot.assumptionId,
          elementIds: [privateUse.element.id, astral.element.id],
          snapshot: assumptionSnapshot,
        },
      ],
      updatedAt: UPDATED_AT,
    });

    const citations = await repo.readRevisionCitations(created.revision.id);
    expect(citations.map(({ elementId }) => elementId)).toEqual([
      astral.element.id,
      privateUse.element.id,
    ]);
    await expect(
      repo.getRevisionSnapshot(created.revision.id),
    ).resolves.toMatchObject({ assumptionCitations: citations });
  });

  it("replaces, refreshes, and removes exact draft citations with one CAS increment", async () => {
    const created = await createSpec();
    const first = await addRequirement(
      created.spec.id,
      created.revision.id,
      "First citation subject.",
    );
    const second = await repo.createDraftElement({
      id: "requirement-citation-second",
      specId: created.spec.id,
      revisionId: created.revision.id,
      kind: "requirement",
      parentElementId: null,
      position: 1,
      payload: requirementPayload("Second citation subject."),
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
    const snapshot = seedAssumption({
      id: "assumption-citation",
      specId: created.spec.id,
      number: 1,
      elementId: first.element.id,
    });

    const replaced = await repo.replaceAssumptionDraftCitations({
      revisionId: created.revision.id,
      specId: created.spec.id,
      expectedCitationVersion: 1,
      replacements: [
        {
          assumptionId: snapshot.assumptionId,
          elementIds: [second.element.id, first.element.id],
          snapshot,
        },
      ],
      updatedAt: UPDATED_AT,
    });
    expect(replaced).toMatchObject({
      kind: "success",
      changed: true,
      revision: { citationVersion: 2 },
      added: [
        {
          elementId: first.element.id,
          assumptionId: snapshot.assumptionId,
        },
        {
          elementId: second.element.id,
          assumptionId: snapshot.assumptionId,
        },
      ],
      removed: [],
      refreshed: [],
    });
    expect(
      (await repo.readRevisionCitations(created.revision.id)).map(
        ({ elementId, assumptionId }) => [elementId, assumptionId],
      ),
    ).toEqual([
      [first.element.id, snapshot.assumptionId],
      [second.element.id, snapshot.assumptionId],
    ]);

    const noOp = await repo.replaceAssumptionDraftCitations({
      revisionId: created.revision.id,
      specId: created.spec.id,
      expectedCitationVersion: 2,
      replacements: [
        {
          assumptionId: snapshot.assumptionId,
          elementIds: [first.element.id, second.element.id],
          snapshot,
        },
      ],
      updatedAt: PROPOSED_AT,
    });
    expect(noOp).toMatchObject({
      kind: "success",
      changed: false,
      revision: { citationVersion: 2 },
      added: [],
      removed: [],
      refreshed: [],
    });
    expect(
      await repo.replaceAssumptionDraftCitations({
        revisionId: created.revision.id,
        specId: created.spec.id,
        expectedCitationVersion: 1,
        replacements: [],
        updatedAt: PROPOSED_AT,
      }),
    ).toEqual({ kind: "stale_version", currentVersion: 2 });

    const refreshedSnapshot = {
      ...snapshot,
      recordVersion: 2,
      text: "The premise was corrected.",
      capturedAt: PROPOSED_AT,
      updatedAt: PROPOSED_AT,
    };
    expect(
      await repo.replaceAssumptionDraftCitations({
        revisionId: created.revision.id,
        specId: created.spec.id,
        expectedCitationVersion: 2,
        replacements: [
          {
            assumptionId: snapshot.assumptionId,
            elementIds: [first.element.id, second.element.id],
            snapshot: refreshedSnapshot,
          },
        ],
        updatedAt: PROPOSED_AT,
      }),
    ).toMatchObject({
      kind: "success",
      changed: true,
      revision: { citationVersion: 3 },
      added: [],
      removed: [],
      refreshed: [
        {
          elementId: first.element.id,
          assumptionId: snapshot.assumptionId,
        },
        {
          elementId: second.element.id,
          assumptionId: snapshot.assumptionId,
        },
      ],
    });

    expect(
      await repo.mutateDraftCitation({
        operation: "uncite",
        revisionId: created.revision.id,
        specId: created.spec.id,
        assumptionId: snapshot.assumptionId,
        elementId: first.element.id,
        expectedCitationVersion: 3,
        updatedAt: APPROVED_AT,
      }),
    ).toMatchObject({
      kind: "success",
      changed: true,
      revision: { citationVersion: 4 },
      removed: [
        {
          elementId: first.element.id,
          assumptionId: snapshot.assumptionId,
        },
      ],
    });

    const secondVersion = await repo.findElementVersion(
      created.revision.id,
      second.element.id,
    );
    if (secondVersion === null)
      throw new Error("missing second element version");
    await repo.removeDraftElement({
      revisionId: created.revision.id,
      elementId: second.element.id,
      expectedElementVersion: secondVersion.elementVersion,
    });
    expect(await repo.findRevision(created.revision.id)).toMatchObject({
      citationVersion: 5,
      citationHash: citationHash(2, []),
    });
    expect(await repo.readRevisionCitations(created.revision.id)).toEqual([]);
  });

  it("refuses stale, cross-spec, non-member, and frozen citation mutations", async () => {
    const created = await createSpec();
    const requirement = await addRequirement(
      created.spec.id,
      created.revision.id,
    );
    const foreign = await createSpec({ id: "spec-citation-foreign" });
    const foreignRequirement = await addRequirement(
      foreign.spec.id,
      foreign.revision.id,
    );
    const snapshot = seedAssumption({
      id: "assumption-citation-membership",
      specId: created.spec.id,
      number: 1,
      elementId: requirement.element.id,
    });

    await expect(
      repo.mutateDraftCitation({
        operation: "cite",
        revisionId: created.revision.id,
        specId: created.spec.id,
        assumptionId: snapshot.assumptionId,
        elementId: foreignRequirement.element.id,
        expectedCitationVersion: 1,
        snapshot,
        updatedAt: UPDATED_AT,
      }),
    ).resolves.toEqual({
      kind: "invalid_relation",
      reason: "element_not_in_revision",
    });
    await expect(
      repo.mutateDraftCitation({
        operation: "cite",
        revisionId: created.revision.id,
        specId: foreign.spec.id,
        assumptionId: snapshot.assumptionId,
        elementId: requirement.element.id,
        expectedCitationVersion: 1,
        snapshot,
        updatedAt: UPDATED_AT,
      }),
    ).resolves.toEqual({
      kind: "invalid_relation",
      reason: "revision_spec_mismatch",
    });

    await repo.approveRevision({
      revisionId: created.revision.id,
      approvedAt: APPROVED_AT,
    });
    await expect(
      repo.mutateDraftCitation({
        operation: "cite",
        revisionId: created.revision.id,
        specId: created.spec.id,
        assumptionId: snapshot.assumptionId,
        elementId: requirement.element.id,
        expectedCitationVersion: 1,
        snapshot,
        updatedAt: UPDATED_AT,
      }),
    ).resolves.toMatchObject({
      kind: "illegal_lifecycle",
      state: "approved",
    });
  });

  it("copies citation triples and snapshot bytes atomically when forking a draft", async () => {
    const created = await createSpec();
    const requirement = await addRequirement(
      created.spec.id,
      created.revision.id,
    );
    const snapshot = seedAssumption({
      id: "assumption-citation-copy",
      specId: created.spec.id,
      number: 1,
      elementId: requirement.element.id,
    });
    await repo.mutateDraftCitation({
      operation: "cite",
      revisionId: created.revision.id,
      specId: created.spec.id,
      assumptionId: snapshot.assumptionId,
      elementId: requirement.element.id,
      expectedCitationVersion: 1,
      snapshot,
      updatedAt: UPDATED_AT,
    });
    await repo.approveRevision({
      revisionId: created.revision.id,
      approvedAt: APPROVED_AT,
    });
    const baseBytes = fixture.db
      .prepare(
        `SELECT assumption_snapshot_json FROM spec_revision_assumption_citations
         WHERE revision_id = ?`,
      )
      .get(created.revision.id);

    const fork = await repo.createDraftFromBase({
      id: "revision-citation-copy",
      specId: created.spec.id,
      baseRevisionId: created.revision.id,
      authoringStage: "requirements",
      createdAt: APPROVED_AT,
    });
    const forkBytes = fixture.db
      .prepare(
        `SELECT assumption_snapshot_json FROM spec_revision_assumption_citations
         WHERE revision_id = ?`,
      )
      .get(fork.id);
    expect(forkBytes).toEqual(baseBytes);
    expect(await repo.getRevisionSnapshot(fork.id)).toMatchObject({
      revision: {
        citationContractVersion: 2,
        citationVersion: 1,
      },
      assumptionCitations: [
        {
          elementId: requirement.element.id,
          assumptionId: snapshot.assumptionId,
          snapshot,
        },
      ],
    });
  });
});

describe("counter allocation", () => {
  it("allocates unique numbers under interleaving and never reuses them", async () => {
    const created = await createSpec();

    const allocated = await Promise.all(
      Array.from({ length: 20 }, () =>
        repo.allocateNumber(created.spec.id, "C:requirement-1"),
      ),
    );

    expect([...allocated].sort((left, right) => left - right)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(await repo.allocateNumber(created.spec.id, "C:requirement-1")).toBe(
      21,
    );
  });

  it("keeps every handle scope independent", async () => {
    const created = await createSpec();
    const scopes = ["R", "D", "T", "Q", "A", "C:requirement-1"] as const;

    expect(
      await Promise.all(
        scopes.map((scope) => repo.allocateNumber(created.spec.id, scope)),
      ),
    ).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

describe("draft compare-and-swap", () => {
  async function createTwoCriteria() {
    const created = await createSpec();
    const requirement = await addRequirement(
      created.spec.id,
      created.revision.id,
    );
    const first = await addCriterion(
      created.spec.id,
      created.revision.id,
      requirement.element.id,
      "First criterion",
      1,
    );
    const second = await addCriterion(
      created.spec.id,
      created.revision.id,
      requirement.element.id,
      "Second criterion",
      2,
    );
    return { created, first, second };
  }

  it("lets interleaved writers update independent elements without losing either write", async () => {
    const { first, second } = await createTwoCriteria();

    await Promise.all([
      repo.updateDraftElement({
        revisionId: first.version.revisionId,
        elementId: first.element.id,
        expectedElementVersion: first.version.elementVersion,
        payload: criterionPayload("First writer landed."),
      }),
      repo.updateDraftElement({
        revisionId: second.version.revisionId,
        elementId: second.element.id,
        expectedElementVersion: second.version.elementVersion,
        payload: criterionPayload("Second writer landed."),
      }),
    ]);

    expect(
      await repo.findElementVersion(first.version.revisionId, first.element.id),
    ).toMatchObject({
      elementVersion: 2,
      payload: { text: "First writer landed." },
    });
    expect(
      await repo.findElementVersion(
        second.version.revisionId,
        second.element.id,
      ),
    ).toMatchObject({
      elementVersion: 2,
      payload: { text: "Second writer landed." },
    });
  });

  it("returns current content in a typed stale_element conflict and preserves the winning write", async () => {
    const { first } = await createTwoCriteria();
    const winnerPayload = criterionPayload("The first writer wins the CAS.");
    const stalePayload = criterionPayload("A stale writer must not overwrite.");

    const winner = await repo.updateDraftElement({
      revisionId: first.version.revisionId,
      elementId: first.element.id,
      expectedElementVersion: first.version.elementVersion,
      payload: winnerPayload,
    });

    const conflict = await repo
      .updateDraftElement({
        revisionId: first.version.revisionId,
        elementId: first.element.id,
        expectedElementVersion: first.version.elementVersion,
        payload: stalePayload,
      })
      .catch((error: unknown) => error);

    expect(conflict).toBeInstanceOf(StaleElementConflictError);
    expect(conflict).toMatchObject({
      code: "stale_element",
      revisionId: first.version.revisionId,
      elementId: first.element.id,
      expectedElementVersion: 1,
      current: {
        elementVersion: 2,
        payload: winnerPayload,
      },
    });
    expect(
      await repo.findElementVersion(first.version.revisionId, first.element.id),
    ).toEqual(winner);
  });

  it("refuses content writes after a revision is approved", async () => {
    const { created, first } = await createTwoCriteria();
    await repo.approveRevision({
      revisionId: created.revision.id,
      approvedAt: APPROVED_AT,
    });

    await expect(
      repo.updateDraftElement({
        revisionId: created.revision.id,
        elementId: first.element.id,
        expectedElementVersion: first.version.elementVersion,
        payload: criterionPayload("Approved content cannot change."),
      }),
    ).rejects.toBeInstanceOf(SpecRevisionImmutableError);
  });

  it("appends deterministically when a draft write omits position", async () => {
    const created = await createSpec();
    const requirement = await addRequirement(
      created.spec.id,
      created.revision.id,
    );
    await addCriterion(
      created.spec.id,
      created.revision.id,
      requirement.element.id,
      "The first criterion.",
      4,
    );

    const appended = await repo.createDraftElement({
      id: nextId("decision"),
      specId: created.spec.id,
      revisionId: created.revision.id,
      kind: "decision",
      parentElementId: null,
      payload: {
        kind: "decision",
        title: "Ordering is one global order",
        chosenApproach: "Append after the highest position in the revision.",
        rejectedAlternatives: [],
        reason: "Opaque element-id tiebreaks are not an author-visible order.",
        tracedRequirementElementIds: [],
      },
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });

    expect(appended.version.position).toBe(5);
    const snapshot = await repo.getRevisionSnapshot(created.revision.id);
    expect(snapshot?.elements.map(({ version }) => version.position)).toEqual([
      0, 4, 5,
    ]);
  });

  it("orders duplicate positions by element id, the documented tiebreak", async () => {
    const created = await createSpec();
    // Written out of element-id order so a repository that fell back to
    // insertion order would produce a different sequence than the tiebreak.
    for (const id of ["requirement-z", "requirement-a", "requirement-m"]) {
      await repo.createDraftElement({
        id,
        specId: created.spec.id,
        revisionId: created.revision.id,
        kind: "requirement",
        parentElementId: null,
        position: 0,
        payload: requirementPayload(`Statement for ${id}.`),
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      });
    }

    const snapshot = await repo.getRevisionSnapshot(created.revision.id);
    expect(snapshot?.elements.map(({ element }) => element.id)).toEqual([
      "requirement-a",
      "requirement-m",
      "requirement-z",
    ]);
    expect(snapshot?.elements.map(({ version }) => version.position)).toEqual([
      0, 0, 0,
    ]);
  });

  it("uses SQLite UTF-8 byte order for the element-id tiebreak", async () => {
    const created = await createSpec();
    const expectedOrder = ["requirement-\uE000", "requirement-\u{10000}"];
    for (const id of [...expectedOrder].reverse()) {
      await repo.createDraftElement({
        id,
        specId: created.spec.id,
        revisionId: created.revision.id,
        kind: "requirement",
        parentElementId: null,
        position: 0,
        payload: requirementPayload(`Statement for ${id}.`),
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      });
    }

    const snapshot = await repo.getRevisionSnapshot(created.revision.id);
    expect(snapshot?.elements.map(({ element }) => element.id)).toEqual(
      expectedOrder,
    );
  });

  it("keeps one global order across parents and children, with nesting carried by the parent alone", async () => {
    const created = await createSpec();
    const requirement = await repo.createDraftElement({
      id: "requirement-parent",
      specId: created.spec.id,
      revisionId: created.revision.id,
      kind: "requirement",
      parentElementId: null,
      position: 1,
      payload: requirementPayload("The parent requirement."),
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
    // The child sits at the parent's position and a second requirement sits
    // between them numerically: order is one global sequence, so the child
    // does not travel with its parent.
    await repo.createDraftElement({
      id: "criterion-child",
      specId: created.spec.id,
      revisionId: created.revision.id,
      kind: "criterion",
      parentElementId: requirement.element.id,
      position: 1,
      payload: criterionPayload("The nested criterion."),
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
    await repo.createDraftElement({
      id: "requirement-sibling",
      specId: created.spec.id,
      revisionId: created.revision.id,
      kind: "requirement",
      parentElementId: null,
      position: 0,
      payload: requirementPayload("The sibling requirement."),
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });

    const snapshot = await repo.getRevisionSnapshot(created.revision.id);
    expect(
      snapshot?.elements.map(({ element, version }) => [
        element.id,
        version.position,
        element.parentElementId,
      ]),
    ).toEqual([
      ["requirement-sibling", 0, null],
      ["criterion-child", 1, "requirement-parent"],
      ["requirement-parent", 1, null],
    ]);
  });

  it("keeps the element's position when an update omits position", async () => {
    const created = await createSpec();
    const requirement = await addRequirement(
      created.spec.id,
      created.revision.id,
    );
    const criterion = await addCriterion(
      created.spec.id,
      created.revision.id,
      requirement.element.id,
      "The only criterion.",
      3,
    );

    const updated = await repo.updateDraftElement({
      revisionId: created.revision.id,
      elementId: criterion.element.id,
      expectedElementVersion: criterion.version.elementVersion,
      payload: criterionPayload("The only criterion, restated."),
      updatedAt: UPDATED_AT,
    });

    expect(updated.position).toBe(3);
  });

  it("rejects a criterion whose parent is not a requirement", async () => {
    const created = await createSpec();
    const section = await repo.createDraftElement({
      id: nextId("section"),
      specId: created.spec.id,
      revisionId: created.revision.id,
      kind: "section",
      parentElementId: null,
      position: 0,
      payload: {
        kind: "section",
        role: "intent_problem",
        title: "Problem",
        body: "Prompt etiquette is not enforcement.",
      },
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });

    await expect(
      repo.createDraftElement({
        id: nextId("criterion"),
        specId: created.spec.id,
        revisionId: created.revision.id,
        kind: "criterion",
        parentElementId: section.element.id,
        position: 1,
        payload: criterionPayload("This parent is invalid."),
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      }),
    ).rejects.toMatchObject({
      failure: { kind: "validation", entity: "spec_element" },
    });
  });

  it("reports the owning spec when an element ID is reused across specs", async () => {
    const firstSpec = await createSpec();
    await repo.createDraftElement({
      id: "sec-problem",
      specId: firstSpec.spec.id,
      revisionId: firstSpec.revision.id,
      kind: "section",
      parentElementId: null,
      position: 0,
      payload: {
        kind: "section",
        role: "intent_problem",
        title: "Problem",
        body: "First spec problem.",
      },
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
    const secondSpec = await createSpec();

    await expect(
      repo.createDraftElement({
        id: "sec-problem",
        specId: secondSpec.spec.id,
        revisionId: secondSpec.revision.id,
        kind: "section",
        parentElementId: null,
        position: 0,
        payload: {
          kind: "section",
          role: "intent_problem",
          title: "Problem",
          body: "Second spec problem.",
        },
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      }),
    ).rejects.toMatchObject({
      name: "SpecElementIdTakenError",
      code: "element_id_taken",
      elementId: "sec-problem",
      existingSpecId: firstSpec.spec.id,
    } satisfies Partial<SpecElementIdTakenError>);
  });

  it.each([
    ["requirement", requirementPayload("A requirement payload.")],
    ["criterion", criterionPayload("A criterion payload.")],
  ] as const)(
    "refuses a %s identity whose payload declares a different element kind",
    async (kind, payload) => {
      const created = await createSpec();
      const mismatchedPayload: SpecElementPayload =
        payload.kind === "requirement"
          ? criterionPayload("Wrong payload kind.")
          : requirementPayload("Wrong payload kind.");

      await expect(
        repo.createDraftElement({
          id: nextId("mismatch"),
          specId: created.spec.id,
          revisionId: created.revision.id,
          kind,
          parentElementId: null,
          position: 0,
          payload: mismatchedPayload,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
        }),
      ).rejects.toMatchObject({
        failure: { kind: "validation", entity: "spec_element" },
      });
    },
  );
});

describe("historical element reintroduction", () => {
  const ORPHAN_ID = "requirement-orphaned";

  /**
   * The reported dead zone, built the way the incident produced it: an element
   * authored on a revision a human then ended, so its identity survives while
   * every version of it lives outside the revision now being authored.
   */
  async function orphanElement() {
    const created = await createSpec();
    await addRequirement(created.spec.id, created.revision.id, "Kept.");
    await repo.approveRevision({
      revisionId: created.revision.id,
      approvedAt: APPROVED_AT,
    });

    const attempt = await repo.createDraftFromBase({
      id: `${created.spec.id}-revision-2`,
      specId: created.spec.id,
      baseRevisionId: created.revision.id,
      authoringStage: "requirements",
      createdAt: UPDATED_AT,
    });
    const orphan = await repo.createDraftElement({
      id: ORPHAN_ID,
      specId: created.spec.id,
      revisionId: attempt.id,
      kind: "requirement",
      parentElementId: null,
      payload: requirementPayload("Authored on the attempt a human ended."),
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
    await repo.withdrawAuthoringRevision({ revisionId: attempt.id });

    const followUp = await repo.createDraftFromBase({
      id: `${created.spec.id}-revision-3`,
      specId: created.spec.id,
      baseRevisionId: created.revision.id,
      authoringStage: "requirements",
      createdAt: UPDATED_AT,
    });
    return { spec: created.spec, approved: created.revision, orphan, followUp };
  }

  it("restores the orphaned identity with its number, provenance, and a revision-local first version", async () => {
    const { spec, orphan, followUp } = await orphanElement();
    const restoredPayload = requirementPayload("Restored, and rewritten.");

    const revived = await repo.createDraftElement({
      id: ORPHAN_ID,
      specId: spec.id,
      revisionId: followUp.id,
      kind: "requirement",
      parentElementId: null,
      payload: restoredPayload,
      reintroduceHistorical: true,
      createdAt: PROPOSED_AT,
      updatedAt: PROPOSED_AT,
    });

    expect(revived.revived).toBe(true);
    // Reloaded through the repository: the identity row is untouched, so the
    // element keeps the number its handle is composed from.
    const reloadedElement = await repo.findElement(ORPHAN_ID);
    expect(reloadedElement).toEqual(orphan.element);
    const snapshot = await repo.getRevisionSnapshot(followUp.id);
    const row = snapshot?.elements.find(
      ({ element }) => element.id === ORPHAN_ID,
    );
    expect(row?.version).toMatchObject({
      revisionId: followUp.id,
      elementVersion: 1,
      payload: restoredPayload,
    });
    // The counter is not advanced: reintroduction reuses an allocated number
    // rather than minting one, so the next new requirement is R3.
    expect(await repo.findCounter(spec.id, "R")).toMatchObject({
      lastNumber: 2,
    });
  });

  it("refuses a historical identity of the same spec without the reintroduction marker", async () => {
    const { spec, followUp } = await orphanElement();

    await expect(
      repo.createDraftElement({
        id: ORPHAN_ID,
        specId: spec.id,
        revisionId: followUp.id,
        kind: "requirement",
        parentElementId: null,
        payload: requirementPayload("Re-authored under the same id."),
        createdAt: PROPOSED_AT,
        updatedAt: PROPOSED_AT,
      }),
    ).rejects.toMatchObject({
      name: "SpecHistoricalElementError",
      code: "historical_element_id",
      reason: "reintroduction_required",
      elementId: ORPHAN_ID,
      specId: spec.id,
      handle: "R2",
    });
  });

  it("refuses a reintroduction that would change the element's kind", async () => {
    const { spec, followUp } = await orphanElement();

    await expect(
      repo.createDraftElement({
        id: ORPHAN_ID,
        specId: spec.id,
        revisionId: followUp.id,
        kind: "task",
        parentElementId: null,
        payload: maximalTaskPayload(),
        reintroduceHistorical: true,
        createdAt: PROPOSED_AT,
        updatedAt: PROPOSED_AT,
      }),
    ).rejects.toMatchObject({
      name: "SpecHistoricalElementError",
      reason: "kind_changed",
      kind: "requirement",
      attemptedKind: "task",
    });
  });

  it("refuses a reintroduction that would change the element's parent", async () => {
    const created = await createSpec();
    const first = await addRequirement(
      created.spec.id,
      created.revision.id,
      "First.",
    );
    const second = await addRequirement(
      created.spec.id,
      created.revision.id,
      "Second.",
    );
    const criterion = await addCriterion(
      created.spec.id,
      created.revision.id,
      first.element.id,
    );
    await repo.removeDraftElement({
      revisionId: created.revision.id,
      elementId: criterion.element.id,
      expectedElementVersion: criterion.version.elementVersion,
    });

    await expect(
      repo.createDraftElement({
        id: criterion.element.id,
        specId: created.spec.id,
        revisionId: created.revision.id,
        kind: "criterion",
        parentElementId: second.element.id,
        payload: criterionPayload("Restored under the wrong requirement."),
        reintroduceHistorical: true,
        createdAt: PROPOSED_AT,
        updatedAt: PROPOSED_AT,
      }),
    ).rejects.toMatchObject({
      name: "SpecHistoricalElementError",
      reason: "parent_changed",
      parentElementId: first.element.id,
      attemptedParentElementId: second.element.id,
    });
  });

  it("reports the ordinary stale-create conflict when the identity is live in the target revision", async () => {
    const created = await createSpec();
    const requirement = await addRequirement(
      created.spec.id,
      created.revision.id,
    );

    await expect(
      repo.createDraftElement({
        id: requirement.element.id,
        specId: created.spec.id,
        revisionId: created.revision.id,
        kind: "requirement",
        parentElementId: null,
        payload: requirementPayload("A second create of a live element."),
        reintroduceHistorical: true,
        createdAt: PROPOSED_AT,
        updatedAt: PROPOSED_AT,
      }),
    ).rejects.toMatchObject({
      name: "StaleElementConflictError",
      code: "stale_element",
      expectedElementVersion: 0,
    });
  });
});
